import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearestWall, offsetLngLat, facadeLit, litIntervals } from '../../js/facade.js';

const C = { lat: 48.85, lng: 2.35 };
const at = (east, north) => ({ lng: offsetLngLat(C, [1, 0], east).lng, lat: offsetLngLat(C, [0, 1], north).lat });
/** Anneau carré de demi-côté h mètres autour de C, fermé comme en GeoJSON. */
const square = (h, reverse = false) => {
  const r = [at(-h, -h), at(h, -h), at(h, h), at(-h, h), at(-h, -h)].map((q) => [q.lng, q.lat]);
  return reverse ? r.reverse() : r;
};
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) < tol, `${what} : ${a} au lieu de ${b}`);

test('mur le plus proche : façade sud vue du jardin, façade est vue du toit, sens des anneaux indifférent', () => {
  for (const reverse of [false, true]) {
    const house = [[square(10, reverse)]];
    const south = nearestWall(at(0, -15), house);
    near(south.azimuth, 180, 0.5, 'façade sud');
    near(south.distance, 5, 0.05, 'distance au mur sud');
    near(south.foot.lat, at(0, -10).lat, 1e-7, 'pied du mur');
    assert.equal(south.inside, false, 'point devant la façade');
    const east = nearestWall(at(7, 1), house);
    near(east.azimuth, 90, 0.5, 'façade est depuis le toit');
    near(east.distance, 3, 0.05, 'distance au mur est');
    assert.equal(east.inside, true, 'point sur le toit');
    // Depuis le toit, 3 m devant le mur : hors du bâtiment.
    const out = offsetLngLat(east.foot, east.normal, 3);
    near(out.lng, at(13, 0).lng, 1e-7, 'point descendu devant la façade est');
  }
  assert.equal(nearestWall(at(0, -25), [[square(10)]]), null, 'aucun mur à moins de 12 m');
});

test('mur le plus proche : une cloison entre deux parties n\'est pas une façade ; sur un grand toit, à toute distance', () => {
  // Deux corps de bâtiment accolés le long de x = 0 ; le point est dans celui de l'ouest, à 1 m de la cloison.
  const rect = (x0, x1) => [[x0, -10], [x1, -10], [x1, 10], [x0, 10], [x0, -10]].map(([x, y]) => [at(x, y).lng, at(x, y).lat]);
  const w = nearestWall(at(-1, 0), [[rect(-10, 0)], [rect(0, 10)]]);
  near(w.azimuth, 270, 0.5, 'façade ouest, pas la cloison');
  near(w.distance, 9, 0.05, 'distance à la façade ouest');
  assert.equal(w.inside, true);
  // Au milieu d'un toit de 40 m, le mur le plus proche est à 20 m : il est trouvé quand même.
  near(nearestWall(at(0, 1), [[square(20)]]).distance, 19, 0.05, 'mur nord à 19 m du milieu du toit');
});

test('mur le plus proche dans une cour intérieure : la façade regarde la cour', () => {
  const chateau = [[square(20), square(10, true)]];
  const w = nearestWall(at(0, 6), chateau);
  near(w.distance, 4, 0.05, 'distance au mur nord de la cour');
  near(w.azimuth, 180, 0.5, 'le mur nord de la cour fait face au sud');
  assert.equal(w.inside, false, 'la cour n\'est pas dans le bâtiment');
});

test('créneaux d\'une façade : soleil levé et devant le mur', () => {
  // Un échantillon toutes les 5 min ; le soleil tourne de 1,25° par échantillon (est à 6 h, sud à midi, ouest à 18 h)
  // et le point est au soleil de 6 h à 18 h.
  const step = 5;
  const az = Array.from({ length: 288 }, (_, i) => (i * step) / 4);
  const lit = Uint8Array.from(az, (_, i) => (i * step >= 360 && i * step < 1080 ? 1 : 0));
  assert.deepEqual(litIntervals(lit, step), [[360, 1080]]);
  assert.deepEqual(litIntervals(facadeLit(lit, az, 180), step), [[365, 1080]], 'façade sud : soleil rasant exclu à 6 h pile');
  assert.deepEqual(litIntervals(facadeLit(lit, az, 90), step), [[360, 720]], 'façade est : le matin');
  assert.deepEqual(litIntervals(facadeLit(lit, az, 0), step), [], 'façade nord : jamais');
  assert.deepEqual(litIntervals(Uint8Array.from([1, 1, 0, 1]), 10), [[0, 20], [30, 40]], 'créneau ouvert jusqu\'au dernier échantillon');
});
