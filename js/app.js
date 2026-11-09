// Interface « Ombres » : date/heure, recherche, panneau soleil, ensoleillement d'un point, état dans l'URL.
import { ShadowMap, STYLES } from './map.js';
import { sunPosition, dayInfo, lightPhase, shadowLength, lightBands } from './sun.js';
import {
  browserTimeZone, isValidTimeZone, wallToUTC, minutesOfDay, tzLabel, formatMinutes, formatTime, formatDateISO, formatDuration,
} from './tz.js';
import { parseHash, buildHash, isValidDateISO, isValidTime } from './state.js';
import { searchPlace } from './geocode.js';

const $ = (id) => document.getElementById(id);
const ui = {
  search: $('search'), searchInput: $('search-input'), results: $('results'), locate: $('locate'),
  panel: $('panel'), panelToggle: $('panel-toggle'),
  phase: $('phase'), azimuth: $('azimuth'), altitude: $('altitude'), altitudeNote: $('altitude-note'), sunrise: $('sunrise'), sunset: $('sunset'),
  noon: $('noon'), daylength: $('daylength'), golden: $('golden'), blue: $('blue'), shadowRatio: $('shadow-ratio'),
  exposureHint: $('exposure-hint'), exposure: $('exposure'), exposureHours: $('exposure-hours'), exposureList: $('exposure-list'),
  exposureBar: $('exposure-bar'), exposureMeta: $('exposure-meta'), exposureClear: $('exposure-clear'),
  toggleShadows: $('toggle-shadows'), toggleBuildings: $('toggle-buildings'), toggleTerrain: $('toggle-terrain'),
  legend: $('legend'), legendMid: $('legend-mid'), legendMax: $('legend-max'),
  opacity: $('opacity'), share: $('share'), shareOk: $('share-ok'),
  play: $('play'), date: $('date'), timeLabel: $('time-label'), tzLabel: $('tz-label'), now: $('now'), time: $('time'), status: $('status'),
  eventDate: $('event-date'), eventTime: $('event-time'), eventHint: $('event-hint'), eventHelp: $('event-help'),
  eventActions: $('event-actions'), eventClear: $('event-clear'), moment: $('moment'), eventMark: $('event-mark'),
};

const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
// Sur téléphone, l'exemple de coordonnées ne tient pas dans le champ : un libellé court à la place.
if (isMobile()) ui.searchInput.placeholder = 'Rechercher';
const DEFAULT_VIEW = { lat: 48.8566, lng: 2.3522, zoom: 15.3 };

// tz-lookup (lat/lng → fuseau IANA) : version embarquée dans vendor/ (chargée avant l'initialisation),
// sinon repli unpkg chargé en arrière-plan, sinon fuseau du navigateur.
let tzlookup = null;
let tzReady = Promise.resolve();
try {
  tzlookup = (await import('../vendor/tz-lookup.js?v=11.8.0')).default;
} catch {
  tzReady = new Promise((resolve) => {
    const sc = document.createElement('script');
    sc.src = 'https://unpkg.com/@photostructure/tz-lookup@11.8.0/tz.js';
    sc.integrity = 'sha384-FRR+ESsmuFIumQk9dxScp1ZHQkRHgIOofu77TV9B0bMdBhljigxyEAtPumYSjaBL';
    sc.crossOrigin = 'anonymous';
    sc.onload = () => {
      if (typeof window.tzlookup === 'function') tzlookup = window.tzlookup;
      resolve();
    };
    sc.onerror = () => resolve();
    document.head.appendChild(sc);
  });
}

function tzFor(lat, lng) {
  try {
    const tz = tzlookup ? tzlookup(lat, lng) : null;
    return isValidTimeZone(tz) ? tz : browserTimeZone();
  } catch {
    return browserTimeZone();
  }
}

