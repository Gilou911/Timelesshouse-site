import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { canDecodePNG, decodePNG, pngSize, unfilterScanlines } from '../../js/png.js';
import { decodeTerrarium } from '../../js/shadow-engine.js';
import { chunk, encodePNG } from '../e2e/png.mjs';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) & 0xff;
  };
}
function randomBytes(n, seed) {
  const next = random(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = next();
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Encodeur de test : applique le filtre demandé à chaque ligne, découpe au besoin les données en plusieurs IDAT. */
function makePNG({ width, height, colorType, bitDepth = 8, raw, filterOf = () => 0, palette, trns, idatSize = 0, interlace = 0 }) {
  const rowBytes = Math.ceil((width * CHANNELS[colorType] * bitDepth) / 8);
  const bpp = Math.max(1, (CHANNELS[colorType] * bitDepth) >> 3);
  const data = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const f = filterOf(y);
    const o = y * (rowBytes + 1);
    data[o] = f;
    for (let i = 0; i < rowBytes; i++) {
      const cur = raw[y * rowBytes + i];
      const left = i >= bpp ? raw[y * rowBytes + i - bpp] : 0;
      const up = y > 0 ? raw[(y - 1) * rowBytes + i] : 0;
      const corner = y > 0 && i >= bpp ? raw[(y - 1) * rowBytes + i - bpp] : 0;
      const predicted = f === 1 ? left : f === 2 ? up : f === 3 ? (left + up) >> 1 : f === 4 ? paeth(left, up, corner) : 0;
      data[o + 1 + i] = (cur - predicted) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  const parts = [SIGNATURE, chunk('IHDR', ihdr)];
  if (palette) parts.push(chunk('PLTE', Buffer.from(palette)));
  if (trns) parts.push(chunk('tRNS', Buffer.from(trns)));
  const z = deflateSync(data);
  if (idatSize > 0) {
    for (let p = 0; p < z.length; p += idatSize) parts.push(chunk('IDAT', z.subarray(p, p + idatSize)));
  } else {
    parts.push(chunk('IDAT', z));
  }
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(parts));
}

function toRGBA(colorType, raw, n) {
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const d = i * 4;
    if (colorType === 6) out.set(raw.subarray(d, d + 4), d);
    else if (colorType === 2) out.set([raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2], 255], d);
    else if (colorType === 4) out.set([raw[i * 2], raw[i * 2], raw[i * 2], raw[i * 2 + 1]], d);
    else out.set([raw[i], raw[i], raw[i], 255], d);
  }
  return out;
}

test('le décodeur est disponible dans cet environnement', () => {
  assert.equal(canDecodePNG, true);
});

test('images écrites par Pillow : pixels identiques à ceux que Pillow relit', async () => {
  const expected = {
    'terrarium-64.png': [64, 64, '710cd1b0dad7ad7925e1a9402f3cb2a0c4c9abb54ebb22be6ee09ace81590477'],
    'palette-1bit.png': [13, 7, 'aa90b5446bb4391e55f7f18735eee376fbd79dd127e2233a2e94e41173d66aa4'],
    'palette-2bit.png': [13, 7, 'ac21391228d7194bc542dc99d625cb80d110a1398be1fd65035585e538bb910e'],
    'palette-4bit.png': [13, 7, 'c2866fc5dff7fb035a6f41185af0bfde315af81187343ea4eea71806d6bfcf93'],
    'gray-alpha.png': [17, 9, '3d29bc360af49c592c9aa450557d5e0462b15735bba81b6c5243be2cf3985668'],
    'gray.png': [17, 9, '96b6440335f14d7968342c65db8f9ec551659eaefa44ab2b6d6ea13a6a179af7'],
  };
  for (const [name, [w, h, hash]] of Object.entries(expected)) {
    const img = await decodePNG(fixture(name));
    assert.equal(img.width, w, name);
    assert.equal(img.height, h, name);
    assert.equal(img.rgba.length, w * h * 4, name);
    assert.equal(sha256(img.rgba), hash, name);
  }
});

test('tuile Terrarium : les hauteurs sortent exactes, au 1/256 de mètre', async () => {
  const img = await decodePNG(fixture('terrarium-64.png'));
  // Premier pixel du relief synthétique : 900 m, soit 33668 = 131 × 256 + 132.
  assert.deepEqual([...img.rgba.subarray(0, 4)], [131, 132, 0, 255]);
  const heights = decodeTerrarium(img.rgba);
  assert.equal(heights.length, 64 * 64);
  assert.equal(heights[0], 900);
});

