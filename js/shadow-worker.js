// Web Worker : télécharge le relief (tuiles Terrarium), construit le champ de hauteurs
// (relief + bâtiments) et calcule les ombres à la demande.
import {
  DemMosaic, decodeTerrarium, fillTerrain, rasterizeBuildings, sweepShadows, depthToRGBA, pointExposure, rowScaleFactors,
  accumulateExposure, exposureToRGBA,
} from './shadow-engine.js';

const TILE_SIZE = 256;
const MAX_CACHE = 240; // ~60 Mo de hauteurs décodées au maximum
const CONCURRENCY = 8;

let demTemplate = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const tileCache = new Map(); // "z/x/y" → Promise<Float32Array|null>
let current = null; // champ de hauteurs courant
let lastSun = null; // { azimuth, altitude }
let mode = 'shadows'; // 'shadows' | 'exposure'
let lastExposure = null; // { samples, stepMinutes, maxMinutes }
let exposureToken = 0;
let style = { shadow: [18, 26, 48, 115], night: [12, 16, 40, 150], soft: false };
let hfToken = 0;

function touchCache(key, value) {
  tileCache.delete(key);
  tileCache.set(key, value);
  if (tileCache.size > MAX_CACHE) tileCache.delete(tileCache.keys().next().value);
}

async function decodeBlob(blob) {
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return decodeTerrarium(img.data);
}

function fetchTile(z, x, y) {
  const n = 1 << z;
  if (y < 0 || y >= n) return Promise.resolve(null);
  const xw = ((x % n) + n) % n;
  const key = `${z}/${xw}/${y}`;
  const cached = tileCache.get(key);
  if (cached) {
    touchCache(key, cached);
    return cached;
  }
  const p = (async () => {
    const url = demTemplate.replace('{z}', z).replace('{x}', xw).replace('{y}', y);
    try {
      const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (!res.ok) return null;
      return await decodeBlob(await res.blob());
    } catch {
      return null;
    }
  })();
  touchCache(key, p);
  p.then((v) => {
    if (v === null) tileCache.delete(key); // on réessaiera plus tard
  });
  return p;
}

async function runPool(tasks, limit) {
  let i = 0;
  const workers = [];
  for (let k = 0; k < Math.min(limit, tasks.length); k++) {
    workers.push((async () => {
      while (i < tasks.length) {
        const t = tasks[i++];
        await t();
      }
    })());
  }
  await Promise.all(workers);
}

async function buildHeightfield(msg) {
  const token = ++hfToken;
  const { id, grid, demZoom, buildings, cellMeters, latCenter, useTerrain, useBuildings } = msg;
  const { w, h } = grid;
  const T = new Float32Array(w * h);
  let tilesLoaded = 0;
  let tilesMissing = 0;

  if (useTerrain) {
    const scale = Math.pow(2, demZoom); // tuiles par unité Mercator
    const n = 1 << demZoom;
    const tx0 = Math.floor(grid.originX * scale);
    const tx1 = Math.floor((grid.originX + w * grid.cellUnits) * scale);
    const ty0 = Math.max(0, Math.floor(grid.originY * scale));
    const ty1 = Math.min(n - 1, Math.floor((grid.originY + h * grid.cellUnits) * scale));
    const mosaic = new DemMosaic(tx0, ty0, tx1 - tx0 + 1, ty1 - ty0 + 1, TILE_SIZE);
    const total = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
    const tasks = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        tasks.push(async () => {
          const heights = await fetchTile(demZoom, tx, ty);
          if (token !== hfToken) return;
          if (heights) {
            mosaic.setTile(tx, ty, heights);
            tilesLoaded++;
          } else {
            tilesMissing++;
          }
          postMessage({ type: 'progress', id, loaded: tilesLoaded + tilesMissing, total });
        });
      }
    }
    await runPool(tasks, CONCURRENCY);
    if (token !== hfToken) return; // une demande plus récente a pris le relais
    fillTerrain(T, grid, mosaic, demZoom);
  }

  const H = new Float32Array(T);
  let touched = 0;
  if (useBuildings && buildings && buildings.polyStart.length > 1) {
    touched = rasterizeBuildings(H, T, grid, buildings);
  }
  let minH = Infinity;
  let maxH = -Infinity;
  for (let i = 0; i < H.length; i++) {
    const v = H[i];
    if (v < minH) minH = v;
    if (v > maxH) maxH = v;
  }
  const rowScale = Number.isFinite(latCenter) ? rowScaleFactors(grid, latCenter) : null;
  current = { id, grid, H, T, depth: new Float32Array(w * h), cellMeters, rowScale };
  postMessage({
    type: 'heightfield-ready',
    id,
    stats: { tilesLoaded, tilesMissing, buildings: touched, minH, maxH, w, h },
  });
  if (mode === 'exposure' && lastExposure) exposureMap({ ...lastExposure });
  else if (lastSun) render({ id, ...lastSun });
}

