// Décodeur PNG exact, sans canvas.
// Relire les pixels d'un canvas n'est pas fiable pour des données : les protections anti-empreinte
// (Brave, Firefox en navigation privée ou avec resistFingerprinting) y ajoutent du bruit, et un écart de 1
// sur le canal rouge d'une tuile Terrarium vaut 256 m. On décompresse donc le PNG nous-mêmes.
// Formats pris en charge : non entrelacé, 8 bits (gris, gris+alpha, RVB, RVBA) et palette 1/2/4/8 bits.

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_PIXELS = 4096 * 4096;
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export const canDecodePNG = typeof DecompressionStream !== 'undefined' && typeof Response !== 'undefined' && typeof Blob !== 'undefined';

async function inflate(bytes) {
  // « deflate » désigne ici le format zlib (RFC 1950), celui des blocs IDAT.
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Annule les filtres de ligne PNG. `bpp` : octets par pixel complet (au moins 1). */
export function unfilterScanlines(data, rowBytes, bpp, height) {
  if (data.length < (rowBytes + 1) * height) throw new Error('PNG tronqué');
  const out = new Uint8Array(rowBytes * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = data[p++];
    const o = y * rowBytes;
    const up = o - rowBytes; // ligne précédente (absente pour y = 0)
    switch (filter) {
      case 0:
        out.set(data.subarray(p, p + rowBytes), o);
        break;
      case 1:
        for (let i = 0; i < rowBytes; i++) out[o + i] = data[p + i] + (i >= bpp ? out[o + i - bpp] : 0);
        break;
      case 2:
        for (let i = 0; i < rowBytes; i++) out[o + i] = data[p + i] + (y > 0 ? out[up + i] : 0);
        break;
      case 3:
        for (let i = 0; i < rowBytes; i++) {
          const left = i >= bpp ? out[o + i - bpp] : 0;
          const above = y > 0 ? out[up + i] : 0;
          out[o + i] = data[p + i] + ((left + above) >> 1);
        }
        break;
      case 4:
        for (let i = 0; i < rowBytes; i++) {
          const left = i >= bpp ? out[o + i - bpp] : 0;
          const above = y > 0 ? out[up + i] : 0;
          const corner = y > 0 && i >= bpp ? out[up + i - bpp] : 0;
          out[o + i] = data[p + i] + paeth(left, above, corner);
        }
        break;
      default:
        throw new Error(`Filtre PNG inconnu : ${filter}`);
    }
    p += rowBytes;
  }
  return out;
}

/**
 * Décode un PNG (Uint8Array) en pixels RVBA 8 bits, sans prémultiplication ni gestion des couleurs.
 * Lève une erreur pour les formats non pris en charge (16 bits, entrelacé) : l'appelant peut alors se replier.
 */
export async function decodePNG(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length < 33) throw new Error('PNG trop court');
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) throw new Error('Signature PNG absente');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let palette = null;
  let transparency = null;
  const idat = [];
  let idatLength = 0;
  let seenEnd = false;

  let p = 8;
  while (p + 12 <= bytes.length && !seenEnd) {
    const length = view.getUint32(p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    const start = p + 8;
    const end = start + length;
    if (end + 4 > bytes.length) throw new Error('Bloc PNG tronqué');
    if (type === 'IHDR') {
      if (length < 13) throw new Error('IHDR invalide');
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      bitDepth = bytes[start + 8];
      colorType = bytes[start + 9];
      if (bytes[start + 10] !== 0 || bytes[start + 11] !== 0) throw new Error('Compression ou filtre PNG inconnu');
      if (bytes[start + 12] !== 0) throw new Error('PNG entrelacé non pris en charge');
    } else if (type === 'PLTE') {
      palette = bytes.subarray(start, end);
    } else if (type === 'tRNS') {
      transparency = bytes.subarray(start, end);
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(start, end));
      idatLength += length;
    } else if (type === 'IEND') {
      seenEnd = true;
    }
    p = end + 4; // saute le CRC
  }

  const channels = CHANNELS[colorType];
  if (!channels || !width || !height) throw new Error('En-tête PNG invalide');
  if (width * height > MAX_PIXELS) throw new Error('PNG trop grand');
  const depthOk = colorType === 3 ? [1, 2, 4, 8].includes(bitDepth) : bitDepth === 8;
  if (!depthOk) throw new Error(`Profondeur PNG non prise en charge : ${bitDepth} bits (type ${colorType})`);
  if (colorType === 3 && !palette) throw new Error('Palette PNG absente');
  if (!idatLength) throw new Error('PNG sans données');

  const compressed = new Uint8Array(idatLength);
  let o = 0;
  for (const part of idat) {
    compressed.set(part, o);
    o += part.length;
  }
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const bpp = Math.max(1, (channels * bitDepth) >> 3);
  const raw = unfilterScanlines(await inflate(compressed), rowBytes, bpp, height);

  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colorType === 6) {
    rgba.set(raw.subarray(0, n * 4));
  } else if (colorType === 2) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = raw[s];
      rgba[d + 1] = raw[s + 1];
      rgba[d + 2] = raw[s + 2];
      rgba[d + 3] = 255;
    }
  } else if (colorType === 0) {
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = raw[i];
      rgba[d + 3] = 255;
    }
  } else if (colorType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = raw[s];
      rgba[d + 3] = raw[s + 1];
    }
  } else {
    // Palette : indices de 1, 2, 4 ou 8 bits, rangés du bit de poids fort vers le faible.
    const mask = (1 << bitDepth) - 1;
    const entries = Math.floor(palette.length / 3);
    for (let y = 0, d = 0; y < height; y++) {
      const row = y * rowBytes;
      for (let x = 0; x < width; x++, d += 4) {
        const bit = x * bitDepth;
        const index = (raw[row + (bit >> 3)] >> (8 - bitDepth - (bit & 7))) & mask;
        if (index >= entries) throw new Error('Indice de palette PNG hors limites');
        rgba[d] = palette[index * 3];
        rgba[d + 1] = palette[index * 3 + 1];
        rgba[d + 2] = palette[index * 3 + 2];
        rgba[d + 3] = transparency && index < transparency.length ? transparency[index] : 255;
      }
    }
  }
  return { width, height, rgba };
}
