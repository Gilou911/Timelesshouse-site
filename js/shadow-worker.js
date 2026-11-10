// Web Worker : télécharge le relief (tuiles Terrarium), construit le champ de hauteurs
// (relief + bâtiments) et calcule les ombres à la demande.
import {
  DemMosaic, decodeTerrarium, fillTerrain, rasterizeBuildings, depthToRGBA, pointExposure, rowScaleFactors,
  exposureToRGBA, renderShadows, sunIsUp, surfaceAt, horizonProfile, mercatorToLngLat, metersPerUnit,
} from './shadow-engine.js';
import { canDecodePNG, decodePNG, pngSize } from './png.js';

// Décodage des tuiles PNG dans le worker. Le décodeur maison (png.js) passe en premier : il rend les octets
// exacts du fichier. Le canvas ne sert que de repli, et seulement s'il relit fidèlement ce qu'on y dessine.
let canvasDistorted = null; // null : pas encore testé
const CAN_CANVAS = typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined';
const CAN_DECODE = canDecodePNG || (CAN_CANVAS && !canvasIsDistorted());
let spareBuffer = null; // tampon RGBA recyclé par la page (évite une allocation de plusieurs Mo par image)

const TILE_SIZE = 256;
const MAX_CACHE = 240; // ~60 Mo de hauteurs décodées au maximum
const CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 15000;
// Horizon lointain d'un point mesuré : relief lu jusqu'à 20 km (au-delà, la courbure de la Terre efface presque tout),
// sur des tuiles de zoom 11 (environ 55 m par pixel à 45° de latitude), au plus 36 tuiles, attendues 8 s au plus.
const HORIZON_RADIUS = 20000;
const HORIZON_ZOOM = 11;
const HORIZON_MAX_TILES = 36;
const HORIZON_WAIT_MS = 8000;

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

/**
 * Les protections anti-empreinte (Brave, Firefox avec resistFingerprinting) bruitent la relecture d'un canvas.
 * Un écart de 1 sur le canal rouge vaut 256 m : mieux vaut pas de relief qu'un relief faux.
 */
function canvasIsDistorted() {
  if (canvasDistorted !== null) return canvasDistorted;
  canvasDistorted = false;
  try {
    const size = 5;
    const ctx = new OffscreenCanvas(size, size).getContext('2d', { willReadFrequently: true });
    for (let i = 0; i < size * size; i++) {
      const b = i * 4;
      ctx.fillStyle = `rgb(${b},${b + 1},${b + 2})`;
      ctx.fillRect(i % size, Math.floor(i / size), 1, 1);
    }
    const data = ctx.getImageData(0, 0, size, size).data;
    for (let i = 0; i < data.length; i++) {
      if (i % 4 !== 3 && data[i] !== i) {
        canvasDistorted = true;
        break;
      }
    }
  } catch {
    canvasDistorted = true;
  }
  return canvasDistorted;
}

async function decodeWithCanvas(blob) {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const { width, height } = bmp;
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return { width, height, rgba: ctx.getImageData(0, 0, width, height).data };
}

