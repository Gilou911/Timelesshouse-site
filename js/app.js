// Interface « Ombres » : date/heure, recherche, panneau soleil, ensoleillement d'un point, état dans l'URL.
import { ShadowMap, STYLES } from './map.js';
import { sunPosition, dayInfo, lightPhase, shadowLength, lightBands } from './sun.js';
import {
  browserTimeZone, isValidTimeZone, wallToUTC, minutesOfDay, tzLabel, formatMinutes, formatTime, formatDateISO, formatDuration,
} from './tz.js';
import { parseHash, buildHash, isValidDateISO, isValidTime, parsePlaces, addPlace } from './state.js';
import { searchPlace } from './geocode.js';
import { nearestWall, offsetLngLat, facadeLit, litIntervals } from './facade.js';
import { moonPosition, moonTimes, moonPhase } from './moon.js';
import { yearSamples, yearTotals, drawYearChart } from './year.js';
import { MapRecorder, pickVideoType, longDate } from './record.js';

const $ = (id) => document.getElementById(id);
const ui = {
  search: $('search'), searchInput: $('search-input'), results: $('results'), locate: $('locate'),
  panel: $('panel'), panelToggle: $('panel-toggle'),
  phase: $('phase'), azimuth: $('azimuth'), altitude: $('altitude'), altitudeNote: $('altitude-note'), sunrise: $('sunrise'), sunset: $('sunset'),
  noon: $('noon'), daylength: $('daylength'), golden: $('golden'), pink: $('pink'), blue: $('blue'), shadowRatio: $('shadow-ratio'),
  exposureHint: $('exposure-hint'), exposure: $('exposure'), exposureHours: $('exposure-hours'), exposureList: $('exposure-list'),
  exposureBar: $('exposure-bar'), exposureMeta: $('exposure-meta'), exposureClear: $('exposure-clear'),
  toggleShadows: $('toggle-shadows'), toggleTrees: $('toggle-trees'), toggleBuildings: $('toggle-buildings'), toggleTerrain: $('toggle-terrain'),
  legend: $('legend'), legendMid: $('legend-mid'), legendMax: $('legend-max'),
  opacity: $('opacity'), share: $('share'), shareOk: $('share-ok'),
  play: $('play'), date: $('date'), timeLabel: $('time-label'), tzLabel: $('tz-label'), now: $('now'), time: $('time'), status: $('status'),
  eventDate: $('event-date'), eventTime: $('event-time'), eventHint: $('event-hint'), eventHelp: $('event-help'),
  eventActions: $('event-actions'), eventClear: $('event-clear'), moment: $('moment'), eventMark: $('event-mark'),
  facadeOn: $('facade-on'), facade: $('facade'), facadeAz: $('facade-az'), facadeDir: $('facade-dir'), facadeNote: $('facade-note'),
  facadeHours: $('facade-hours'), facadeList: $('facade-list'), facadeBar: $('facade-bar'),
  placesHint: $('places-hint'), placeForm: $('place-form'), placeName: $('place-name'), placeError: $('place-error'), places: $('places'),
  moonPhase: $('moon-phase'), moonrise: $('moonrise'), moonset: $('moonset'), moonLit: $('moon-lit'), moonPos: $('moon-pos'),
  pointHeight: $('point-height'),
  yearOn: $('year-on'), year: $('year'), yearHours: $('year-hours'), yearLabel: $('year-label'), yearChart: $('year-chart'),
  yearMonths: $('year-months'), yearNote: $('year-note'),
  record: $('record'), recordLabel: $('record-label'), recordTime: $('record-time'), videoLink: $('video-link'), recordError: $('record-error'),
  recordUnsupported: $('record-unsupported'), videoLinkLabel: $('video-link-label'),
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
  trees: hash.trees ?? true,
  opacity: hash.opacity ?? 0.45,
  point: hash.point || null,
  mode: hash.mode === 'exposure' ? 'exposure' : 'shadows',
  playing: false,
  speed: 2,
  // Cérémonie { date, minutes } et jour du repérage : chacun garde sa propre heure, le jour affiché dit lequel est actif.
  event: hash.event ? { date: hash.event.date, minutes: hhmmToMinutes(hash.event.time) } : null,
  eventMinutes: 0,
  scout: null,
  facade: hash.facade ?? null, // azimut vers lequel la façade (ou le sujet) fait face, null = pas de façade
  height: hash.height ?? 1.5, // hauteur du point mesuré au-dessus du sol ou du toit (m) : étage, balcon, drone
};
const fmtMeters = (v) => String(v).replace('.', ',');
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
  trees: state.trees,
  opacity: state.opacity,
  mode: state.mode,
  cellBudget: isMobile() ? 600000 : 1200000,
  exposureSamples: () => buildExposureSamples(),
});
const map = shadowMap.map;
let marker = null;
let lastLit = null; // dernier ensoleillement du point : la façade se recalcule sans relancer le relief
let facadeNote = ''; // d'où vient l'orientation de la façade (mur lu, ou aucun mur tout près)
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

  // Frise du curseur : nuit, heure bleue, heure rose, heure dorée, jour, en bandes nettes, de minuit à minuit (heure civile).
  const { y, mo, d } = dateParts();
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  const dayStart = wallToUTC(state.tz, y, mo, d, 0, 0);
  const dayEnd = wallToUTC(state.tz, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0);
  const bands = lightBands(dayStart, dayEnd, c.lat, c.lng);

  // Lune : lever et coucher du jour civil (le coucher peut précéder le lever).
  const mt = moonTimes(dayStart, dayEnd, c.lat, c.lng);
  const noMoonEvent = mt.alwaysUp ? 'toujours levée' : mt.alwaysDown ? 'toujours couchée' : 'aucun ce jour-là';
  ui.moonrise.textContent = mt.rise ? t(mt.rise) : noMoonEvent;
  ui.moonset.textContent = mt.set ? t(mt.set) : noMoonEvent;
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
  ui.pink.textContent = ranges('pink');
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
  const moon = moonPhase(t);
  const mpos = moonPosition(t, c.lat, c.lng);
  ui.moonPhase.textContent = moon.name;
  ui.moonLit.textContent = `${Math.round(moon.fraction * 100)} %`;
  ui.moonPos.textContent = mpos.altitude > 0 ? `${fmtDeg(mpos.azimuth)} ${cardinal(mpos.azimuth)} · ${fmtDeg(mpos.altitude, 1)} de haut` : 'sous l\'horizon';
  ui.timeLabel.textContent = formatMinutes(state.minutes);
  ui.tzLabel.textContent = `${tzLabel(state.tz, t)} · ${state.tz.replace(/_/g, ' ')}`;
  ui.tzLabel.title = state.tz;
  ui.time.value = String(state.minutes);
  ui.time.setAttribute('aria-valuetext', formatMinutes(state.minutes));
  ui.date.value = state.date;
  shadowMap.setSunPath(c, hourPositions, { azimuth: pos.azimuth, altitude: pos.altitude }, state.point ? state.facade : null);
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
  lastLit = null;
  renderFacade();
  const res = await shadowMap.exposureAt(state.point, samples, state.height);
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
    resetYear();
    return;
  }
  lastLit = { lit: res.lit, azimuths: samples.map((s) => s.azimuth), step };
  renderSlots(litIntervals(res.lit, step), ui.exposureHours, ui.exposureList, ui.exposureBar, 'Aucun soleil direct ce jour-là.');
  renderFacade();
  const alt = res.elevation != null ? `altitude ${Math.round(res.elevation)} m` : '';
  const roof = res.surface != null && res.elevation != null && res.surface - res.elevation > 1 ? ` · sur un toit (${Math.round(res.surface - res.elevation)} m)` : '';
  const trees = res.underTrees ? ' · sous les arbres' : '';
  const far = res.horizon === 'partial' ? ' · relief lointain incomplet' : '';
  ui.exposureMeta.textContent = `${alt}${roof}${trees} · mesuré à ${fmtMeters(state.height)} m ${roof ? 'au-dessus du toit' : 'du sol'}${far}`;
  refreshYear();
}

