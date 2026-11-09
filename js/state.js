// État partageable dans l'URL : #lat/lng/zoom/bearing/pitch?d=YYYY-MM-DD&t=HH:MM&tz=…&style=…&b3d=1&ter=1
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
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.get('d') || '')) out.date = q.get('d');
  if (/^\d{2}:\d{2}$/.test(q.get('t') || '')) out.time = q.get('t');
  if (q.get('tz')) out.tz = q.get('tz');
  if (q.get('style')) out.style = q.get('style');
  if (q.has('b3d')) out.buildings3d = q.get('b3d') === '1';
  if (q.has('ter')) out.terrain = q.get('ter') === '1';
  if (q.has('sh')) out.shadows = q.get('sh') === '1';
  if (q.get('m') === 'exposure') out.mode = 'exposure';
  if (q.get('p')) {
    const p = q.get('p').split(',').map(parseFloat);
    if (p.length === 2 && p.every(Number.isFinite)) out.point = { lat: p[0], lng: p[1] };
  }
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
  if (st.point) q.set('p', `${r(st.point.lat, 5)},${r(st.point.lng, 5)}`);
  const qs = q.toString().replace(/%3A/g, ':').replace(/%2C/g, ',').replace(/%2F/g, '/');
  return `#${path}${qs ? '?' + qs : ''}`;
}
