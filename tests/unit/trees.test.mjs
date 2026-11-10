import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMeters, heightFromGirth, treeShape, parisTrees, osmTrees, withoutDuplicates, tileOf, tileBounds, overpassQuery,
  treeFeatures, TreeStore, TREE_TILE_ZOOM,
} from '../../js/trees.js';
import { castTreeShadows, treesAround, treeBlocksSun, pointExposure, renderShadows } from '../../js/shadow-engine.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('arbres : mesures lues dans les étiquettes, hauteur d\'après la circonférence, forme par défaut', () => {
  assert.equal(parseMeters('12'), 12);
  assert.equal(parseMeters('12 m'), 12);
  assert.equal(parseMeters('12,5'), 12.5);
  assert.equal(parseMeters('120 cm'), 1.2);
  assert.ok(near(parseMeters('40 ft'), 12.192));
  assert.equal(parseMeters('grand'), 0);
  assert.equal(parseMeters(undefined), 0);
  assert.ok(near(heightFromGirth(1), 4 + 30 / Math.PI));
  assert.equal(heightFromGirth(0), 0);
  assert.equal(heightFromGirth(20), 0); // circonférence aberrante : inconnue
  assert.deepEqual(treeShape(15, 0), { h: 15, r: 4.5, hb: 4.5 });
  assert.deepEqual(treeShape(0, 0), { h: 10, r: 3, hb: 3 }); // rien de connu : un arbre de rue moyen
  assert.deepEqual(treeShape(25, 8), { h: 25, r: 4, hb: 5 });
  assert.deepEqual(treeShape(3, 0), { h: 3, r: 1, hb: 1.5 });
});

test('arbres : listes de la Ville de Paris et d\'OpenStreetMap, alignements, doublons', () => {
  const paris = parisTrees([
    { geo_point_2d: { lon: 2.3, lat: 48.86 }, hauteurenm: 14, circonferenceencm: 90 },
    { geo_point_2d: { lon: 2.301, lat: 48.86 }, hauteurenm: 0, circonferenceencm: 100 }, // hauteur non saisie
    { geo_point_2d: null, hauteurenm: 10 },
  ]);
  assert.equal(paris.length, 8);
  assert.deepEqual(paris.slice(0, 4), [2.3, 48.86, 14, 0]);
  assert.ok(near(paris[6], heightFromGirth(1)));

  const osm = osmTrees({
    elements: [
      { type: 't', geometry: { type: 'Point', coordinates: [2.30001, 48.86] }, tags: { h: '17', d: '', c: '' } },
      { type: 't', geometry: { type: 'Point', coordinates: [2.302, 48.86] }, tags: { h: '', d: '9 m', c: '1.2' } },
      { type: 'way', geometry: [{ lat: 48.861, lon: 2.3 }, null, { lat: 48.861 + 104 / 111320, lon: 2.3 }], tags: { natural: 'tree_row', height: '12' } },
      { type: 'way', geometry: [null, { lat: 48.9, lon: 2.3 }], tags: { natural: 'tree_row' } }, // un seul sommet lisible : rien
    ],
  });
  // 2 arbres, puis un alignement de 104 m : 13 intervalles de 8 m, 14 arbres, les deux bouts compris.
  assert.equal(osm.length / 4, 2 + 14);
  assert.deepEqual(osm.slice(0, 4), [2.30001, 48.86, 17, 0]);
  assert.ok(near(osm[6], heightFromGirth(1.2)) && osm[7] === 9);
  assert.ok(near(osm[9], 48.861) && near(osm[osm.length - 3], 48.861 + 104 / 111320) && osm[10] === 12);

  // L'arbre d'OpenStreetMap à 0,7 m d'un arbre de la Ville est le même ; celui à 147 m ne l'est pas.
  const kept = withoutDuplicates(osm.slice(0, 8), paris);
  assert.deepEqual(kept, osm.slice(4, 8));
});