// ---------- État ----------
const hash = parseHash(location.hash);
const lat0 = hash.lat ?? DEFAULT_VIEW.lat;
const lng0 = hash.lng ?? DEFAULT_VIEW.lng;
const state = {
  tz: isValidTimeZone(hash.tz) ? hash.tz : tzFor(lat0, lng0),
  tzAuto: !isValidTimeZone(hash.tz),
  date: '',
  minutes: 720,
  style: STYLES[hash.style] ? hash.style : 'plan',
  buildings3d: hash.buildings3d ?? true,
  terrain: hash.terrain ?? false,
  shadows: hash.shadows ?? true,
  opacity: hash.opacity ?? 0.45,
  point: hash.point || null,
  mode: hash.mode === 'exposure' ? 'exposure' : 'shadows',
  playing: false,
  speed: 2,
  // Cérémonie { date, minutes } et jour du repérage : chacun garde sa propre heure, le jour affiché dit lequel est actif.
  event: hash.event ? { date: hash.event.date, minutes: hhmmToMinutes(hash.event.time) } : null,
  eventMinutes: 0,
  scout: null,
};
function hhmmToMinutes(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}
{
  const now = new Date();
  state.date = hash.date || formatDateISO(state.tz, now);
  state.minutes = hash.time ? hhmmToMinutes(hash.time) : Math.floor(minutesOfDay(state.tz, now));
  // Par défaut, le repérage, c'est aujourd'hui, maintenant ; le premier affichage le remplace si un autre jour est montré.
  state.scout = { date: formatDateISO(state.tz, now), minutes: Math.floor(minutesOfDay(state.tz, now)) };
  if (state.event) state.eventMinutes = state.event.minutes;
}

function dateParts() {
  const [y, mo, d] = state.date.split('-').map(Number);
  return { y, mo, d };
}
function instant() {
  const { y, mo, d } = dateParts();
  return wallToUTC(state.tz, y, mo, d, Math.floor(state.minutes / 60), state.minutes % 60);
}
function noonUTC() {
  const { y, mo, d } = dateParts();
  return wallToUTC(state.tz, y, mo, d, 12, 0);
}
function minutesInDay(date) {
  // Minutes depuis minuit (heure civile) pour un instant du jour sélectionné ; null si absent.
  if (!date) return null;
  const sameDay = formatDateISO(state.tz, date) === state.date;
  const m = minutesOfDay(state.tz, date);
  return sameDay ? m : m + (date > noonUTC() ? 1440 : -1440);
}

// ---------- Carte ----------
const shadowMap = new ShadowMap('map', {
  lat: lat0,
  lng: lng0,
  zoom: hash.zoom ?? DEFAULT_VIEW.zoom,
  bearing: hash.bearing || 0,
  pitch: hash.pitch || 0,
  style: state.style,
  buildings3d: state.buildings3d,
  terrain: state.terrain,
  shadows: state.shadows,
  opacity: state.opacity,
  mode: state.mode,
  cellBudget: isMobile() ? 600000 : 1200000,
  exposureSamples: () => buildExposureSamples(),
});
const map = shadowMap.map;
let marker = null;
let day = null; // dayInfo courant
let hourPositions = [];
const debug = { frames: 0, stats: null, lastExposure: null, state, shadowMap };
window.__ombres = debug;

// ---------- Soleil ----------
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
function cardinal(az) {
  return CARDINALS[Math.round((((az % 360) + 360) % 360) / 45) % 8];
}
function fmtDeg(v, digits = 0) {
  return `${v.toFixed(digits).replace('.', ',')}°`;
}

function focusLngLat() {
  if (state.point) return { lng: state.point.lng, lat: state.point.lat };
  const c = map.getCenter();
  return { lng: c.lng, lat: c.lat };
}

/** Paramètres permettant au worker de recalculer l'élévation du soleil en chaque cellule (terminateur). */
function sunExtras(t, pos) {
  return {
    altitudeGeometric: pos.altitudeGeometric,
    declination: pos.declination,
    eqTime: pos.equationOfTime,
    minutesUTC: t.getUTCHours() * 60 + t.getUTCMinutes() + t.getUTCSeconds() / 60,
  };
}

