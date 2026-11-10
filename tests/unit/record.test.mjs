import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickVideoType, videoSize, longDate } from '../../js/record.js';

test('format de la vidéo : MP4 si le navigateur sait le faire, sinon WebM, sinon rien', () => {
  assert.equal(pickVideoType(() => true), 'video/mp4;codecs=avc1');
  assert.equal(pickVideoType((t) => t.startsWith('video/webm')), 'video/webm;codecs=vp9');
  assert.equal(pickVideoType((t) => t === 'video/webm'), 'video/webm');
  assert.equal(pickVideoType(() => false), null);
});

test('taille de la vidéo : pixels réels de l\'écran, grand côté de 1 920 px au plus, nombres pairs', () => {
  assert.deepEqual(videoSize(1440, 813, 2), { w: 1920, h: 1084 }, 'Retina 1 440 px : ramené à 1 920 de large');
  assert.deepEqual(videoSize(375, 812, 3), { w: 886, h: 1920 }, 'téléphone en hauteur : grand côté ramené à 1 920');
  assert.deepEqual(videoSize(1280, 720, 1), { w: 1280, h: 720 }, 'écran ordinaire : sa propre taille');
  assert.deepEqual(videoSize(301, 201, 1), { w: 300, h: 200 }, 'nombres pairs pour H.264');
});

test('date incrustée en toutes lettres', () => {
  assert.equal(longDate('2026-11-10'), 'mardi 10 novembre 2026');
  assert.equal(longDate('2027-06-12'), 'samedi 12 juin 2027');
});