// ---------- Ensoleillement sur l'année ----------
const MONTHS = Array.from({ length: 12 }, (_, i) => new Intl.DateTimeFormat('fr-FR', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, i, 1))));
const HORIZON_NOTE = {
  complete: 'Relief compté jusqu\'à 20 km autour du point ; bâtiments et arbres dans la zone calculée seulement.',
  partial: 'Relief lointain incomplet (des tuiles de relief n\'ont pas répondu) ; bâtiments et arbres dans la zone calculée seulement.',
  none: 'Relief, bâtiments et arbres de la zone calculée.',
};
let heightfieldSeq = 0; // un nouveau champ de hauteurs (vue déplacée, arbres) rend l'année périmée
let yearKey = '';
let yearData = null;
let yearSeq = 0;

/** Calcule l'année du point si elle a changé (point, hauteur, année, fuseau, champ de hauteurs), sinon la redessine. */
async function refreshYear() {
  ui.year.hidden = !ui.yearOn.checked;
  if (ui.year.hidden || !state.point) return;
  const { y } = dateParts();
  const key = [state.point.lat, state.point.lng, state.height, y, state.tz, heightfieldSeq].join();
  if (key === yearKey) return drawYear();
  yearKey = key;
  const seq = ++yearSeq;
  ui.yearHours.textContent = '…';
  const data = yearSamples(state.tz, y, state.point.lat, state.point.lng);
  const res = await shadowMap.exposureAt(state.point, data.samples, state.height);
  if (seq !== yearSeq) return;
  if (!res || !res.lit) {
    yearKey = ''; // la prochaine mesure du point relancera l'année
    return;
  }
  data.samples = null;
  yearData = { year: y, data, lit: res.lit, horizon: res.horizon };
  drawYear();
}