function refreshDay() {
  const c = focusLngLat();
  day = dayInfo(noonUTC(), c.lat, c.lng);
  const t = (d) => (d ? formatTime(state.tz, d) : '—');
  if (day.status === 'polar-day') {
    ui.sunrise.textContent = 'jour polaire';
    ui.sunset.textContent = 'jour polaire';
  } else if (day.status === 'polar-night') {
    ui.sunrise.textContent = 'nuit polaire';
    ui.sunset.textContent = 'nuit polaire';
  } else {
    ui.sunrise.textContent = t(day.sunrise);
    ui.sunset.textContent = t(day.sunset);
  }
  ui.noon.textContent = `${t(day.solarNoon)} (${fmtDeg(day.noonAltitude, 1)})`;
  ui.daylength.textContent = formatDuration(day.dayLengthMinutes);

  // Frise du curseur : nuit, heure bleue, heure dorée, jour, en bandes nettes, de minuit à minuit (heure civile).
  const { y, mo, d } = dateParts();
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  const bands = lightBands(
    wallToUTC(state.tz, y, mo, d, 0, 0),
    wallToUTC(state.tz, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0),
    c.lat,
    c.lng,
  );
  // Une bande s'arrête là où le pouce du curseur montre cette heure : 11 px (demi-pouce) + part du jour × (piste − 22 px).
  const at = (date) => {
    const f = Math.min(1, Math.max(0, minutesInDay(date) / 1439));
    return `calc(11px + ${(f * 100).toFixed(3)}% - ${(22 * f).toFixed(2)}px)`;
  };
  ui.time.style.setProperty('--daylight', `linear-gradient(90deg, ${bands.map((b) => `var(--band-${b.key}) ${at(b.from)} ${at(b.to)}`).join(', ')})`);
  const ranges = (key) => {
    const list = bands.filter((b) => b.key === key);
    if (!list.length) return '—';
    // Un créneau ne se coupe jamais (gluon après le tiret) : faute de place, la ligne passe entre le matin et le soir.
    return bands.length === 1 ? 'toute la journée' : list.map((b) => `${t(b.from)}–⁠${t(b.to)}`).join(' · ');
  };
  ui.golden.textContent = ranges('golden');
  ui.blue.textContent = ranges('blue');

  // Positions horaires pour le tracé.
  hourPositions = [];
  for (let h = 0; h < 24; h++) {
    const p = sunPosition(wallToUTC(state.tz, y, mo, d, h, 0), c.lat, c.lng);
    hourPositions.push({ label: `${h}h`, azimuth: p.azimuth, altitude: p.altitude });
  }
  ui.legendMax.textContent = formatDuration(day.dayLengthMinutes);
  ui.legendMid.textContent = formatDuration(day.dayLengthMinutes / 2);
}

/** Échantillons du jour (toutes les 20 min) au centre de la carte, pour la carte des heures de soleil. */
let exposureMapSeq = 0;
function buildExposureSamples() {
  const center = map.getCenter();
  const { y, mo, d } = dateParts();
  const stepMinutes = 20;
  const samples = [];
  for (let m = 0; m < 1440; m += stepMinutes) {
    const t = wallToUTC(state.tz, y, mo, d, Math.floor(m / 60), m % 60);
    const p = sunPosition(t, center.lat, center.lng);
    samples.push({ azimuth: p.azimuth, altitude: p.altitude, ...sunExtras(t, p) });
  }
  return { samples, stepMinutes, maxMinutes: day ? day.dayLengthMinutes : 0, seq: ++exposureMapSeq };
}

/** Demande explicite d'une carte des heures de soleil (changement de mode, de date ou de fuseau). */
function requestExposureMap() {
  const { samples, stepMinutes, maxMinutes, seq } = buildExposureSamples();
  shadowMap.requestExposureMap(samples, stepMinutes, maxMinutes, seq);
  setStatus('Calcul des heures de soleil…');
}

function setMode(mode) {
  state.mode = mode;
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === mode;
  ui.legend.hidden = mode !== 'exposure';
  shadowMap.setMode(mode);
  if (mode === 'exposure') requestExposureMap();
  scheduleHash();
}