test('arbres : tuiles et requête Overpass', () => {
  const [x, y] = tileOf(2.3522, 48.8566, TREE_TILE_ZOOM);
  const [w, s, e, n] = tileBounds(x, y, TREE_TILE_ZOOM);
  assert.ok(w <= 2.3522 && e > 2.3522 && s <= 48.8566 && n > 48.8566, JSON.stringify([w, s, e, n]));
  assert.deepEqual(tileOf(e + 1e-9, n - 1e-9, TREE_TILE_ZOOM), [x + 1, y]);
  const q = overpassQuery([2.3, 48.86, 2.31, 48.87]);
  assert.match(q, /\[bbox:48\.860000,2\.300000,48\.870000,2\.310000\]/); // sud, ouest, nord, est
  assert.match(q, /node\["natural"="tree"\]/);
  assert.match(q, /way\["natural"="tree_row"\]/);
});

test('arbres : volumes 3D, un tronc et cinq tranches de houppier par arbre', () => {
  const fc = treeFeatures([2.3, 48.86, 15, 0]);
  assert.equal(fc.features.length, 6);
  const [trunk, ...crown] = fc.features.map((f) => f.properties);
  assert.equal(trunk.k, 0);
  assert.equal(trunk.b, 0);
  assert.ok(trunk.t > 4.5 && trunk.t < 15);
  assert.deepEqual(crown.map((p) => p.k), [1, 1, 1, 1, 1]);
  assert.equal(crown[0].b, 4.5);
  assert.ok(near(crown[4].t, 15));
  for (let i = 1; i < crown.length; i++) assert.ok(near(crown[i].b, crown[i - 1].t), 'tranches jointives');
  const radius = (f) => (f.geometry.coordinates[0][0][1] - 48.86) * 111320; // premier sommet au nord
  const radii = fc.features.slice(1).map(radius);
  assert.ok(radii[2] > 4.45 && radii[2] <= 4.5, 'tranche du milieu : presque tout le rayon');
  assert.ok(radii[0] < radii[1] && radii[1] < radii[2] && radii[4] < radii[3] && radii[3] < radii[2], radii.join());
  const ring = fc.features[3].geometry.coordinates[0];
  assert.equal(ring.length, 11);
  assert.deepEqual(ring[0], ring[10]); // anneau fermé
});

