import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHash, buildHash } from '../../js/state.js';

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
  const p3 = parseHash(buildHash({ ...st, mode: 'exposure' }));
  assert.equal(p3.mode, 'exposure');
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
});