async function decodeBlob(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Taille lue dans l'en-tête avant tout décodage : une tuile qui ne fait pas TILE_SIZE est refusée sans être
  // décompressée, ni ici ni par le canvas (une image géante épuiserait la mémoire du worker). Terrarium est un
  // format PNG : une image d'un autre format, dont on ne peut pas lire la taille d'avance, est refusée aussi.
  const size = pngSize(bytes);
  if (!size) throw new Error('Tuile de relief illisible : pas un PNG');
  if (size.width !== TILE_SIZE || size.height !== TILE_SIZE) throw new Error('Taille de tuile inattendue');
  let img = null;
  if (canDecodePNG) {
    try {
      img = await decodePNG(bytes);
    } catch {
      // PNG hors du décodeur maison (16 bits, entrelacé) : repli sur le canvas, à la taille déjà vérifiée
    }
  }
  if (!img) {
    if (!CAN_CANVAS || canvasIsDistorted()) throw new Error('Tuile de relief illisible');
    img = await decodeWithCanvas(blob);
  }
  // La mosaïque suppose des tuiles carrées de TILE_SIZE pixels : une autre taille serait lue de travers.
  if (img.width !== TILE_SIZE || img.height !== TILE_SIZE) throw new Error('Taille de tuile inattendue');
  return decodeTerrarium(img.rgba);
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
    // Deux tentatives, chacune bornée dans le temps : une requête qui ne répond jamais ne doit pas bloquer le calcul.
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      let blob = null;
      try {
        const res = await fetch(url, { mode: 'cors', credentials: 'omit', signal: ctrl.signal });
        if (res.status === 404) return null; // tuile inexistante : inutile d'insister
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        blob = await res.blob();
      } catch {
        // erreur réseau ou délai dépassé : on réessaie une fois
      } finally {
        clearTimeout(timer);
      }
      if (blob) {
        try {
          return await decodeBlob(blob);
        } catch {
          return null; // image invalide : inutile de retélécharger
        }
      }
    }
    return null;
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
  const { id, grid, demZoom, buildings, trees, cellMeters, latCenter, useTerrain, useBuildings } = msg;
  const { w, h } = grid;
  const T = new Float32Array(w * h);
  let tilesLoaded = 0;
  let tilesMissing = 0;
  const terrainUnsupported = useTerrain && !CAN_DECODE;

  if (useTerrain && CAN_DECODE) {
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
    mosaic.smoothSeams(); // sinon, une fausse ligne d'ombre au raccord de deux tuiles, sur les pentes
    if (tilesMissing > 0) mosaic.fillUnfilled(); // comblées à la hauteur moyenne des tuiles chargées
    fillTerrain(T, grid, mosaic, demZoom);
  }

  const H = new Float32Array(T);
  let touched = 0;
  if (useBuildings && buildings && buildings.polyStart.length > 1) {
    touched = rasterizeBuildings(H, T, grid, buildings);
  }
  // Les bois vont dans H, jamais dans T : le balayage lit le relief seul au point exact du rayon (sinon, des stries).
  let canopy = null;
  let canopyCells = 0;
  if (trees && trees.polyStart.length > 1) {
    canopy = new Uint8Array(w * h);
    rasterizeBuildings(H, T, grid, trees, canopy);
    for (let i = 0; i < canopy.length; i++) canopyCells += canopy[i];
    if (!canopyCells) canopy = null;
  }
  let minH = Infinity;
  let maxH = -Infinity;
  for (let i = 0; i < H.length; i++) {
    const v = H[i];
    if (v < minH) minH = v;
    if (v > maxH) maxH = v;
  }
  const rowScale = Number.isFinite(latCenter) ? rowScaleFactors(grid, latCenter) : null;
  current = {
    id, grid, H, T, canopy, depth: new Float32Array(w * h), depthValid: false, acc: null, accMaxMinutes: 0, cellMeters, rowScale,
    demZoom: tilesLoaded > 0 ? demZoom : null, // null : pas de relief, donc pas d'horizon lointain non plus
  };
  postMessage({
    type: 'heightfield-ready',
    id,
    stats: { tilesLoaded, tilesMissing, buildings: touched, wooded: canopyCells / (w * h), minH, maxH, w, h, terrainUnsupported },
  });
  if (mode === 'exposure') {
    // La demande la plus récente l'emporte (une date changée pendant le téléchargement du relief, par exemple).
    const ex = newestExposure(msg.exposure, lastExposure);
    if (ex) exposureMap({ ...ex });
  } else if (lastSun) {
    render({ id, ...lastSun });
  }
}

function newestExposure(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (b.seq || 0) > (a.seq || 0) ? b : a;
}

