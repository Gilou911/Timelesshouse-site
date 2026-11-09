import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sweepShadows, rasterizeBuildings, decodeTerrarium, DemMosaic, fillTerrain, depthToRGBA, pointExposure,
  lngLatToMercator, mercatorToLngLat, metersPerUnit, rowScaleFactors, accumulateExposure, exposureToRGBA, exposureColor, applyNightMask, renderShadows, NIGHT,
} from '../../js/shadow-engine.js';
import { sunPosition } from '../../js/sun.js';

function grid(w, h) {
  return { w, h, H: new Float32Array(w * h), depth: new Float32Array(w * h) };
}

test('tour isolée, soleil au sud à 45° : ombre vers le nord, longueur = hauteur', () => {
  const { w, h, H, depth } = grid(41, 41);
  H[20 * w + 20] = 10; // tour de 10 m sur une cellule, cellules de 1 m
  sweepShadows(H, w, h, 180, 45, 1, depth);
  // Ombre vers le nord (y décroissant) sur ~10 cellules.
  let shaded = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (depth[y * w + x] > 0) shaded++;
  assert.ok(shaded >= 9 && shaded <= 11, `cellules ombragées ${shaded}`);
  assert.ok(depth[19 * w + 20] > 0, 'cellule juste au nord ombragée');
  assert.ok(depth[10 * w + 20] > 0, 'cellule à 10 m au nord ombragée');
  assert.equal(depth[9 * w + 20], 0, 'au-delà de 10 m : éclairé');
  assert.equal(depth[21 * w + 20], 0, 'au sud de la tour : éclairé');
  assert.equal(depth[20 * w + 20], 0, 'le toit est éclairé');
});

test('soleil à l\'est : ombre vers l\'ouest ; soleil au nord-ouest : ombre vers le sud-est', () => {
  const { w, h, H, depth } = grid(41, 41);
  H[20 * w + 20] = 5;
  sweepShadows(H, w, h, 90, 45, 1, depth);
  assert.ok(depth[20 * w + 17] > 0, 'ouest ombragé');
  assert.equal(depth[20 * w + 23], 0, 'est éclairé');
  sweepShadows(H, w, h, 315, 30, 1, depth);
  assert.ok(depth[22 * w + 22] > 0, 'sud-est ombragé');
  assert.equal(depth[18 * w + 18], 0, 'nord-ouest éclairé');
});

test('soleil couché : tout est NIGHT ; soleil au zénith : rien', () => {
  const { w, h, H, depth } = grid(8, 8);
  H[27] = 50;
  sweepShadows(H, w, h, 100, -2, 1, depth);
  assert.ok(depth.every((d) => d === NIGHT));
  sweepShadows(H, w, h, 100, 89.9, 1, depth);
  assert.ok(depth.every((d) => d === 0));
});

test('pente face au nord sous soleil bas au sud : ombrée ; le sommet reste éclairé', () => {
  const w = 60;
  const h = 60;
  const H = new Float32Array(w * h);
  // Crête est-ouest : hauteur maximale à y = 30, versant nord raide (10 m/cellule), versant sud doux.
  for (let y = 0; y < h; y++) {
    const z = y <= 30 ? 300 - (30 - y) * 10 : 300 - (y - 30) * 2;
    for (let x = 0; x < w; x++) H[y * w + x] = Math.max(0, z);
  }
  const depth = new Float32Array(w * h);
  sweepShadows(H, w, h, 180, 20, 1, depth); // soleil au sud, 20° : tan = 0,36 < pente nord (10)
  assert.equal(depth[30 * w + 30], 0, 'crête éclairée');
  assert.ok(depth[29 * w + 30] > 0, 'versant nord à l\'ombre');
  assert.equal(depth[40 * w + 30], 0, 'versant sud éclairé');
});

