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

const SEAM_WINDOW = 8; // voir DemMosaic.smoothSeams

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

  /**
   * Adoucit les raccords entre deux tuiles chargées voisines. Aux zooms 14 et 15, les tuiles Terrarium sont agrandies
   * depuis un relief plus grossier, chacune un peu trop serrée : d'un côté à l'autre d'un raccord, la hauteur varie de
   * 1,2 à 1,8 fois la pente locale, comme s'il manquait un demi-pixel de terrain. Le balayage y voyait un petit mur,
   * d'où une fausse ligne d'ombre droite. Sur chaque ligne qui traverse un raccord, l'excès sur la pente voisine est
   * réparti en rampe jusqu'au milieu des deux tuiles : une rampe courte raidirait la pente en bande le long du raccord.
   * L'excès est moyenné sur ±SEAM_WINDOW pixels le long du raccord : sur un relief fin (natif), il n'est que du bruit,
   * à ne pas étirer en stries. Les tuiles comblées (fillUnfilled) ne sont pas lissées.
   */
  smoothSeams() {
    const ts = this.tileSize;
    const w = this.width;
    const d = this.data;
    const half = ts >> 1;
    const excess = new Float32Array(ts);
    for (const vertical of [true, false]) {
      const step = vertical ? 1 : w; // d'un pixel au suivant, en travers du raccord
      for (let ty = this.ty0; ty < this.ty0 + this.ny; ty++) {
        for (let tx = this.tx0; tx < this.tx0 + this.nx; tx++) {
          if (!this.filledKeys.has(`${tx}/${ty}`) || !this.filledKeys.has(vertical ? `${tx + 1}/${ty}` : `${tx}/${ty + 1}`)) continue;
          const ox = (tx - this.tx0) * ts;
          const oy = (ty - this.ty0) * ts;
          const first = (t) => (vertical ? (oy + t) * w + ox + ts : (oy + ts) * w + ox + t); // 1er pixel après le raccord
          for (let t = 0; t < ts; t++) {
            const i = first(t);
            const b = d[i - step];
            const c = d[i];
            const slope = (b - d[i - 2 * step] + d[i + step] - c) / 2;
            // Plus grand que la pente voisine, ce n'est plus la marche d'un raccord : une falaise, ou une tuile vide
            // (Terrarium en sert, à 0 m), qu'il ne faut pas étaler sur la tuile d'à côté.
            excess[t] = Math.abs(c - b - slope) <= Math.abs(slope) ? c - b - slope : 0;
          }
          for (let t = 0; t < ts; t++) {
            const u0 = Math.max(0, t - SEAM_WINDOW);
            const u1 = Math.min(ts - 1, t + SEAM_WINDOW);
            let sum = 0;
            for (let u = u0; u <= u1; u++) sum += excess[u];
            const e = sum / (u1 - u0 + 1) / 2; // moitié de la marche, retirée de chaque côté
            const i = first(t);
            for (let k = 0; k < half; k++) {
              const f = e * (1 - k / half);
              d[i + k * step] -= f;
              d[i - (k + 1) * step] += f;
            }
          }
        }
      }
    }
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
 * `canopy` (Uint8Array w*h, facultatif) : mode arbres. Seul le sol nu (ou un bois déjà posé) est relevé, jamais un
 * bâtiment, et chaque cellule boisée y est marquée (voir surfaceAt).
 * @returns nombre de polygones ayant touché au moins une cellule
 */
export function rasterizeBuildings(H, T, grid, buildings, canopy = null) {
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
    const fill = (i) => {
      if (canopy) {
        if (H[i] > T[i] && !canopy[i]) return 0;
        canopy[i] = 1;
      }
      const top = T[i] + height;
      if (top > H[i]) H[i] = top;
      return 1;
    };
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
        for (let x = xa; x <= xb; x++) filled += fill(y * w + x);
      }
    }
    // Bâtiment plus petit qu'une cellule : on marque la cellule du centroïde.
    if (filled === 0 && cx >= 0 && cx < w && cy >= 0 && cy < h) filled = fill(ccy * w + ccx);
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

