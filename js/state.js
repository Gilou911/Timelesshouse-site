// État partageable dans l'URL : #lat/lng/zoom/bearing/pitch?d=YYYY-MM-DD&t=HH:MM&tz=…&style=…&b3d=1&ter=1
/** Date civile réelle (pas de 31 février), entre 1900 et 2100 : domaine de validité du calcul solaire. */
export function isValidDateISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || y > 2100) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** Heure HH:MM entre 00:00 et 23:59. */
export function isValidTime(s) {
  const m = /^(\d{2}):(\d{2})$/.exec(s || '');
  return !!m && Number(m[1]) <= 23 && Number(m[2]) <= 59;
}

export function parseHash(hash) {
  const s = (hash || '').replace(/^#/, '');
  if (!s) return {};
  const [path, query = ''] = s.split('?');
  const out = {};
  const parts = path.split('/').map(parseFloat);
  if (parts.length >= 3 && parts.slice(0, 3).every((v) => Number.isFinite(v))) {
    out.lat = Math.max(-85, Math.min(85, parts[0]));
    out.lng = parts[1] >= -180 && parts[1] <= 180 ? parts[1] : ((parts[1] + 180) % 360 + 360) % 360 - 180;
    out.zoom = Math.max(0, Math.min(22, parts[2]));
    if (Number.isFinite(parts[3])) out.bearing = parts[3];
    if (Number.isFinite(parts[4])) out.pitch = Math.max(0, Math.min(85, parts[4]));
  }
  const q = new URLSearchParams(query);
  if (isValidDateISO(q.get('d'))) out.date = q.get('d');
  if (isValidTime(q.get('t'))) out.time = q.get('t');
  if (q.get('tz')) out.tz = q.get('tz');
  if (q.get('style')) out.style = q.get('style');
  if (q.has('b3d')) out.buildings3d = q.get('b3d') === '1';
  if (q.has('ter')) out.terrain = q.get('ter') === '1';
  if (q.has('sh')) out.shadows = q.get('sh') === '1';
  if (q.get('m') === 'exposure') out.mode = 'exposure';
  if (q.has('o')) {
    const o = parseFloat(q.get('o'));
    if (Number.isFinite(o)) out.opacity = Math.max(0.15, Math.min(0.85, o));
  }
  if (q.get('p')) {
    const p = q.get('p').split(',').map(parseFloat);
    if (p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 85 && Math.abs(p[1]) <= 180) out.point = { lat: p[0], lng: p[1] };
  }
  // Façade : f=azimut (degrés entiers) vers lequel elle fait face.
  if (/^\d{1,3}$/.test(q.get('f') || '') && Number(q.get('f')) < 360) out.facade = Number(q.get('f'));
  // Cérémonie : ev=YYYY-MM-DDTHH:MM
  const ev = /^(.{10})T(.{5})$/.exec(q.get('ev') || '');
  if (ev && isValidDateISO(ev[1]) && isValidTime(ev[2])) out.event = { date: ev[1], time: ev[2] };
  return out;
}

export function buildHash(st) {
  const r = (v, n) => Number(v).toFixed(n).replace(/\.?0+$/, '');
  let path = `${r(st.lat, 5)}/${r(st.lng, 5)}/${r(st.zoom, 2)}`;
  if (st.bearing || st.pitch) path += `/${r(st.bearing || 0, 1)}/${r(st.pitch || 0, 1)}`;
  const q = new URLSearchParams();
  if (st.date) q.set('d', st.date);
  if (st.time) q.set('t', st.time);
  if (st.tz) q.set('tz', st.tz);
  if (st.style && st.style !== 'plan') q.set('style', st.style);
  if (st.buildings3d === false) q.set('b3d', '0');
  if (st.terrain) q.set('ter', '1');
  if (st.shadows === false) q.set('sh', '0');
  if (st.mode === 'exposure') q.set('m', 'exposure');
  if (Number.isFinite(st.opacity) && Math.abs(st.opacity - 0.45) > 1e-9) q.set('o', r(st.opacity, 2));
  if (st.point) q.set('p', `${r(st.point.lat, 5)},${r(st.point.lng, 5)}`);
  if (st.facade != null) q.set('f', String(Math.round(st.facade) % 360));
  if (st.event) q.set('ev', `${st.event.date}T${st.event.time}`);
  const qs = q.toString().replace(/%3A/g, ':').replace(/%2C/g, ',').replace(/%2F/g, '/');
  return `#${path}${qs ? '?' + qs : ''}`;
}