function refreshSun() {
  const c = focusLngLat();
  const center = map.getCenter();
  const t = instant();
  const posCenter = sunPosition(t, center.lat, center.lng);
  shadowMap.setSun(posCenter.azimuth, posCenter.altitude, sunExtras(t, posCenter));
  const pos = state.point ? sunPosition(t, c.lat, c.lng) : posCenter;
  const phase = lightPhase(pos.altitude);
  ui.phase.textContent = phase.label;
  ui.azimuth.textContent = `${fmtDeg(pos.azimuth)} ${cardinal(pos.azimuth)}`;
  ui.altitude.textContent = fmtDeg(pos.altitude, 1);
  ui.altitudeNote.hidden = pos.altitude > 0;
  const ratio = shadowLength(1, pos.altitude);
  ui.shadowRatio.textContent = isFinite(ratio) ? `${ratio >= 100 ? '> 100' : ratio.toFixed(1).replace('.', ',')} × la hauteur` : 'aucune (nuit)';
  ui.timeLabel.textContent = formatMinutes(state.minutes);
  ui.tzLabel.textContent = `${tzLabel(state.tz, t)} · ${state.tz.replace(/_/g, ' ')}`;
  ui.tzLabel.title = state.tz;
  ui.time.value = String(state.minutes);
  ui.time.setAttribute('aria-valuetext', formatMinutes(state.minutes));
  ui.date.value = state.date;
  shadowMap.setSunPath(c, hourPositions, { azimuth: pos.azimuth, altitude: pos.altitude });
  rememberMoment();
}

// ---------- Cérémonie et repérage ----------
/** Le jour affiché est celui de la cérémonie ou celui du repérage : on retient l'heure de chacun, et on l'indique. */
function rememberMoment() {
  if (!state.event) return;
  const onEvent = state.date === state.event.date;
  if (onEvent) state.eventMinutes = state.minutes;
  else state.scout = { date: state.date, minutes: state.minutes };
  for (const r of ui.moment.querySelectorAll('input')) r.checked = (r.value === 'event') === onEvent;
}

/** Affiche un autre moment ; le relief, le point et la carte des heures ne se recalculent que si le jour change. */
function setMoment(date, minutes) {
  const dayChanged = date !== state.date;
  state.date = date;
  state.minutes = minutes;
  refreshAll();
  if (dayChanged && state.point) computeExposure();
  if (dayChanged && state.mode === 'exposure') requestExposureMap();
}

function renderEvent() {
  const ev = state.event;
  ui.eventDate.value = ev ? ev.date : '';
  ui.eventTime.value = ev ? formatMinutes(ev.minutes) : '';
  ui.eventHint.hidden = !!ev;
  ui.eventHelp.hidden = !ev;
  ui.eventActions.hidden = !ev;
  ui.moment.hidden = !ev;
  ui.eventMark.hidden = !ev;
  if (ev) {
    ui.eventMark.style.setProperty('--at', String(ev.minutes / 1439));
    ui.eventMark.title = `Cérémonie à ${formatMinutes(ev.minutes)}`;
  }
}

function setEvent(ev) {
  state.event = ev;
  renderEvent();
  if (!ev) return scheduleHash();
  // Le jour quitté devient celui du repérage (s'il n'est pas déjà celui de la cérémonie).
  if (state.date !== ev.date) state.scout = { date: state.date, minutes: state.minutes };
  setMoment(ev.date, ev.minutes);
}

function readEventInputs() {
  if (!isValidDateISO(ui.eventDate.value)) return;
  // Heure pas encore choisie : celle qui est affichée, écrite dans le champ pour qu'on la voie.
  if (!isValidTime(ui.eventTime.value)) ui.eventTime.value = formatMinutes(state.minutes);
  setEvent({ date: ui.eventDate.value, minutes: hhmmToMinutes(ui.eventTime.value) });
}
ui.eventDate.addEventListener('change', readEventInputs);
ui.eventTime.addEventListener('change', readEventInputs);
// Saisie abandonnée (date incomplète, heure effacée) : les champs reviennent à la cérémonie enregistrée.
// Sans cérémonie, le champ rempli en premier reste tel quel en attendant l'autre.
for (const el of [ui.eventDate, ui.eventTime]) el.addEventListener('blur', () => state.event && renderEvent());
ui.eventClear.addEventListener('click', () => setEvent(null));
for (const r of ui.moment.querySelectorAll('input')) {
  r.addEventListener('change', () => {
    if (!r.checked || !state.event) return;
    if (r.value === 'event') setMoment(state.event.date, state.eventMinutes);
    else setMoment(state.scout.date, state.scout.minutes);
  });
}