const MAX_TREE_SHADOW = 400; // m : soleil très bas, l'ombre d'un arbre est coupée là (elle se perd dans celles du relief)

/**
 * Ombres des arbres isolés, ajoutées à `depth` après le balayage. Chaque houppier est un ellipsoïde en l'air (rayon r,
 * demi-hauteur rv, centre à cz m) : une cellule est à l'ombre si le rayon qui part de sa surface (H) vers le soleil le
 * traverse. L'ombre se détache donc du pied de l'arbre quand le soleil baisse (le tronc n'en porte pas).
 * trees = { n, gx, gy (cellules), cz, r, rv, base (sol au pied, m) }. On ne parcourt que la bande, large comme le
 * houppier, qui va du houppier au bout de son ombre sur un sol 5 m plus bas que le pied (400 m au plus).
 */
export function castTreeShadows(depth, H, w, h, trees, azimuth, altitude, cellMeters, rowScale = null) {
  if (!trees || !trees.n || altitude <= 0) return depth;
  const az = azimuth * RAD;
  const ux = Math.sin(az); // vers le soleil, x vers l'est
  const uy = -Math.cos(az); // vers le soleil, y vers le sud
  const cosA = Math.cos(altitude * RAD);
  const sinA = Math.sin(altitude * RAD);
  const tanA = sinA / cosA;
  for (let t = 0; t < trees.n; t++) {
    const gx = trees.gx[t];
    const gy = trees.gy[t];
    const cz = trees.cz[t];
    const r = trees.r[t];
    const top = cz + trees.rv[t];
    const cm = cellMeters * (rowScale ? rowScale[Math.min(h - 1, Math.max(0, Math.floor(gy)))] : 1);
    // Hauteurs multipliées par k = r / rv : le houppier devient une sphère de rayon r, le rayon de soleil (sx, sy, sz).
    const k = r / trees.rv[t];
    let sx = cosA * ux;
    let sy = cosA * uy;
    let sz = sinA * k;
    const sn = Math.hypot(sx, sy, sz);
    sx /= sn;
    sy /= sn;
    sz /= sn;
    // Bande de l'ombre, en mètres depuis le tronc : s le long de l'ombre (à l'opposé du soleil), de −r (bord du
    // houppier côté soleil) au bout de l'ellipse d'ombre la plus lointaine (centre, plus demi-grand axe r / sz) ;
    // q en travers, à ±r. Une cellule de marge partout.
    const sMin = -r - cm;
    const sMax = Math.min(MAX_TREE_SHADOW, (cz - trees.base[t] + 5) / tanA + r / sz) + cm;
    const qMax = r + cm;
    let yLo = Infinity;
    let yHi = -Infinity;
    for (const bs of [sMin, sMax]) {
      for (const bq of [-qMax, qMax]) {
        const y = -bs * uy + bq * ux; // point s·(−u) + q·v, v = (−uy, ux)
        if (y < yLo) yLo = y;
        if (y > yHi) yHi = y;
      }
    }
    const r2 = r * r;
    const iy0 = Math.max(0, Math.floor(gy + yLo / cm));
    const iy1 = Math.min(h - 1, Math.floor(gy + yHi / cm));
    for (let iy = iy0; iy <= iy1; iy++) {
      const dy = (iy + 0.5 - gy) * cm;
      // Sur cette ligne : ux·dx ∈ [−sMax − uy·dy, −sMin − uy·dy] et −uy·dx ∈ [−qMax − ux·dy, qMax − ux·dy].
      let lo = -Infinity;
      let hi = Infinity;
      const a0 = -sMax - uy * dy;
      const a1 = -sMin - uy * dy;
      if (Math.abs(ux) < 1e-9) {
        if (a0 > 0 || a1 < 0) continue;
      } else {
        lo = Math.min(a0 / ux, a1 / ux);
        hi = Math.max(a0 / ux, a1 / ux);
      }
      const b0 = -qMax - ux * dy;
      const b1 = qMax - ux * dy;
      if (Math.abs(uy) < 1e-9) {
        if (b0 > 0 || b1 < 0) continue;
      } else {
        lo = Math.max(lo, Math.min(-b0 / uy, -b1 / uy));
        hi = Math.min(hi, Math.max(-b0 / uy, -b1 / uy));
      }
      if (lo > hi) continue;
      const ix0 = Math.max(0, Math.floor(gx + lo / cm));
      const ix1 = Math.min(w - 1, Math.floor(gx + hi / cm));
      for (let ix = ix0; ix <= ix1; ix++) {
        const i = iy * w + ix;
        const zp = H[i];
        if (zp >= top) continue;
        const dx = (ix + 0.5 - gx) * cm;
        const dz = k * (cz - zp);
        const proj = -dx * sx - dy * sy + dz * sz; // du point vers le centre du houppier, le long du rayon
        if (proj <= 0) continue;
        if (dx * dx + dy * dy + dz * dz - proj * proj < r2 && top - zp > depth[i]) depth[i] = top - zp;
      }
    }
  }
  return depth;
}

