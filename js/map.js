// Carte MapLibre + couche d'ombres (worker) + tracé du soleil.
import { lngLatToMercator, mercatorToLngLat, metersPerUnit } from './shadow-engine.js';

const CFG = (typeof window !== 'undefined' && window.OMBRES_CONFIG) || {};
export const DEM_URL = CFG.demUrl || 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const OFM = CFG.openFreeMap || 'https://tiles.openfreemap.org';
export const ESRI_URL =
  CFG.esriUrl || 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
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

/** Gère la carte, la couche d'ombres et le tracé du soleil. */
export class ShadowMap {
  constructor(container, options) {
    this.options = {
      style: 'plan',
      buildings3d: true,
      terrain: false,
      shadows: true,
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
    this.worker.postMessage({ type: 'config', demTemplate: DEM_URL, style: this._style() });

    this.map.on('style.load', () => this._installLayers());
    this.map.on('load', () => {
      this.ready = true;
      this.emit('ready');
    });
    this.map.on('moveend', () => this._scheduleHeightfield());
    this.map.on('sourcedata', (e) => {
      if (e.tile && this.vectorSource && e.sourceId === this.vectorSource && !this._hfTimer && !this._idleHandler && this.hfId > 0) {
        this._tilesSinceBuild = true;
      }
    });
    this.map.on('idle', () => {
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
    if (mode === 'shadows') this._requestRender();
  }

  /** Demande la carte des heures de soleil pour les échantillons donnés (azimut/élévation) du jour. */
  requestExposureMap(samples, stepMinutes, maxMinutes) {
    this.lastExposureRequest = { samples, stepMinutes, maxMinutes };
    this.frameInFlight = true;
    clearTimeout(this._renderGuard);
    this._renderGuard = setTimeout(() => {
      this.frameInFlight = false;
    }, 30000);
    this.worker.postMessage({ type: 'exposure-map', requestId: ++this.requestId, samples, stepMinutes, maxMinutes });
  }

  /** Re-crée nos sources/couches après chaque chargement de style. */
  _installLayers() {
    const map = this.map;
    const style = map.getStyle();
    const layers = style.layers || [];
    this.vectorSource = this._findVectorSource(style);
    const firstSymbol = (layers.find((l) => l.type === 'symbol') || {}).id;

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
    if (!map.getLayer('ombres-hillshade')) {
      map.addLayer(
        {
          id: 'ombres-hillshade',
          type: 'hillshade',
          source: 'dem',
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
          layout: { visibility: this.options.buildings3d ? 'visible' : 'none' },
          paint: {
            'fill-extrusion-color': this.options.style === 'satellite' ? '#c9c4bb' : '#e4dfd6',
            'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
            'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
            'fill-extrusion-opacity': 0.9,
          },
        },
        firstSymbol,
      );
    }

    // Tracé du soleil (au-dessus de tout).
    if (!map.getSource('ombres-sunpath')) map.addSource('ombres-sunpath', { type: 'geojson', data: EMPTY_FC });
    if (!map.getLayer('ombres-sunpath-arc')) {
      map.addLayer({
        id: 'ombres-sunpath-arc',
        type: 'line',
        source: 'ombres-sunpath',
        filter: ['==', ['get', 'kind'], 'arc'],
        paint: { 'line-color': '#f5a623', 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.9 },
      });
      map.addLayer({
        id: 'ombres-sunpath-ticks',
        type: 'line',
        source: 'ombres-sunpath',
        filter: ['==', ['get', 'kind'], 'tick'],
        paint: { 'line-color': '#f5a623', 'line-width': 1.5, 'line-opacity': 0.8 },
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
        paint: { 'line-color': '#ffd23f', 'line-width': 4 },
      });
      map.addLayer({
        id: 'ombres-sunpath-sun',
        type: 'circle',
        source: 'ombres-sunpath',
        filter: ['==', ['get', 'kind'], 'sun'],
        paint: {
          'circle-radius': 8,
          'circle-color': '#ffd23f',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
          'circle-opacity': ['case', ['get', 'up'], 1, 0.35],
        },
      });
      if (style.glyphs) {
        // Même police que les étiquettes du style (les polices disponibles dépendent du serveur de glyphes).
        const symbolWithFont = layers.find((l) => l.type === 'symbol' && l.layout && Array.isArray(l.layout['text-font']) && l.layout['text-font'].every((f) => typeof f === 'string'));
        const font = symbolWithFont ? symbolWithFont.layout['text-font'] : ['Noto Sans Regular'];
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
    const run = () => {
      // On attend que toutes les tuiles demandées (bâtiments compris) soient chargées : l'événement « idle ».
      // triggerRepaint garantit qu'il sera émis même si la carte est déjà au repos.
      if (this._idleHandler) this.map.off('idle', this._idleHandler);
      this._idleHandler = () => {
        this._idleHandler = null;
        this._buildHeightfield();
      };
      this.map.once('idle', this._idleHandler);
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
    const margin = 0.3;
    const W = x1 - x0;
    const Hh = y1 - y0;
    x0 -= W * margin;
    x1 += W * margin;
    y0 = Math.max(0, y0 - Hh * margin);
    y1 = Math.min(1, y1 + Hh * margin);

    let cellUnits = unitsPerPx / this.options.quality;
    let w = Math.ceil((x1 - x0) / cellUnits);
    let h = Math.ceil((y1 - y0) / cellUnits);
    const budget = this.options.cellBudget;
    if (w * h > budget) {
      cellUnits *= Math.sqrt((w * h) / budget);
      w = Math.ceil((x1 - x0) / cellUnits);
      h = Math.ceil((y1 - y0) / cellUnits);
    }
    const grid = { w, h, originX: x0, originY: y0, cellUnits };
    const cellMeters = cellUnits * metersPerUnit(center.lat);
    const demZoom = Math.max(0, Math.min(15, Math.floor(Math.log2(1 / (cellUnits * 256)))));
    const buildings = this._collectBuildings();
    const id = ++this.hfId;
    this.grids.set(id, grid);
    for (const k of this.grids.keys()) if (k < id - 2 && k !== this.currentGridId) this.grids.delete(k);
    this.emit('computing', { id, grid, demZoom, buildings: buildings.polyStart.length - 1 });
    this.worker.postMessage(
      {
        type: 'heightfield',
        id,
        grid,
        demZoom,
        buildings,
        cellMeters,
        latCenter: center.lat,
        useTerrain: this.options.terrainShadows !== false,
        useBuildings: this.options.buildingShadows !== false,
      },
      [buildings.coords.buffer, buildings.ringStart.buffer, buildings.polyStart.buffer, buildings.heights.buffer],
    );
  }

  /** Extrait les emprises de bâtiments (tuiles vectorielles chargées) en tableaux plats, unités Mercator. */
  _collectBuildings() {
    const coords = [];
    const ringStart = [0];
    const polyStart = [0];
    const heights = [];
    const map = this.map;
    if (this.vectorSource && map.getZoom() >= 12.5 && map.getSource(this.vectorSource)) {
      let feats = [];
      try {
        feats = map.querySourceFeatures(this.vectorSource, { sourceLayer: 'building' });
      } catch {
        feats = [];
      }
      for (const f of feats) {
        const p = f.properties || {};
        if (p.hide_3d === true || p.hide_3d === 'true') continue;
        let h = Number(p.render_height);
        if (!(h > 0)) h = Number(p.height);
        if (!(h > 0)) h = Number(p['building:levels']) * 3.2;
        if (!(h > 0)) h = 6;
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
              const [mx, my] = lngLatToMercator(pt[0], pt[1]);
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
    const src = this.map.getSource('ombres');
    if (src && typeof src.play === 'function') {
      src.play();
      if (this.currentGridId !== msg.id) {
        this.currentGridId = msg.id;
        src.setCoordinates(this._gridCorners(grid));
      }
      this._flushTerrainCache();
      this.map.triggerRepaint();
      this.map.once('render', () => src.pause());
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
    if (this.frameInFlight) {
      this.sunDirty = true;
      return;
    }
    this.frameInFlight = true;
    this.worker.postMessage({ type: 'render', requestId: ++this.requestId, azimuth: this.sun.azimuth, altitude: this.sun.altitude });
    // Sécurité : si le worker ne répond pas (pas encore de champ de hauteurs), on ne bloque pas les rendus suivants.
    clearTimeout(this._renderGuard);
    this._renderGuard = setTimeout(() => {
      this.frameInFlight = false;
    }, 1500);
  }

  /** Met à jour la position du soleil utilisée pour les ombres. */
  setSun(azimuth, altitude) {
    this.sun = { azimuth, altitude };
    this._requestRender();
  }

  setOpacity(opacity) {
    this.options.opacity = opacity;
    this.worker.postMessage({ type: 'config', style: this._style() });
  }

  setShadowsVisible(v) {
    this.options.shadows = v;
    if (this.map.getLayer('ombres-overlay')) this.map.setLayoutProperty('ombres-overlay', 'visibility', v ? 'visible' : 'none');
  }

  setBuildings3d(v) {
    this.options.buildings3d = v;
    if (this.map.getLayer('ombres-buildings-3d')) {
      this.map.setLayoutProperty('ombres-buildings-3d', 'visibility', v ? 'visible' : 'none');
    }
  }

  setTerrain3d(v) {
    this.options.terrain = v;
    if (!this.map.getSource('dem')) return;
    this.map.setTerrain(v ? { source: 'dem', exaggeration: 1 } : null);
    if (this.map.getLayer('ombres-hillshade')) this.map.setLayoutProperty('ombres-hillshade', 'visibility', v ? 'visible' : 'none');
  }

  setStyle(key) {
    if (!STYLES[key] || key === this.options.style) return;
    this.options.style = key;
    this.currentGridId = null;
    this.map.setStyle(STYLES[key].style(), { diff: false });
  }

  /** Ensoleillement d'un point pour une liste d'instants (azimut/élévation). */
  exposureAt(lngLat, samples, eyeHeight = 1.5) {
    return new Promise((resolve) => {
      const [x, y] = lngLatToMercator(lngLat.lng, lngLat.lat);
      const requestId = ++this.requestId;
      this.pendingExposure.set(requestId, resolve);
      this.worker.postMessage({ type: 'exposure', requestId, x, y, samples, eyeHeight });
      setTimeout(() => {
        if (this.pendingExposure.has(requestId)) {
          this.pendingExposure.delete(requestId);
          resolve({ lit: null });
        }
      }, 4000);
    });
  }

  /**
   * Trace la course du soleil autour d'un point : graduations horaires, arc, rayon courant, direction de l'ombre.
   * hours = [{ label, azimuth, altitude }], current = { azimuth, altitude }
   */
  setSunPath(lngLat, hours, current) {
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
    src.setData({ type: 'FeatureCollection', features });
  }
}
