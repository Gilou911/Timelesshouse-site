import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHash, buildHash, isValidDateISO, isValidTime, parsePlaces, addPlace } from '../../js/state.js';

test('aller-retour de l\'état dans le hash', () => {
  const st = { lat: 48.8566, lng: 2.3522, zoom: 15.5, bearing: -20, pitch: 45, date: '2026-11-09', time: '15:30', tz: 'Europe/Paris', style: 'satellite', buildings3d: true, terrain: false, shadows: true, point: { lat: 48.85, lng: 2.35 } };
  const h = buildHash(st);
  const p = parseHash(h);
  assert.equal(p.lat, 48.8566);
  assert.equal(p.lng, 2.3522);
  assert.equal(p.zoom, 15.5);
  assert.equal(p.bearing, -20);
  assert.equal(p.pitch, 45);
  assert.equal(p.date, '2026-11-09');
  assert.equal(p.time, '15:30');
  assert.equal(p.tz, 'Europe/Paris');
  assert.equal(p.style, 'satellite');
  assert.equal(p.buildings3d, undefined, 'valeur par défaut non encodée');
  assert.equal(p.terrain, undefined, 'valeur par défaut non encodée');
  assert.equal(p.shadows, undefined);
  assert.ok(!/%3A|%2C/.test(h), `hash lisible : ${h}`);
  const p2 = parseHash(buildHash({ ...st, buildings3d: false, terrain: true, shadows: false, trees: false }));
  assert.equal(p2.buildings3d, false);
  assert.equal(p2.terrain, true);
  assert.equal(p2.shadows, false);
  assert.equal(p2.trees, false, 'arbres retirés : arb=0');
  assert.equal(parseHash(buildHash({ ...st, trees: true })).trees, undefined, 'arbres par défaut non encodés');
  const p3 = parseHash(buildHash({ ...st, mode: 'exposure', opacity: 0.7 }));
  assert.equal(p3.mode, 'exposure');
  assert.equal(p3.opacity, 0.7);
  assert.equal(parseHash(buildHash({ ...st, opacity: 0.45 })).opacity, undefined, 'intensité par défaut non encodée');
  assert.equal(parseHash('#1/2/3?o=5').opacity, 0.85, 'intensité bornée');
  assert.equal(parseHash(buildHash(st)).mode, undefined);
  assert.deepEqual(p.point, { lat: 48.85, lng: 2.35 });
});

test('hash invalide ou vide', () => {
  assert.deepEqual(parseHash(''), {});
  assert.deepEqual(parseHash('#abc/def'), {});
  const p = parseHash('#48.8/2.3/12?d=pas-une-date&t=99h');
  assert.equal(p.zoom, 12);
  assert.equal(p.date, undefined);
  assert.equal(p.time, undefined);
  assert.equal(parseHash('#48.8/2.3/12?p=120,2.3').point, undefined, 'latitude du point hors bornes ignorée');
  assert.equal(parseHash('#48.8/2.3/12?p=48.8,200').point, undefined, 'longitude du point hors bornes ignorée');
});

test('cérémonie dans le lien : aller-retour, valeurs invalides ignorées', () => {
  const st = { lat: 48.85, lng: 2.35, zoom: 15, date: '2026-11-10', time: '11:00', event: { date: '2027-06-14', time: '16:00' } };
  const h = buildHash(st);
  assert.ok(/ev=2027-06-14T16:00/.test(h), `cérémonie lisible : ${h}`);
  assert.deepEqual(parseHash(h).event, { date: '2027-06-14', time: '16:00' });
  assert.equal(parseHash(buildHash({ ...st, event: null })).event, undefined);
  for (const bad of ['2027-02-30T16:00', '2027-06-14T25:00', '2027-06-14', 'n-importe-quoi', '2027-06-14T16:00:00']) {
    assert.equal(parseHash(`#48.8/2.3/12?ev=${bad}`).event, undefined, `refusée : ${bad}`);
  }
});

