// Fuseaux horaires sans dépendance : conversions heure civile ↔ UTC via Intl.

const fmtCache = new Map();

function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Date UTC → composantes de l'heure civile dans le fuseau `tz`. mo = 1..12. */
export function utcToWall(tz, date) {
  const parts = formatter(tz).formatToParts(date);
  const o = {};
  for (const p of parts) if (p.type !== 'literal') o[p.type] = parseInt(p.value, 10);
  return { y: o.year, mo: o.month, d: o.day, h: o.hour === 24 ? 0 : o.hour, mi: o.minute, s: o.second };
}

/** Décalage (minutes) du fuseau `tz` par rapport à UTC à l'instant `date` (positif à l'est). */
export function tzOffsetMinutes(tz, date) {
  const w = utcToWall(tz, date);
  const asUTC = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  const t = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUTC - t) / 60000);
}

/** Heure civile (y, mo 1..12, d, h, mi, s) dans `tz` → Date UTC. Gère les changements d'heure. */
export function wallToUTC(tz, y, mo, d, h, mi, s = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off1 = tzOffsetMinutes(tz, new Date(guess));
  let t = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(tz, new Date(t));
  if (off2 !== off1) t = guess - off2 * 60000;
  return new Date(t);
}

/** Minutes écoulées depuis minuit (heure civile de `tz`) pour l'instant `date`. */
export function minutesOfDay(tz, date) {
  const w = utcToWall(tz, date);
  return w.h * 60 + w.mi + w.s / 60;
}

/** Étiquette courte du fuseau, ex. « UTC+1 », « UTC−3:30 ». */
export function tzLabel(tz, date) {
  const off = tzOffsetMinutes(tz, date);
  const sign = off < 0 ? '−' : '+';
  const a = Math.abs(off);
  const hh = Math.floor(a / 60);
  const mm = a % 60;
  return `UTC${sign}${hh}${mm ? ':' + String(mm).padStart(2, '0') : ''}`;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** "HH:MM" à partir de minutes depuis minuit. */
export function formatMinutes(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/** "HH:MM" de l'instant `date` dans `tz`. */
export function formatTime(tz, date) {
  if (!date) return '—';
  const w = utcToWall(tz, date);
  return `${pad2(w.h)}:${pad2(w.mi)}`;
}

/** "YYYY-MM-DD" de l'instant `date` dans `tz`. */
export function formatDateISO(tz, date) {
  const w = utcToWall(tz, date);
  return `${w.y}-${pad2(w.mo)}-${pad2(w.d)}`;
}

/** Durée en minutes → "12 h 34". */
export function formatDuration(min) {
  if (min == null || !isFinite(min)) return '—';
  const m = Math.round(min);
  return `${Math.floor(m / 60)} h ${pad2(m % 60)}`;
}