function takeBuffer(n) {
  if (spareBuffer && spareBuffer.byteLength === n) {
    const out = new Uint8ClampedArray(spareBuffer);
    spareBuffer = null;
    return out;
  }
  return null;
}

/** Recolore la dernière image sans recalcul (changement d'opacité). */
function recolor() {
  if (!current) return;
  const { grid } = current;
  const { w, h } = grid;
  if (mode === 'exposure' && current.acc) {
    const rgba = exposureToRGBA(current.acc, w, h, takeBuffer(w * h * 4), current.accMaxMinutes, style.exposureAlpha || 165);
    postMessage({ type: 'frame', id: current.id, w, h, buffer: rgba.buffer, ms: 0, kind: 'exposure', maxMinutes: current.accMaxMinutes, maxAcc: current.accMax }, [rgba.buffer]);
  } else if (mode === 'shadows' && current.depthValid) {
    const rgba = depthToRGBA(current.depth, w, h, takeBuffer(w * h * 4), style);
    postMessage({ type: 'frame', id: current.id, w, h, buffer: rgba.buffer, ms: 0 }, [rgba.buffer]);
  } else if (mode === 'exposure' && lastExposure) {
    exposureMap({ ...lastExposure });
  } else if (lastSun) {
    render({ ...lastSun });
  }
}

