// Moteur d'ombres : champ de hauteurs (relief + bâtiments) puis balayage dans la direction du soleil.
// Fonctions pures sur tableaux typés — utilisables dans un Web Worker comme dans Node (tests).
//
// Convention de grille : x vers l'est, y vers le sud (comme la projection Web Mercator),
// cellule (x, y) à l'indice y * w + x. Hauteurs en mètres.

const RAD = Math.PI / 180;
export const EARTH_RADIUS = 6378137;
export const NIGHT = Math.fround(1e30); // sentinelle (représentable en float32) : soleil couché

/** Mètres par unité Mercator (monde = 1) à la latitude donnée. */
export function metersPerUnit(lat) {
  return 2 * Math.PI * EARTH_RADIUS * Math.cos(lat * RAD);
}

/** Longitude/latitude → unités Mercator normalisées [0,1]. */
export function lngLatToMercator(lng, lat) {
  const phi = Math.max(-85.051129, Math.min(85.051129, lat)) * RAD;
  return [
    (lng + 180) / 360,
    (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2,
  ];
}

export function mercatorToLngLat(x, y) {
  const lng = x * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / RAD);
  return [lng, lat];
}

/** Décode une tuile Terrarium (RGBA) en hauteurs (m). Les valeurs négatives (mer, nodata) sont ramenées à 0. */
export function decodeTerrarium(rgba, out) {
  const n = rgba.length >> 2;
  const heights = out || new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i << 2;
    const h = rgba[j] * 256 + rgba[j + 1] + rgba[j + 2] / 256 - 32768;
    heights[i] = h > 0 ? h : 0;
  }
  return heights;
}

/**
 * Mosaïque de tuiles DEM contiguës (même zoom) avec échantillonnage bilinéaire.
 * Les coordonnées d'échantillonnage sont en pixels de la mosaïque (0,0 = coin haut-gauche de la tuile tx0,ty0).
 */
export class DemMosaic {
  constructor(tx0, ty0, nx, ny, tileSize = 256) {
    this.tx0 = tx0;
    this.ty0 = ty0;
    this.nx = nx;
    this.ny = ny;
    this.tileSize = tileSize;
    this.width = nx * tileSize;
    this.height = ny * tileSize;
    this.data = new Float32Array(this.width * this.height);
    this.filled = 0;
  }

  setTile(tx, ty, heights) {
    const ts = this.tileSize;
    const ox = (tx - this.tx0) * ts;
    const oy = (ty - this.ty0) * ts;
    if (ox < 0 || oy < 0 || ox >= this.width || oy >= this.height) return;
    for (let y = 0; y < ts; y++) {
      const src = y * ts;
      const dst = (oy + y) * this.width + ox;
      this.data.set(heights.subarray(src, src + ts), dst);
    }
    this.filled++;
  }