test('rasterisation d\'un bâtiment rectangulaire avec trou, toit suivant le relief', () => {
  const w = 20;
  const h = 20;
  const gridSpec = { w, h, originX: 0, originY: 0, cellUnits: 1 };
  const T = new Float32Array(w * h);
  for (let i = 0; i < T.length; i++) T[i] = 100 + (i % w); // relief croissant vers l'est
  const H = new Float32Array(T);
  // Carré extérieur [4,12]x[4,12], trou [7,9]x[7,9]
  const coords = new Float64Array([
    4, 4, 12, 4, 12, 12, 4, 12, // extérieur
    7, 7, 7, 9, 9, 9, 9, 7, // trou
  ]);
  const ringStart = new Int32Array([0, 4, 8]);
  const polyStart = new Int32Array([0, 2]);
  const heights = new Float32Array([25]);
  const touched = rasterizeBuildings(H, T, gridSpec, { coords, ringStart, polyStart, heights });
  assert.equal(touched, 1);
  // Toit = relief de la cellule + 25 m (le relief croît de 1 m par colonne).
  assert.equal(H[5 * w + 5], 100 + 5 + 25);
  assert.equal(H[11 * w + 11], 100 + 11 + 25);
  assert.equal(H[8 * w + 8], T[8 * w + 8], 'le trou garde le relief');
  assert.equal(H[3 * w + 3], T[3 * w + 3], 'hors bâtiment inchangé');
  assert.equal(H[12 * w + 12], T[12 * w + 12], 'bord exclusif');
  // Deux morceaux d'un même bâtiment (découpe de tuile) donnent des toits continus au raccord.
  const H2 = new Float32Array(T);
  rasterizeBuildings(H2, T, gridSpec, {
    coords: new Float64Array([4, 4, 8, 4, 8, 12, 4, 12, 8, 4, 12, 4, 12, 12, 8, 12]),
    ringStart: new Int32Array([0, 4, 8]),
    polyStart: new Int32Array([0, 1, 2]),
    heights: new Float32Array([25, 25]),
  });
  assert.equal(H2[6 * w + 7] + 1, H2[6 * w + 8], 'pas de marche au raccord des morceaux');
});

test('bâtiment plus petit qu\'une cellule : la cellule du centroïde est marquée', () => {
  const gridSpec = { w: 5, h: 5, originX: 0, originY: 0, cellUnits: 1 };
  const T = new Float32Array(25);
  const H = new Float32Array(25);
  const coords = new Float64Array([2.1, 2.1, 2.3, 2.1, 2.3, 2.3, 2.1, 2.3]);
  const touched = rasterizeBuildings(H, T, gridSpec, {
    coords, ringStart: new Int32Array([0, 4]), polyStart: new Int32Array([0, 1]), heights: new Float32Array([7]),
  });
  assert.equal(touched, 1);
  assert.equal(H[2 * 5 + 2], 7);
});

test('décodage Terrarium et mosaïque bilinéaire', () => {
  // Pixel : R=128, G=0, B=0 → 128*256 - 32768 = 0 m ; R=129,G=1,B=128 → 256 + 1 + 0,5 = 257,5 m
  const rgba = new Uint8ClampedArray([128, 0, 0, 255, 129, 1, 128, 255, 0, 0, 0, 255, 130, 0, 0, 255]);
  const hts = decodeTerrarium(rgba);
  assert.deepEqual(Array.from(hts), [0, 257.5, 0, 512]);
  const m = new DemMosaic(10, 20, 2, 1, 2);
  m.setTile(10, 20, new Float32Array([0, 10, 0, 10]));
  m.setTile(11, 20, new Float32Array([20, 30, 20, 30]));
  assert.equal(m.filled, 2);
  assert.equal(m.sample(0.5, 0.5), 0);
  assert.equal(m.sample(1.5, 0.5), 10);
  assert.equal(m.sample(2.5, 0.5), 20);
  assert.equal(m.sample(2.0, 0.5), 15, 'interpolation entre deux tuiles');
  assert.equal(m.sample(-5, 0.5), 0, 'bord prolongé');
  assert.equal(m.sample(99, 0.5), 30, 'bord prolongé');
});

