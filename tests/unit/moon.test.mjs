import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moonPosition, moonTimes, moonPhase } from '../../js/moon.js';

// Valeurs de référence calculées avec astronomy-engine 2 (Python, Don Cross ; précision de l'ordre de la minute d'arc) :
// position topocentrique sans réfraction (altAirless) et avec réfraction normale (alt), lever et coucher du bord
// supérieur dans le jour civil, part éclairée et élongation (MoonPhase).
const POSITIONS = [
  { name: 'Paris', lat: 48.8566, lng: 2.3522, t: '2026-11-10T22:00:00Z', az: 289.7362, altAirless: -51.3224, alt: -51.0414 },
  { name: 'Paris', lat: 48.8566, lng: 2.3522, t: '2026-06-21T03:00:00Z', az: 319.5601, altAirless: -31.8325, alt: -31.41 },
  { name: 'Sydney', lat: -33.8688, lng: 151.2093, t: '2026-01-15T12:00:00Z', az: 170.399, altAirless: -28.2978, alt: -27.8495 },
  { name: 'Tromsø', lat: 69.6492, lng: 18.9553, t: '2026-12-21T11:00:00Z', az: 40.8461, altAirless: 7.4514, alt: 7.5683 },
  { name: 'Quito', lat: -0.1807, lng: -78.4678, t: '2027-03-22T02:30:00Z', az: 92.3159, altAirless: 51.9986, alt: 52.0118 },
];

for (const c of POSITIONS) {
  test(`position de la Lune — ${c.name} ${c.t}`, () => {
    const p = moonPosition(new Date(c.t), c.lat, c.lng);
    assert.ok(Math.abs(p.azimuth - c.az) < 0.2, `azimut ${p.azimuth} au lieu de ${c.az}`);
    assert.ok(Math.abs(p.altitudeTrue - c.altAirless) < 0.15, `élévation vraie ${p.altitudeTrue} au lieu de ${c.altAirless}`);
    // Sous l'horizon, les deux bibliothèques ne prolongent pas la réfraction de la même façon : on ne compare qu'au-dessus.
    if (c.alt > 0) assert.ok(Math.abs(p.altitude - c.alt) < 0.15, `élévation apparente ${p.altitude} au lieu de ${c.alt}`);
  });
}

const TIMES = [
  { name: 'Paris, lendemain de la nouvelle lune', lat: 48.8566, lng: 2.3522, day: '2026-11-10', offset: 1, rise: '2026-11-10T08:28:40Z', set: '2026-11-10T16:19:46Z' },
  { name: 'Paris, coucher le matin puis lever le soir', lat: 48.8566, lng: 2.3522, day: '2026-11-25', offset: 1, rise: '2026-11-25T16:14:40Z', set: '2026-11-25T08:41:21Z' },
  { name: 'Vaux, le jour d\'une cérémonie', lat: 48.8566, lng: 2.3522, day: '2027-06-12', offset: 2, rise: '2027-06-12T13:07:55Z', set: '2027-06-12T00:04:17Z' },
  { name: 'Sydney', lat: -33.8688, lng: 151.2093, day: '2026-01-15', offset: 11, rise: '2026-01-14T15:20:52Z', set: '2026-01-15T06:32:08Z' },
];

for (const c of TIMES) {
  test(`lever et coucher de la Lune — ${c.name}`, () => {
    const start = new Date(Date.parse(`${c.day}T00:00:00Z`) - c.offset * 3600000);
    const r = moonTimes(start, new Date(start.getTime() + 86400000), c.lat, c.lng);
    for (const k of ['rise', 'set']) {
      const minutes = Math.abs(r[k].getTime() - Date.parse(c[k])) / 60000;
      assert.ok(minutes < 3, `${k} ${r[k].toISOString()} au lieu de ${c[k]} (${minutes.toFixed(1)} min)`);
    }
    assert.equal(r.alwaysUp || r.alwaysDown, false);
  });
}

test('Lune toujours levée à Tromsø le 21 décembre 2026 (ni lever ni coucher)', () => {
  const start = new Date('2026-12-20T23:00:00Z');
  const r = moonTimes(start, new Date(start.getTime() + 86400000), 69.6492, 18.9553);
  assert.deepEqual([r.rise, r.set, r.alwaysUp, r.alwaysDown], [null, null, true, false]);
});

test('phase de la Lune : part éclairée, élongation, nom', () => {
  const CASES = [
    { t: '2026-11-10T12:00:00Z', fraction: 0.016, elongation: 13.624, name: 'Nouvelle lune' },
    { t: '2026-11-24T12:00:00Z', fraction: 0.9979, elongation: 178.306, name: 'Pleine lune' },
    { t: '2026-12-01T12:00:00Z', fraction: 0.4748, elongation: 273.035, name: 'Dernier quartier' },
    { t: '2027-06-12T14:00:00Z', fraction: 0.6239, elongation: 104.242, name: 'Premier quartier' },
    { t: '2027-01-03T00:00:00Z', fraction: 0.2008, elongation: 307.055, name: 'Dernier croissant' },
  ];
  for (const c of CASES) {
    const p = moonPhase(new Date(c.t));
    assert.ok(Math.abs(p.fraction - c.fraction) < 0.01, `${c.t} : part éclairée ${p.fraction} au lieu de ${c.fraction}`);
    assert.ok(Math.abs(p.elongation - c.elongation) < 0.5, `${c.t} : élongation ${p.elongation} au lieu de ${c.elongation}`);
    assert.equal(p.name, c.name, c.t);
  }
});