function refreshAll() {
  refreshDay();
  refreshSun();
  scheduleHash();
}

// ---------- Ensoleillement d'un point ----------
function setPoint(lngLat) {
  state.point = lngLat ? { lat: lngLat.lat, lng: lngLat.lng } : null;
  if (marker) {
    marker.remove();
    marker = null;
  }
  if (state.point) {
    const elm = document.createElement('div');
    elm.className = 'point-marker';
    marker = new maplibregl.Marker({ element: elm, draggable: true }).setLngLat([state.point.lng, state.point.lat]).addTo(map);
    marker.on('dragend', () => setPoint(marker.getLngLat()));
    ui.exposure.hidden = false;
    ui.exposureHint.hidden = true;
    computeExposure();
  } else {
    ui.exposure.hidden = true;
    ui.exposureHint.hidden = false;
  }
  refreshAll();
}

let exposureSeq = 0;
async function computeExposure() {
  if (!state.point) return;
  const seq = ++exposureSeq;
  const { y, mo, d } = dateParts();
  const step = 5;
  const samples = [];
  for (let m = 0; m < 1440; m += step) {
    const p = sunPosition(wallToUTC(state.tz, y, mo, d, Math.floor(m / 60), m % 60), state.point.lat, state.point.lng);
    samples.push({ azimuth: p.azimuth, altitude: p.altitude });
  }
  ui.exposureHours.textContent = '…';
  ui.exposureList.innerHTML = '';
  const res = await shadowMap.exposureAt(state.point, samples, 1.5);
  if (seq !== exposureSeq) return;
  debug.lastExposure = res;
  if (!res || !res.lit) {
    ui.exposureHours.textContent = '…';
    ui.exposureList.innerHTML =
      res && res.reason === 'outside'
        ? '<li>Point hors de la zone calculée : recentrez la carte dessus.</li>'
        : '<li>Calcul du relief en cours…</li>';
    ui.exposureBar.innerHTML = '';
    ui.exposureMeta.textContent = '';
    return;
  }
  const lit = res.lit;
  const intervals = [];
  let litMin = 0;
  let start = -1;
  for (let i = 0; i <= lit.length; i++) {
    const on = i < lit.length && lit[i] === 1;
    if (on) litMin += step;
    if (on && start < 0) start = i * step;
    if (!on && start >= 0) {
      intervals.push([start, i * step]);
      start = -1;
    }
  }
  ui.exposureHours.textContent = formatDuration(litMin);
  ui.exposureList.innerHTML = intervals.length
    ? intervals.map(([a, b]) => `<li>de ${formatMinutes(a)} à ${formatMinutes(b)}</li>`).join('')
    : '<li>Aucun soleil direct ce jour-là.</li>';
  ui.exposureBar.innerHTML = '';
  let cursor = 0;
  for (const [a, b] of intervals) {
    const gap = document.createElement('i');
    gap.style.width = `${((a - cursor) / 1440) * 100}%`;
    gap.style.background = 'transparent';
    ui.exposureBar.appendChild(gap);
    const seg = document.createElement('i');
    seg.style.width = `${((b - a) / 1440) * 100}%`;
    ui.exposureBar.appendChild(seg);
    cursor = b;
  }
  const alt = res.elevation != null ? `altitude ${Math.round(res.elevation)} m` : '';
  const roof = res.surface != null && res.elevation != null && res.surface - res.elevation > 1 ? ` · sur un toit (${Math.round(res.surface - res.elevation)} m)` : '';
  ui.exposureMeta.textContent = `${alt}${roof} · mesuré à 1,5 m ${roof ? 'au-dessus du toit' : 'du sol'}`;
}