test('fillTerrain échantillonne la mosaïque au bon zoom', () => {
  // Zoom 0, tuile 2 px : le monde fait 2 px. Grille de 2x2 cellules couvrant le monde.
  const m = new DemMosaic(0, 0, 1, 1, 2);
  m.setTile(0, 0, new Float32Array([1, 2, 3, 4]));
  const T = new Float32Array(4);
  fillTerrain(T, { w: 2, h: 2, originX: 0, originY: 0, cellUnits: 0.5 }, m, 0);
  assert.deepEqual(Array.from(T), [1, 2, 3, 4]);
});

test('depthToRGBA : couleurs ombre / nuit / transparent', () => {
  const depth = new Float32Array([0, 3, NIGHT]);
  const rgba = depthToRGBA(depth, 3, 1, null, { shadow: [10, 20, 30, 120], night: [1, 2, 3, 200], soft: false });
  assert.deepEqual(Array.from(rgba), [0, 0, 0, 0, 10, 20, 30, 120, 1, 2, 3, 200]);
});

test('pointExposure : point au nord d\'un mur est à l\'ombre quand le soleil est bas au sud', () => {
  const w = 30;
  const h = 30;
  const H = new Float32Array(w * h);
  for (let x = 0; x < w; x++) H[15 * w + x] = 20; // mur est-ouest de 20 m à y = 15
  const samples = [
    { azimuth: 180, altitude: 30 }, // sud, bas → ombre jusqu'à 34 m au nord
    { azimuth: 180, altitude: 80 }, // sud, haut → ombre courte (3,5 m)
    { azimuth: 0, altitude: 30 }, // nord → le point est côté soleil
    { azimuth: 90, altitude: -1 }, // nuit
  ];
  const lit = pointExposure(H, w, h, 15.5, 5.5, samples, 1); // 10 m au nord du mur
  assert.deepEqual(Array.from(lit), [0, 1, 1, 0]);
});

test('conversions Mercator', () => {
  const [x, y] = lngLatToMercator(2.3522, 48.8566);
  assert.ok(Math.abs(x - 0.50653) < 1e-4 && Math.abs(y - 0.34403) < 1e-4, `${x},${y}`);
  const [lng, lat] = mercatorToLngLat(x, y);
  assert.ok(Math.abs(lng - 2.3522) < 1e-9 && Math.abs(lat - 48.8566) < 1e-9);
  assert.ok(Math.abs(metersPerUnit(0) - 40075016.7) < 1);
  assert.ok(Math.abs(metersPerUnit(60) - 40075016.7 / 2) < 1);
});

test('performance : balayage 1024x1024 en moins de 400 ms', () => {
  const w = 1024;
  const h = 1024;
  const H = new Float32Array(w * h);
  for (let i = 0; i < H.length; i++) H[i] = 50 * Math.sin(i / 97) + 30 * Math.cos(i / 1013);
  const depth = new Float32Array(w * h);
  const t0 = performance.now();
  sweepShadows(H, w, h, 215, 25, 2, depth);
  const dt = performance.now() - t0;
  assert.ok(dt < 400, `balayage en ${dt.toFixed(0)} ms`);
});

test('rowScale : une cellule « plus petite » en mètres allonge l\'ombre en cellules', () => {
  const { w, h, H, depth } = grid(41, 61);
  H[10 * w + 20] = 10; // tour au nord (lignes 0-30 : échelle 1)
  H[50 * w + 20] = 10; // tour au sud (lignes 31-60 : échelle 0,5 → chaque cellule vaut 0,5 m)
  const rowScale = new Float32Array(h).fill(1);
  for (let y = 31; y < h; y++) rowScale[y] = 0.5;
  sweepShadows(H, w, h, 90, 45, 1, depth, rowScale); // soleil à l'est : ombre vers l'ouest
  const len = (row) => {
    let n = 0;
    for (let x = 0; x < 20; x++) if (depth[row * w + x] > 0) n++;
    return n;
  };
  assert.ok(Math.abs(len(10) - 10) <= 1, `ombre nord ${len(10)} cellules`);
  assert.ok(Math.abs(len(50) - 20) <= 1, `ombre sud ${len(50)} cellules`);
});

