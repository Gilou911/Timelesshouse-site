import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yearSamples, yearTotals } from '../../js/year.js';
import { sunPosition } from '../../js/sun.js';

test('année jour par jour : 365 ou 366 jours, heure civile suivie aux changements d\'heure', () => {
  const t0 = performance.now();
  const a = yearSamples('Europe/Paris', 2026, 48.8566, 2.3522);
  const ms = performance.now() - t0;
  assert.equal(a.days, 365);
  assert.equal(a.perDay, 144);
  assert.equal(a.samples.length, 365 * 144);
  assert.equal(a.altitudes.length, 365 * 144);
  assert.ok(ms < 1000, `calcul en ${ms.toFixed(0)} ms`);
  const at = (day, hh) => a.samples[day * 144 + hh * 6];
  // 28 mars (heure d'hiver, UTC+1) puis 29 mars (passage à l'heure d'été à 2 h, UTC+2) : midi civil = 11 h puis 10 h UTC.
  assert.ok(Math.abs(at(86, 12).altitude - sunPosition(new Date('2026-03-28T11:00:00Z'), 48.8566, 2.3522).altitude) < 1e-9);
  assert.ok(Math.abs(at(87, 12).altitude - sunPosition(new Date('2026-03-29T10:00:00Z'), 48.8566, 2.3522).altitude) < 1e-9);
  // 25 octobre (retour à l'heure d'hiver à 3 h) : midi civil = 11 h UTC.
  assert.ok(Math.abs(at(297, 12).azimuth - sunPosition(new Date('2026-10-25T11:00:00Z'), 48.8566, 2.3522).azimuth) < 1e-9);
  assert.ok(Math.abs(a.altitudes[87 * 144 + 72] - at(87, 12).altitude) < 1e-4, 'altitudes rangées comme les échantillons');
  assert.ok(at(0, 0).altitude < 0 && at(172, 14).altitude > 60, 'nuit en janvier à minuit, soleil haut vers 14 h (midi solaire) au solstice');
  assert.equal(yearSamples('UTC', 2028, 0, 0, 60).days, 366, 'année bissextile');
});

test('totaux par mois et sur l\'année', () => {
  const perDay = 144;
  const lit = new Uint8Array(365 * perDay);
  for (let i = 0; i < 31 * perDay; i += 2) lit[i] = 1; // janvier : un échantillon sur deux
  lit[364 * perDay + 70] = 1; // une seule tranche de 10 min le 31 décembre
  const { months, total } = yearTotals(lit, 2026, perDay, 10);
  assert.equal(months[0], 31 * 72 * 10);
  assert.equal(months[1], 0);
  assert.equal(months[11], 10);
  assert.equal(total, 31 * 72 * 10 + 10);
});