// ---------- Événements carte ----------
let dragging = false;
map.on('dragstart', () => (dragging = true));
map.on('dragend', () => setTimeout(() => (dragging = false), 50));
map.on('click', (e) => {
  if (dragging) return;
  const target = e.originalEvent && e.originalEvent.target;
  if (target && target.closest && target.closest('.maplibregl-marker')) return;
  setPoint(e.lngLat);
});
map.on('moveend', () => {
  const c = map.getCenter();
  if (state.tzAuto) {
    const tz = tzFor(c.lat, c.lng);
    if (tz !== state.tz) {
      state.tz = tz;
    }
  }
  refreshAll();
});
shadowMap.on('heightfield', (stats) => {
  debug.stats = stats;
  if (stats.terrainUnsupported) {
    setStatus('Ce navigateur ne sait pas lire les tuiles de relief de façon fiable : seules les ombres des bâtiments sont calculées.', true);
    if (state.point) computeExposure();
    return;
  }
  if (stats.tilesMissing > 0 && stats.tilesLoaded === 0) {
    setStatus('Relief indisponible (tuiles non chargées) : seules les ombres des bâtiments sont calculées.', true);
    if (state.point) computeExposure();
    return;
  }
  const parts = [];
  parts.push(`relief ${stats.tilesLoaded} tuile${stats.tilesLoaded > 1 ? 's' : ''}${stats.tilesMissing ? ` (${stats.tilesMissing} manquante${stats.tilesMissing > 1 ? 's' : ''})` : ''}`);
  parts.push(`${stats.buildings.toLocaleString('fr-FR')} bâtiment${stats.buildings > 1 ? 's' : ''}`);
  setStatus(parts.join(' · '));
  if (state.point) computeExposure();
});
shadowMap.on('computing', () => setStatus('Calcul du relief…'));
shadowMap.on('progress', (p) => setStatus(p.kind === 'exposure' ? `Heures de soleil : ${Math.round((100 * p.loaded) / p.total)} %` : `Relief : ${p.loaded}/${p.total} tuiles`));
shadowMap.on('frame', (f) => {
  debug.frames++;
  if (f.kind === 'exposure') setStatus(`Heures de soleil calculées en ${(f.ms / 1000).toFixed(1).replace('.', ',')} s · max ${formatDuration(f.maxAcc)}`);
});
shadowMap.on('error', (e) => setStatus(`Erreur de calcul : ${e.message || e}`, true));
let mapErrorShown = 0;
shadowMap.on('maperror', (err) => {
  const msg = String((err && err.message) || err);
  if (/glyph|font/i.test(msg)) return;
  if (Date.now() - mapErrorShown < 5000) return;
  mapErrorShown = Date.now();
  setStatus(`Fond de carte indisponible : ${msg.slice(0, 90)}`, true);
});
shadowMap.on('ready', () => refreshAll());
// Un changement de fond recrée les sources : on retrace la course du soleil et on renvoie la position du soleil.
shadowMap.on('styleload', () => refreshSun());

function setStatus(text, isError = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle('err', isError);
}

// ---------- Contrôles temps ----------
ui.time.addEventListener('input', () => {
  state.minutes = Number(ui.time.value);
  refreshSun();
  scheduleHash();
});
ui.date.addEventListener('change', () => {
  if (isValidDateISO(ui.date.value) && ui.date.value !== state.date) setMoment(ui.date.value, state.minutes);
});
// Saisie abandonnée sur une date vide ou hors bornes : le champ revient à la date réellement affichée.
ui.date.addEventListener('blur', () => {
  if (ui.date.value !== state.date) ui.date.value = state.date;
});
ui.now.addEventListener('click', () => {
  const now = new Date();
  setMoment(formatDateISO(state.tz, now), Math.floor(minutesOfDay(state.tz, now)));
});

