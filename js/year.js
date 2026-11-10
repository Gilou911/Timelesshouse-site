// Ensoleillement d'un point sur l'année : échantillons jour par jour, totaux, graphique jours × heures.
import { wallToUTC } from './tz.js';
import { sunPosition } from './sun.js';

export const YEAR_STEP = 10; // minutes entre deux échantillons d'un même jour

/**
 * Positions du soleil vues du point, chaque jour de l'année civile `year` (fuseau `tz`), toutes les `step` minutes
 * d'heure civile : le graphique lit l'heure affichée par une montre, changements d'heure compris.
 * Rend { days, perDay, step, samples: [{ azimuth, altitude }], altitudes: Float32Array }, rangés jour par jour.
 */
export function yearSamples(tz, year, lat, lng, step = YEAR_STEP) {
  const perDay = 1440 / step;
  const days = Math.round((Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000);
  const samples = new Array(days * perDay);
  const altitudes = new Float32Array(days * perDay);
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.UTC(year, 0, 1 + i));
    const [y, mo, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    const midnight = wallToUTC(tz, y, mo, d, 0, 0).getTime();
    // Même décalage horaire toute la journée : on ajoute les minutes ; un jour de changement d'heure, on convertit chacune.
    const steady = wallToUTC(tz, y, mo, d, 23, 0).getTime() === midnight + 23 * 3600000;
    for (let k = 0; k < perDay; k++) {
      const m = k * step;
      const t = steady ? midnight + m * 60000 : wallToUTC(tz, y, mo, d, Math.floor(m / 60), m % 60).getTime();
      const p = sunPosition(new Date(t), lat, lng);
      samples[i * perDay + k] = { azimuth: p.azimuth, altitude: p.altitude };
      altitudes[i * perDay + k] = p.altitude;
    }
  }
  return { days, perDay, step, samples, altitudes };
}

/** Minutes de soleil direct par mois (0 = janvier) et sur l'année, d'après les échantillons éclairés (1) ou non (0). */
export function yearTotals(lit, year, perDay, step) {
  const months = new Array(12).fill(0);
  for (let i = 0; i < lit.length; i++) {
    if (lit[i]) months[new Date(Date.UTC(year, 0, 1 + Math.floor(i / perDay))).getUTCMonth()] += step;
  }
  return { months, total: months.reduce((a, b) => a + b, 0) };
}

/** Couleur CSS quelconque → [r, g, b, a] (0-255), lue par le navigateur lui-même. */
function rgba(css) {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  return Array.from(ctx.getImageData(0, 0, 1, 1).data);
}

/**
 * Graphique jours × heures, net à la résolution de l'écran : une ligne par jour (janvier en haut), l'heure en
 * abscisse comme la frise de la barre du temps. Soleil, ombre (soleil levé mais caché) et nuit ; un trait marque le
 * jour affiché (`markDay`, index dans l'année, ou -1).
 */
export function drawYearChart(canvas, data, lit, markDay) {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const H = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const css = getComputedStyle(canvas);
  const sun = rgba(css.getPropertyValue('--sun'));
  const shade = rgba(css.getPropertyValue('--text-2'));
  shade[3] = Math.round(shade[3] * 0.55);
  const night = rgba(css.getPropertyValue('--band-night'));
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const px = img.data;
  const { days, perDay, altitudes } = data;
  for (let y = 0; y < H; y++) {
    const row = Math.min(days - 1, Math.floor((y * days) / H)) * perDay;
    for (let x = 0; x < W; x++) {
      const i = row + Math.min(perDay - 1, Math.floor((x * perDay) / W));
      const c = lit[i] ? sun : altitudes[i] > 0 ? shade : night;
      px.set(c, (y * W + x) * 4);
    }
  }
  ctx.putImageData(img, 0, 0);
  if (markDay >= 0) {
    const t = Math.max(1, Math.round(1.5 * dpr));
    ctx.fillStyle = css.getPropertyValue('--text');
    ctx.fillRect(0, Math.round(((markDay + 0.5) * H) / days - t / 2), W, t);
  }
}
