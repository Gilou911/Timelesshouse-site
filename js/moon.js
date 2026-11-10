// Lune : position, lever, coucher, phase. Sans dépendance.
// Position : « MiniMoon » de Montenbruck et Pfleger (Astronomy on the Personal Computer), quelques minutes d'arc ;
// distance : quatre termes principaux de Meeus (Astronomical Algorithms, chap. 47). Lever et coucher : convention de
// Meeus (centre géocentrique à 0,7275 × parallaxe − 34'), soit le bord supérieur sur l'horizon, réfraction comprise.
import { julianDay, refraction } from './sun.js';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const ARCS = 206264.8062; // secondes d'arc par radian
const TAU = 2 * Math.PI;
const frac = (x) => x - Math.floor(x);

/** Coordonnées géocentriques : longitude et latitude écliptiques, ascension droite, déclinaison (rad), distance (km). */
function moonCoords(date) {
  const T = (julianDay(date) - 2451545) / 36525;
  const L0 = frac(0.606433 + 1336.855225 * T);
  const l = TAU * frac(0.374897 + 1325.55241 * T); // anomalie moyenne de la Lune
  const ls = TAU * frac(0.993133 + 99.997361 * T); // anomalie moyenne du Soleil
  const D = TAU * frac(0.827361 + 1236.853086 * T); // élongation moyenne
  const F = TAU * frac(0.259086 + 1342.227825 * T); // distance au nœud ascendant
  const { sin, cos } = Math;
  const dL =
    22640 * sin(l) - 4586 * sin(l - 2 * D) + 2370 * sin(2 * D) + 769 * sin(2 * l) - 668 * sin(ls) - 412 * sin(2 * F) -
    212 * sin(2 * l - 2 * D) - 206 * sin(l + ls - 2 * D) + 192 * sin(l + 2 * D) - 165 * sin(ls - 2 * D) - 125 * sin(D) -
    110 * sin(l + ls) + 148 * sin(l - ls) - 55 * sin(2 * F - 2 * D);
  const S = F + (dL + 412 * sin(2 * F) + 541 * sin(ls)) / ARCS;
  const h = F - 2 * D;
  const N =
    -526 * sin(h) + 44 * sin(l + h) - 31 * sin(-l + h) - 23 * sin(ls + h) + 11 * sin(-ls + h) - 25 * sin(-2 * l + F) +
    21 * sin(-l + F);
  const lon = TAU * frac(L0 + dL / 1296000);
  const lat = (18520 * sin(S) + N) / ARCS;
  const dist = 385000.56 - 20905.355 * cos(l) - 3699.111 * cos(2 * D - l) - 2955.968 * cos(2 * D) - 569.925 * cos(2 * l);
  const eps = 23.43929111 * RAD;
  const ra = Math.atan2(sin(lon) * cos(eps) - Math.tan(lat) * sin(eps), cos(lon));
  const dec = Math.asin(sin(lat) * cos(eps) + cos(lat) * sin(eps) * sin(lon));
  return { lon, lat, dist, ra, dec, T };
}

/** Hauteur et azimut géocentriques (degrés), et parallaxe horizontale (degrés). */
function horizontal(date, lat, lng) {
  const c = moonCoords(date);
  const gmst = 280.46061837 + 360.98564736629 * (julianDay(date) - 2451545) + 0.000387933 * c.T * c.T;
  const ha = (gmst + lng) * RAD - c.ra;
  const phi = lat * RAD;
  const alt = Math.asin(Math.sin(phi) * Math.sin(c.dec) + Math.cos(phi) * Math.cos(c.dec) * Math.cos(ha)) * DEG;
  const az = Math.atan2(-Math.cos(c.dec) * Math.sin(ha), Math.sin(c.dec) * Math.cos(phi) - Math.cos(c.dec) * Math.cos(ha) * Math.sin(phi)) * DEG;
  return { alt, az: (az + 360) % 360, parallax: Math.asin(6378.14 / c.dist) * DEG };
}

/**
 * Position de la Lune vue d'un lieu.
 * @returns {{azimuth:number, altitude:number, altitudeTrue:number}} azimut depuis le nord ; élévation apparente
 *   (parallaxe et réfraction comprises) et vraie (parallaxe seule), en degrés.
 */
export function moonPosition(date, lat, lng) {
  const h = horizontal(date, lat, lng);
  const altitudeTrue = h.alt - h.parallax * Math.cos(h.alt * RAD);
  return { azimuth: h.az, altitude: altitudeTrue + refraction(altitudeTrue), altitudeTrue };
}

/**
 * Lever et coucher entre deux instants (en pratique, de minuit à minuit, heure civile) : hauteur échantillonnée
 * toutes les 10 min, passage interpolé. Le premier lever et le premier coucher ; null s'il n'y en a pas ce jour-là.
 * @returns {{rise:Date|null, set:Date|null, alwaysUp:boolean, alwaysDown:boolean}}
 */
export function moonTimes(start, end, lat, lng) {
  const above = (t) => {
    const h = horizontal(new Date(t), lat, lng);
    return h.alt - (0.7275 * h.parallax - 0.5667);
  };
  const step = 10 * 60000;
  const t1 = end.getTime();
  let t0 = start.getTime();
  let f0 = above(t0);
  const first = f0;
  let rise = null;
  let set = null;
  while (t0 < t1 && !(rise && set)) {
    const t = Math.min(t0 + step, t1);
    const f = above(t);
    if (f0 < 0 !== f < 0) {
      const tc = new Date(t0 + (f0 / (f0 - f)) * (t - t0));
      if (f0 < 0) rise = rise || tc;
      else set = set || tc;
    }
    t0 = t;
    f0 = f;
  }
  const none = !rise && !set;
  return { rise, set, alwaysUp: none && first >= 0, alwaysDown: none && first < 0 };
}

const PHASES = ['Nouvelle lune', 'Premier croissant', 'Premier quartier', 'Gibbeuse croissante', 'Pleine lune', 'Gibbeuse décroissante', 'Dernier quartier', 'Dernier croissant'];

/**
 * Phase : part éclairée du disque (0 à 1), élongation en longitude (0 = nouvelle, 90 = premier quartier,
 * 180 = pleine, 270 = dernier quartier) et nom de la phase (huit secteurs de 45° centrés sur les phases).
 */
export function moonPhase(date) {
  const c = moonCoords(date);
  // Soleil, précision basse (0,01°) : longitude écliptique moyenne + équation du centre.
  const d = julianDay(date) - 2451545;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const sunLon = (280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const psi = Math.acos(Math.cos(c.lat) * Math.cos(c.lon - sunLon)); // élongation vraie
  const R = 149598000; // distance Terre-Soleil (km), assez juste pour l'angle de phase
  const i = Math.atan2(R * Math.sin(psi), c.dist - R * Math.cos(psi));
  const elongation = ((((c.lon - sunLon) * DEG) % 360) + 360) % 360;
  return { fraction: (1 + Math.cos(i)) / 2, elongation, name: PHASES[Math.floor(((elongation + 22.5) % 360) / 45)] };
}