let playTimer = null;
function setPlaying(on) {
  state.playing = on;
  // Les SVG inline n'ont pas de propriété `hidden` : on bascule une classe sur le bouton.
  ui.play.classList.toggle('playing', on);
  ui.play.setAttribute('aria-label', on ? 'Pause' : 'Lecture');
  ui.play.setAttribute('aria-pressed', String(on));
  clearInterval(playTimer);
  if (on) {
    playTimer = setInterval(() => {
      state.minutes = (state.minutes + state.speed) % 1440;
      refreshSun();
    }, 50);
  } else {
    scheduleHash();
  }
}
ui.play.addEventListener('click', () => setPlaying(!state.playing));

document.addEventListener('keydown', (e) => {
  const active = document.activeElement;
  const onBody = !active || active === document.body;
  const onMap = active && active.classList && active.classList.contains('maplibregl-canvas');
  // Les raccourcis ne doivent pas voler le focus d'un bouton, d'un champ ou d'un lien.
  if (!onBody && !onMap) return;
  if (e.code === 'Space') {
    e.preventDefault();
    setPlaying(!state.playing);
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && onBody) {
    // Sur la carte, les flèches font défiler la vue : on ne les détourne pas.
    e.preventDefault();
    const d = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 60 : 10);
    state.minutes = ((state.minutes + d) % 1440 + 1440) % 1440;
    refreshSun();
    scheduleHash();
  }
});

// ---------- Couches ----------
ui.toggleShadows.checked = state.shadows;
ui.toggleBuildings.checked = state.buildings3d;
ui.toggleTerrain.checked = state.terrain;
ui.opacity.value = String(state.opacity);
for (const r of document.querySelectorAll('input[name="style"]')) r.checked = r.value === state.style;

ui.toggleShadows.addEventListener('change', () => {
  state.shadows = ui.toggleShadows.checked;
  shadowMap.setShadowsVisible(state.shadows);
  scheduleHash();
});
ui.toggleBuildings.addEventListener('change', () => {
  state.buildings3d = ui.toggleBuildings.checked;
  shadowMap.setBuildings3d(state.buildings3d);
  scheduleHash();
});
ui.toggleTerrain.addEventListener('change', () => {
  state.terrain = ui.toggleTerrain.checked;
  shadowMap.setTerrain3d(state.terrain);
  scheduleHash();
});
let opacityTimer = null;
ui.opacity.addEventListener('input', () => {
  state.opacity = Number(ui.opacity.value);
  // Un rendu complet par cran serait trop : on regroupe les changements rapprochés.
  clearTimeout(opacityTimer);
  opacityTimer = setTimeout(() => {
    shadowMap.setOpacity(state.opacity);
    scheduleHash();
  }, 60);
});
for (const r of document.querySelectorAll('input[name="mode"]')) {
  r.checked = r.value === state.mode;
  r.addEventListener('change', () => {
    if (r.checked) setMode(r.value);
  });
}
ui.legend.hidden = state.mode !== 'exposure';
for (const r of document.querySelectorAll('input[name="style"]')) {
  r.addEventListener('change', () => {
    if (!r.checked) return;
    state.style = r.value;
    shadowMap.setStyle(state.style);
    scheduleHash();
  });
}

// ---------- Recherche ----------
let searchAbort = null;
ui.search.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = ui.searchInput.value.trim();
  if (!q) return;
  if (searchAbort) searchAbort.abort();
  searchAbort = new AbortController();
  showResults([{ name: 'Recherche…', empty: true }]);
  try {
    const res = await searchPlace(q, { signal: searchAbort.signal });
    showResults(res.length ? res : [{ name: 'Aucun résultat', empty: true }]);
    if (res.length === 1) goToResult(res[0]);
  } catch (err) {
    if (err.name !== 'AbortError') showResults([{ name: 'Recherche indisponible pour le moment', empty: true }]);
  }
});
function showResults(items) {
  ui.results.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('li');
    li.textContent = it.name;
    li.setAttribute('role', 'option');
    if (it.empty) li.className = 'empty';
    else {
      li.tabIndex = 0;
      li.addEventListener('click', () => goToResult(it));
      li.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') goToResult(it);
      });
    }
    ui.results.appendChild(li);
  }
  ui.results.hidden = items.length === 0;
}
function goToResult(r) {
  ui.results.hidden = true;
  ui.results.innerHTML = '';
  if (r.bbox && Math.abs(r.bbox[1] - r.bbox[0]) < 0.5) {
    map.fitBounds([[r.bbox[2], r.bbox[0]], [r.bbox[3], r.bbox[1]]], { padding: 40, maxZoom: 16.5, duration: 900 });
  } else {
    map.flyTo({ center: [r.lng, r.lat], zoom: Math.max(map.getZoom(), 14), duration: 900 });
  }
  ui.searchInput.blur();
}
document.addEventListener('click', (e) => {
  if (!ui.search.contains(e.target)) ui.results.hidden = true;
});
ui.locate.addEventListener('click', () => {
  if (!navigator.geolocation) return setStatus('Géolocalisation indisponible', true);
  setStatus('Recherche de votre position…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 16, duration: 1200 });
      setStatus('');
    },
    () => setStatus('Position refusée ou indisponible', true),
    { enableHighAccuracy: true, timeout: 10000 },
  );
});