/** Point hors de la zone calculée, relief pas encore prêt : l'année d'un autre point ne reste pas affichée. */
function resetYear() {
  yearKey = '';
  yearData = null;
  ui.yearHours.textContent = '…';
  ui.yearMonths.textContent = '';
  ui.yearNote.textContent = '';
  ui.yearChart.getContext('2d').clearRect(0, 0, ui.yearChart.width, ui.yearChart.height);
}

function drawYear() {
  if (!yearData || ui.year.hidden) return;
  const { year, data, lit, horizon } = yearData;
  const { months, total } = yearTotals(lit, year, data.perDay, data.step);
  const h = (min) => `${Math.round(min / 60).toLocaleString('fr-FR')} h`;
  ui.yearHours.textContent = h(total);
  ui.yearLabel.textContent = `de soleil direct en ${year}`;
  const most = months.indexOf(Math.max(...months));
  const least = months.indexOf(Math.min(...months));
  ui.yearMonths.textContent = total ? `Le plus en ${MONTHS[most]} (${h(months[most])}), le moins en ${MONTHS[least]} (${h(months[least])}).` : 'Aucun soleil direct de toute l\'année.';
  ui.yearNote.textContent = HORIZON_NOTE[horizon] || HORIZON_NOTE.none;
  ui.yearChart.setAttribute('aria-label', `Heures de soleil direct par mois : ${months.map((m, i) => `${MONTHS[i]} ${h(m)}`).join(', ')}`);
  const { y, mo, d } = dateParts();
  drawYearChart(ui.yearChart, data, lit, y === year ? Math.round((Date.UTC(y, mo - 1, d) - Date.UTC(y, 0, 1)) / 86400000) : -1);
}
ui.yearOn.addEventListener('change', refreshYear);
// Le graphique suit le thème de l'appareil et la largeur du panneau.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawYear);
let yearResize = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(yearResize);
  yearResize = requestAnimationFrame(drawYear);
});

// Hauteur du point : virgule ou point décimal, ramenée entre 0 et 500 m ; une saisie illisible reprend la valeur d'avant.
ui.pointHeight.addEventListener('change', () => {
  const v = parseFloat(ui.pointHeight.value.replace(',', '.'));
  if (Number.isFinite(v)) {
    state.height = Math.min(500, Math.max(0, Math.round(v * 10) / 10));
    computeExposure();
    scheduleHash();
  }
  ui.pointHeight.value = fmtMeters(state.height);
});

/** Durée totale, liste des créneaux et barre de la journée. */
function renderSlots(intervals, hoursEl, listEl, barEl, empty) {
  hoursEl.textContent = formatDuration(intervals.reduce((s, [a, b]) => s + b - a, 0));
  listEl.innerHTML = intervals.length
    ? intervals.map(([a, b]) => `<li>de ${formatMinutes(a)} à ${formatMinutes(b)}</li>`).join('')
    : `<li>${empty}</li>`;
  barEl.innerHTML = '';
  let cursor = 0;
  for (const [a, b] of intervals) {
    const gap = document.createElement('i');
    gap.style.width = `${((a - cursor) / 1440) * 100}%`;
    gap.style.background = 'transparent';
    barEl.appendChild(gap);
    const seg = document.createElement('i');
    seg.style.width = `${((b - a) / 1440) * 100}%`;
    barEl.appendChild(seg);
    cursor = b;
  }
}