test('façade dans le lien : azimut entier de 0 à 359', () => {
  const h = buildHash({ lat: 48.85, lng: 2.35, zoom: 17, facade: 179.6 });
  assert.ok(/f=180/.test(h), h);
  assert.equal(parseHash(h).facade, 180);
  assert.equal(parseHash(buildHash({ lat: 48.85, lng: 2.35, zoom: 17, facade: 0 })).facade, 0, 'plein nord gardé');
  assert.equal(parseHash(buildHash({ lat: 48.85, lng: 2.35, zoom: 17, facade: 359.7 })).facade, 0, '360° ramené à 0');
  assert.equal(parseHash(buildHash({ lat: 48.85, lng: 2.35, zoom: 17, facade: null })).facade, undefined);
  for (const bad of ['360', '-5', '12.5', 'sud', '']) assert.equal(parseHash(`#48.8/2.3/12?f=${bad}`).facade, undefined, `refusé : ${bad}`);
});

test('date et heure du lien : seules les valeurs réelles sont acceptées', () => {
  for (const d of ['2026-11-09', '2024-02-29', '1900-01-01', '2100-12-31']) assert.ok(isValidDateISO(d), d);
  for (const d of ['2026-02-31', '2025-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '1899-12-31', '2101-01-01', '0002-01-01', '9999-99-99', '2026-1-9', '', null, undefined]) {
    assert.ok(!isValidDateISO(d), `refusée : ${d}`);
  }
  for (const t of ['00:00', '15:30', '23:59']) assert.ok(isValidTime(t), t);
  for (const t of ['24:00', '12:60', '99:99', '7:05', '', null, undefined]) assert.ok(!isValidTime(t), `refusée : ${t}`);

  const p = parseHash('#48.8/2.3/12?d=2026-02-31&t=99:99');
  assert.equal(p.date, undefined, 'le 31 février est ignoré');
  assert.equal(p.time, undefined, '99:99 est ignoré');
  assert.equal(p.zoom, 12, 'le reste du lien est conservé');
  const q = parseHash('#48.8/2.3/12?d=2024-02-29&t=23:59');
  assert.equal(q.date, '2024-02-29');
  assert.equal(q.time, '23:59');
});

test('carnet de lieux : lecture prudente du stockage, ajout en tête, même nom remplacé', () => {
  for (const bad of [null, '', 'pas du json', '{"name":"a"}', '42']) assert.deepEqual(parsePlaces(bad), [], `ignoré : ${bad}`);
  const stored = JSON.stringify([
    { name: 'Château de Vaux', hash: '#48.56/2.71/17?ev=2027-06-12T16:00' },
    { name: '', hash: '#1/2/3' },
    { name: 'Sans lien', hash: 'http://ailleurs' },
    null,
    { name: 'Parc', hash: '#48.8/2.3/15' },
  ]);
  assert.deepEqual(parsePlaces(stored).map((p) => p.name), ['Château de Vaux', 'Parc'], 'entrées mal formées écartées');
  let list = parsePlaces(stored);
  list = addPlace(list, { name: 'Orangerie', hash: '#1/2/3' });
  assert.deepEqual(list.map((p) => p.name), ['Orangerie', 'Château de Vaux', 'Parc'], 'le dernier enregistré en tête');
  list = addPlace(list, { name: ' château de vaux ', hash: '#9/9/9' });
  assert.deepEqual(list.map((p) => p.hash), ['#9/9/9', '#1/2/3', '#48.8/2.3/15'], 'même nom : remplacé, remonté en tête');
});

test('hauteur du point dans le lien : 1,5 m par défaut, de 0 à 500 m', () => {
  const base = { lat: 48.85, lng: 2.35, zoom: 17 };
  assert.ok(!/h=/.test(buildHash({ ...base, height: 1.5 })), 'hauteur par défaut non encodée');
  assert.equal(parseHash(buildHash({ ...base, height: 7.5 })).height, 7.5);
  assert.equal(parseHash(buildHash({ ...base, height: 120 })).height, 120, 'drone');
  assert.equal(parseHash(buildHash({ ...base, height: 0 })).height, 0, 'au ras du sol');
  for (const bad of ['-1', '501', 'haut', '']) assert.equal(parseHash(`#48.8/2.3/12?h=${bad}`).height, undefined, `refusée : ${bad}`);
});
