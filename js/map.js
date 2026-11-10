// Carte MapLibre + couche d'ombres (worker) + tracé du soleil.
import { lngLatToMercator, mercatorToLngLat, metersPerUnit } from './shadow-engine.js';
import { TreeStore, TREES_MIN_ZOOM } from './trees.js';
import { TreesLayer } from './trees3d.js';

const CFG = (typeof window !== 'undefined' && window.OMBRES_CONFIG) || {};
export const DEM_URL = CFG.demUrl || 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const OFM = CFG.openFreeMap || 'https://tiles.openfreemap.org';
// Arbres isolés : la liste de la Ville de Paris (dans Paris), et OpenStreetMap partout par le serveur public Overpass.
// overpass.openstreetmap.fr, essayé le 10/11/2026, refuse les sites publics (« usages autorisés » seulement).
const PARIS_TREES_URL = CFG.parisTreesUrl || 'https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/les-arbres/exports/json';
const OVERPASS_URLS = CFG.overpassUrls || ['https://overpass-api.de/api/interpreter'];
const OSM_LINK = '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const TREES_ATTRIBUTION = {
  paris: `Arbres : <a href="https://opendata.paris.fr/explore/dataset/les-arbres/" target="_blank" rel="noopener">Ville de Paris</a>, ${OSM_LINK}`,
  osm: `Arbres : ${OSM_LINK}`,
};
const TREES_MARGIN_M = 250; // les arbres un peu hors de la vue y portent aussi leur ombre
export const ESRI_URL =
  CFG.esriUrl || 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
// Attente maximale du repos de la carte avant de calculer avec les tuiles déjà chargées.
const IDLE_FALLBACK_MS = CFG.idleFallbackMs > 0 ? CFG.idleFallbackMs : 6000;
const DEM_ATTRIBUTION =
  'Relief : <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Terrain Tiles</a> (Mapzen, AWS Open Data)';
const OFM_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

export const STYLES = {
  plan: { label: 'Plan', style: () => CFG.planStyle || `${OFM}/styles/bright` },
  satellite: { label: 'Satellite', style: () => CFG.satelliteStyle || satelliteStyle() },
};

function satelliteStyle() {
  return {
    version: 8,
    name: 'Satellite',
    glyphs: `${OFM}/fonts/{fontstack}/{range}.pbf`,
    sources: {
      esri: {
        type: 'raster',
        tiles: [ESRI_URL],
        tileSize: 256,
        maxzoom: 19,
        attribution:
          'Powered by <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a> — Source : Esri, Vantor, Earthstar Geographics, and the GIS User Community',
      },
      openmaptiles: { type: 'vector', url: `${OFM}/planet`, attribution: OFM_ATTRIBUTION },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#0b1020' } },
      { id: 'satellite', type: 'raster', source: 'esri', paint: { 'raster-fade-duration': 0 } },
      {
        id: 'buildings-data',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom: 13,
        paint: { 'fill-color': '#000000', 'fill-opacity': 0 },
      },
    ],
  };
}

const EMPTY_FC = { type: 'FeatureCollection', features: [] };
// shortcut: une seule hauteur pour tous les bois (OpenStreetMap n'en donne pas), à remplacer par une vraie hauteur de canopée si une source ouverte s'y prête.
const CANOPY_HEIGHT = 15;

function buildingHeight(p) {
  if (p.hide_3d === true || p.hide_3d === 'true') return 0;
  let h = Number(p.render_height);
  if (!(h > 0)) h = Number(p.height);
  if (!(h > 0)) h = Number(p['building:levels']) * 3.2;
  return h > 0 ? h : 6;
}
// Bois et forêts (landcover « wood ») seulement : un parc est surtout une pelouse, une haute canopée y ferait de fausses ombres.
const treeHeight = (p) => (p.class === 'wood' ? CANOPY_HEIGHT : 0);
const buffersOf = (p) => [p.coords.buffer, p.ringStart.buffer, p.polyStart.buffer, p.heights.buffer];

// Lumière des bâtiments 3D quand le soleil est passé sous l'horizon de plus de 6° : faible et bleutée, venue du ciel.
const NIGHT_LIGHT = [90, 98, 132];
const NO_TRANSITION = { duration: 0, delay: 0 }; // la lumière suit le curseur sans traîner derrière les ombres

/**
 * Lumière de MapLibre pour les bâtiments 3D : elle vient du soleil. Ancre « map » : 0° = nord, sens horaire ; angle
 * polaire = 90° − élévation. Les façades tournées vers le soleil sont claires, les autres sombres. Du coucher à −6°, la
 * lumière s'assombrit et monte au zénith : la nuit, plus aucun mur n'est éclairé par le soleil, seul un faible ciel
 * bleuté garde les toits un peu plus clairs que les murs, pour qu'on lise encore les volumes.
 */
export function sunLight(azimuth, altitude) {
  const t = Math.min(1, Math.max(0, -altitude / 6)); // 0 : soleil levé ; 1 : nuit
  const c = NIGHT_LIGHT.map((v) => Math.round(255 + (v - 255) * t));
  return {
    anchor: 'map',
    position: [1.15, ((azimuth % 360) + 360) % 360, (90 - Math.min(90, Math.max(0, altitude))) * (1 - t)],
    color: `rgb(${c.join(', ')})`,
    intensity: 0.6 - 0.25 * t,
    'position-transition': NO_TRANSITION,
    'color-transition': NO_TRANSITION,
    'intensity-transition': NO_TRANSITION,
  };
}