// ---------- Façade ou axe de prise de vue ----------
function renderFacade() {
  const on = state.facade != null;
  ui.facadeOn.checked = on;
  ui.facade.hidden = !on;
  if (!on) return;
  ui.facadeAz.value = String(state.facade);
  ui.facadeDir.textContent = `${fmtDeg(state.facade)} ${cardinal(state.facade)}`;
  ui.facadeNote.textContent = `${facadeNote}${facadeNote ? ' ' : ''}La flèche part de la façade vers la caméra : le soleil l'éclaire quand il est de ce côté.`;
  if (!lastLit) {
    ui.facadeHours.textContent = '…';
    ui.facadeList.innerHTML = '';
    ui.facadeBar.innerHTML = '';
    return;
  }
  const lit = facadeLit(lastLit.lit, lastLit.azimuths, state.facade);
  renderSlots(litIntervals(lit, lastLit.step), ui.facadeHours, ui.facadeList, ui.facadeBar, 'Aucun soleil sur la façade ce jour-là.');
}

/** Mur le plus proche d'un point, parmi les bâtiments affichés autour de lui. */
function findWall(lngLat) {
  if (!map.getLayer('ombres-buildings-3d')) return null;
  const p = map.project([lngLat.lng, lngLat.lat]);
  const feats = map.queryRenderedFeatures([[p.x - 40, p.y - 40], [p.x + 40, p.y + 40]], { layers: ['ombres-buildings-3d'] });
  const polys = feats.flatMap((f) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : []));
  return nearestWall(lngLat, polys);
}

/** Oriente la façade sur le mur le plus proche ; un point posé sur le toit descend 3 m devant ce mur, au sol. */
function aimFacade(lngLat) {
  const wall = findWall(lngLat);
  if (!wall) {
    facadeNote = 'Aucun mur à moins de 12 m : réglez l\'orientation.';
    return lngLat;
  }
  state.facade = Math.round(wall.azimuth) % 360;
  facadeNote = `Orientation lue sur le mur le plus proche${wall.inside ? '' : `, à ${Math.round(wall.distance)} m`}.`;
  return wall.inside ? offsetLngLat(wall.foot, wall.normal, 3) : lngLat;
}

ui.facadeOn.addEventListener('change', () => {
  if (ui.facadeOn.checked) {
    state.facade = 180;
    if (state.point) return setPoint(aimFacade(state.point));
  } else state.facade = null;
  renderFacade();
  refreshAll();
});
ui.facadeAz.addEventListener('input', () => {
  state.facade = Number(ui.facadeAz.value);
  facadeNote = '';
  renderFacade();
  refreshSun();
  scheduleHash();
});

// ---------- Événements carte ----------
let dragging = false;
map.on('dragstart', () => (dragging = true));
map.on('dragend', () => setTimeout(() => (dragging = false), 50));
map.on('click', (e) => {
  if (dragging) return;
  const target = e.originalEvent && e.originalEvent.target;
  if (target && target.closest && target.closest('.maplibregl-marker')) return;
  // Façade active : un nouveau point lit l'orientation du mur le plus proche (déplacer le repère, lui, la garde).
  setPoint(state.facade != null ? aimFacade(e.lngLat) : e.lngLat);
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
  heightfieldSeq++;
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
  if (stats.wooded > 0) parts.push(`bois\u00a0${Math.max(1, Math.round(stats.wooded * 100))}\u00a0%`); // insécable : jamais un « % » seul à la ligne
  if (stats.trees > 0) parts.push(`${stats.trees.toLocaleString('fr-FR')}\u00a0arbre${stats.trees > 1 ? 's' : ''}`);
  if (stats.treesLoading) parts.push('arbres en chargement…');
  else if (stats.treesFailed) parts.push(stats.treesRetrying ? 'arbres indisponibles, nouvel essai automatique' : 'arbres indisponibles pour l\'instant');
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
      // Un tour complet de la journée filmé : la vidéo s'arrête d'elle-même.
      if (recorder && (recordedMinutes += state.speed) >= 1440) setPlaying(false);
    }, 50);
  } else {
    scheduleHash();
    if (recorder) stopRecording();
  }
}
ui.play.addEventListener('click', () => setPlaying(!state.playing));

