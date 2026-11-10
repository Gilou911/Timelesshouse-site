// Serveur de test : fichiers de l'app + style/tuiles factices + relais des tuiles de relief (cache disque).
import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { GeoJSONVT } from '@maplibre/geojson-vt';
import { fromGeojsonVt } from '@maplibre/vt-pbf';
import { encodePNG } from './png.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = join(ROOT, 'tests', 'e2e', 'out', 'dem-cache');
mkdirSync(CACHE, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.pbf': 'application/x-protobuf',
  '.txt': 'text/plain; charset=utf-8',
};

// ---- Bâtiments factices (Paris : damier d'immeubles + une tour ; Chamonix : quelques maisons) ----
function rectAround(lat, lng, dxM, dyM, wM, hM) {
  const mLat = 1 / 111320;
  const mLng = 1 / (111320 * Math.cos((lat * Math.PI) / 180));
  const cx = lng + dxM * mLng;
  const cy = lat + dyM * mLat;
  const hw = (wM / 2) * mLng;
  const hh = (hM / 2) * mLat;
  return [[[cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh], [cx - hw, cy - hh]]];
}
function buildingsGeoJSON() {
  const features = [];
  const P = { lat: 48.8566, lng: 2.3522 };
  for (let i = -6; i <= 6; i++) {
    for (let j = -6; j <= 6; j++) {
      if (i === 0 && j === 0) continue;
      features.push({
        type: 'Feature',
        properties: { render_height: 18 + ((i * 7 + j * 3) % 5) * 4, render_min_height: 0 },
        geometry: { type: 'Polygon', coordinates: rectAround(P.lat, P.lng, i * 70, j * 70, 36, 36) },
      });
    }
  }
  features.push({
    type: 'Feature',
    properties: { render_height: 150, render_min_height: 0, name: 'tour' },
    geometry: { type: 'Polygon', coordinates: rectAround(P.lat, P.lng, 0, 0, 40, 40) },
  });
  const C = { lat: 45.9237, lng: 6.8694 };
  for (let k = 0; k < 12; k++) {
    features.push({
      type: 'Feature',
      properties: { render_height: 9 },
      geometry: { type: 'Polygon', coordinates: rectAround(C.lat, C.lng, (k % 4) * 60 - 90, Math.floor(k / 4) * 60 - 60, 14, 10) },
    });
  }
  return { type: 'FeatureCollection', features };
}
const VT_OPTIONS = { maxZoom: 14, indexMaxZoom: 14, indexMaxPoints: 0, buffer: 64, extent: 4096 };
const tileIndex = new GeoJSONVT(buildingsGeoJSON(), VT_OPTIONS);
// Un bois de 200 m de côté à 600 m à l'est de la tour de Paris (hors du damier), et une pelouse de parc à côté, qui ne compte pas.
const P0 = { lat: 48.8566, lng: 2.3522 };
const landcoverIndex = new GeoJSONVT({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { class: 'wood', subclass: 'forest' }, geometry: { type: 'Polygon', coordinates: rectAround(P0.lat, P0.lng, 700, 0, 200, 200) } },
    { type: 'Feature', properties: { class: 'grass', subclass: 'park' }, geometry: { type: 'Polygon', coordinates: rectAround(P0.lat, P0.lng, 700, -250, 200, 200) } },
  ],
}, VT_OPTIONS);

