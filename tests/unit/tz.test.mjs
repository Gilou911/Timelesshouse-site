import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tzOffsetMinutes, wallToUTC, utcToWall, minutesOfDay, tzLabel, formatMinutes, isValidTimeZone, formatDuration } from '../../js/tz.js';

test('décalages Paris été/hiver, Sydney, Katmandou', () => {
  assert.equal(tzOffsetMinutes('Europe/Paris', new Date('2026-07-01T12:00:00Z')), 120);
  assert.equal(tzOffsetMinutes('Europe/Paris', new Date('2026-01-01T12:00:00Z')), 60);
  assert.equal(tzOffsetMinutes('Australia/Sydney', new Date('2026-01-01T12:00:00Z')), 660);
  assert.equal(tzOffsetMinutes('Asia/Kathmandu', new Date('2026-01-01T12:00:00Z')), 345);
  assert.equal(tzOffsetMinutes('America/St_Johns', new Date('2026-01-01T12:00:00Z')), -210);
});

test('heure civile ↔ UTC, y compris le changement d\'heure', () => {
  const d = wallToUTC('Europe/Paris', 2026, 11, 9, 15, 30);
  assert.equal(d.toISOString(), '2026-11-09T14:30:00.000Z');
  const w = utcToWall('Europe/Paris', d);
  assert.deepEqual(w, { y: 2026, mo: 11, d: 9, h: 15, mi: 30, s: 0 });
  // Passage à l'heure d'été 2026 : 29 mars, 02:00 → 03:00 (02:30 n'existe pas, on tolère l'un ou l'autre côté).
  const gap = wallToUTC('Europe/Paris', 2026, 3, 29, 2, 30);
  assert.ok(['2026-03-29T00:30:00.000Z', '2026-03-29T01:30:00.000Z'].includes(gap.toISOString()), gap.toISOString());
  // Minuit s'affiche 00, pas 24.
  const m = utcToWall('Europe/Paris', wallToUTC('Europe/Paris', 2026, 1, 1, 0, 0));
  assert.equal(m.h, 0);
});

test('minutes du jour, étiquettes, formats', () => {
  assert.equal(minutesOfDay('Europe/Paris', new Date('2026-11-09T14:30:00Z')), 930);
  assert.equal(tzLabel('Europe/Paris', new Date('2026-07-01T00:00:00Z')), 'UTC+2');
  assert.equal(tzLabel('America/St_Johns', new Date('2026-01-01T00:00:00Z')), 'UTC−3:30');
  assert.equal(formatMinutes(930), '15:30');
  assert.equal(formatMinutes(1440), '00:00');
  assert.equal(formatDuration(754), '12 h 34');
  assert.ok(isValidTimeZone('Etc/GMT+9'));
  assert.ok(!isValidTimeZone('Mars/Olympus'));
});