// ---------- Vidéo de l'animation ----------
const videoType = typeof MediaRecorder !== 'undefined' && HTMLCanvasElement.prototype.captureStream ? pickVideoType((t) => MediaRecorder.isTypeSupported(t)) : null;
let recorder = null;
let recordedMinutes = 0;
let recordTimer = null;
let videoUrl = null;
const fmtClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function startRecording() {
  ui.recordError.hidden = true;
  const r = new MapRecorder(map, videoType, () => ({ time: formatMinutes(state.minutes), date: longDate(state.date) }));
  try {
    r.start();
  } catch (err) {
    ui.recordError.textContent = `Enregistrement impossible : ${err.message || err}`;
    ui.recordError.hidden = false;
    return;
  }
  recorder = r;
  debug.recorder = r;
  recordedMinutes = 0;
  ui.videoLink.hidden = true;
  ui.recordLabel.textContent = 'Arrêter';
  setStatus('Enregistrement de la vidéo : la pause l\'arrête.');
  // Le chrono reste dans le bouton, hors de la ligne d'état qu'un lecteur d'écran lirait à chaque seconde.
  const t0 = performance.now();
  const tick = () => (ui.recordTime.textContent = ` · ${fmtClock((performance.now() - t0) / 1000)}`);
  tick();
  recordTimer = setInterval(tick, 500);
  if (!state.playing) setPlaying(true);
}

async function stopRecording() {
  const r = recorder;
  recorder = null;
  clearInterval(recordTimer);
  ui.recordLabel.textContent = 'Enregistrer';
  ui.recordTime.textContent = '';
  let blob = null;
  try {
    blob = await r.stop();
  } catch {
    // traité juste dessous, comme une vidéo vide
  }
  if (!blob || !blob.size) {
    ui.recordError.textContent = 'L\'enregistrement a échoué : aucune image n\'a été filmée.';
    ui.recordError.hidden = false;
    setStatus('');
    return;
  }
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = URL.createObjectURL(blob);
  const ext = blob.type === 'video/mp4' ? 'mp4' : 'webm';
  const size = `${(blob.size / 1e6).toFixed(1).replace('.', ',')}\u00a0Mo`;
  ui.videoLink.href = videoUrl;
  ui.videoLink.download = `ombres-${state.date}.${ext}`;
  ui.videoLinkLabel.textContent = `Télécharger · ${ext.toUpperCase()}, ${size}`;
  ui.videoLink.hidden = false;
  setStatus(`Vidéo prête (${ext.toUpperCase()}, ${size}) : « Télécharger », dans la section Vidéo du panneau.`);
}

if (!videoType) {
  ui.record.disabled = true;
  ui.recordUnsupported.hidden = false;
}
ui.record.addEventListener('click', () => (recorder ? setPlaying(false) : startRecording()));

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
ui.toggleTrees.checked = state.trees;
ui.toggleBuildings.checked = state.buildings3d;
ui.toggleTerrain.checked = state.terrain;
ui.opacity.value = String(state.opacity);
for (const r of document.querySelectorAll('input[name="style"]')) r.checked = r.value === state.style;

ui.toggleShadows.addEventListener('change', () => {
  state.shadows = ui.toggleShadows.checked;
  shadowMap.setShadowsVisible(state.shadows);
  scheduleHash();
});
ui.toggleTrees.addEventListener('change', () => {
  state.trees = ui.toggleTrees.checked;
  shadowMap.setTrees(state.trees);
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
      // Un lieu du carnet s'ouvre (it.open) ; un résultat de recherche se survole.
      const go = () => (it.open ? it.open() : goToResult(it));
      li.tabIndex = 0;
      li.addEventListener('click', go);
      li.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') go();
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
  // Le nom trouvé devient celui proposé pour le carnet, tant qu'on n'en a pas tapé un autre.
  if (!ui.placeName.value || autoName) {
    ui.placeName.value = r.name.split(',')[0].trim();
    autoName = true;
  }
}
// Champ de recherche vide : le carnet de lieux en guise de suggestions.
function showPlaces() {
  const list = readPlaces();
  if (list.length) showResults([{ name: 'Carnet de lieux', empty: true }, ...list.map((p) => ({ name: p.name, open: () => openPlace(p.hash) }))]);
}
ui.searchInput.addEventListener('focus', () => {
  if (!ui.searchInput.value.trim()) showPlaces();
});
ui.searchInput.addEventListener('input', () => {
  if (!ui.searchInput.value.trim()) showPlaces();
  else ui.results.hidden = true;
});
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
  const h = currentHash();
  if (h !== location.hash) history.replaceState(null, '', h);
}
function currentHash() {
  const c = map.getCenter();
  return buildHash({
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
    trees: state.trees,
    point: state.point,
    mode: state.mode,
    opacity: state.opacity,
    event: state.event && { date: state.event.date, time: formatMinutes(state.event.minutes) },
    facade: state.facade,
    height: state.height,
  });
}