// ---------- Panneau / partage ----------
ui.exposureClear.addEventListener('click', () => setPoint(null));
ui.panelToggle.addEventListener('click', () => {
  const collapsed = ui.panel.classList.toggle('collapsed');
  ui.panelToggle.setAttribute('aria-expanded', String(!collapsed));
  ui.panel.setAttribute('aria-hidden', String(collapsed));
});
if (isMobile()) {
  ui.panel.classList.add('collapsed');
  ui.panelToggle.setAttribute('aria-expanded', 'false');
  ui.panel.setAttribute('aria-hidden', 'true');
}
ui.share.addEventListener('click', async () => {
  syncHash(true);
  try {
    await navigator.clipboard.writeText(location.href);
    ui.shareOk.hidden = false;
    setTimeout(() => (ui.shareOk.hidden = true), 2000);
  } catch {
    prompt('Copiez ce lien :', location.href);
  }
});

// ---------- URL ----------
let hashTimer = null;
function scheduleHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(syncHash, 300);
}
function syncHash(force = false) {
  if (state.playing && !force) return;
  const c = map.getCenter();
  const h = buildHash({
    lat: c.lat,
    lng: c.lng,
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
    date: state.date,
    time: formatMinutes(state.minutes),
    tz: state.tzAuto ? '' : state.tz,
    style: state.style,
    buildings3d: state.buildings3d,
    terrain: state.terrain,
    shadows: state.shadows,
    point: state.point,
    mode: state.mode,
    opacity: state.opacity,
    event: state.event && { date: state.event.date, time: formatMinutes(state.event.minutes) },
  });
  if (h !== location.hash) history.replaceState(null, '', h);
}

// La barre de temps peut dépasser sa hauteur nominale (fuseau long, petit écran) : on mesure sa hauteur réelle.
const timebar = document.querySelector('.timebar');
if (timebar && 'ResizeObserver' in window) {
  const ro = new ResizeObserver(() => {
    document.documentElement.style.setProperty('--timebar-h', `${Math.ceil(timebar.getBoundingClientRect().height)}px`);
  });
  // La boîte entière : la zone de sécurité est une marge intérieure, invisible pour l'observation du seul contenu.
  ro.observe(timebar, { box: 'border-box' });
}

// Premier affichage (la carte déclenchera aussi refreshAll à 'ready').
renderEvent();
refreshAll();
if (state.point) setPoint(state.point);
tzReady.then(() => {
  if (!state.tzAuto || !tzlookup) return;
  const c = map.getCenter();
  const tz = tzFor(c.lat, c.lng);
  if (tz !== state.tz) {
    // Fuseau connu tardivement (repli CDN) : si l'heure affichée était « maintenant », on la recale dans ce fuseau.
    const wasNow = !hash.time && !hash.date;
    state.tz = tz;
    if (wasNow) {
      const now = new Date();
      state.date = formatDateISO(state.tz, now);
      state.minutes = Math.floor(minutesOfDay(state.tz, now));
    }
    refreshAll();
    if (state.mode === 'exposure') requestExposureMap();
  }
});