/**
 * Arbres isolés autour d'un point (voir pointExposure) : écarts en mètres (est, nord) et hauteur du centre du
 * houppier au-dessus de l'œil (z0), rangés par tranches d'azimut d'un degré : à chaque instant, seuls ceux qui sont
 * dans la direction du soleil sont testés. `under` : le point est sous un houppier.
 */
export function treesAround(trees, gx, gy, z0, cellMeters, maxDist = 500) {
  const list = [];
  const bins = Array.from({ length: 360 }, () => []);
  let under = false;
  for (let t = 0; t < trees.n; t++) {
    const dx = (trees.gx[t] - gx) * cellMeters;
    const dy = (gy - trees.gy[t]) * cellMeters;
    const dist = Math.hypot(dx, dy);
    const r = trees.r[t];
    const rv = trees.rv[t];
    const dz = trees.cz[t] - z0;
    if (dist > maxDist || dz + rv <= 0) continue;
    if (dist < r) under = true;
    const j = list.length;
    list.push({
      dx, dy, dz, r, rv,
      maxAlt: Math.atan2(dz + rv, Math.max(0.01, dist - r)) / RAD, // au-dessus, le soleil passe par-dessus la cime
      minAlt: Math.atan2(dz - rv, dist + r) / RAD, // au-dessous, il passe sous le houppier
    });
    const half = dist <= r ? 180 : Math.asin(r / dist) / RAD + 1;
    const az = (Math.atan2(dx, dy) / RAD + 360) % 360;
    const lo = Math.floor(az - half);
    for (let b = lo; b <= Math.floor(az + half) && b < lo + 360; b++) bins[((b % 360) + 360) % 360].push(j);
  }
  return { list, bins, under };
}