  /** Échantillon bilinéaire aux coordonnées pixel (px, py) ; les bords sont prolongés. */
  sample(px, py) {
    const w = this.width;
    const h = this.height;
    let x = px - 0.5;
    let y = py - 0.5;
    if (x < 0) x = 0;
    else if (x > w - 1) x = w - 1;
    if (y < 0) y = 0;
    else if (y > h - 1) y = h - 1;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = x0 + 1 < w ? x0 + 1 : x0;
    const y1 = y0 + 1 < h ? y0 + 1 : y0;
    const fx = x - x0;
    const fy = y - y0;
    const d = this.data;
    const a = d[y0 * w + x0];
    const b = d[y0 * w + x1];
    const c = d[y1 * w + x0];
    const e = d[y1 * w + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
  }
}

/**
 * Remplit le champ de hauteurs du relief à partir d'une mosaïque DEM.
 * @param {Float32Array} T sortie (w*h)
 * @param {object} grid { w, h, originX, originY, cellUnits } en unités Mercator
 * @param {DemMosaic} mosaic mosaïque au zoom `zoom`
 */
export function fillTerrain(T, grid, mosaic, zoom) {
  const { w, h, originX, originY, cellUnits } = grid;
  const scale = mosaic.tileSize * Math.pow(2, zoom); // pixels DEM par unité Mercator
  const px0 = mosaic.tx0 * mosaic.tileSize;
  const py0 = mosaic.ty0 * mosaic.tileSize;
  for (let y = 0; y < h; y++) {
    const my = originY + (y + 0.5) * cellUnits;
    const py = my * scale - py0;
    for (let x = 0; x < w; x++) {
      const mx = originX + (x + 0.5) * cellUnits;
      T[y * w + x] = mosaic.sample(mx * scale - px0, py);
    }
  }
  return T;
}

/**
 * Rasterise des bâtiments (polygones en unités Mercator) dans le champ de hauteurs H (déjà rempli par le relief T).
 * buildings = { coords: Float64Array [x0,y0,x1,y1,…], ringStart: Int32Array (indices de sommets, sentinelle finale),
 *               polyStart: Int32Array (indices d'anneaux, sentinelle finale), heights: Float32Array (par polygone) }
 * Le toit est plat : base = relief au centroïde de l'anneau extérieur.
 * @returns nombre de polygones ayant touché au moins une cellule
 */
export function rasterizeBuildings(H, T, grid, buildings) {
  const { w, h, originX, originY, cellUnits } = grid;
  const { coords, ringStart, polyStart, heights } = buildings;
  const nPoly = polyStart.length - 1;
  let touched = 0;
  const xs = [];
  for (let p = 0; p < nPoly; p++) {
    const height = heights[p];
    if (!(height > 0)) continue;
    const r0 = polyStart[p];
    const r1 = polyStart[p + 1];
    if (r1 <= r0) continue;
    // Bornes + centroïde (anneau extérieur) en coordonnées de grille.
    let minY = Infinity;
    let maxY = -Infinity;
    let cx = 0;
    let cy = 0;
    let cn = 0;
    const v0 = ringStart[r0];
    const v1 = ringStart[r0 + 1];
    for (let v = v0; v < v1; v++) {
      const gx = (coords[2 * v] - originX) / cellUnits;
      const gy = (coords[2 * v + 1] - originY) / cellUnits;
      if (gy < minY) minY = gy;
      if (gy > maxY) maxY = gy;
      cx += gx;
      cy += gy;
      cn++;
    }
    if (cn === 0) continue;
    cx /= cn;
    cy /= cn;
    const ccx = Math.min(w - 1, Math.max(0, Math.floor(cx)));
    const ccy = Math.min(h - 1, Math.max(0, Math.floor(cy)));
    const base = T[ccy * w + ccx];
    const top = base + height;
    const yStart = Math.max(0, Math.floor(minY));
    const yEnd = Math.min(h - 1, Math.ceil(maxY));
    let filled = 0;
    for (let y = yStart; y <= yEnd; y++) {
      const yc = y + 0.5;
      xs.length = 0;
      for (let r = r0; r < r1; r++) {
        const a0 = ringStart[r];
        const a1 = ringStart[r + 1];
        const n = a1 - a0;
        if (n < 3) continue;
        for (let i = 0; i < n; i++) {
          const ia = a0 + i;
          const ib = a0 + ((i + 1) % n);
          const ay = (coords[2 * ia + 1] - originY) / cellUnits;
          const by = (coords[2 * ib + 1] - originY) / cellUnits;
          if ((ay <= yc) === (by <= yc)) continue;
          const ax = (coords[2 * ia] - originX) / cellUnits;
          const bx = (coords[2 * ib] - originX) / cellUnits;
          xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
        const xb = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
        for (let x = xa; x <= xb; x++) {
          const i = y * w + x;
          if (top > H[i]) H[i] = top;
          filled++;
        }
      }
    }
    if (filled === 0 && cx >= 0 && cx < w && cy >= 0 && cy < h) {
      // Bâtiment plus petit qu'une cellule : on marque la cellule du centroïde.
      const i = ccy * w + ccx;
      if (top > H[i]) H[i] = top;
      filled = 1;
    }
    if (filled) touched++;
  }
  return touched;
}

/**
 * Balayage des ombres. Pour chaque cellule, `depth` reçoit la hauteur (m) de l'obstacle qui l'ombrage
 * au-dessus de sa propre surface (0 = éclairée). Si le soleil est couché, tout vaut NIGHT.
 * @param {Float32Array} H hauteurs (w*h)
 * @param {number} azimuth azimut du soleil en degrés (0 = nord, 90 = est)
 * @param {number} altitude élévation du soleil en degrés
 * @param {number} cellMeters taille d'une cellule en mètres
 * @param {Float32Array} depth sortie (w*h)
 */
export function sweepShadows(H, w, h, azimuth, altitude, cellMeters, depth) {
  if (altitude <= 0) {
    depth.fill(NIGHT);
    return depth;
  }
  depth.fill(0);
  const az = azimuth * RAD;
  // Direction de propagation de l'ombre (on s'éloigne du soleil), x est, y sud.
  const dx = -Math.sin(az);
  const dy = Math.cos(az);
  const m = Math.max(Math.abs(dx), Math.abs(dy));
  const sx = dx / m;
  const sy = dy / m;
  const stepMeters = Math.hypot(sx, sy) * cellMeters;
  const drop = Math.tan(altitude * RAD) * stepMeters;

  const line = (x0, y0) => {
    let px = x0;
    let py = y0;
    let top = -Infinity;
    for (;;) {
      const ix = Math.round(px);
      const iy = Math.round(py);
      if (ix < 0 || ix >= w || iy < 0 || iy >= h) break;
      const i = iy * w + ix;
      const z = H[i];
      if (z < top) {
        const d = top - z;
        if (d > depth[i]) depth[i] = d;
      } else {
        top = z;
      }
      top -= drop;
      px += sx;
      py += sy;
    }
  };

  if (Math.abs(dx) >= Math.abs(dy)) {
    const x0 = sx > 0 ? 0 : w - 1;
    for (let y = 0; y < h; y++) line(x0, y);
    if (sy > 0) for (let x = 0; x < w; x++) line(x, 0);
    else if (sy < 0) for (let x = 0; x < w; x++) line(x, h - 1);
  } else {
    const y0 = sy > 0 ? 0 : h - 1;
    for (let x = 0; x < w; x++) line(x, y0);
    if (sx > 0) for (let y = 0; y < h; y++) line(0, y);
    else if (sx < 0) for (let y = 0; y < h; y++) line(w - 1, y);
  }
  return depth;
}

/**
 * Convertit la profondeur d'ombre en image RGBA.
 * style = { shadow: [r,g,b,a], night: [r,g,b,a], soft: boolean }
 */
export function depthToRGBA(depth, w, h, out, style) {
  const n = w * h;
  const rgba = out || new Uint8ClampedArray(n * 4);
  const [sr, sg, sb, sa] = style.shadow;
  const [nr, ng, nb, na] = style.night;
  const soft = !!style.soft;
  for (let i = 0; i < n; i++) {
    const d = depth[i];
    const j = i << 2;
    if (d >= NIGHT) {
      rgba[j] = nr;
      rgba[j + 1] = ng;
      rgba[j + 2] = nb;
      rgba[j + 3] = na;
    } else if (d > 0) {
      rgba[j] = sr;
      rgba[j + 1] = sg;
      rgba[j + 2] = sb;
      // Ombre un peu plus légère quand l'obstacle dépasse à peine (lisière), si demandé.
      rgba[j + 3] = soft ? Math.round(sa * Math.min(1, 0.55 + d / 4)) : sa;
    } else {
      rgba[j] = 0;
      rgba[j + 1] = 0;
      rgba[j + 2] = 0;
      rgba[j + 3] = 0;
    }
  }
  return rgba;
}

/**
 * Ensoleillement d'un point de la grille pour une liste d'instants.
 * samples = [{ azimuth, altitude }, …] ; retourne Uint8Array (1 = éclairé, 0 = à l'ombre / nuit).
 * @param {number} eyeHeight hauteur (m) au-dessus de la surface locale (ex. 1,5 m pour une personne)
 */
export function pointExposure(H, w, h, gx, gy, samples, cellMeters, eyeHeight = 0) {
  const out = new Uint8Array(samples.length);
  const ix0 = Math.min(w - 1, Math.max(0, Math.floor(gx)));
  const iy0 = Math.min(h - 1, Math.max(0, Math.floor(gy)));
  const z0 = H[iy0 * w + ix0] + eyeHeight;
  let maxH = -Infinity;
  for (let i = 0; i < H.length; i++) if (H[i] > maxH) maxH = H[i];
  for (let s = 0; s < samples.length; s++) {
    const { azimuth, altitude } = samples[s];
    if (altitude <= 0) {
      out[s] = 0;
      continue;
    }
    const az = azimuth * RAD;
    const dx = Math.sin(az);
    const dy = -Math.cos(az);
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    const sx = dx / m;
    const sy = dy / m;
    const stepMeters = Math.hypot(sx, sy) * cellMeters;
    const tanA = Math.tan(altitude * RAD);
    let px = gx + sx;
    let py = gy + sy;
    let dist = stepMeters;
    let lit = 1;
    for (;;) {
      const ix = Math.floor(px);
      const iy = Math.floor(py);
      if (ix < 0 || ix >= w || iy < 0 || iy >= h) break;
      const required = z0 + dist * tanA;
      if (required > maxH) break;
      if (H[iy * w + ix] > required + 0.01) {
        lit = 0;
        break;
      }
      px += sx;
      py += sy;
      dist += stepMeters;
    }
    out[s] = lit;
  }
  return out;
}
