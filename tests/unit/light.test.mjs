import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sunLight } from '../../js/map.js';

test('lumière des bâtiments 3D : le soleil le jour, le ciel la nuit, sans saut au coucher', () => {
  const day = sunLight(135, 30);
  assert.equal(day.anchor, 'map', 'ancre « carte » : 0° = nord, même repère que l\'azimut du soleil');
  assert.deepEqual(day.position, [1.15, 135, 60], 'angle polaire = 90° − élévation');
  assert.equal(day.intensity, 0.6);
  assert.equal(day.color, 'rgb(255, 255, 255)');
  assert.equal(day['position-transition'].duration, 0, 'aucun retard sur les ombres');
  assert.deepEqual(sunLight(-90, 45).position, [1.15, 270, 45], 'azimut ramené entre 0 et 360°');
  const night = sunLight(300, -20);
  assert.deepEqual(night.position, [1.15, 300, 0], 'la nuit, la lumière vient du zénith : aucun mur n\'est éclairé par le soleil');
  assert.equal(night.intensity, 0.35);
  assert.equal(night.color, 'rgb(90, 98, 132)');
  // Continuité au coucher : rien ne saute entre +0,01° et −0,01°.
  const a = sunLight(250, 0.01);
  const b = sunLight(250, -0.01);
  assert.ok(Math.abs(a.position[2] - b.position[2]) < 0.2 && Math.abs(a.intensity - b.intensity) < 0.01, `${a.position} / ${b.position}`);
  // De plus en plus sombre du coucher à −6°, puis plus rien ne change.
  const lum = (l) => l.color.match(/\d+/g).map(Number).reduce((s, v) => s + v, 0);
  assert.ok(lum(sunLight(250, -1)) > lum(sunLight(250, -3)) && lum(sunLight(250, -3)) > lum(sunLight(250, -5.9)));
  assert.deepEqual(sunLight(250, -6), { ...sunLight(250, -40), position: [1.15, 250, 0] });
});
