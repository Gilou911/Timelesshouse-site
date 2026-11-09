// Recherche de lieu via Nominatim (OpenStreetMap). Usage léger : une requête par validation, jamais en autocomplétion.
const ENDPOINT = 'https://nominatim.openstreetmap.org/search';

const TIMEOUT_MS = 10000;

function withTimeout(signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  }
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

export async function searchPlace(query, { limit = 6, signal } = {}) {
  const q = query.trim();
  if (!q) return [];
  // Coordonnées saisies directement : "48.85, 2.35"
  const m = q.match(/^\s*(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)\s*$/);
  if (m) {
    const lat = parseFloat(m[1].replace(',', '.'));
    const lng = parseFloat(m[2].replace(',', '.'));
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return [{ name: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng, bbox: null }];
    }
  }
  const url = new URL(ENDPOINT);
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('accept-language', 'fr');
  const t = withTimeout(signal);
  let data;
  try {
    const res = await fetch(url, { signal: t.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    data = await res.json();
  } finally {
    t.done();
  }
  return data.map((r) => ({
    name: r.display_name,
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
    bbox: r.boundingbox ? r.boundingbox.map(parseFloat) : null, // [latMin, latMax, lngMin, lngMax]
    type: r.type,
  }));
}
