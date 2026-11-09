import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sunPosition, dayInfo, timesForZenith, shadowLength, refraction } from '../../js/sun.js';

// Valeurs de référence calculées avec pvlib 0.16 (algorithme NREL SPA).
const CASES = [
  { name: 'Paris été midi UTC', lat: 48.8566, lng: 2.3522, t: '2026-06-21T12:00:00Z', az: 184.0528, alt: 64.5441, altGeom: 64.5361 },
  { name: 'Paris novembre fin de journée', lat: 48.8566, lng: 2.3522, t: '2026-11-09T15:30:00Z', az: 235.4316, alt: 6.1723, altGeom: 6.0336 },
  { name: 'Sydney', lat: -33.8688, lng: 151.2093, t: '2026-01-15T03:00:00Z', az: 312.4907, alt: 72.3223, altGeom: 72.3169 },
  { name: 'Tromsø nuit polaire', lat: 69.6492, lng: 18.9553, t: '2026-12-21T11:00:00Z', az: 184.0832, alt: -3.1435, altGeom: -3.1435 },
  { name: 'Quito équinoxe', lat: -0.1807, lng: -78.4678, t: '2026-03-20T17:30:00Z', az: 275.8868, alt: 87.7989, altGeom: 87.7983 },
];

for (const c of CASES) {
  test(`position du soleil — ${c.name}`, () => {
    const p = sunPosition(new Date(c.t), c.lat, c.lng);
    // Près du zénith l'azimut est mal conditionné : tolérance élargie.
    const azTol = c.altGeom > 85 ? 0.2 : 0.05;
    assert.ok(Math.abs(p.azimuth - c.az) < azTol, `azimut ${p.azimuth} vs ${c.az}`);
    assert.ok(Math.abs(p.altitudeGeometric - c.altGeom) < 0.02, `élévation géom. ${p.altitudeGeometric} vs ${c.altGeom}`);
    // Réfraction : pvlib n'en applique pas sous l'horizon, NOAA si ; on compare au-dessus de -0,5° seulement.
    if (c.altGeom > -0.5) assert.ok(Math.abs(p.altitude - c.alt) < 0.05, `élévation apparente ${p.altitude} vs ${c.alt}`);
  });
}

test('lever/coucher Paris 21 juin 2026 (heure d\'été UTC+2)', () => {
  // Références NOAA : lever ≈ 05:47, coucher ≈ 21:58 heure locale (UTC+2).
  const noonUTC = new Date('2026-06-21T10:00:00Z');
  const d = dayInfo(noonUTC, 48.8566, 2.3522);
  assert.equal(d.status, 'normal');
  const rise = (d.sunrise.getTime() - Date.UTC(2026, 5, 21)) / 60000 + 120; // minutes locales
  const set = (d.sunset.getTime() - Date.UTC(2026, 5, 21)) / 60000 + 120;
  assert.ok(Math.abs(rise - (5 * 60 + 47)) <= 2, `lever ${rise}`);
  assert.ok(Math.abs(set - (21 * 60 + 58)) <= 2, `coucher ${set}`);
  assert.ok(d.dayLengthMinutes > 16 * 60 && d.dayLengthMinutes < 16.3 * 60, `durée ${d.dayLengthMinutes}`);
  assert.ok(d.goldenMorningEnd > d.sunrise && d.goldenEveningStart < d.sunset);
  assert.ok(d.civilDawn < d.sunrise && d.civilDusk > d.sunset);
});

test('nuit polaire à Tromsø, jour polaire à Longyearbyen', () => {
  const nuit = dayInfo(new Date('2026-12-21T11:00:00Z'), 69.6492, 18.9553);
  assert.equal(nuit.status, 'polar-night');
  assert.equal(nuit.dayLengthMinutes, 0);
  const jour = dayInfo(new Date('2026-06-21T11:00:00Z'), 78.2232, 15.6267);
  assert.equal(jour.status, 'polar-day');
  assert.equal(jour.dayLengthMinutes, 1440);
});

test('cohérence lever/coucher et élévation nulle', () => {
  const noonUTC = new Date('2026-03-20T12:00:00Z');
  const { rise, set } = timesForZenith(noonUTC, 40.7128, -74.006, 90.833);
  for (const t of [rise, set]) {
    const p = sunPosition(t, 40.7128, -74.006);
    // Le bord supérieur du disque affleure l'horizon : élévation géométrique ≈ -0,833°.
    assert.ok(Math.abs(p.altitudeGeometric + 0.833) < 0.05, `élévation au lever/coucher ${p.altitudeGeometric}`);
  }
});

test('hémisphère sud : le soleil de midi est au nord', () => {
  const p = sunPosition(new Date('2026-06-21T02:30:00Z'), -33.8688, 151.2093);
  assert.ok(p.azimuth < 20 || p.azimuth > 340, `azimut ${p.azimuth}`);
});

test('longueur d\'ombre et réfraction', () => {
  assert.ok(Math.abs(shadowLength(10, 45) - 10) < 1e-9);
  assert.equal(shadowLength(10, 0), Infinity);
  assert.ok(Math.abs(refraction(0) - 0.4819) < 0.01, `réfraction horizon ${refraction(0)}`);
  assert.equal(refraction(89), 0);
});

test('jour très long avec fuseau décalé (Nome, Alaska) : coucher après lever, ~21 h de jour', () => {
  // Midi civil du 21 juin 2026 à Nome (UTC−8 en été) = 20:00 UTC ; le midi solaire est vers 14:00 heure locale.
  const noonUTC = new Date('2026-06-21T20:00:00Z');
  const d = dayInfo(noonUTC, 64.5011, -165.4064);
  assert.equal(d.status, 'normal');
  assert.ok(d.sunset > d.sunrise, `coucher ${d.sunset.toISOString()} après lever ${d.sunrise.toISOString()}`);
  assert.ok(d.dayLengthMinutes > 20.5 * 60 && d.dayLengthMinutes < 22 * 60, `durée ${d.dayLengthMinutes}`);
  // Le coucher (≈ 01:45 locale le 22) est plus de 12 h après le midi civil : il ne doit pas être renvoyé la veille.
  assert.ok(d.sunset.getTime() - noonUTC.getTime() > 12 * 3600000, 'coucher > 12 h après le midi civil');
  // Midi solaire ≈ 12:00 UTC + 165,4°/15 = 23:02 UTC (15:02 heure locale).
  assert.ok(Math.abs(d.solarNoon.getTime() - new Date('2026-06-21T23:02:00Z').getTime()) < 10 * 60000, `midi solaire ${d.solarNoon.toISOString()}`);
});

test('Auckland en été (UTC+13) : le jour civil chevauche deux jours UTC', () => {
  const noonUTC = new Date('2026-01-14T23:00:00Z'); // 15 janv. 12:00 NZDT
  const d = dayInfo(noonUTC, -36.8485, 174.7633);
  const riseLocalMin = ((d.sunrise.getTime() + 13 * 3600000) % 86400000) / 60000;
  const setLocalMin = ((d.sunset.getTime() + 13 * 3600000) % 86400000) / 60000;
  assert.ok(Math.abs(riseLocalMin - (6 * 60 + 16)) <= 5, `lever local ${riseLocalMin}`);
  assert.ok(Math.abs(setLocalMin - (20 * 60 + 40)) <= 5, `coucher local ${setLocalMin}`);
  assert.ok(d.sunset > d.sunrise);
});
