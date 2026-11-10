// Arbres isolés : la liste de la Ville de Paris (dans Paris) et les arbres d'OpenStreetMap (partout), chargés par tuile.
// Lecture des réponses, forme d'un arbre et volumes 3D sont des fonctions pures (testées dans Node) ; TreeStore ne
// sert que dans la page. Un arbre est rangé à plat : [lng, lat, hauteur, diamètre du houppier, …], 0 = inconnu.

export const TREE_TILE_ZOOM = 15; // tuiles d'environ 800 m de côté à Paris
export const TREES_MIN_ZOOM = 15; // plus loin, un houppier fait moins d'une cellule de calcul
// Emprise de la liste de la Ville de Paris : Paris avec les bois de Boulogne et de Vincennes ([ouest, sud, est, nord]).
export const PARIS_BOUNDS = [2.22, 48.81, 2.475, 48.905];
const DEFAULT_HEIGHT = 10; // un arbre de rue moyen, quand ni hauteur ni circonférence ne sont connues
const ROW_SPACING = 8; // m entre deux arbres d'un alignement tracé comme une ligne (natural=tree_row)
const DEDUPE_METERS = 3; // un arbre d'OpenStreetMap à moins de 3 m d'un arbre de la Ville est le même arbre
const M_PER_DEG = 111320;