test('chaque filtre de ligne, pour chaque type de couleur 8 bits', async () => {
  const width = 19;
  const height = 11;
  for (const colorType of [0, 2, 4, 6]) {
    const raw = randomBytes(width * height * CHANNELS[colorType], 100 + colorType);
    const want = toRGBA(colorType, raw, width * height);
    for (const f of [0, 1, 2, 3, 4]) {
      const img = await decodePNG(makePNG({ width, height, colorType, raw, filterOf: () => f }));
      assert.deepEqual(img.rgba, want, `type ${colorType}, filtre ${f}`);
    }
    const mixed = await decodePNG(makePNG({ width, height, colorType, raw, filterOf: (y) => (y * 3 + 1) % 5 }));
    assert.deepEqual(mixed.rgba, want, `type ${colorType}, filtres mélangés`);
  }
});

test('données réparties sur plusieurs blocs IDAT', async () => {
  const width = 32;
  const height = 32;
  const raw = randomBytes(width * height * 3, 7);
  const png = makePNG({ width, height, colorType: 2, raw, filterOf: (y) => y % 5, idatSize: 7 });
  const img = await decodePNG(png);
  assert.deepEqual(img.rgba, toRGBA(2, raw, width * height));
});

test('accepte un ArrayBuffer comme un Uint8Array décalé dans son tampon', async () => {
  const raw = randomBytes(5 * 4 * 4, 3);
  const png = makePNG({ width: 5, height: 4, colorType: 6, raw, filterOf: () => 4 });
  const padded = new Uint8Array(png.length + 9);
  padded.set(png, 9);
  assert.deepEqual((await decodePNG(padded.subarray(9))).rgba, raw);
  assert.deepEqual((await decodePNG(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength))).rgba, raw);
});

test('palette 8 bits : transparence partielle, indice hors palette refusé', async () => {
  const palette = [255, 0, 0, 0, 255, 0, 0, 0, 255];
  const raw = Uint8Array.from([0, 1, 2, 2, 1, 0]);
  const img = await decodePNG(makePNG({ width: 3, height: 2, colorType: 3, raw, palette, trns: [10, 20], filterOf: () => 1 }));
  assert.deepEqual([...img.rgba], [
    255, 0, 0, 10, 0, 255, 0, 20, 0, 0, 255, 255,
    0, 0, 255, 255, 0, 255, 0, 20, 255, 0, 0, 10,
  ]);
  await assert.rejects(decodePNG(makePNG({ width: 3, height: 2, colorType: 3, raw: Uint8Array.from([0, 1, 3, 0, 0, 0]), palette })), /palette/i);
  await assert.rejects(decodePNG(makePNG({ width: 3, height: 2, colorType: 3, raw })), /Palette PNG absente/);
});

test('filtres : valeurs calculées à la main', () => {
  // Une ligne brute puis une ligne filtrée, un octet par pixel.
  const line = (filter, bytes) => unfilterScanlines(Uint8Array.from([0, 10, 20, 30, filter, ...bytes]), 3, 1, 2).subarray(3);
  assert.deepEqual([...line(1, [5, 5, 250])], [5, 10, 4]); // Sub : 5, 5+5, 250+10 modulo 256
  assert.deepEqual([...line(2, [5, 5, 250])], [15, 25, 24]); // Up : 5+10, 5+20, 250+30 modulo 256
  assert.deepEqual([...line(3, [5, 5, 250])], [10, 20, 19]); // Average : 5+⌊10/2⌋, 5+⌊(10+20)/2⌋, 250+⌊(20+30)/2⌋ modulo 256
  // Paeth : 1er octet, seul le haut existe (10). 2e : gauche 15, haut 20, coin 10 → p = 25, le plus proche est 20.
  // 3e : gauche 25, haut 30, coin 20 → p = 35, le plus proche est 30.
  assert.deepEqual([...line(4, [5, 5, 250])], [15, 25, 24]);
  // Paeth à égalité. Gauche 4, haut 13, coin 10 → p = 7, gauche et coin à 3 : la gauche l'emporte.
  assert.deepEqual([...unfilterScanlines(Uint8Array.from([0, 10, 13, 4, 250, 1]), 2, 1, 2).subarray(2)], [4, 5]);
  // Gauche 13, haut 4, coin 10 → p = 7, haut et coin à 3 : le haut l'emporte.
  assert.deepEqual([...unfilterScanlines(Uint8Array.from([0, 10, 4, 4, 3, 1]), 2, 1, 2).subarray(2)], [13, 5]);
  // Première ligne : la ligne du dessus vaut zéro, quel que soit le filtre.
  assert.deepEqual([...unfilterScanlines(Uint8Array.from([4, 7, 1, 1]), 3, 1, 1)], [7, 8, 9]);
  assert.deepEqual([...unfilterScanlines(Uint8Array.from([3, 8, 4, 2]), 3, 1, 1)], [8, 8, 6]);
  // Pixels de plusieurs octets : le voisin de gauche est à bpp octets, pas à un octet.
  assert.deepEqual([...unfilterScanlines(Uint8Array.from([1, 1, 2, 3, 10, 20, 30]), 6, 3, 1)], [1, 2, 3, 11, 22, 33]);
});

