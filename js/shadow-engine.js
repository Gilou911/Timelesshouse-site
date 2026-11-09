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

/**
 * Facteur d'échelle par ligne de grille : mètres par cellule sur la ligne y, rapportés à ceux de la latitude de référence.
 * (En Mercator, une cellule couvre d'autant moins de mètres que la latitude est élevée.)
 */
export function rowScaleFactors(grid, latRef) {
  const out = new Float32Array(grid.h);
  const cosRef = Math.cos(latRef * RAD);
  for (let y = 0; y < grid.h; y++) {
    const lat = mercatorToLngLat(0, grid.originY + (y + 0.5) * grid.cellUnits)[1];
    out[y] = Math.cos(lat * RAD) / cosRef;
  }
  return out;
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
    this.filledKeys = new Set();
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
    this.filledKeys.add(`${tx}/${ty}`);
  }

  /** Hauteur moyenne des tuiles chargées (échantillonnée), ou 0 si aucune. */
  meanFilledHeight() {
    if (this.filledKeys.size === 0) return 0;
    const ts = this.tileSize;
    let sum = 0;
    let n = 0;
    for (const key of this.filledKeys) {
      const [tx, ty] = key.split('/').map(Number);
      const ox = (tx - this.tx0) * ts;
      const oy = (ty - this.ty0) * ts;
      for (let y = 0; y < ts; y += 16) {
        const row = (oy + y) * this.width + ox;
        for (let x = 0; x < ts; x += 16) {
          sum += this.data[row + x];
          n++;
        }
      }
    }
    return n ? sum / n : 0;
  }

  /**
   * Remplit les tuiles non chargées avec une hauteur constante (par défaut la moyenne des tuiles chargées) :
   * un trou à 0 m au milieu d'un relief produirait de fausses ombres sur toute la tuile.
   * @returns nombre de tuiles comblées
   */
  fillUnfilled(value = this.meanFilledHeight()) {
    const ts = this.tileSize;
    let n = 0;
    for (let ty = this.ty0; ty < this.ty0 + this.ny; ty++) {
      for (let tx = this.tx0; tx < this.tx0 + this.nx; tx++) {
        if (this.filledKeys.has(`${tx}/${ty}`)) continue;
        const ox = (tx - this.tx0) * ts;
        const oy = (ty - this.ty0) * ts;
        for (let y = 0; y < ts; y++) this.data.fill(value, (oy + y) * this.width + ox, (oy + y) * this.width + ox + ts);
        n++;
      }
    }
    return n;
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
 * Le toit suit le relief (hauteur ajoutée au relief de chaque cellule), sans marche aux bords de tuiles.
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
    // Le toit suit le relief sous l'emprise (hauteur ajoutée cellule par cellule) : un toit plat calé sur le
    // centroïde créerait une marche à chaque bord de tuile vectorielle, où les emprises sont découpées.
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
          const top = T[i] + height;
          if (top > H[i]) H[i] = top;
          filled++;
        }
      }
    }
    if (filled === 0 && cx >= 0 && cx < w && cy >= 0 && cy < h) {
      // Bâtiment plus petit qu'une cellule : on marque la cellule du centroïde.
      const i = ccy * w + ccx;
      const top = T[i] + height;
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
 * @param {Float32Array} [T] relief seul (w*h) : s'il est fourni, le relief est lu au point exact du rayon
 */
export function sweepShadows(H, w, h, azimuth, altitude, cellMeters, depth, rowScale = null, T = null) {
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
  // Perte de hauteur de la ligne d'ombre par pas ; `rowScale` (facultatif, par ligne) corrige la variation
  // d'échelle de la projection Mercator avec la latitude sur les vues très étendues.
  const drop = Math.tan(altitude * RAD) * stepMeters;

  // Décalage entier arrondi AVANT l'ajout au point de départ : toutes les lignes partagent exactement le même
  // décalage au pas k (x0 + k·sx arrondi après addition pouvait basculer d'un côté ou de l'autre d'un demi-entier
  // selon x0, et sauter des cellules aux azimuts « à égalité »). Avec un décalage commun, la couverture est totale.
  // Ce décalage commun écarte toutes les lignes du vrai rayon de la même fraction de cellule au même pas : lire le
  // relief à la cellule arrondie donnait la même erreur de hauteur à toute une colonne (ou ligne), d'où des stries
  // d'ombre sur les pentes rasantes. Le relief est donc interpolé au point exact du rayon ; les bâtiments restent nets.
  const xMajor = Math.abs(dx) >= Math.abs(dy);
  const line = (x0, y0) => {
    let top = -Infinity;
    for (let k = 0; ; k++) {
      const ix = x0 + Math.round(k * sx);
      const iy = y0 + Math.round(k * sy);
      if (ix < 0 || ix >= w || iy < 0 || iy >= h) break;
      const i = iy * w + ix;
      let z = H[i];
      if (T) {
        let a;
        let b;
        let f;
        if (xMajor) {
          const p = y0 + k * sy;
          let j0 = Math.floor(p);
          f = p - j0;
          if (j0 < 0) { j0 = 0; f = 0; }
          const j1 = j0 + 1 < h ? j0 + 1 : j0;
          a = T[j0 * w + ix];
          b = T[j1 * w + ix];
        } else {
          const p = x0 + k * sx;
          let j0 = Math.floor(p);
          f = p - j0;
          if (j0 < 0) { j0 = 0; f = 0; }
          const j1 = j0 + 1 < w ? j0 + 1 : j0;
          a = T[iy * w + j0];
          b = T[iy * w + j1];
        }
        z += a + (b - a) * f - T[i];
      }
      if (z < top) {
        const d = top - z;
        if (d > depth[i]) depth[i] = d;
      } else {
        top = z;
      }
      top -= rowScale ? drop * rowScale[iy] : drop;
    }
  };

  if (xMajor) {
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
  const rgba = out && out.length === n * 4 ? out : new Uint8ClampedArray(n * 4);
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
export function pointExposure(H, w, h, gx, gy, samples, cellMeters, eyeHeight = 0, rowScale = null) {
  const out = new Uint8Array(samples.length);
  const ix0 = Math.min(w - 1, Math.max(0, Math.floor(gx)));
  const iy0 = Math.min(h - 1, Math.max(0, Math.floor(gy)));
  const z0 = H[iy0 * w + ix0] + eyeHeight;
  if (rowScale) cellMeters *= rowScale[iy0];
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

/**
 * Cumule, cellule par cellule, les minutes de soleil direct sur une liste d'instants (un balayage par instant).
 * samples = [{ azimuth, altitude }], chaque échantillon vaut `stepMinutes`.
 * `onProgress(k, n)` est appelé après chaque balayage (facultatif).
 */
export function accumulateExposure(H, w, h, samples, stepMinutes, cellMeters, rowScale, depth, acc, onProgress, grid) {
  acc.fill(0);
  const n = w * h;
  for (let k = 0; k < samples.length; k++) {
    const s = samples[k];
    const perCell = grid && Number.isFinite(s.declination) && Number.isFinite(s.minutesUTC);
    if (sunIsUp(s) || perCell) {
      if (grid) renderShadows(H, grid, s, cellMeters, rowScale, depth);
      else sweepShadows(H, w, h, s.azimuth, s.altitude, cellMeters, depth, rowScale);
      for (let i = 0; i < n; i++) if (depth[i] === 0) acc[i] += stepMinutes;
    }
    if (onProgress) onProgress(k + 1, samples.length);
  }
  return acc;
}

/** Rampe de couleurs (minutes de soleil → RGBA) : nuit bleue → pourpre → orange → jaune pâle. */
export const EXPOSURE_RAMP = [
  [0, 28, 36, 86],
  [0.25, 96, 58, 138],
  [0.5, 204, 92, 74],
  [0.75, 245, 166, 35],
  [1, 255, 238, 130],
];

export function exposureColor(t) {
  const r = EXPOSURE_RAMP;
  if (t <= 0) return [r[0][1], r[0][2], r[0][3]];
  if (t >= 1) return [r[r.length - 1][1], r[r.length - 1][2], r[r.length - 1][3]];
  for (let i = 1; i < r.length; i++) {
    if (t <= r[i][0]) {
      const a = r[i - 1];
      const b = r[i];
      const f = (t - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
    }
  }
  return [r[r.length - 1][1], r[r.length - 1][2], r[r.length - 1][3]];
}

/** Convertit le cumul (minutes) en image RGBA ; maxMinutes = durée du jour (ou valeur max). */
let EXPOSURE_LUT = null;
function exposureLUT() {
  if (EXPOSURE_LUT) return EXPOSURE_LUT;
  const lut = new Uint8ClampedArray(257 * 3);
  for (let i = 0; i <= 256; i++) {
    const c = exposureColor(i / 256);
    lut[i * 3] = c[0];
    lut[i * 3 + 1] = c[1];
    lut[i * 3 + 2] = c[2];
  }
  EXPOSURE_LUT = lut;
  return lut;
}

export function exposureToRGBA(acc, w, h, out, maxMinutes, alpha) {
  const n = w * h;
  const rgba = out && out.length === n * 4 ? out : new Uint8ClampedArray(n * 4);
  const lut = exposureLUT();
  const scale = maxMinutes > 0 ? 256 / maxMinutes : 0;
  for (let i = 0; i < n; i++) {
    let k = Math.round(acc[i] * scale);
    if (k > 256) k = 256;
    if (k < 0) k = 0;
    const j = i << 2;
    rgba[j] = lut[k * 3];
    rgba[j + 1] = lut[k * 3 + 1];
    rgba[j + 2] = lut[k * 3 + 2];
    rgba[j + 3] = alpha;
  }
  return rgba;
}

const SIN_HORIZON = Math.sin(-0.833 * RAD); // bord supérieur du disque solaire à l'horizon

/**
 * Masque jour/nuit cellule par cellule : la position du soleil varie avec la longitude (angle horaire)
 * et la latitude. Indispensable dès que la vue couvre plus de quelques degrés (terminateur).
 * sun = { declination (deg), eqTime (min), minutesUTC } ; `centerLit` indique si le balayage a été fait.
 * Les cellules sous l'horizon reçoivent NIGHT ; si le centre était de nuit mais la cellule de jour, elle est éclairée.
 */
export function applyNightMask(depth, grid, sun, centerLit) {
  const { w, h, originX, originY, cellUnits } = grid;
  const sinD = Math.sin(sun.declination * RAD);
  const cosD = Math.cos(sun.declination * RAD);
  const cosHA = new Float64Array(w);
  for (let x = 0; x < w; x++) {
    const lng = (originX + (x + 0.5) * cellUnits) * 360 - 180;
    const ha = ((sun.minutesUTC + sun.eqTime + 4 * lng) / 4 - 180) * RAD;
    cosHA[x] = Math.cos(ha);
  }
  for (let y = 0; y < h; y++) {
    const lat = mercatorToLngLat(0, originY + (y + 0.5) * cellUnits)[1] * RAD;
    const a = Math.sin(lat) * sinD;
    const b = Math.cos(lat) * cosD;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const sinAlt = a + b * cosHA[x];
      if (sinAlt <= SIN_HORIZON) depth[row + x] = NIGHT;
      else if (!centerLit) depth[row + x] = 0;
    }
  }
  return depth;
}

export const HORIZON_ALTITUDE = -0.833; // élévation géométrique du centre du soleil au lever/coucher (bord supérieur)

/** Le soleil est-il levé ? Même définition que le lever/coucher affichés (bord supérieur du disque). */
export function sunIsUp(sun) {
  const geom = Number.isFinite(sun.altitudeGeometric) ? sun.altitudeGeometric : sun.altitude;
  return geom > HORIZON_ALTITUDE;
}

/**
 * Rendu complet des ombres pour un instant : balayage (avec élévation apparente, bornée à un minimum quand le soleil
 * affleure l'horizon) puis masque jour/nuit cellule par cellule quand les paramètres solaires sont fournis.
 * Les deux étapes partagent la même définition du soleil levé, pour éviter tout éclair au lever/coucher.
 */
export function renderShadows(H, grid, sun, cellMeters, rowScale, depth, T = null) {
  const { w, h } = grid;
  const up = sunIsUp(sun);
  const altitude = up ? Math.max(sun.altitude, 0.05) : Math.min(sun.altitude, 0);
  sweepShadows(H, w, h, sun.azimuth, altitude, cellMeters, depth, rowScale, T);
  if (Number.isFinite(sun.declination) && Number.isFinite(sun.minutesUTC)) applyNightMask(depth, grid, sun, up);
  return depth;
}
