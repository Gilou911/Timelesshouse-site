import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHash, buildHash, isValidDateISO, isValidTime } from '../../js/state.js';

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
  const p2 = parseHash(buildHash({ ...st, buildings3d: false, terrain: true, shadows: false }));
  assert.equal(p2.buildings3d, false);
  assert.equal(p2.terrain, true);
  assert.equal(p2.shadows, false);
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