/** Carte des heures de soleil : un balayage par échantillon, avec cession du fil entre deux pour rester réactif. */
async function exposureMap(msg) {
  // On ne garde que la demande la plus récente (numéro de séquence croissant côté page).
  if (lastExposure && (lastExposure.seq || 0) > (msg.seq || 0)) msg = { ...lastExposure, requestId: msg.requestId };
  lastExposure = { samples: msg.samples, stepMinutes: msg.stepMinutes, maxMinutes: msg.maxMinutes, seq: msg.seq || 0 };
  if (!current) {
    postMessage({ type: 'frame-skipped', requestId: msg.requestId });
    return;
  }
  const token = ++exposureToken;
  const { grid, H, T, depth, cellMeters, rowScale } = current;
  const { w, h } = grid;
  const acc = new Float32Array(w * h);
  const t0 = performance.now();
  const n = w * h;
  let k = 0;
  for (const s of msg.samples) {
    if (token !== exposureToken || current.grid !== grid || mode !== 'exposure') {
      postMessage({ type: 'frame-skipped', requestId: msg.requestId });
      return;
    }
    const perCell = Number.isFinite(s.declination) && Number.isFinite(s.minutesUTC);
    if (sunIsUp(s) || perCell) {
      renderShadows(H, grid, s, cellMeters, rowScale, depth, T);
      for (let i = 0; i < n; i++) if (depth[i] === 0) acc[i] += msg.stepMinutes;
    }
    k++;
    if (k % 6 === 0) {
      postMessage({ type: 'progress', id: current.id, loaded: k, total: msg.samples.length, kind: 'exposure' });
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  if (token !== exposureToken || current.grid !== grid || mode !== 'exposure') {
    postMessage({ type: 'frame-skipped', requestId: msg.requestId });
    return;
  }
  let maxAcc = 0;
  for (let i = 0; i < n; i++) if (acc[i] > maxAcc) maxAcc = acc[i];
  const maxMinutes = msg.maxMinutes > 0 ? msg.maxMinutes : maxAcc;
  current.acc = acc;
  current.accMax = maxAcc;
  current.accMaxMinutes = maxMinutes;
  const rgba = exposureToRGBA(acc, w, h, takeBuffer(w * h * 4), maxMinutes, style.exposureAlpha || 165);
  postMessage(
    { type: 'frame', id: current.id, requestId: msg.requestId, w, h, buffer: rgba.buffer, ms: performance.now() - t0, kind: 'exposure', maxMinutes, maxAcc },
    [rgba.buffer],
  );
}

function sunFromMsg(msg) {
  return {
    azimuth: msg.azimuth,
    altitude: msg.altitude,
    altitudeGeometric: msg.altitudeGeometric,
    declination: msg.declination,
    eqTime: msg.eqTime,
    minutesUTC: msg.minutesUTC,
  };
}

function render(msg) {
  lastSun = sunFromMsg(msg);
  if (!current) {
    // Pas encore de champ de hauteurs : on répond quand même pour libérer le verrou côté page.
    postMessage({ type: 'frame-skipped', requestId: msg.requestId });
    return;
  }
  const { grid, H, T, depth, cellMeters, rowScale } = current;
  const { w, h } = grid;
  const t0 = performance.now();
  renderShadows(H, grid, sunFromMsg(msg), cellMeters, rowScale, depth, T);
  current.depthValid = true;
  const rgba = depthToRGBA(depth, w, h, takeBuffer(w * h * 4), style);
  postMessage(
    { type: 'frame', id: current.id, requestId: msg.requestId, w, h, buffer: rgba.buffer, ms: performance.now() - t0 },
    [rgba.buffer],
  );
}

/**
 * Horizon lointain du point (gx, gy) de la grille courante, au-delà du bord de la grille et jusqu'à 20 km : la grille
 * ne couvre que la vue, or en montagne le soleil bas d'hiver est caché par des sommets à plusieurs kilomètres.
 * `eye` : hauteur de l'œil au-dessus du relief (m). Rend { profile, complete } ou null (grille assez grande, pas de relief).
 */
async function farHorizon(cur, gx, gy, eye) {
  const { grid, cellMeters, rowScale, demZoom } = cur;
  if (demZoom == null) return null;
  const cellM = cellMeters * (rowScale ? rowScale[Math.min(grid.h - 1, Math.floor(gy))] : 1);
  // Distance (m) du point au bord de la grille dans chaque direction : en deçà, la grille fine a déjà tout vu.
  const start = new Float32Array(360);
  let nearest = Infinity;
  for (let a = 0; a < 360; a++) {
    const sx = Math.sin((a * Math.PI) / 180);
    const sy = -Math.cos((a * Math.PI) / 180);
    const tx = sx > 1e-9 ? (grid.w - gx) / sx : sx < -1e-9 ? -gx / sx : Infinity;
    const ty = sy > 1e-9 ? (grid.h - gy) / sy : sy < -1e-9 ? -gy / sy : Infinity;
    start[a] = Math.min(tx, ty) * cellM;
    nearest = Math.min(nearest, start[a]);
  }
  if (nearest >= HORIZON_RADIUS) return null;

  const mx = grid.originX + gx * grid.cellUnits;
  const my = grid.originY + gy * grid.cellUnits;
  const mpu = metersPerUnit(mercatorToLngLat(mx, my)[1]);
  const r = HORIZON_RADIUS / mpu;
  let z = Math.min(HORIZON_ZOOM, demZoom);
  let tx0;
  let tx1;
  let ty0;
  let ty1;
  for (;;) {
    const n = 2 ** z;
    tx0 = Math.floor((mx - r) * n);
    tx1 = Math.floor((mx + r) * n);
    ty0 = Math.max(0, Math.floor((my - r) * n));
    ty1 = Math.min(n - 1, Math.floor((my + r) * n));
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= HORIZON_MAX_TILES || z === 0) break;
    z--; // près des pôles, les tuiles rétrécissent : un zoom de moins
  }
  const mosaic = new DemMosaic(tx0, ty0, tx1 - tx0 + 1, ty1 - ty0 + 1, TILE_SIZE);
  const tasks = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      tasks.push(async () => {
        const heights = await fetchTile(z, tx, ty);
        if (heights) mosaic.setTile(tx, ty, heights);
      });
    }
  }
  // Une tuile qui tarde ne bloque pas la mesure : on calcule avec celles qui sont là (les autres comptent pour 0 m).
  let timer;
  await Promise.race([runPool(tasks, CONCURRENCY), new Promise((r2) => { timer = setTimeout(r2, HORIZON_WAIT_MS); })]);
  clearTimeout(timer);
  const scale = TILE_SIZE * 2 ** z;
  const elevAt = (east, north) => mosaic.sample((mx + east / mpu) * scale - tx0 * TILE_SIZE, (my - north / mpu) * scale - ty0 * TILE_SIZE);
  if (!mosaic.filledKeys.has(`${Math.floor(mx * 2 ** z)}/${Math.floor(my * 2 ** z)}`)) return null; // sans la tuile du point, pas d'œil
  const px = mpu / scale; // mètres par pixel de ces tuiles
  for (let a = 0; a < 360; a++) start[a] = Math.max(start[a], 2 * px);
  return { profile: horizonProfile(elevAt, elevAt(0, 0) + eye, start, HORIZON_RADIUS, px), complete: mosaic.filled === tasks.length };
}