/** Gère la carte, la couche d'ombres et le tracé du soleil. */
export class ShadowMap {
  constructor(container, options) {
    this.options = {
      style: 'plan',
      buildings3d: true,
      terrain: false,
      shadows: true,
      trees: true,
      opacity: 0.45,
      mode: 'shadows',
      quality: 1,
      cellBudget: 1200000,
      ...options,
    };
    this.listeners = new Map();
    this.sun = { azimuth: 180, altitude: 45 };
    this.hfId = 0;
    this.grids = new Map();
    this.currentGridId = null;
    this.frameInFlight = false;
    this.sunDirty = false;
    this.requestId = 0;
    this.pendingExposure = new Map();
    this.stats = null;
    this.vectorSource = null;
    this.ready = false;

    this.trees = new TreeStore({ parisUrl: PARIS_TREES_URL, overpassUrls: OVERPASS_URLS, onUpdate: () => this._onTreesUpdate() });
    this._treesLayer = new TreesLayer('ombres-trees-3d');
    this._treesParis = false; // arbres de la Ville de Paris dans la vue : leur crédit est affiché

    this.canvas = document.createElement('canvas');
    this.canvas.width = 2;
    this.canvas.height = 2;
    this.ctx = this.canvas.getContext('2d');

    this.map = new maplibregl.Map({
      container,
      style: STYLES[this.options.style].style(),
      center: [this.options.lng, this.options.lat],
      zoom: this.options.zoom,
      bearing: this.options.bearing || 0,
      pitch: this.options.pitch || 0,
      maxPitch: 70,
      hash: false,
      attributionControl: false,
      fadeDuration: 0,
      canvasContextAttributes: { antialias: true },
    });
    this.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    this.worker = new Worker(new URL('./shadow-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev) => this._onWorkerMessage(ev.data);
    this.worker.onerror = (ev) => this.emit('error', { message: ev.message || 'worker' });
    this.worker.postMessage({ type: 'config', demTemplate: DEM_URL, style: this._style(), mode: this.options.mode });

    this.map.on('style.load', () => this._installLayers());
    this.map.on('load', () => {
      this.ready = true;
      this.emit('ready');
    });
    this.map.on('moveend', () => this._scheduleHeightfield());
    this.map.on('sourcedata', (e) => {
      if (e.tile && this.vectorSource && e.sourceId === this.vectorSource && !this._hfTimer && !this._idleHandler && this.hfId > 0) {
        this._tilesSinceBuild = true;
        // Carte qui n'atteint pas le repos (tuile muette) : la tuile tardive relance le calcul sans attendre « idle ».
        if (this._idleLate) this._scheduleHeightfield();
      }
      if (e.tile && e.sourceId === 'dem') this._treesBaseDirty = true;
    });
    this.map.on('idle', () => {
      this._idleLate = false;
      // Relief 3D : le pied des arbres est posé sur le sol, lu quand ses tuiles sont là.
      if (this._treesBaseDirty && this.options.terrain) {
        this._treesBaseDirty = false;
        this._treesLayer.setBase(this._groundAt());
      }
      if (this._tilesSinceBuild && !this._idleHandler) {
        this._tilesSinceBuild = false;
        this._scheduleHeightfield();
      }
    });
    this.map.on('error', (e) => {
      if (e && e.error) this.emit('maperror', e.error);
    });
  }

  on(evt, fn) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, []);
    this.listeners.get(evt).push(fn);
    return this;
  }

  emit(evt, payload) {
    for (const fn of this.listeners.get(evt) || []) fn(payload);
  }

  _style() {
    const a = Math.round(255 * this.options.opacity);
    return { shadow: [18, 26, 48, a], night: [10, 14, 36, Math.min(255, a + 60)], soft: false, exposureAlpha: Math.min(230, a + 80) };
  }

  /** Mode d'affichage : 'shadows' (ombres à l'instant choisi) ou 'exposure' (heures de soleil du jour). */
  setMode(mode) {
    if (mode !== 'shadows' && mode !== 'exposure') return;
    this.options.mode = mode;
    this.worker.postMessage({ type: 'config', mode });
    if (mode === 'shadows') {
      // Une carte des heures de soleil éventuellement en cours est interrompue côté worker : on libère le verrou.
      this.frameInFlight = false;
      clearTimeout(this._renderGuard);
      this._requestRender();
    }
  }

  /** Demande la carte des heures de soleil pour les échantillons donnés (azimut/élévation) du jour. */
  requestExposureMap(samples, stepMinutes, maxMinutes, seq = 0) {
    this.frameInFlight = true;
    clearTimeout(this._renderGuard);
    this._renderGuard = setTimeout(() => {
      this.frameInFlight = false;
    }, 30000);
    this.worker.postMessage({ type: 'exposure-map', requestId: ++this.requestId, samples, stepMinutes, maxMinutes, seq });
  }