/** Carte des heures de soleil : un balayage par échantillon, avec cession du fil entre deux pour rester réactif. */
async function exposureMap(msg) {
  lastExposure = { samples: msg.samples, stepMinutes: msg.stepMinutes, maxMinutes: msg.maxMinutes };
  if (!current) {
    postMessage({ type: 'frame-skipped', requestId: msg.requestId });
    return;
  }
  const token = ++exposureToken;
  const { grid, H, depth, cellMeters, rowScale } = current;
  const { w, h } = grid;
  const acc = new Float32Array(w * h);
  const t0 = performance.now();
  const n = w * h;
  let k = 0;
  for (const s of msg.samples) {
    if (token !== exposureToken || current.grid !== grid) {
      postMessage({ type: 'frame-skipped', requestId: msg.requestId });
      return;
    }
    if (s.altitude > 0) {
      sweepShadows(H, w, h, s.azimuth, s.altitude, cellMeters, depth, rowScale);
      for (let i = 0; i < n; i++) if (depth[i] === 0) acc[i] += msg.stepMinutes;
    }
    k++;
    if (k % 6 === 0) {
      postMessage({ type: 'progress', id: current.id, loaded: k, total: msg.samples.length, kind: 'exposure' });
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  if (token !== exposureToken || current.grid !== grid) return;
  let maxAcc = 0;
  for (let i = 0; i < n; i++) if (acc[i] > maxAcc) maxAcc = acc[i];
  const maxMinutes = msg.maxMinutes > 0 ? msg.maxMinutes : maxAcc;
  const rgba = exposureToRGBA(acc, w, h, null, maxMinutes, style.exposureAlpha || 165);
  postMessage(
    { type: 'frame', id: current.id, requestId: msg.requestId, w, h, buffer: rgba.buffer, ms: performance.now() - t0, kind: 'exposure', maxMinutes, maxAcc },
    [rgba.buffer],
  );
}

function render(msg) {
  lastSun = { azimuth: msg.azimuth, altitude: msg.altitude };
  if (!current) {
    // Pas encore de champ de hauteurs : on répond quand même pour libérer le verrou côté page.
    postMessage({ type: 'frame-skipped', requestId: msg.requestId });
    return;
  }
  const { grid, H, depth, cellMeters, rowScale } = current;
  const { w, h } = grid;
  const t0 = performance.now();
  sweepShadows(H, w, h, msg.azimuth, msg.altitude, cellMeters, depth, rowScale);
  const rgba = depthToRGBA(depth, w, h, null, style);
  postMessage(
    { type: 'frame', id: current.id, requestId: msg.requestId, w, h, buffer: rgba.buffer, ms: performance.now() - t0 },
    [rgba.buffer],
  );
}

function exposure(msg) {
  if (!current) {
    postMessage({ type: 'exposure-result', requestId: msg.requestId, lit: null });
    return;
  }
  const { grid, H, cellMeters, rowScale } = current;
  const gx = (msg.x - grid.originX) / grid.cellUnits;
  const gy = (msg.y - grid.originY) / grid.cellUnits;
  if (gx < 0 || gy < 0 || gx >= grid.w || gy >= grid.h) {
    postMessage({ type: 'exposure-result', requestId: msg.requestId, lit: null });
    return;
  }
  const lit = pointExposure(H, grid.w, grid.h, gx, gy, msg.samples, cellMeters, msg.eyeHeight || 0, rowScale);
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  postMessage({
    type: 'exposure-result',
    requestId: msg.requestId,
    lit,
    elevation: current.T[iy * grid.w + ix],
    surface: H[iy * grid.w + ix],
  });
}

self.onmessage = (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'config':
      if (msg.demTemplate) demTemplate = msg.demTemplate;
      if (msg.style) style = { ...style, ...msg.style };
      if (msg.mode) mode = msg.mode;
      if (msg.style && current) {
        if (mode === 'exposure' && lastExposure) exposureMap({ ...lastExposure });
        else if (lastSun) render({ ...lastSun });
      }
      break;
    case 'exposure-map':
      exposureMap(msg).catch((err) => postMessage({ type: 'error', message: String(err) }));
      break;
    case 'heightfield':
      buildHeightfield(msg).catch((err) => postMessage({ type: 'error', id: msg.id, message: String(err) }));
      break;
    case 'render':
      if (mode === 'exposure') {
        lastSun = { azimuth: msg.azimuth, altitude: msg.altitude };
        postMessage({ type: 'frame-skipped', requestId: msg.requestId });
      } else {
        render(msg);
      }
      break;
    case 'exposure':
      exposure(msg);
      break;
    default:
      break;
  }
};