test('rowScaleFactors : 1 à la latitude de référence, plus petit vers le pôle, plus grand vers l\'équateur', () => {
  const [, yN] = lngLatToMercator(0, 60);
  const [, yS] = lngLatToMercator(0, 45);
  const gridSpec = { w: 1, h: 3, originY: yN, cellUnits: (yS - yN) / 3 };
  const latMid = mercatorToLngLat(0, yN + 1.5 * gridSpec.cellUnits)[1];
  const f = rowScaleFactors(gridSpec, latMid);
  assert.ok(Math.abs(f[1] - 1) < 1e-6, `ligne centrale ${f[1]}`);
  assert.ok(f[0] < 1 && f[2] > 1, `${f[0]} ${f[2]}`);
});

test('accumulateExposure : le nord d\'un mur reçoit moins de soleil que le sud', () => {
  const w = 30;
  const h = 30;
  const H = new Float32Array(w * h);
  for (let x = 0; x < w; x++) H[15 * w + x] = 20;
  const samples = [];
  for (let az = 90; az <= 270; az += 10) samples.push({ azimuth: az, altitude: 30 }); // course grossière (hémisphère nord)
  samples.push({ azimuth: 0, altitude: -5 }); // nuit : ignoré
  const depth = new Float32Array(w * h);
  const acc = new Float32Array(w * h);
  let calls = 0;
  accumulateExposure(H, w, h, samples, 10, 1, null, depth, acc, () => calls++);
  assert.equal(calls, samples.length);
  const north = acc[5 * w + 15];
  const south = acc[25 * w + 15];
  assert.ok(south > north, `sud ${south} > nord ${north}`);
  assert.equal(south, 190, 'côté sud : toutes les positions de jour comptent (19 × 10 min)');
  const rgba = exposureToRGBA(acc, w, h, null, 190, 200);
  assert.equal(rgba[(25 * w + 15) * 4 + 3], 200);
  const cSouth = exposureColor(1);
  assert.deepEqual([rgba[(25 * w + 15) * 4], rgba[(25 * w + 15) * 4 + 1], rgba[(25 * w + 15) * 4 + 2]], cSouth);
});

test('applyNightMask : à 12:00 UTC le méridien de Greenwich est de jour, l\'antiméridien de nuit', () => {
  // Grille couvrant le monde (latitudes ±60°), 36 x 12 cellules.
  const [, yTop] = lngLatToMercator(0, 60);
  const [, yBottom] = lngLatToMercator(0, -60);
  const w = 36;
  const h = 12;
  const grid = { w, h, originX: 0, originY: yTop, cellUnits: 1 / w };
  assert.ok(Math.abs((yBottom - yTop) / h - 1 / w) < 0.01, 'cellules à peu près carrées');
  const depth = new Float32Array(w * h);
  // Équinoxe : déclinaison ≈ 0, équation du temps ≈ −7 min ; centre (lng 0) de jour.
  applyNightMask(depth, grid, { declination: 0, eqTime: -7, minutesUTC: 720 }, true);
  const at = (lng, lat) => {
    const [mx, my] = lngLatToMercator(lng, lat);
    return depth[Math.floor((my - yTop) / grid.cellUnits) * w + Math.floor(mx / grid.cellUnits)];
  };
  assert.equal(at(0, 45), 0, 'Europe de jour');
  assert.equal(at(-75, 40), 0, 'New York de jour (matin)');
  assert.equal(at(180, 0), NIGHT, 'antiméridien de nuit');
  assert.equal(at(140, -30), NIGHT, 'Australie de nuit');
  // Centre de nuit (soleil couché au centre) : les cellules de jour sont rétablies à 0.
  depth.fill(NIGHT);
  applyNightMask(depth, grid, { declination: 0, eqTime: -7, minutesUTC: 0 }, false);
  assert.equal(at(180, 0), 0, 'antiméridien de jour à minuit UTC');
  assert.equal(at(0, 45), NIGHT, 'Europe de nuit à minuit UTC');
});

