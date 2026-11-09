// Recherche de lieu via Nominatim (OpenStreetMap). Usage léger : une requête par validation, jamais en autocomplétion.
const ENDPOINT = 'https://nominatim.openstreetmap.org/search';

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
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const data = await res.json();
  return data.map((r) => ({
    name: r.display_name,
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
    bbox: r.boundingbox ? r.boundingbox.map(parseFloat) : null, // [latMin, latMax, lngMin, lngMax]
    type: r.type,
  }));
}