/** Longueur lue dans une étiquette d'OpenStreetMap : « 12 », « 12 m », « 12,5 », « 120 cm », « 40 ft ». */
export function parseMeters(v) {
  if (v == null) return 0;
  const m = String(v).trim().replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*(m|cm|mm|ft|'|)$/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  return unit === 'cm' ? n / 100 : unit === 'mm' ? n / 1000 : unit === 'ft' || unit === "'" ? n * 0.3048 : n;
}

/** Hauteur estimée d'après la circonférence du tronc (m) : environ 30 m par mètre de diamètre, entre 4 et 30 m. */
export function heightFromGirth(c) {
  if (!(c >= 0.1 && c <= 12)) return 0;
  return Math.min(30, Math.max(4, 4 + (30 * c) / Math.PI));
}

/**
 * Forme simplifiée d'un arbre : un houppier en ellipsoïde posé sur un tronc. Hauteur h (m), rayon du houppier r,
 * base du houppier hb. Sans diamètre connu, le houppier fait 0,6 fois la hauteur (2 à 16 m) ; il commence au tiers
 * de la hauteur, entre 1,5 et 5 m (les arbres de rue sont élagués pour laisser passer).
 */
export function treeShape(height, diameter) {
  const h = height >= 1.5 && height <= 60 ? height : DEFAULT_HEIGHT;
  const d = diameter >= 1 && diameter <= 40 ? diameter : Math.min(16, Math.max(2, 0.6 * h));
  const hb = Math.min(h - 1, Math.min(5, Math.max(1.5, 0.3 * h)));
  return { h, r: d / 2, hb };
}

/** Réponse de l'API de la Ville de Paris (jeu « les-arbres ») → arbres à plat. */
export function parisTrees(records) {
  const out = [];
  for (const rec of Array.isArray(records) ? records : []) {
    const p = rec && rec.geo_point_2d;
    if (!p || !Number.isFinite(p.lon) || !Number.isFinite(p.lat)) continue;
    let h = Number(rec.hauteurenm);
    // La liste porte des hauteurs nulles ou aberrantes (saisies à 0, ou en cm) : on se rabat sur la circonférence.
    if (!(h >= 1.5 && h <= 45)) h = heightFromGirth(Number(rec.circonferenceencm) / 100);
    out.push(p.lon, p.lat, h, 0);
  }
  return out;
}

/** Réponse d'Overpass (voir overpassQuery) → arbres à plat ; un alignement donne un arbre tous les 8 m. */
export function osmTrees(json) {
  const out = [];
  for (const e of (json && json.elements) || []) {
    const tags = e.tags || {};
    if (e.type === 't' || e.type === 'node') {
      const c = e.geometry && e.geometry.coordinates;
      const lng = c ? c[0] : e.lon;
      const lat = c ? c[1] : e.lat;
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      let h = parseMeters(tags.h ?? tags.height);
      if (!(h >= 1.5 && h <= 60)) h = heightFromGirth(parseMeters(tags.c ?? tags.circumference));
      out.push(lng, lat, h, parseMeters(tags.d ?? tags.diameter_crown));
    } else if (e.type === 'way' && Array.isArray(e.geometry)) {
      const h = parseMeters(tags.height);
      const d = parseMeters(tags.diameter_crown);
      // Un sommet hors de l'emprise demandée peut arriver vide (null) : on garde les autres.
      const g = e.geometry.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
      if (g.length < 2) continue;
      const kx = M_PER_DEG * Math.cos((g[0].lat * Math.PI) / 180);
      const seg = [];
      let total = 0;
      for (let i = 1; i < g.length; i++) {
        const len = Math.hypot((g[i].lon - g[i - 1].lon) * kx, (g[i].lat - g[i - 1].lat) * M_PER_DEG);
        seg.push(len);
        total += len;
      }
      // Un arbre à chaque bout, et autant d'intervalles égaux que l'alignement en contient de 8 m environ.
      const n = Math.max(1, Math.round(total / ROW_SPACING));
      let i = 0;
      let start = 0; // longueur cumulée au début du segment i
      for (let k = 0; k <= n; k++) {
        const at = (total * k) / n;
        while (i < seg.length - 1 && start + seg[i] < at) start += seg[i++];
        const f = seg[i] > 0 ? Math.min(1, (at - start) / seg[i]) : 0;
        out.push(g[i].lon + (g[i + 1].lon - g[i].lon) * f, g[i].lat + (g[i + 1].lat - g[i].lat) * f, h, d);
      }
    }
  }
  return out;
}

/** Arbres d'OpenStreetMap qui ne sont pas déjà dans la liste de la Ville (à moins de 3 m d'un des siens). */
export function withoutDuplicates(osm, paris) {
  if (!paris.length || !osm.length) return osm;
  const kx = M_PER_DEG * Math.cos((paris[1] * Math.PI) / 180);
  const cell = (lng, lat) => [Math.floor((lng * kx) / DEDUPE_METERS), Math.floor((lat * M_PER_DEG) / DEDUPE_METERS)];
  const seen = new Map();
  for (let i = 0; i < paris.length; i += 4) {
    const [cx, cy] = cell(paris[i], paris[i + 1]);
    const key = `${cx}/${cy}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(i);
  }
  const out = [];
  for (let i = 0; i < osm.length; i += 4) {
    const [cx, cy] = cell(osm[i], osm[i + 1]);
    let dup = false;
    for (let dx = -1; dx <= 1 && !dup; dx++) {
      for (let dy = -1; dy <= 1 && !dup; dy++) {
        for (const j of seen.get(`${cx + dx}/${cy + dy}`) || []) {
          if (Math.hypot((osm[i] - paris[j]) * kx, (osm[i + 1] - paris[j + 1]) * M_PER_DEG) < DEDUPE_METERS) {
            dup = true;
            break;
          }
        }
      }
    }
    if (!dup) out.push(osm[i], osm[i + 1], osm[i + 2], osm[i + 3]);
  }
  return out;
}

/** Tuile (x, y) du zoom z qui contient le point. */
export function tileOf(lng, lat, z) {
  const n = 2 ** z;
  const phi = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n);
  return [Math.min(n - 1, Math.max(0, x)), Math.min(n - 1, Math.max(0, y))];
}

/** Emprise [ouest, sud, est, nord] (degrés) de la tuile. */
export function tileBounds(x, y, z) {
  const n = 2 ** z;
  const lat = (t) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * t) / n))) * 180) / Math.PI;
  return [(x / n) * 360 - 180, lat(y + 1), ((x + 1) / n) * 360 - 180, lat(y)];
}

/** Requête Overpass : arbres (avec leurs seules mesures) et alignements d'arbres de l'emprise. */
export function overpassQuery([w, s, e, n]) {
  const b = [s, w, n, e].map((v) => v.toFixed(6)).join(',');
  return `[out:json][timeout:90][bbox:${b}];node["natural"="tree"];convert t ::geom=geom(),h=t["height"],d=t["diameter_crown"],c=t["circumference"];out geom qt;way["natural"="tree_row"];out geom qt;`;
}

const intersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

// Houppier en cinq tranches de cylindre : [bas, haut] en fraction de sa hauteur, rayon pris au milieu de la tranche
// sur un ellipsoïde (√(1 − z²), z de −1 en bas à 1 en haut). Assez rond vu de près, assez léger pour des milliers.
const CROWN_SLABS = [[0, 0.15], [0.15, 0.4], [0.4, 0.7], [0.7, 0.88], [0.88, 1]].map(([a, b]) => {
  const z = a + b - 1; // milieu de la tranche, ramené à [−1, 1]
  return [a, b, Math.sqrt(1 - z * z)];
});

/**
 * Volumes 3D des arbres (GeoJSON pour une couche fill-extrusion) : un tronc carré et un houppier arrondi en cinq
 * tranches de cylindre. Propriétés : b = base, t = sommet (m), k = 0 tronc, 1 houppier.
 */
export function treeFeatures(trees) {
  const features = [];
  const ring = (lng, lat, r, n, rot) => {
    const kx = 1 / (M_PER_DEG * Math.cos((lat * Math.PI) / 180));
    const out = [];
    for (let i = 0; i <= n; i++) {
      const a = rot + (2 * Math.PI * (i % n)) / n;
      out.push([lng + r * Math.sin(a) * kx, lat + (r * Math.cos(a)) / M_PER_DEG]);
    }
    return [out];
  };
  for (let i = 0; i < trees.length; i += 4) {
    const lng = trees[i];
    const lat = trees[i + 1];
    const { h, r, hb } = treeShape(trees[i + 2], trees[i + 3]);
    const c = h - hb; // hauteur du houppier
    const trunk = Math.max(0.15, Math.min(0.5, r * 0.08));
    features.push({ type: 'Feature', properties: { b: 0, t: hb + 0.2 * c, k: 0 }, geometry: { type: 'Polygon', coordinates: ring(lng, lat, trunk, 4, Math.PI / 4) } });
    for (const [z0, z1, f] of CROWN_SLABS) {
      features.push({ type: 'Feature', properties: { b: hb + z0 * c, t: hb + z1 * c, k: 1 }, geometry: { type: 'Polygon', coordinates: ring(lng, lat, r * f, 10, 0) } });
    }
  }
  return { type: 'FeatureCollection', features };
}

const CACHE_NAME = 'ombres-arbres-1';
const CACHE_DAYS = 30;
const RETRY_FAILED_MS = 120000; // une tuile en échec est redemandée deux minutes plus tard, si on y revient
const OVERPASS_WAITS = [5000, 15000, 45000]; // serveur public saturé : il demande d'attendre de plus en plus
// Serveur saturé ou injoignable : les tuiles encore à l'écran sont redemandées seules, de plus en plus espacées.
const AUTO_RETRY_MS = [60000, 120000, 240000, 480000];
// Saturé (429, 502, 503, 504) ou réseau (pas de statut) : on peut réessayer ; une autre erreur est définitive.
const isBusy = (err) => !err.status || [429, 502, 503, 504].includes(err.status);

async function fetchJSON(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, mode: 'cors', credentials: 'omit', signal: ctrl.signal });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Charge les arbres par tuile, les garde en mémoire et dans le cache du navigateur (30 jours : Overpass met souvent
 * plus de 20 s à répondre). Une seule requête par source à la fois, sur l'emprise de toutes les tuiles manquantes.
 * `onUpdate()` est appelé à chaque arrivée (ou au premier échec), pour recalculer. Serveur saturé : nouvel essai seul
 * au bout de 1, 2, 4 puis toutes les 8 minutes, pour les tuiles encore à l'écran. `delays` : attentes (tests).
 */
export class TreeStore {
  constructor({ parisUrl, overpassUrl, onUpdate, delays = {} }) {
    this.urls = { paris: parisUrl, osm: overpassUrl };
    this.onUpdate = onUpdate;
    this.delays = { paris: 3000, overpass: OVERPASS_WAITS, auto: AUTO_RETRY_MS, ...delays };
    this.tiles = new Map(); // "x/y" → { paris, osm } : tableau d'arbres, 'cache', 'queued', 'loading' ou { failed: t }
    this.busy = { paris: false, osm: false };
    this.failures = { paris: 0, osm: 0 }; // échecs de suite, par source
    this.retryTimers = { paris: null, osm: null };
    this.wanted = [];
    this.version = 0;
  }

  /** Arbres connus dans l'emprise [ouest, sud, est, nord] (et seulement là) ; lance le chargement des tuiles qui manquent. */
  request(bounds) {
    const z = TREE_TILE_ZOOM;
    const [x0, y1] = tileOf(bounds[0], bounds[1], z);
    const [x1, y0] = tileOf(bounds[2], bounds[3], z);
    const keys = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) keys.push(`${x}/${y}`);
    this.wanted = keys;
    const trees = [];
    let loading = false;
    let failed = false;
    let paris = false;
    for (const key of keys) {
      const t = this._tile(key);
      for (const src of this._sources(key)) {
        const v = t[src];
        if (v && v.failed !== undefined) {
          if (Date.now() - v.failed > RETRY_FAILED_MS) t[src] = undefined;
          else failed = true;
        }
        if (!Array.isArray(t[src]) && !(t[src] && t[src].failed !== undefined)) loading = true;
      }
      const city = Array.isArray(t.paris) ? t.paris : [];
      const osm = Array.isArray(t.osm) ? t.osm : [];
      for (const list of [city, city.length ? withoutDuplicates(osm, city) : osm]) {
        for (let i = 0; i < list.length; i += 4) {
          const lng = list[i];
          const lat = list[i + 1];
          if (lng >= bounds[0] && lng <= bounds[2] && lat >= bounds[1] && lat <= bounds[3]) {
            trees.push(lng, lat, list[i + 2], list[i + 3]);
            if (list === city) paris = true;
          }
        }
      }
    }
    this._pump();
    // paris : des arbres de la Ville dans l'emprise (leur crédit doit alors s'afficher) ; retrying : nouvel essai prévu.
    const retrying = !!(this.retryTimers.paris || this.retryTimers.osm);
    return { trees, loading, failed, retrying, paris, key: `${this.version}|${bounds.map((v) => v.toFixed(5)).join()}` };
  }

  _tile(key) {
    let t = this.tiles.get(key);
    if (!t) {
      t = {};
      this.tiles.set(key, t);
      // Mémoire bornée : on oublie les tuiles les plus anciennes qui ne sont plus regardées.
      if (this.tiles.size > 400) {
        for (const k of this.tiles.keys()) {
          if (this.tiles.size <= 300) break;
          if (!this.wanted.includes(k) && Object.values(this.tiles.get(k)).every((v) => Array.isArray(v) || v === undefined)) this.tiles.delete(k);
        }
      }
    }
    return t;
  }

  _sources(key) {
    const [x, y] = key.split('/').map(Number);
    return this.urls.paris && intersects(tileBounds(x, y, TREE_TILE_ZOOM), PARIS_BOUNDS) ? ['paris', 'osm'] : ['osm'];
  }

  _pump() {
    const unknown = [];
    for (const key of this.wanted) {
      const t = this._tile(key);
      for (const src of this._sources(key)) {
        if (t[src] === undefined) {
          t[src] = 'cache';
          unknown.push([key, src]);
        }
      }
    }
    // Toutes les tuiles inconnues sont cherchées ensemble dans le cache : les absentes partent en une seule requête.
    if (unknown.length) this._fromCache(unknown);
    for (const src of ['paris', 'osm']) {
      if (this.busy[src]) continue;
      const keys = this.wanted.filter((k) => this.tiles.get(k)[src] === 'queued');
      if (keys.length) this._fetch(src, keys);
    }
  }

  async _fromCache(list) {
    let cache = null;
    try {
      cache = await caches.open(CACHE_NAME);
    } catch {
      cache = null; // pas de cache (navigation privée, Node) : on passe par le réseau
    }
    let hits = 0;
    await Promise.all(list.map(async ([key, src]) => {
      let hit = null;
      try {
        const res = cache && (await cache.match(this._cacheUrl(key, src)));
        const body = res && (await res.json());
        if (body && Date.now() - body.t < CACHE_DAYS * 86400000 && Array.isArray(body.trees)) hit = body.trees;
      } catch {
        hit = null;
      }
      const t = this._tile(key);
      if (t[src] !== 'cache') return; // arrivé entre-temps par le réseau
      t[src] = hit || 'queued';
      if (hit) hits++;
    }));
    if (hits) {
      this.version++;
      this.onUpdate();
    }
    this._pump();
  }

  _cacheUrl(key, src) {
    const base = typeof location !== 'undefined' ? location.origin : 'https://ombres.invalid';
    return `${base}/__ombres-cache/arbres/${src}/${TREE_TILE_ZOOM}/${key}`;
  }

  async _fetch(src, keys) {
    this.busy[src] = true;
    const xy = keys.map((k) => k.split('/').map(Number));
    const xs = xy.map((p) => p[0]);
    const ys = xy.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const covered = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) covered.push(`${x}/${y}`);
    for (const k of covered) {
      const t = this._tile(k);
      if (!Array.isArray(t[src])) t[src] = 'loading';
    }
    const [w, , , n] = tileBounds(x0, y0, TREE_TILE_ZOOM);
    const [, s, e] = tileBounds(x1, y1, TREE_TILE_ZOOM);
    let flat = null;
    let busy = false;
    try {
      flat = src === 'paris' ? await this._paris([w, s, e, n]) : await this._overpass([w, s, e, n]);
    } catch (err) {
      flat = null;
      busy = isBusy(err);
    }
    // Rangement par tuile : toutes celles de l'emprise sont complètes, même vides.
    const byTile = new Map(covered.map((k) => [k, []]));
    if (flat) {
      for (let i = 0; i < flat.length; i += 4) {
        const [x, y] = tileOf(flat[i], flat[i + 1], TREE_TILE_ZOOM);
        const list = byTile.get(`${x}/${y}`);
        if (list) list.push(flat[i], flat[i + 1], Math.round(flat[i + 2] * 10) / 10, Math.round(flat[i + 3] * 10) / 10);
      }
    }
    let cache = null;
    try {
      cache = flat ? await caches.open(CACHE_NAME) : null;
    } catch {
      cache = null;
    }
    for (const [k, list] of byTile) {
      const t = this._tile(k);
      if (!flat) {
        if (!Array.isArray(t[src])) t[src] = { failed: Date.now() }; // un échec n'efface pas ce qui était déjà là
        continue;
      }
      t[src] = list;
      if (cache) cache.put(this._cacheUrl(k, src), new Response(JSON.stringify({ t: Date.now(), trees: list }))).catch(() => {});
    }
    this.busy[src] = false;
    if (flat) {
      this.failures[src] = 0;
    } else {
      this.failures[src]++;
      if (busy) this._retryLater(src);
    }
    // Un nouvel échec du même serveur ne change rien à l'écran : pas de recalcul.
    if (flat || this.failures[src] === 1) {
      this.version++;
      this.onUpdate();
    }
    this._pump();
  }

  /** Nouvel essai seul, plus tard, des tuiles de cette source encore à l'écran et en échec. */
  _retryLater(src) {
    clearTimeout(this.retryTimers[src]);
    const waits = this.delays.auto;
    this.retryTimers[src] = setTimeout(() => {
      this.retryTimers[src] = null;
      for (const key of this.wanted) {
        const t = this.tiles.get(key);
        if (t && t[src] && t[src].failed !== undefined) t[src] = undefined;
      }
      this._pump();
    }, waits[Math.min(this.failures[src], waits.length) - 1]);
  }

  async _paris([w, s, e, n]) {
    const where = `in_bbox(geo_point_2d,${s.toFixed(6)},${w.toFixed(6)},${n.toFixed(6)},${e.toFixed(6)})`;
    const url = `${this.urls.paris}?select=geo_point_2d,hauteurenm,circonferenceencm&where=${encodeURIComponent(where)}`;
    for (let attempt = 0; ; attempt++) {
      try {
        return parisTrees(await fetchJSON(url, {}, 30000));
      } catch (err) {
        if (attempt >= 1) throw err;
        await new Promise((r) => setTimeout(r, this.delays.paris));
      }
    }
  }

  async _overpass(bounds) {
    const body = `data=${encodeURIComponent(overpassQuery(bounds))}`;
    const init = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body };
    for (let attempt = 0; ; attempt++) {
      try {
        return osmTrees(await fetchJSON(this.urls.osm, init, 100000));
      } catch (err) {
        if (!isBusy(err) || attempt >= this.delays.overpass.length) throw err;
        await new Promise((r) => setTimeout(r, this.delays.overpass[attempt]));
      }
    }
  }
}
