// Export de l'animation : la carte filmée pendant que l'heure défile, l'heure et la date incrustées, sans dépendance.

/** Premier format que le navigateur sait enregistrer : MP4 (H.264) si possible, sinon WebM ; null s'il n'en sait aucun. */
export function pickVideoType(isSupported) {
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return types.find((t) => isSupported(t)) || null;
}

/**
 * Taille de la vidéo : la carte en pixels réels de l'écran, le grand côté ramené à 1 920 px au plus (au-delà, les
 * encodeurs H.264 des navigateurs refusent ou décrochent), en nombres pairs comme H.264 l'exige.
 */
export function videoSize(cssW, cssH, dpr, maxSide = 1920) {
  const s = Math.min(dpr, maxSide / Math.max(cssW, cssH));
  const even = (v) => Math.max(2, 2 * Math.floor(v / 2));
  return { w: even(cssW * s), h: even(cssH * s) };
}

const LONG_DATE = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Date en toutes lettres, en français : « mardi 10 novembre 2026 » (lue à chaque image de la vidéo). */
export function longDate(dateISO) {
  const [y, mo, d] = dateISO.split('-').map(Number);
  return LONG_DATE.format(new Date(Date.UTC(y, mo - 1, d)));
}

/**
 * Filme la carte : à chaque rendu de MapLibre, l'image est recopiée (dans le même rendu, sans preserveDrawingBuffer)
 * sur un canvas 2D qui y incruste l'heure et la date, et ce canvas est enregistré par MediaRecorder.
 * `label()` rend { time, date } du moment affiché.
 */
export class MapRecorder {
  constructor(map, type, label) {
    this.map = map;
    this.type = type;
    this.label = label;
  }

  start() {
    const src = this.map.getCanvas();
    const { w, h } = videoSize(src.clientWidth, src.clientHeight, window.devicePixelRatio || 1);
    this.canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    this.ctx = this.canvas.getContext('2d');
    this.font = getComputedStyle(document.documentElement).getPropertyValue('--font') || 'sans-serif';
    // Les licences des données (OpenStreetMap, OpenFreeMap, Esri, Terrain Tiles) demandent leur crédit sur toute image diffusée.
    // Le relief n'apparaît dans le crédit de la carte qu'en 3D, mais les ombres en viennent toujours.
    const attrib = this.map.getContainer().querySelector('.maplibregl-ctrl-attrib-inner');
    this.credit = attrib ? attrib.textContent.replace(/\s+/g, ' ').trim() : '';
    if (!/Terrain Tiles/.test(this.credit)) this.credit += `${this.credit ? ' · ' : ''}Relief : Terrain Tiles (Mapzen)`;
    this.onRender = () => this.draw();
    this.map.on('render', this.onRender);
    // L'heure change aussi quand la carte, elle, ne bouge pas (ombres masquées) : on redemande alors un rendu.
    const watch = () => {
      const l = this.label();
      if (l.time !== this.drawn) this.map.triggerRepaint();
      this.raf = requestAnimationFrame(watch);
    };
    watch();
    this.stream = this.canvas.captureStream(30);
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, { mimeType: this.type, videoBitsPerSecond: 8e6 });
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
    this.recorder.start(1000);
    this.map.triggerRepaint();
  }

  draw() {
    const { ctx, canvas } = this;
    const { width: w, height: h } = canvas;
    ctx.drawImage(this.map.getCanvas(), 0, 0, w, h);
    const l = this.label();
    this.drawn = l.time;
    const u = Math.min(w, h);
    const x = Math.round(u * 0.045);
    // Texte blanc sur un dégradé sombre en bas de l'image et une ombre floue : lisible sur un plan clair comme sur le
    // satellite, sans pavé derrière les mots.
    ctx.save();
    const g = ctx.createLinearGradient(0, h - u * 0.4, 0, h);
    g.addColorStop(0, 'rgba(0, 0, 0, 0)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0.5)');
    ctx.fillStyle = g;
    ctx.fillRect(0, h - u * 0.4, w, u * 0.4);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = u * 0.02;
    ctx.textBaseline = 'alphabetic';
    ctx.font = `400 ${Math.round(u * 0.034)}px ${this.font}`;
    ctx.fillText(l.date, x, h - x);
    ctx.font = `300 ${Math.round(u * 0.09)}px ${this.font}`;
    ctx.fillText(l.time, x - Math.round(u * 0.004), h - x - Math.round(u * 0.05));
    ctx.font = `400 ${Math.round(u * 0.016)}px ${this.font}`;
    ctx.textAlign = 'right';
    ctx.fillText(this.credit, w - x, h - x, w * 0.5);
    ctx.restore();
  }

  /** Arrête l'enregistrement et rend la vidéo (Blob). */
  stop() {
    cancelAnimationFrame(this.raf);
    this.map.off('render', this.onRender);
    return new Promise((resolve) => {
      const done = () => {
        for (const t of this.stream.getTracks()) t.stop();
        resolve(new Blob(this.chunks, { type: this.type.split(';')[0] }));
      };
      // Un encodeur tombé en panne en route laisse l'enregistreur inactif : on rend ce qui a été filmé.
      if (this.recorder.state === 'inactive') return done();
      this.recorder.onstop = done;
      this.recorder.stop();
    });
  }
}