test('fichiers invalides ou hors format : erreur, jamais de pixels inventés', async () => {
  const raw = randomBytes(4 * 4 * 3, 1);
  const good = makePNG({ width: 4, height: 4, colorType: 2, raw });
  await assert.rejects(decodePNG(new Uint8Array(40)), /Signature/);
  await assert.rejects(decodePNG(good.subarray(0, 20)), /trop court/);
  await assert.rejects(decodePNG(good.subarray(0, good.length - 20)), /tronqué|sans données/);
  await assert.rejects(decodePNG(makePNG({ width: 4, height: 4, colorType: 2, raw, interlace: 1 })), /entrelacé/);
  await assert.rejects(decodePNG(makePNG({ width: 4, height: 4, colorType: 2, bitDepth: 16, raw: randomBytes(96, 2) })), /16 bits/);
  await assert.rejects(decodePNG(makePNG({ width: 4, height: 4, colorType: 2, raw, filterOf: () => 5 })), /Filtre PNG inconnu/);
  // Moins de lignes que n'en annonce l'en-tête.
  const short = makePNG({ width: 4, height: 3, colorType: 2, raw });
  short[8 + 8 + 7] = 4; // hauteur 3 → 4 dans IHDR
  await assert.rejects(decodePNG(short), /tronqué/);
  // Flux compressé abîmé.
  const broken = good.slice();
  const idat = Buffer.from(broken).indexOf('IDAT');
  for (let i = idat + 6; i < idat + 14; i++) broken[i] ^= 0xff;
  await assert.rejects(decodePNG(broken));
  // Sans bloc IDAT.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  await assert.rejects(decodePNG(new Uint8Array(Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]))), /sans données/);
  assert.throws(() => unfilterScanlines(new Uint8Array(5), 3, 1, 2), /tronqué/);
});

test('image piégée : taille lue sans décompresser, plafond, flux borné à l\'en-tête', async () => {
  const good = makePNG({ width: 4, height: 4, colorType: 2, raw: randomBytes(4 * 4 * 3, 3) });
  assert.deepEqual(pngSize(good), { width: 4, height: 4 });
  assert.equal(pngSize(new Uint8Array(40)), null, 'pas un PNG');
  // En-tête démesuré : la taille se lit sans rien décompresser, et le décodeur refuse avant d'allouer quoi que ce soit.
  const huge = good.slice();
  new DataView(huge.buffer).setUint32(16, 100000);
  new DataView(huge.buffer).setUint32(20, 100000);
  assert.deepEqual(pngSize(huge), { width: 100000, height: 100000 });
  await assert.rejects(decodePNG(huge), /trop grand/);
  // Au-delà de 1024 × 1024 : refusé aussi (le plafond était de 4096 × 4096, soit 64 Mo par image).
  const big = good.slice();
  new DataView(big.buffer).setUint32(16, 2048);
  new DataView(big.buffer).setUint32(20, 2048);
  await assert.rejects(decodePNG(big), /trop grand/);
  // Bombe de décompression : 2 × 2 pixels annoncés, 8 Mo de zéros compressés en quelques Ko.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const bomb = new Uint8Array(Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(8 * 1024 * 1024))), chunk('IEND', Buffer.alloc(0))]));
  assert.ok(bomb.length < 64 * 1024, `bombe de ${bomb.length} octets`);
  await assert.rejects(decodePNG(bomb), /plus grand que son en-tête/);
});

test('tuiles factices des tests de bout en bout : même encodage, mêmes hauteurs', async () => {
  const rgba = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) rgba.set([128, i * 16, 128, 255], i * 4); // 128 × 256 + G + 0,5 − 32768
  const img = await decodePNG(new Uint8Array(encodePNG(4, 4, rgba)));
  assert.deepEqual(img.rgba, rgba);
  assert.deepEqual([...decodeTerrarium(img.rgba)], Array.from({ length: 16 }, (_, i) => i * 16 + 0.5));
});
