// Façade ou axe de prise de vue : le mur le plus proche d'un point, et les créneaux où le soleil l'éclaire.

const RAD = Math.PI / 180;

/** Pair-impair sur tous les anneaux : un point dans une cour intérieure n'est pas dans le bâtiment. */
function inside(rings, x, y) {
  let c = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if (r[i][1] > y !== r[j][1] > y && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
    }
  }
  return c;
}

/**
 * Mur extérieur le plus proche de `p` ({lng, lat}) parmi des emprises de bâtiments.
 * polygons : [[anneau extérieur, cours…], …], anneaux en [lng, lat] (GeoJSON).
 * Un mur dont le côté extérieur tombe dans un autre bâtiment n'en est pas un : cloison entre deux parties
 * d'un château, ou coupure d'une emprise au bord d'une tuile (les deux morceaux se recouvrent).
 * @returns {{azimuth:number, distance:number, foot:{lng:number,lat:number}, normal:number[], inside:boolean}|null}
 *   azimuth : direction vers laquelle le mur fait face (de l'intérieur vers l'extérieur), 0 = nord, 90 = est.
 *   foot : point du mur le plus proche ; normal : vecteur unité (est, nord) vers l'extérieur ;
 *   inside : `p` est dans ce bâtiment (sur son toit).
 */
export function nearestWall(p, polygons, maxMeters = 12) {
  const kx = 111320 * Math.cos(p.lat * RAD);
  const ky = 110540;
  let best = null;
  const all = polygons.map((poly) => poly.map((r) => r.map(([lng, lat]) => [(lng - p.lng) * kx, (lat - p.lat) * ky])));
  const inAny = (x, y) => all.some((rings) => inside(rings, x, y));
  // Point sur un toit : le mur extérieur le plus proche, à toute distance.
  const onRoof = inAny(0, 0);
  const limit = onRoof ? Infinity : maxMeters;
  for (const rings of all) {
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const [ax, ay] = ring[i];
        const [bx, by] = ring[(i + 1) % ring.length];
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy);
        if (len < 0.5) continue; // anneau fermé (dernier = premier) ou sommet doublé
        const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (len * len)));
        const distance = Math.hypot(ax + t * dx, ay + t * dy);
        if (distance > limit || (best && distance >= best.distance)) continue;
        let nx = dy / len;
        let ny = -dx / len;
        // La normale sort du bâtiment : un pas de 50 cm depuis le milieu du mur ne doit pas y entrer…
        if (inside(rings, ax + dx / 2 + nx * 0.5, ay + dy / 2 + ny * 0.5)) {
          nx = -nx;
          ny = -ny;
        }
        // … ni entrer dans un autre.
        if (inAny(ax + dx / 2 + nx * 0.5, ay + dy / 2 + ny * 0.5)) continue;
        best = { distance, x: ax + t * dx, y: ay + t * dy, nx, ny };
      }
    }
  }
  if (!best) return null;
  return {
    azimuth: ((Math.atan2(best.nx, best.ny) / RAD) + 360) % 360,
    distance: best.distance,
    foot: { lng: p.lng + best.x / kx, lat: p.lat + best.y / ky },
    normal: [best.nx, best.ny],
    inside: onRoof,
  };
}

/** Décale `p` de `meters` dans la direction (est, nord) `dir`. */
export function offsetLngLat(p, dir, meters) {
  return { lng: p.lng + (dir[0] * meters) / (111320 * Math.cos(p.lat * RAD)), lat: p.lat + (dir[1] * meters) / 110540 };
}

/** Éclairage d'une façade tournée vers `facing` (degrés) : le point est au soleil ET le soleil est devant le mur. */
export function facadeLit(lit, azimuths, facing) {
  // Seuil d'arrondi : soleil exactement dans le plan du mur (cos 90° = 6e-17) = non éclairé.
  return lit.map((v, i) => (v && Math.cos((azimuths[i] - facing) * RAD) > 1e-9 ? 1 : 0));
}

/** Créneaux [début, fin] en minutes des échantillons à 1, un échantillon toutes les `step` minutes. */
export function litIntervals(lit, step) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= lit.length; i++) {
    const on = i < lit.length && lit[i] === 1;
    if (on && start < 0) start = i * step;
    if (!on && start >= 0) {
      out.push([start, i * step]);
      start = -1;
    }
  }
  return out;
}