test('TreeStore : Paris et OpenStreetMap chargés en une requête chacun, doublons retirés, échec signalé', async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  let failOverpass = false;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    if (String(url).startsWith('https://paris.test')) {
      return new Response(JSON.stringify([{ geo_point_2d: { lon: 2.3522, lat: 48.8566 }, hauteurenm: 12 }]), { status: 200 });
    }
    if (failOverpass) return new Response('{}', { status: 400 });
    return new Response(JSON.stringify({
      elements: [
        { type: 't', geometry: { coordinates: [2.35221, 48.8566] }, tags: { h: '12' } }, // doublon (0,7 m)
        { type: 't', geometry: { coordinates: [2.353, 48.857] }, tags: { h: '8' } },
      ],
    }), { status: 200 });
  };
  try {
    let updates = 0;
    const store = new TreeStore({ parisUrl: 'https://paris.test/arbres', overpassUrl: 'https://overpass.test/api', onUpdate: () => updates++ });
    const bounds = [2.351, 48.856, 2.354, 48.858];
    const first = store.request(bounds);
    assert.equal(first.loading, true);
    assert.equal(first.trees.length, 0);
    for (let i = 0; i < 50 && store.request(bounds).loading; i++) await new Promise((r) => setTimeout(r, 5));
    const done = store.request(bounds);
    assert.equal(done.loading, false);
    assert.equal(done.trees.length / 4, 2, JSON.stringify(done.trees));
    assert.equal(done.paris, true);
    // Seuls les arbres de l'emprise demandée sont rendus, même si leur tuile déborde.
    assert.equal(store.request([2.3525, 48.8562, 2.354, 48.858]).trees.length / 4, 1);
    assert.ok(updates >= 2);
    assert.equal(calls.filter((c) => c.url.startsWith('https://paris.test')).length, 1);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
    const paris = calls.find((c) => c.url.startsWith('https://paris.test')).url;
    assert.match(decodeURIComponent(paris), /in_bbox\(geo_point_2d,48\.\d+,2\.\d+,48\.\d+,2\.\d+\)/);

    // Hors de Paris : OpenStreetMap seulement ; une réponse refusée est un échec signalé, sans boucler.
    failOverpass = true;
    const lyon = [4.83, 45.76, 4.832, 45.761];
    store.request(lyon);
    for (let i = 0; i < 50 && store.request(lyon).loading; i++) await new Promise((r) => setTimeout(r, 5));
    const failed = store.request(lyon);
    assert.equal(failed.failed, true);
    assert.equal(failed.trees.length, 0);
    assert.equal(failed.paris, false);
    assert.equal(calls.filter((c) => c.url.startsWith('https://paris.test')).length, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// Un arbre de 15 m (houppier de 5 à 15 m, rayon 4 m) au milieu d'un sol plat, cellules de 0,5 m.
function oneTree() {
  const w = 161;
  const h = 161;
  const cm = 0.5;
  const trees = { n: 1, gx: Float32Array.of(80.5), gy: Float32Array.of(80.5), cz: Float32Array.of(10), r: Float32Array.of(4), rv: Float32Array.of(5), base: Float32Array.of(0) };
  const H = new Float32Array(w * h);
  const at = (east, north) => Math.round(80 + east / cm) + Math.round(80 - north / cm) * w; // cellule à (est, nord) m du tronc
  return { w, h, cm, trees, H, at };
}

test('arbre isolé : ombre ronde, décollée du pied quand le soleil baisse', () => {
  const { w, h, cm, trees, H, at } = oneTree();
  const depth = new Float32Array(w * h);
  // Soleil plein sud à 45° : centre de l'ombre à 10 m au nord, demi-longueur 4 / sin(38,66°) = 6,4 m.
  castTreeShadows(depth, H, w, h, trees, 180, 45, cm);
  assert.equal(depth[at(0, 0)], 0, 'pied de l\'arbre au soleil');
  assert.ok(depth[at(0, 10)] > 0 && depth[at(0, 5)] > 0 && depth[at(0, 15.5)] > 0, 'ombre de 3,6 à 16,4 m au nord');
  assert.equal(depth[at(0, 17.5)], 0);
  assert.equal(depth[at(0, 2)], 0);
  assert.equal(depth[at(4.5, 10)], 0, 'plus large que le houppier : au soleil');
  assert.ok(depth[at(3.5, 10)] > 0);
  assert.equal(depth[at(0, -3)], 0, 'rien côté soleil');
  // Soleil haut : l'ombre est sous l'arbre.
  depth.fill(0);
  castTreeShadows(depth, H, w, h, trees, 180, 80, cm);
  assert.ok(depth[at(0, 0)] > 0);
  // Soleil bas : le rayon passe sous le houppier, le pied est au soleil, l'ombre est loin.
  depth.fill(0);
  castTreeShadows(depth, H, w, h, trees, 180, 20, cm);
  assert.equal(depth[at(0, 0)], 0);
  assert.ok(depth[at(0, 10 / Math.tan((20 * Math.PI) / 180))] > 0); // centre de l'ombre à 27,5 m
  // Un toit plus haut que le houppier n'est jamais ombragé par lui.
  depth.fill(0);
  H[at(0, 10)] = 16;
  castTreeShadows(depth, H, w, h, trees, 180, 45, cm);
  assert.equal(depth[at(0, 10)], 0);
});

test('arbre isolé : la mesure d\'un point concorde avec la carte des ombres', () => {
  const { w, h, cm, trees, H, at } = oneTree();
  const depth = new Float32Array(w * h);
  const sun = { azimuth: 200, altitude: 35 };
  castTreeShadows(depth, H, w, h, trees, sun.azimuth, sun.altitude, cm);
  let checked = 0;
  for (const [e, n] of [[0, 0], [2, 12], [4, 15], [5, 12], [-3, 8], [0, 25], [6, 18]]) {
    const i = at(e, n);
    const gx = (i % w) + 0.5;
    const gy = Math.floor(i / w) + 0.5;
    const around = treesAround(trees, gx, gy, 0, cm);
    const lit = pointExposure(H, w, h, gx, gy, [sun], cm, 0, null, { trees: around })[0];
    assert.equal(lit === 0, depth[i] > 0, `point (${e}, ${n}) : mesure ${lit}, carte ${depth[i]}`);
    checked++;
  }
  assert.equal(checked, 7);
  // Sous le houppier : « sous les arbres », à l'ombre à midi d'été, au soleil quand il est bas.
  const under = treesAround(trees, 80.5, 80.5, 1.5, cm);
  assert.equal(under.under, true);
  assert.equal(treeBlocksSun(under, 180, 64), true);
  assert.equal(treeBlocksSun(under, 180, 8), false);
  // Trop loin, et soleil dans l'autre direction : rien.
  const far = treesAround(trees, 80.5, 80.5 - 30 / cm, 0, cm);
  assert.equal(treeBlocksSun(far, 0, 20), false);
});

test('arbres isolés : ajoutés par renderShadows après le balayage, jamais la nuit', () => {
  const { w, h, cm, trees, H, at } = oneTree();
  const depth = new Float32Array(w * h);
  const grid = { w, h, originX: 0.5, originY: 0.3, cellUnits: 1e-9 };
  renderShadows(H, grid, { azimuth: 180, altitude: 45 }, cm, null, depth, H, trees);
  assert.ok(depth[at(0, 10)] > 0);
  renderShadows(H, grid, { azimuth: 180, altitude: -5 }, cm, null, depth, H, trees);
  assert.ok(depth.every((v) => v >= 1e29), 'nuit partout');
});

test('arbres isolés : la bande parcourue contient toute l\'ombre (comparaison avec un calcul sur toute la grille)', () => {
  const w = 161;
  const h = 161;
  const cm = 0.5;
  const trees = {
    n: 3,
    gx: Float32Array.of(80.5, 40.2, 120.7), gy: Float32Array.of(80.5, 60.3, 110.1),
    cz: Float32Array.of(10, 6, 13), r: Float32Array.of(4, 2.5, 6), rv: Float32Array.of(5, 3, 7), base: Float32Array.of(0, 0, 1),
  };
  const H = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) H[y * w + x] = x > 100 && y < 40 ? 7 : x > 130 ? 1 : 0; // un toit, une marche
  const brute = (az, alt) => {
    const out = new Uint8Array(w * h);
    const RAD = Math.PI / 180;
    for (let t = 0; t < trees.n; t++) {
      const k = trees.r[t] / trees.rv[t];
      const s = [Math.cos(alt * RAD) * Math.sin(az * RAD), -Math.cos(alt * RAD) * Math.cos(az * RAD), Math.sin(alt * RAD) * k];
      const n = Math.hypot(...s);
      for (let i = 0; i < w * h; i++) {
        const zp = H[i];
        if (zp >= trees.cz[t] + trees.rv[t]) continue;
        const dx = ((i % w) + 0.5 - trees.gx[t]) * cm;
        const dy = (Math.floor(i / w) + 0.5 - trees.gy[t]) * cm;
        const dz = k * (trees.cz[t] - zp);
        const proj = (-dx * s[0] - dy * s[1] + dz * s[2]) / n;
        if (proj > 0 && dx * dx + dy * dy + dz * dz - proj * proj < trees.r[t] ** 2) out[i] = 1;
      }
    }
    return out;
  };
  for (const az of [0, 33, 90, 135, 200, 271, 315]) {
    for (const alt of [10, 30, 60, 85]) {
      const depth = new Float32Array(w * h);
      castTreeShadows(depth, H, w, h, trees, az, alt, cm);
      const ref = brute(az, alt);
      let missing = 0;
      let extra = 0;
      let shaded = 0;
      for (let i = 0; i < w * h; i++) {
        if (ref[i] && !(depth[i] > 0)) missing++;
        if (!ref[i] && depth[i] > 0) extra++;
        shaded += ref[i];
      }
      assert.ok(shaded > 50, `ombre attendue (${az}°, ${alt}°)`);
      assert.equal(missing + extra, 0, `azimut ${az}°, élévation ${alt}° : ${missing} cellules manquées, ${extra} en trop`);
    }
  }
});