// ---- Arbres isolés factices, entre le damier et le bois (520 à 560 m à l'est de la tour) ----
// Ville de Paris : 5 arbres de 15 m alignés nord-sud. OpenStreetMap : un doublon (à 0,5 m du premier), deux arbres à
// lui, et un alignement de 104 m tracé comme une ligne (natural=tree_row).
const at = (dxM, dyM) => [P0.lng + dxM / (111320 * Math.cos((P0.lat * Math.PI) / 180)), P0.lat + dyM / 111320];
const PARIS_TREES = [-100, -50, 0, 50, 100].map((dy) => at(520, dy));
const OSM_TREES = [[at(520.5, -100), '15'], [at(560, 0), '10'], [at(560, 40), '']];
const OSM_ROW = [at(520, 110), at(520, 214)]; // 104 m : 13 intervalles de 8 m, 14 arbres, dans la grille à z17
const inBox = ([lng, lat], [s, w, n, e]) => lat >= s && lat <= n && lng >= w && lng <= e;
function parisTreesResponse(where) {
  const m = /in_bbox\(geo_point_2d,([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/.exec(where || '');
  const box = m ? m.slice(1).map(Number) : [-90, -180, 90, 180];
  return PARIS_TREES.filter((p) => inBox(p, box)).map(([lon, lat]) => ({ geo_point_2d: { lon, lat }, hauteurenm: 15, circonferenceencm: 120 }));
}
function overpassResponse(query) {
  const m = /\[bbox:([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\]/.exec(query || '');
  const box = m ? m.slice(1).map(Number) : [-90, -180, 90, 180];
  const elements = OSM_TREES.filter(([p]) => inBox(p, box)).map(([p, h], id) => ({ type: 't', id, geometry: { type: 'Point', coordinates: p }, tags: { h, d: '', c: '' } }));
  if (OSM_ROW.some((p) => inBox(p, box))) {
    elements.push({ type: 'way', id: 1, geometry: OSM_ROW.map(([lon, lat]) => ({ lat, lon })), tags: { natural: 'tree_row', height: '12' } });
  }
  return { version: 0.6, elements };
}

// ---- Tuile raster factice : fond clair avec grille ----
const rasterTile = (() => {
  const w = 256;
  const rgba = new Uint8Array(w * w * 4);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const grid = x % 64 === 0 || y % 64 === 0;
      const i = (y * w + x) * 4;
      rgba[i] = grid ? 200 : 236;
      rgba[i + 1] = grid ? 205 : 238;
      rgba[i + 2] = grid ? 215 : 232;
      rgba[i + 3] = 255;
    }
  }
  return encodePNG(w, w, rgba);
})();

function mockStyle(base) {
  return {
    version: 8,
    name: 'mock',
    sources: {
      mockraster: { type: 'raster', tiles: [`${base}/mock/raster/{z}/{x}/{y}.png`], tileSize: 256, maxzoom: 18, attribution: 'Tuiles de test' },
      openmaptiles: { type: 'vector', tiles: [`${base}/mock/vec/{z}/{x}/{y}.pbf`], minzoom: 13, maxzoom: 14 },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#e9ebe6' } },
      { id: 'raster', type: 'raster', source: 'mockraster' },
      { id: 'building', type: 'fill', source: 'openmaptiles', 'source-layer': 'building', minzoom: 13, paint: { 'fill-color': '#d9cfc0', 'fill-outline-color': '#b8ad9c' } },
    ],
  };
}

// Styles OpenFreeMap réels (fixtures téléchargées depuis hyperknot/openfreemap-styles), rebranchés sur les tuiles factices.
const FIXTURES = join(ROOT, 'tests', 'e2e', 'fixtures');
function realStyle(name, base) {
  const file = join(FIXTURES, `ofm-${name}.json`);
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8').replace(/https:\/\/__TILEJSON_DOMAIN__/g, `${base}/mock/ofm`);
}
const onePixelPNG = encodePNG(1, 1, new Uint8Array([0, 0, 0, 0]));

function demTile(z, x, y) {
  const file = join(CACHE, `${z}-${x}-${y}.png`);
  if (existsSync(file)) return readFileSync(file);
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  try {
    const buf = execFileSync('curl', ['-sS', '-m', '30', '--fail', url], { maxBuffer: 10 * 1024 * 1024 });
    writeFileSync(file, buf);
    return buf;
  } catch {
    return null;
  }
}

export function startServer(port = 0, { injectConfig = false } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const base = `http://localhost:${server.address().port}`;
    res.setHeader('Access-Control-Allow-Origin', '*');
    let m;
    if (injectConfig && (url.pathname === '/' || url.pathname === '/index.html')) {
      // Mode « npm run serve » : la page pointe vers le style factice et le relais de relief local.
      const cfg = {
        demUrl: `${base}/dem/{z}/{x}/{y}.png`, planStyle: `${base}/mock/ofm/bright.json`, satelliteStyle: `${base}/mock/style.json`, openFreeMap: `${base}/mock/ofm`,
        parisTreesUrl: `${base}/mock/paris-trees`, overpassUrl: `${base}/mock/overpass`,
      };
      const html = readFileSync(join(ROOT, 'index.html'), 'utf8').replace('<script src="vendor/maplibre-gl.js', `<script>window.OMBRES_CONFIG = ${JSON.stringify(cfg)};</script>\n  <script src="vendor/maplibre-gl.js`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (url.pathname === '/mock/paris-trees') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(parisTreesResponse(url.searchParams.get('where'))));
    }
    if (url.pathname === '/mock/overpass') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const data = new URLSearchParams(body).get('data');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(overpassResponse(data)));
      });
      return undefined;
    }
    if (url.pathname === '/mock/style.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(mockStyle(base)));
    }
    if ((m = url.pathname.match(/^\/mock\/ofm\/(bright|liberty|positron)\.json$/))) {
      const body = realStyle(m[1], base);
      if (!body) {
        res.writeHead(404);
        return res.end('fixture manquante');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(body);
    }
    if (url.pathname === '/mock/ofm/planet') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        tilejson: '3.0.0', name: 'mock planet', tiles: [`${base}/mock/vec/{z}/{x}/{y}.pbf`], minzoom: 0, maxzoom: 14,
        vector_layers: [{ id: 'building', fields: { render_height: 'Number', render_min_height: 'Number' } }, { id: 'landcover', fields: { class: 'String', subclass: 'String' } }],
        attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> (test)',
      }));
    }
    if (/^\/mock\/ofm\/natural_earth\//.test(url.pathname)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(rasterTile);
    }
    if (/^\/mock\/ofm\/sprites\/.*\.json$/.test(url.pathname)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{}');
    }
    if (/^\/mock\/ofm\/sprites\/.*\.png$/.test(url.pathname)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(onePixelPNG);
    }
    if (/^\/mock\/ofm\/fonts\//.test(url.pathname)) {
      res.writeHead(200, { 'Content-Type': 'application/x-protobuf' });
      return res.end(Buffer.alloc(0));
    }
    if ((m = url.pathname.match(/^\/mock\/raster\/(\d+)\/(\d+)\/(\d+)\.png$/))) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(rasterTile);
    }
    if ((m = url.pathname.match(/^\/mock\/vec\/(\d+)\/(\d+)\/(\d+)\.pbf$/))) {
      const layers = {};
      const tile = tileIndex.getTile(+m[1], +m[2], +m[3]);
      const cover = landcoverIndex.getTile(+m[1], +m[2], +m[3]);
      if (tile) layers.building = tile;
      if (cover) layers.landcover = cover;
      if (!tile && !cover) {
        res.writeHead(204);
        return res.end();
      }
      const buf = fromGeojsonVt(layers, { version: 2 });
      res.writeHead(200, { 'Content-Type': 'application/x-protobuf' });
      return res.end(Buffer.from(buf));
    }
    if ((m = url.pathname.match(/^\/dem\/(\d+)\/(\d+)\/(\d+)\.png$/))) {
      const buf = demTile(+m[1], +m[2], +m[3]);
      if (!buf) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      return res.end(buf);
    }
    // Fichiers statiques
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port, close: () => server.close(), server }));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startServer(Number(process.env.PORT) || 8787, { injectConfig: true });
  console.log(`Ombres : http://localhost:${port}/  (fond de carte factice, vrai relief via le relais local)`);
}