async function exposure(msg) {
  const cur = current;
  if (!cur) {
    postMessage({ type: 'exposure-result', requestId: msg.requestId, lit: null, reason: 'no-grid' });
    return;
  }
  const { grid, H, T, canopy, cellMeters, rowScale } = cur;
  const gx = (msg.x - grid.originX) / grid.cellUnits;
  const gy = (msg.y - grid.originY) / grid.cellUnits;
  if (gx < 0 || gy < 0 || gx >= grid.w || gy >= grid.h) {
    postMessage({ type: 'exposure-result', requestId: msg.requestId, lit: null, reason: 'outside' });
    return;
  }
  const i = Math.floor(gy) * grid.w + Math.floor(gx);
  const base = surfaceAt(H, T, canopy, i);
  const eye = msg.eyeHeight || 0;
  // La mesure du jour et celle de l'année portent sur le même point : l'horizon complet sert aux deux.
  const key = `${gx},${gy},${eye}`;
  const far = cur.far && cur.far.key === key ? cur.far.value : await farHorizon(cur, gx, gy, base - T[i] + eye);
  if (!far || far.complete) cur.far = { key, value: far };
  if (current !== cur) {
    // Champ de hauteurs remplacé pendant la lecture de l'horizon : la page redemande la mesure sur le nouveau.
    postMessage({ type: 'exposure-result', requestId: msg.requestId, lit: null, reason: 'stale' });
    return;
  }
  const lit = pointExposure(H, grid.w, grid.h, gx, gy, msg.samples, cellMeters, eye, rowScale, { base, horizon: far && far.profile });
  postMessage({
    type: 'exposure-result',
    requestId: msg.requestId,
    lit,
    elevation: T[i],
    surface: base,
    underTrees: !!(canopy && canopy[i]),
    horizon: far ? (far.complete ? 'complete' : 'partial') : 'none',
  });
}

self.onmessage = (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'config':
      if (msg.demTemplate) demTemplate = msg.demTemplate;
      if (msg.style) style = { ...style, ...msg.style };
      if (msg.mode && msg.mode !== mode) {
        mode = msg.mode;
        exposureToken++; // interrompt une carte des heures de soleil en cours
      }
      if (msg.style && current) recolor();
      break;
    case 'exposure-map':
      exposureMap(msg).catch((err) => postMessage({ type: 'error', message: String(err) }));
      break;
    case 'heightfield':
      buildHeightfield(msg).catch((err) => postMessage({ type: 'error', id: msg.id, message: String(err) }));
      break;
    case 'render':
      if (mode === 'exposure') {
        lastSun = sunFromMsg(msg);
        postMessage({ type: 'frame-skipped', requestId: msg.requestId });
      } else {
        render(msg);
      }
      break;
    case 'exposure':
      exposure(msg).catch((err) => postMessage({ type: 'exposure-result', requestId: msg.requestId, lit: null, reason: String(err) }));
      break;
    case 'recycle':
      if (msg.buffer instanceof ArrayBuffer && msg.buffer.byteLength > 0) spareBuffer = msg.buffer;
      break;
    default:
      break;
  }
};