/** Un des arbres de `near` (treesAround) cache-t-il le soleil ? */
export function treeBlocksSun(near, azimuth, altitude) {
  const bin = near.bins[((Math.floor(azimuth) % 360) + 360) % 360];
  if (!bin.length) return false;
  const cosA = Math.cos(altitude * RAD);
  const sinA = Math.sin(altitude * RAD);
  const ex = cosA * Math.sin(azimuth * RAD);
  const ny = cosA * Math.cos(azimuth * RAD);
  for (const j of bin) {
    const t = near.list[j];
    if (altitude > t.maxAlt || altitude < t.minAlt) continue;
    const k = t.r / t.rv;
    const sz = sinA * k;
    const dz = k * t.dz;
    const proj = (t.dx * ex + t.dy * ny + dz * sz) / Math.hypot(cosA, sz);
    if (proj > 0 && t.dx * t.dx + t.dy * t.dy + dz * dz - proj * proj < t.r * t.r) return true;
  }
  return false;
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
 * @param {object} [opts] { base } : surface (m) sous le point si ce n'est pas H (un point dans un bois est au sol) ;
 *   { horizon } : horizon lointain au-delà de la grille (voir horizonProfile), le soleil doit passer au-dessus ;
 *   { trees } : arbres isolés autour du point (treesAround), leurs houppiers arrêtent le soleil
 */
export function pointExposure(H, w, h, gx, gy, samples, cellMeters, eyeHeight = 0, rowScale = null, opts = {}) {
  const out = new Uint8Array(samples.length);
  const ix0 = Math.min(w - 1, Math.max(0, Math.floor(gx)));
  const iy0 = Math.min(h - 1, Math.max(0, Math.floor(gy)));
  const z0 = (opts.base ?? H[iy0 * w + ix0]) + eyeHeight;
  const hz = opts.horizon;
  if (rowScale) cellMeters *= rowScale[iy0];
  let maxH = -Infinity;
  for (let i = 0; i < H.length; i++) if (H[i] > maxH) maxH = H[i];
  for (let s = 0; s < samples.length; s++) {
    const { azimuth, altitude } = samples[s];
    if (altitude <= 0) {
      out[s] = 0;
      continue;
    }
    if (hz) {
      const f = ((((azimuth % 360) + 360) % 360) * hz.length) / 360;
      const a0 = Math.floor(f) % hz.length;
      const a1 = (a0 + 1) % hz.length;
      if (altitude <= hz[a0] + (hz[a1] - hz[a0]) * (f - Math.floor(f))) {
        out[s] = 0;
        continue;
      }
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
    if (lit && opts.trees && treeBlocksSun(opts.trees, azimuth, altitude)) lit = 0;
    out[s] = lit;
  }
  return out;
}

// Courbure de la Terre vue à travers l'atmosphère (coefficient de réfraction 0,13) : un relief à d mètres paraît
// plus bas de d² × CURVATURE.
const CURVATURE = (1 - 0.13) / (2 * EARTH_RADIUS);

/**
 * Horizon lointain d'un point : pour chacun des n azimuts (0 = nord, sens horaire), la plus grande élévation apparente
 * (degrés) du relief entre start[a] et `radius` mètres, par pas de `step` mètres. `elevAt(est, nord)` lit le relief
 * (m) à ce décalage en mètres ; z0 est l'altitude de l'œil. -90 là où rien n'est lu.
 */
export function horizonProfile(elevAt, z0, start, radius, step, n = 360) {
  const out = new Float32Array(n).fill(-90);
  for (let a = 0; a < n; a++) {
    const az = (a * 360 * RAD) / n;
    const ex = Math.sin(az);
    const ny = Math.cos(az);
    let best = -Infinity;
    for (let d = Math.max(step, start[a]); d <= radius; d += step) {
      const t = (elevAt(d * ex, d * ny) - d * d * CURVATURE - z0) / d;
      if (t > best) best = t;
    }
    if (best > -Infinity) out[a] = Math.atan(best) / RAD;
  }
  return out;
}

/** Surface où se tient un point : le toit d'un bâtiment, mais le sol dans un bois (on y est sous les arbres). */
export function surfaceAt(H, T, canopy, i) {
  return canopy && canopy[i] ? T[i] : H[i];
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
export function renderShadows(H, grid, sun, cellMeters, rowScale, depth, T = null, trees = null) {
  const { w, h } = grid;
  const up = sunIsUp(sun);
  const altitude = up ? Math.max(sun.altitude, 0.05) : Math.min(sun.altitude, 0);
  sweepShadows(H, w, h, sun.azimuth, altitude, cellMeters, depth, rowScale, T);
  if (up && trees) castTreeShadows(depth, H, w, h, trees, sun.azimuth, altitude, cellMeters, rowScale);
  if (Number.isFinite(sun.declination) && Number.isFinite(sun.minutesUTC)) applyNightMask(depth, grid, sun, up);
  return depth;
}