// ---------- Carnet de lieux (stockage du navigateur, aucun serveur) ----------
const PLACES_KEY = 'ombres.carnet';
let autoName = false; // le nom du champ vient de la recherche : une nouvelle recherche peut le remplacer

function readPlaces() {
  try {
    return parsePlaces(localStorage.getItem(PLACES_KEY));
  } catch {
    return []; // stockage refusé (navigation privée stricte, réglages du navigateur)
  }
}

function savePlaces(list) {
  try {
    localStorage.setItem(PLACES_KEY, JSON.stringify(list));
    ui.placeError.hidden = true;
  } catch {
    ui.placeError.textContent = 'Le navigateur refuse d\'enregistrer (navigation privée ?) : le carnet n\'a pas changé.';
    ui.placeError.hidden = false;
  }
  renderPlaces();
}

function renderPlaces() {
  const list = readPlaces();
  ui.placesHint.hidden = list.length > 0;
  ui.places.innerHTML = '';
  for (const p of list) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'place-open';
    const name = document.createElement('span');
    name.textContent = p.name;
    open.append(name);
    const ev = parseHash(p.hash).event;
    if (ev) {
      const meta = document.createElement('small');
      meta.textContent = `cérémonie le ${ev.date.split('-').reverse().join('/')} à ${ev.time}`;
      open.append(meta);
    }
    open.addEventListener('click', () => openPlace(p.hash));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'link danger';
    del.textContent = 'Supprimer';
    del.setAttribute('aria-label', `Supprimer ${p.name}`);
    del.addEventListener('click', () => savePlaces(readPlaces().filter((q) => q.name !== p.name)));
    const li = document.createElement('li');
    li.append(open, del);
    ui.places.append(li);
  }
}

/** Rouvre un lieu : vue, point, façade, cérémonie, date et heure. Les réglages d'affichage (fond, couches) restent. */
function openPlace(h) {
  const p = parseHash(h);
  if (p.lat == null) return;
  ui.results.hidden = true;
  ui.searchInput.blur();
  // Le jour du repérage reste celui qu'on regardait, sauf si c'était la cérémonie d'un autre lieu.
  const scout = state.event && state.date === state.event.date ? state.scout : { date: state.date, minutes: state.minutes };
  state.event = p.event ? { date: p.event.date, minutes: hhmmToMinutes(p.event.time) } : null;
  state.scout = scout;
  if (state.event) state.eventMinutes = state.event.minutes;
  renderEvent();
  state.facade = p.facade ?? null;
  facadeNote = '';
  state.height = p.height ?? 1.5;
  ui.pointHeight.value = fmtMeters(state.height);
  state.tzAuto = !isValidTimeZone(p.tz);
  state.tz = state.tzAuto ? tzFor(p.lat, p.lng) : p.tz;
  if (p.date) state.date = p.date;
  if (p.time) state.minutes = hhmmToMinutes(p.time);
  map.jumpTo({ center: [p.lng, p.lat], zoom: p.zoom, bearing: p.bearing || 0, pitch: p.pitch || 0 });
  setPoint(p.point || null);
  renderFacade();
  if (state.mode === 'exposure') requestExposureMap();
}

ui.placeForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = ui.placeName.value.trim();
  if (!name) return;
  savePlaces(addPlace(readPlaces(), { name, hash: currentHash() }));
  if (ui.placeError.hidden) {
    ui.placeName.value = '';
    autoName = false;
  }
});
ui.placeName.addEventListener('input', () => (autoName = false));

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
renderFacade();
renderPlaces();
ui.pointHeight.value = fmtMeters(state.height);
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