  /** Re-crée nos sources/couches après chaque chargement de style. */
  _installLayers() {
    const map = this.map;
    const style = map.getStyle();
    const layers = style.layers || [];
    this.vectorSource = this._findVectorSource(style);
    // On insère nos couches sous les étiquettes : première couche « symbol » portant du texte (les symboles
    // sans texte, comme les flèches de sens unique, peuvent précéder des remplissages dans certains styles).
    const firstSymbol = (layers.find((l) => l.type === 'symbol' && l.layout && l.layout['text-field'] !== undefined) || {}).id;

    if (!map.getSource('dem')) {
      map.addSource('dem', {
        type: 'raster-dem',
        tiles: [DEM_URL],
        tileSize: 256,
        maxzoom: 15,
        encoding: 'terrarium',
        attribution: DEM_ATTRIBUTION,
      });
    }
    if (!map.getSource('dem-hillshade')) {
      // Source distincte pour l'ombrage : MapLibre dégrade la résolution d'un hillshade qui partage la source du relief 3D.
      map.addSource('dem-hillshade', { type: 'raster-dem', tiles: [DEM_URL], tileSize: 256, maxzoom: 15, encoding: 'terrarium' });
    }
    if (!map.getLayer('ombres-hillshade')) {
      map.addLayer(
        {
          id: 'ombres-hillshade',
          type: 'hillshade',
          source: 'dem-hillshade',
          layout: { visibility: this.options.terrain ? 'visible' : 'none' },
          paint: {
            'hillshade-exaggeration': 0.3,
            'hillshade-shadow-color': '#2b2b3a',
            'hillshade-highlight-color': '#ffffff',
            'hillshade-illumination-anchor': 'map',
          },
        },
        firstSymbol,
      );
    }

    if (!map.getSource('ombres')) {
      const g = this.grids.get(this.currentGridId);
      map.addSource('ombres', {
        type: 'canvas',
        canvas: this.canvas,
        coordinates: g ? this._gridCorners(g) : this._defaultCorners(),
        animate: false,
      });
    }
    if (!map.getLayer('ombres-overlay')) {
      map.addLayer(
        {
          id: 'ombres-overlay',
          type: 'raster',
          source: 'ombres',
          layout: { visibility: this.options.shadows ? 'visible' : 'none' },
          paint: { 'raster-opacity': 1, 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
        },
        firstSymbol,
      );
    }

    // Bâtiments 3D : notre propre couche, les extrusions du style sont masquées pour éviter les doublons.
    for (const l of layers) {
      if (l.type === 'fill-extrusion') map.setLayoutProperty(l.id, 'visibility', 'none');
    }
    if (this.vectorSource && !map.getLayer('ombres-buildings-3d')) {
      map.addLayer(
        {
          id: 'ombres-buildings-3d',
          type: 'fill-extrusion',
          source: this.vectorSource,
          'source-layer': 'building',
          minzoom: 13,
          filter: ['!=', ['get', 'hide_3d'], true],
          paint: {
            'fill-extrusion-color': this.options.style === 'satellite' ? '#c9c4bb' : '#e4dfd6',
            'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
            'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
            // Bascule par l'opacité (propriété de peinture) : changer la visibilité rechargerait toutes les tuiles vectorielles.
            'fill-extrusion-opacity': this.options.buildings3d ? 0.9 : 0,
          },
        },
        firstSymbol,
      );
    }

    this._firstSymbol = firstSymbol;
    this._addTreesLayer();

    // Tracé du soleil (au-dessus de tout).
    if (!map.getSource('ombres-sunpath')) map.addSource('ombres-sunpath', { type: 'geojson', data: EMPTY_FC });
    if (!map.getLayer('ombres-sunpath-arc')) {
      map.addLayer({
        id: 'ombres-sunpath-arc',
        type: 'line',
        source: 'ombres-sunpath',
        filter: ['==', ['get', 'kind'], 'arc'],
        paint: { 'line-color': '#ff9500', 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.9 },
      });
      map.addLayer({
        id: 'ombres-sunpath-ticks',
        type: 'line',
        source: 'ombres-sunpath',
        filter: ['==', ['get', 'kind'], 'tick'],
        paint: { 'line-color': '#ff9500', 'line-width': 1.5, 'line-opacity': 0.8 },
      });
      map.addLayer({
        id: 'ombres-sunpath-shadow',
        type: 'line',
        source: 'ombres-sunpath',
        filter: ['==', ['get', 'kind'], 'shadow'],
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#1a2340', 'line-width': 4, 'line-opacity': 0.8 },
      });
      map.addLayer({
        id: 'ombres-sunpath-ray',
        type: 'line',
        source: 'ombres-sunpath',
        filter: ['==', ['get', 'kind'], 'ray'],
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#ffcc00', 'line-width': 4 },
      });
      // Façade : flèche du mur vers la caméra, au bleu du point dont elle part, liserée de blanc pour le satellite.
      map.addLayer({
        id: 'ombres-sunpath-facade-casing',
        type: 'line',
        source: 'ombres-sunpath',
        filter: ['==', ['get', 'kind'], 'facade'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 7 },
      });
      map.addLayer({
        id: 'ombres-sunpath-facade',
        type: 'line',
        source: 'ombres-sunpath',
        filter: ['==', ['get', 'kind'], 'facade'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2563d6', 'line-width': 3.5 },
      });
      map.addLayer({
        id: 'ombres-sunpath-sun',
        type: 'circle',
        source: 'ombres-sunpath',
        filter: ['==', ['get', 'kind'], 'sun'],
        paint: {
          'circle-radius': 8,
          'circle-color': '#ffcc00',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
          'circle-opacity': ['case', ['get', 'up'], 1, 0.35],
        },
      });
      if (style.glyphs) {
        // Même police que les étiquettes du style (les polices disponibles dépendent du serveur de glyphes).
        // On préfère une police droite : la première couche de texte est souvent en italique (cours d'eau).
        const fonts = layers
          .filter((l) => l.type === 'symbol' && l.layout && Array.isArray(l.layout['text-font']) && l.layout['text-font'].length > 0 && l.layout['text-font'].every((f) => typeof f === 'string'))
          .map((l) => l.layout['text-font']);
        const font = fonts.find((f) => !f.some((name) => /italic|oblique/i.test(name))) || fonts[0] || ['Noto Sans Regular'];
        map.addLayer({
          id: 'ombres-sunpath-labels',
          type: 'symbol',
          source: 'ombres-sunpath',
          filter: ['==', ['get', 'kind'], 'label'],
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 11,
            'text-font': font,
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: { 'text-color': '#7a4a00', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
        });
      }
    }

    map.setTerrain(this.options.terrain ? { source: 'dem', exaggeration: 1 } : null);
    this._lightKey = null; // le nouveau style a sa propre lumière
    this._applyLight();
    this._scheduleHeightfield(true);
    this.emit('styleload');
  }

  _findVectorSource(style) {
    const sources = style.sources || {};
    const withBuildings = (style.layers || []).find((l) => l['source-layer'] === 'building' && sources[l.source]);
    if (withBuildings) return withBuildings.source;
    const vec = Object.keys(sources).find((id) => sources[id].type === 'vector');
    return vec || null;
  }

  _defaultCorners() {
    const c = this.map.getCenter();
    const d = 0.001;
    return [
      [c.lng - d, c.lat + d],
      [c.lng + d, c.lat + d],
      [c.lng + d, c.lat - d],
      [c.lng - d, c.lat - d],
    ];
  }

  _gridCorners(g) {
    const x1 = g.originX + g.w * g.cellUnits;
    const y1 = g.originY + g.h * g.cellUnits;
    return [
      mercatorToLngLat(g.originX, g.originY),
      mercatorToLngLat(x1, g.originY),
      mercatorToLngLat(x1, y1),
      mercatorToLngLat(g.originX, y1),
    ];
  }

  _scheduleHeightfield(immediate) {
    clearTimeout(this._hfTimer);
    clearTimeout(this._idleFallback);
    const run = () => {
      // On attend que toutes les tuiles demandées (bâtiments compris) soient chargées : l'événement « idle ».
      // triggerRepaint garantit qu'il sera émis même si la carte est déjà au repos.
      if (this._idleHandler) this.map.off('idle', this._idleHandler);
      this._idleHandler = () => {
        clearTimeout(this._idleFallback);
        this._idleHandler = null;
        this._buildHeightfield();
      };
      this.map.once('idle', this._idleHandler);
      // Filet de sécurité : une tuile qui ne répond jamais repousse « idle » indéfiniment.
      // Passé le délai, on calcule avec ce qui est chargé ; les tuiles tardives relanceront un calcul.
      // Carte déjà connue comme bloquée : inutile de rejouer toute l'attente à chaque déplacement.
      const wait = this._idleLate ? Math.min(IDLE_FALLBACK_MS, 1500) : IDLE_FALLBACK_MS;
      this._idleFallback = setTimeout(() => {
        if (!this._idleHandler) return;
        this.map.off('idle', this._idleHandler);
        this._idleHandler = null;
        this._idleLate = true;
        this._buildHeightfield();
      }, wait);
      this.map.triggerRepaint();
    };
    this._hfTimer = setTimeout(run, immediate ? 0 : 120);
  }

  /** Décrit la grille de calcul couvrant la vue (avec marge) et lance le worker. */
  _buildHeightfield() {
    const map = this.map;
    this._hfTimer = null;
    this._tilesSinceBuild = false;
    if (!map.getSource('ombres')) return;
    const c = map.getCanvas();
    const cw = Math.max(1, c.clientWidth);
    const ch = Math.max(1, c.clientHeight);
    const zoom = map.getZoom();
    const unitsPerPx = 1 / (512 * Math.pow(2, zoom));
    const b = map.getBounds();
    const [bx0, by0] = lngLatToMercator(b.getWest(), b.getNorth());
    const [bx1, by1] = lngLatToMercator(b.getEast(), b.getSouth());
    const center = map.getCenter();
    const [cx, cy] = lngLatToMercator(center.lng, center.lat);
    const maxHalfW = cw * unitsPerPx * 1.1;
    const maxHalfH = ch * unitsPerPx * 1.1;
    let x0 = Math.max(bx0, cx - maxHalfW);
    let x1 = Math.min(bx1, cx + maxHalfW);
    let y0 = Math.max(by0, cy - maxHalfH);
    let y1 = Math.min(by1, cy + maxHalfH);
    const view = [x0, y0, x1, y1]; // vue (bornée près de l'horizon en 3D), avant la marge du calcul
    const margin = 0.3;
    const W = x1 - x0;
    const Hh = y1 - y0;
    x0 -= W * margin;
    x1 += W * margin;
    y0 = Math.max(0, y0 - Hh * margin);
    y1 = Math.min(1, y1 + Hh * margin);
    // Vue aussi large que le monde : une seule largeur de monde suffit, la carte répète l'image de part et d'autre.
    // Plus large, les copies se chevaucheraient et les ombres s'additionneraient (relief 3D, styles à couches 3D).
    const wholeWorld = x1 - x0 >= 1;
    if (wholeWorld) {
      x0 = cx - 0.5;
      x1 = cx + 0.5;
    }

    let cellUnits = unitsPerPx / this.options.quality;
    let w = Math.ceil((x1 - x0) / cellUnits);
    let h = Math.ceil((y1 - y0) / cellUnits);
    const budget = this.options.cellBudget;
    if (w * h > budget) {
      cellUnits *= Math.sqrt((w * h) / budget);
      w = Math.ceil((x1 - x0) / cellUnits);
      h = Math.ceil((y1 - y0) / cellUnits);
    }
    if (wholeWorld) {
      // Largeur exacte d'un monde : les copies se touchent sans se recouvrir.
      cellUnits = 1 / w;
      h = Math.ceil((y1 - y0) / cellUnits);
    }
    const grid = { w, h, originX: x0, originY: y0, cellUnits };
    const cellMeters = cellUnits * metersPerUnit(center.lat);
    const demZoom = Math.max(0, Math.min(15, Math.floor(Math.log2(1 / (cellUnits * 256)))));
    const buildings = this._collectPolygons('building', buildingHeight, x0, x1);
    const trees = this.options.trees ? this._collectPolygons('landcover', treeHeight, x0, x1) : null;
    const single = this._singleTrees(view, x0, x1);
    const id = ++this.hfId;
    this.grids.set(id, grid);
    for (const k of this.grids.keys()) if (k < id - 2 && k !== this.currentGridId) this.grids.delete(k);
    this.emit('computing', { id, grid, demZoom, buildings: buildings.polyStart.length - 1 });
    // En mode « heures de soleil », les échantillons du jour partent avec le relief : une seule carte par calcul.
    const exposure = this.options.mode === 'exposure' && typeof this.options.exposureSamples === 'function' ? this.options.exposureSamples() : null;
    this.worker.postMessage(
      {
        type: 'heightfield',
        id,
        grid,
        demZoom,
        buildings,
        trees,
        singleTrees: single.arrays,
        treesInfo: { wanted: single.wanted, loading: single.loading, failed: single.failed, retrying: single.retrying },
        cellMeters,
        latCenter: center.lat,
        useTerrain: this.options.terrainShadows !== false,
        useBuildings: this.options.buildingShadows !== false,
        exposure,
      },
      [
        ...buffersOf(buildings),
        ...(trees ? buffersOf(trees) : []),
        ...(single.arrays ? Object.values(single.arrays).map((a) => a.buffer) : []),
      ],
    );
  }

  /**
   * Arbres isolés de la vue (plus 250 m) : demandés à TreeStore, posés en 3D, et rendus en tableaux Mercator pour le
   * worker. À partir du zoom 15 seulement : plus loin, un houppier tient dans une cellule de calcul.
   */
  _singleTrees([vx0, vy0, vx1, vy1], gx0, gx1) {
    if (!this.options.trees || this.map.getZoom() < TREES_MIN_ZOOM) {
      this._setTreeFeatures(null);
      return { arrays: null, wanted: false, loading: false, failed: false, retrying: false };
    }
    const [w, n] = mercatorToLngLat(vx0, vy0);
    const [e, s] = mercatorToLngLat(vx1, vy1);
    const dLat = TREES_MARGIN_M / 111320;
    const dLng = dLat / Math.cos((((n + s) / 2) * Math.PI) / 180);
    const res = this.trees.request([w - dLng, s - dLat, e + dLng, n + dLat]);
    if (res.key !== this._treesKey) this._setTreeFeatures(res.trees, res.key, res.paris);
    const count = res.trees.length / 4;
    const arrays = { x: new Float64Array(count), y: new Float64Array(count), h: new Float32Array(count), d: new Float32Array(count) };
    for (let i = 0; i < count; i++) {
      let [mx, my] = lngLatToMercator(res.trees[4 * i], res.trees[4 * i + 1]);
      if (gx0 < 0 && mx > gx1) mx -= 1;
      else if (gx1 > 1 && mx < gx0) mx += 1;
      arrays.x[i] = mx;
      arrays.y[i] = my;
      arrays.h[i] = res.trees[4 * i + 2];
      arrays.d[i] = res.trees[4 * i + 3];
    }
    return { arrays: count ? arrays : null, wanted: true, loading: res.loading, failed: res.failed, retrying: res.retrying };
  }

  _setTreeFeatures(list, key = null, paris = false) {
    if (!list && this._treesKey == null) return;
    this._treesKey = key;
    this._treesLayer.setTrees(list || [], this._groundAt());
    if (this.options.terrain) this._treesBaseDirty = true; // tuiles de relief pas forcément toutes là
    if (this.map.getSource('ombres-trees') && paris !== this._treesParis) {
      // Le crédit d'une source est lu à sa création : on la recrée quand des arbres de la Ville entrent ou sortent.
      this._treesParis = paris;
      this.map.removeLayer('ombres-trees-credit');
      this.map.removeSource('ombres-trees');
      this._addTreesLayer();
    }
  }

  /**
   * Arbres isolés en volume (TreesLayer, js/trees3d.js) : houppier rond sur un tronc, éclairé par le soleil. Une source
   * vide porte leur crédit : une couche personnalisée n'en a pas, et le crédit des données doit s'afficher.
   */
  _addTreesLayer() {
    const map = this.map;
    const before = map.getLayer(this._firstSymbol) ? this._firstSymbol : undefined;
    if (!map.getSource('ombres-trees')) {
      const attribution = TREES_ATTRIBUTION[this._treesParis ? 'paris' : 'osm'];
      map.addSource('ombres-trees', { type: 'geojson', data: EMPTY_FC, attribution });
    }
    if (!map.getLayer('ombres-trees-credit')) {
      map.addLayer({ id: 'ombres-trees-credit', type: 'fill', source: 'ombres-trees', minzoom: TREES_MIN_ZOOM - 0.5, paint: { 'fill-opacity': 0 } }, before);
    }
    this._treesLayer.satellite = this.options.style === 'satellite';
    this._treesLayer.visible = this._treesVisible();
    if (!map.getLayer('ombres-trees-3d')) map.addLayer(this._treesLayer, before);
  }

  /** Altitude du sol pour le pied des arbres : celle du relief 3D quand il est affiché, sinon aucune (sol plat). */
  _groundAt() {
    if (!this.options.terrain || !this.map.getTerrain()) return null;
    return (lng, lat) => this.map.queryTerrainElevation([lng, lat]) || 0;
  }

  /** De nouveaux arbres sont arrivés (ou un serveur a échoué) : on recalcule, groupé sur 300 ms. */
  _onTreesUpdate() {
    if (!this.options.trees) return;
    clearTimeout(this._treesTimer);
    this._treesTimer = setTimeout(() => this._scheduleHeightfield(true), 300);
  }

  _treesVisible() {
    return this.options.trees && this.options.buildings3d;
  }

  _showTrees3d() {
    this._treesLayer.visible = this._treesVisible();
    this.map.triggerRepaint();
  }

  /**
   * Extrait les polygones d'une couche des tuiles vectorielles chargées (bâtiments, bois) en tableaux plats, unités
   * Mercator, avec une hauteur par polygone ; `heightOf(propriétés)` rend 0 pour écarter un objet.
   */
  _collectPolygons(sourceLayer, heightOf, gx0 = 0, gx1 = 1) {
    const coords = [];
    const ringStart = [0];
    const polyStart = [0];
    const heights = [];
    const map = this.map;
    if (this.vectorSource && map.getZoom() >= 12.5 && map.getSource(this.vectorSource)) {
      let feats = [];
      try {
        feats = map.querySourceFeatures(this.vectorSource, { sourceLayer });
      } catch {
        feats = [];
      }
      for (const f of feats) {
        const h = heightOf(f.properties || {});
        if (!(h > 0)) continue;
        const geom = f.geometry;
        if (!geom) continue;
        const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
        for (const rings of polys) {
          let added = 0;
          for (const ring of rings) {
            const n = ring.length;
            if (n < 3) continue;
            const start = coords.length / 2;
            for (let i = 0; i < n; i++) {
              const pt = ring[i];
              if (i === n - 1 && pt[0] === ring[0][0] && pt[1] === ring[0][1]) break;
              let [mx, my] = lngLatToMercator(pt[0], pt[1]);
              // Vue à cheval sur l'antiméridien : la grille déborde de [0,1], on y ramène les sommets.
              if (gx0 < 0 && mx > gx1) mx -= 1;
              else if (gx1 > 1 && mx < gx0) mx += 1;
              coords.push(mx, my);
            }
            if (coords.length / 2 - start < 3) {
              coords.length = start * 2;
              continue;
            }
            ringStart.push(coords.length / 2);
            added++;
          }
          if (added) {
            polyStart.push(ringStart.length - 1);
            heights.push(h);
          }
        }
      }
    }
    return {
      coords: Float64Array.from(coords),
      ringStart: Int32Array.from(ringStart),
      polyStart: Int32Array.from(polyStart),
      heights: Float32Array.from(heights),
    };
  }

  _onWorkerMessage(msg) {
    switch (msg.type) {
      case 'progress':
        if (msg.id === this.hfId) this.emit('progress', msg);
        break;
      case 'heightfield-ready':
        this.stats = msg.stats;
        this.emit('heightfield', msg.stats);
        break;
      case 'frame':
        this._drawFrame(msg);
        break;
      case 'frame-skipped':
        this.frameInFlight = false;
        if (this.sunDirty) {
          this.sunDirty = false;
          this._requestRender();
        }
        break;
      case 'exposure-result': {
        const cb = this.pendingExposure.get(msg.requestId);
        if (cb) {
          this.pendingExposure.delete(msg.requestId);
          cb(msg);
        }
        break;
      }
      case 'error':
        this.emit('error', msg);
        break;
      default:
        break;
    }
  }

  _drawFrame(msg) {
    // Toute image reçue signifie que le worker est libre : on relâche le verrou.
    this.frameInFlight = false;
    clearTimeout(this._renderGuard);
    const grid = this.grids.get(msg.id);
    if (!grid) return;
    const { w, h } = msg;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const img = new ImageData(new Uint8ClampedArray(msg.buffer), w, h);
    this.ctx.putImageData(img, 0, 0);
    // Le tampon repart au worker pour être réutilisé (transfert sans copie).
    this.worker.postMessage({ type: 'recycle', buffer: msg.buffer }, [msg.buffer]);
    const src = this.map.getSource('ombres');
    if (src && typeof src.play === 'function') {
      src.play();
      if (this.currentGridId !== msg.id) {
        this.currentGridId = msg.id;
        src.setCoordinates(this._gridCorners(grid));
      }
      this._flushTerrainCache();
      this.map.triggerRepaint();
      // Le canvas est envoyé au GPU pendant le rendu (prepare, _playing = true). On coupe ensuite _playing sans
      // passer par pause(), qui referait un second envoi identique (champ privé, version MapLibre épinglée).
      this.map.once('render', () => {
        src._playing = false;
      });
    }
    this.emit('frame', { ms: msg.ms, w, h, kind: msg.kind || 'shadows', maxMinutes: msg.maxMinutes, maxAcc: msg.maxAcc });
    if (this.sunDirty) {
      this.sunDirty = false;
      this._requestRender();
    }
  }

  /**
   * Avec le relief 3D, MapLibre drape les couches 2D dans des textures mises en cache par tuile de relief ;
   * une mise à jour du canvas ne les invalide pas. On vide ce cache nous-mêmes (API interne, version épinglée).
   */
  _flushTerrainCache() {
    const terrain = this.map.terrain;
    if (!terrain) return;
    const tm = terrain.tileManager || terrain.sourceCache;
    if (tm && typeof tm.freeRtt === 'function') tm.freeRtt();
  }

  _requestRender() {
    if (this.options.mode === 'exposure') return;
    if (!this.options.shadows) {
      // Couche masquée : inutile de calculer ; la prochaine image sera demandée au ré-affichage.
      this.sunDirty = true;
      return;
    }
    if (this.frameInFlight) {
      this.sunDirty = true;
      return;
    }
    this.frameInFlight = true;
    this.worker.postMessage({ type: 'render', requestId: ++this.requestId, ...this.sun });
    // Sécurité : si le worker ne répond pas (pas encore de champ de hauteurs), on ne bloque pas les rendus suivants.
    clearTimeout(this._renderGuard);
    this._renderGuard = setTimeout(() => {
      this.frameInFlight = false;
    }, 1500);
  }

  /**
   * Met à jour la position du soleil utilisée pour les ombres.
   * `extra` = { declination, eqTime, minutesUTC } permet le masque jour/nuit par cellule (vues étendues).
   */
  setSun(azimuth, altitude, extra = {}) {
    this.sun = { azimuth, altitude, ...extra };
    this._treesLayer.setSun(azimuth, altitude);
    this._applyLight();
    this._requestRender();
  }

  /** Les bâtiments 3D sont éclairés depuis la position du soleil (au dixième de degré près). */
  _applyLight() {
    const { azimuth, altitude } = this.sun;
    const key = `${azimuth.toFixed(1)}/${altitude.toFixed(1)}`;
    if (key === this._lightKey) return;
    try {
      this.map.setLight(sunLight(azimuth, altitude));
      this._lightKey = key;
    } catch {
      // style en cours de chargement : la lumière sera posée à « style.load »
    }
  }

  setOpacity(opacity) {
    this.options.opacity = opacity;
    this.worker.postMessage({ type: 'config', style: this._style() });
  }

  setShadowsVisible(v) {
    this.options.shadows = v;
    if (this.map.getLayer('ombres-overlay')) this.map.setLayoutProperty('ombres-overlay', 'visibility', v ? 'visible' : 'none');
    if (v) {
      // Pendant le masquage, la texture GPU n'a pas été mise à jour : on redemande une image fraîche.
      if (this.options.mode === 'exposure') this.worker.postMessage({ type: 'config', style: this._style() });
      else {
        this.sunDirty = false;
        this._requestRender();
      }
    }
  }

  setBuildings3d(v) {
    this.options.buildings3d = v;
    if (this.map.getLayer('ombres-buildings-3d')) {
      this.map.setPaintProperty('ombres-buildings-3d', 'fill-extrusion-opacity', v ? 0.9 : 0);
    }
    this._showTrees3d();
  }

  /** Bois et arbres isolés : le champ de hauteurs est recalculé avec ou sans eux. */
  setTrees(v) {
    this.options.trees = v;
    this._showTrees3d();
    this._scheduleHeightfield(true);
  }

  setTerrain3d(v) {
    this.options.terrain = v;
    if (!this.map.getSource('dem')) return;
    this.map.setTerrain(v ? { source: 'dem', exaggeration: 1 } : null);
    // Les arbres suivent : posés sur le relief (lu au prochain repos de la carte), ou de nouveau sur un sol plat.
    if (v) this._treesBaseDirty = true;
    else this._treesLayer.setBase(null);
    if (this.map.getLayer('ombres-hillshade')) this.map.setLayoutProperty('ombres-hillshade', 'visibility', v ? 'visible' : 'none');
  }

  setStyle(key) {
    if (!STYLES[key] || key === this.options.style) return;
    this.options.style = key;
    // currentGridId est conservé : la source canvas est recréée avec les coordonnées de la grille courante,
    // l'image précédente reste donc correctement calée jusqu'à la prochaine image.
    this.map.setStyle(STYLES[key].style(), { diff: false });
  }

  /** Ensoleillement d'un point pour une liste d'instants (azimut/élévation). */
  exposureAt(lngLat, samples, eyeHeight = 1.5) {
    return new Promise((resolve) => {
      const [x, y] = lngLatToMercator(lngLat.lng, lngLat.lat);
      const requestId = ++this.requestId;
      this.pendingExposure.set(requestId, resolve);
      this.worker.postMessage({ type: 'exposure', requestId, x, y, samples, eyeHeight });
      // Le premier point d'un lieu attend aussi les tuiles de l'horizon lointain (8 s au plus côté worker).
      setTimeout(() => {
        if (this.pendingExposure.has(requestId)) {
          this.pendingExposure.delete(requestId);
          resolve({ lit: null });
        }
      }, 20000);
    });
  }

  /**
   * Trace la course du soleil autour d'un point : graduations horaires, arc, rayon courant, direction de l'ombre.
   * hours = [{ label, azimuth, altitude }], current = { azimuth, altitude }, facade = azimuth de la façade ou null
   */
  setSunPath(lngLat, hours, current, facade = null) {
    const src = this.map.getSource('ombres-sunpath');
    if (!src) return;
    if (!lngLat) {
      src.setData(EMPTY_FC);
      return;
    }
    const zoom = this.map.getZoom();
    const unitsPerPx = 1 / (512 * Math.pow(2, zoom));
    const R = 110 * unitsPerPx;
    const [x, y] = lngLatToMercator(lngLat.lng, lngLat.lat);
    const tip = (az, r) => {
      const a = (az * Math.PI) / 180;
      return mercatorToLngLat(x + r * Math.sin(a), y - r * Math.cos(a));
    };
    const features = [];
    const arc = [];
    for (const hr of hours) {
      if (hr.altitude <= -0.833) continue;
      const r = R * (0.55 + 0.45 * Math.cos((hr.altitude * Math.PI) / 180));
      arc.push(tip(hr.azimuth, r));
      features.push({
        type: 'Feature',
        properties: { kind: 'tick' },
        geometry: { type: 'LineString', coordinates: [tip(hr.azimuth, r * 0.92), tip(hr.azimuth, r * 1.08)] },
      });
      if (hr.label) {
        features.push({
          type: 'Feature',
          properties: { kind: 'label', label: hr.label },
          geometry: { type: 'Point', coordinates: tip(hr.azimuth, r * 1.28) },
        });
      }
    }
    if (arc.length >= 2) {
      features.push({ type: 'Feature', properties: { kind: 'arc' }, geometry: { type: 'LineString', coordinates: arc } });
    }
    if (current) {
      const up = current.altitude > 0;
      const r = R * (0.55 + 0.45 * Math.cos((current.altitude * Math.PI) / 180));
      features.push({
        type: 'Feature',
        properties: { kind: 'ray', up },
        geometry: { type: 'LineString', coordinates: [[lngLat.lng, lngLat.lat], tip(current.azimuth, r)] },
      });
      features.push({ type: 'Feature', properties: { kind: 'sun', up }, geometry: { type: 'Point', coordinates: tip(current.azimuth, r) } });
      if (up) {
        const len = Math.min(3, Math.max(0.35, 1 / Math.tan((current.altitude * Math.PI) / 180) * 0.6)) * R;
        features.push({
          type: 'Feature',
          properties: { kind: 'shadow' },
          geometry: { type: 'LineString', coordinates: [[lngLat.lng, lngLat.lat], tip(current.azimuth + 180, len)] },
        });
      }
    }
    if (facade != null) {
      // Flèche dans l'anneau des heures : hampe de 0,5 R, pointe de 14 px à ±149°.
      const a = (facade * Math.PI) / 180;
      const tx = x + 0.5 * R * Math.sin(a);
      const ty = y - 0.5 * R * Math.cos(a);
      const head = (da) => mercatorToLngLat(tx + 14 * unitsPerPx * Math.sin(a + da), ty - 14 * unitsPerPx * Math.cos(a + da));
      const end = mercatorToLngLat(tx, ty);
      features.push({
        type: 'Feature',
        properties: { kind: 'facade' },
        geometry: { type: 'MultiLineString', coordinates: [[[lngLat.lng, lngLat.lat], end], [head(2.6), end, head(-2.6)]] },
      });
    }
    src.setData({ type: 'FeatureCollection', features });
  }
}