test('balayage : chaque cellule est visitée pour tout azimut (plateau uniforme sous une dalle surélevée)', () => {
  // Dalle de 100 m couvrant tout le bord « côté soleil » : toute cellule non couverte par une ligne resterait éclairée.
  const w = 50;
  const h = 37;
  const azimuths = [];
  for (let az = 0; az < 360; az += 7.5) azimuths.push(az);
  // Azimuts « à égalité » exacte (pas mineur = ±1/2, ±1/4, ±3/4, ±1/3 de cellule).
  for (const r of [0.5, 0.25, 0.75, 1 / 3]) {
    for (const q of [Math.atan(r), Math.PI / 2 - Math.atan(r)]) {
      for (let k = 0; k < 4; k++) azimuths.push(((q * 180) / Math.PI + 90 * k) % 360);
    }
  }
  for (const az of azimuths) {
    const H = new Float32Array(w * h);
    const depth = new Float32Array(w * h);
    // Un mur très haut tout autour du bord : toute cellule intérieure doit être à l'ombre pour un soleil bas.
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x === 0 || y === 0 || x === w - 1 || y === h - 1) H[y * w + x] = 1000;
    sweepShadows(H, w, h, az, 5, 1, depth);
    let missed = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) if (depth[y * w + x] === 0) missed++;
    assert.equal(missed, 0, `azimut ${az} : ${missed} cellules intérieures non visitées`);
  }
});

test('DemMosaic : les tuiles manquantes sont comblées à la hauteur moyenne des tuiles chargées', () => {
  const m = new DemMosaic(0, 0, 2, 2, 2);
  m.setTile(0, 0, new Float32Array([100, 100, 100, 100]));
  m.setTile(1, 1, new Float32Array([300, 300, 300, 300]));
  assert.equal(m.filled, 2);
  assert.equal(m.meanFilledHeight(), 200);
  const n = m.fillUnfilled();
  assert.equal(n, 2);
  assert.equal(m.sample(2.5, 0.5), 200, 'tuile (1,0) comblée');
  assert.equal(m.sample(0.5, 2.5), 200, 'tuile (0,1) comblée');
  assert.equal(m.sample(0.5, 0.5), 100, 'tuile chargée intacte');
});

test('coucher de soleil : le nombre de cellules éclairées décroît sans éclair (seuils cohérents balayage/masque)', () => {
  // Paris, 9 nov. 2026, coucher affiché 17:18 (16:18 UTC). Grille de 40 x 40 cellules de 10 m autour du centre.
  const lat = 48.8566;
  const lng = 2.3522;
  const w = 40;
  const h = 40;
  const [cx, cy] = lngLatToMercator(lng, lat);
  const cellUnits = 10 / metersPerUnit(lat);
  const grid = { w, h, originX: cx - 20 * cellUnits, originY: cy - 20 * cellUnits, cellUnits };
  const H = new Float32Array(w * h);
  H[20 * w + 20] = 30; // une tour
  const depth = new Float32Array(w * h);
  let prevLit = Infinity;
  let sawShadows = false;
  let sawNight = false;
  for (let m = 16 * 60; m <= 16 * 60 + 40; m++) {
    const t = new Date(Date.UTC(2026, 10, 9, Math.floor(m / 60), m % 60));
    const p = sunPosition(t, lat, lng);
    const sun = { azimuth: p.azimuth, altitude: p.altitude, altitudeGeometric: p.altitudeGeometric, declination: p.declination, eqTime: p.equationOfTime, minutesUTC: m };
    renderShadows(H, grid, sun, 10, null, depth);
    let lit = 0;
    let night = 0;
    for (let i = 0; i < depth.length; i++) {
      if (depth[i] === 0) lit++;
      else if (depth[i] === NIGHT) night++;
    }
    if (lit < w * h && night === 0) sawShadows = true;
    if (night === w * h) sawNight = true;
    assert.ok(lit <= prevLit + 1, `${m} min : ${lit} cellules éclairées après ${prevLit} (éclair)`);
    prevLit = lit;
  }
  assert.ok(sawShadows && sawNight, 'ombres longues puis nuit');
});
