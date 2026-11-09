// Position du soleil et heures remarquables — algorithme NOAA (Jean Meeus, "Astronomical Algorithms").
// Aucune dépendance. Précision typique : < 0,01° sur l'azimut/élévation, ~1 min sur lever/coucher.

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export const SUNRISE_ZENITH = 90.833; // bord supérieur du disque + réfraction standard

export function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Paramètres solaires (déclinaison, équation du temps) pour un siècle julien donné. */
function solarParams(t) {
  const L0 = ((280.46646 + t * (36000.76983 + t * 0.0003032)) % 360 + 360) % 360;
  const M = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const Mr = M * RAD;
  const C =
    Math.sin(Mr) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * Mr) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * Mr) * 0.000289;
  const trueLong = L0 + C;
  const omega = (125.04 - 1934.136 * t) * RAD;
  const lambda = (trueLong - 0.00569 - 0.00478 * Math.sin(omega)) * RAD;
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = (eps0 + 0.00256 * Math.cos(omega)) * RAD;
  const declination = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const y = Math.tan(eps / 2) ** 2;
  const L0r = L0 * RAD;
  const eqTime =
    4 *
    DEG *
    (y * Math.sin(2 * L0r) -
      2 * e * Math.sin(Mr) +
      4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
      0.5 * y * y * Math.sin(4 * L0r) -
      1.25 * e * e * Math.sin(2 * Mr));
  return { declination, eqTime };
}

/** Correction de réfraction atmosphérique (degrés) pour une élévation géométrique (degrés). */
export function refraction(elev) {
  if (elev > 85) return 0;
  const te = Math.tan(elev * RAD);
  let r;
  if (elev > 5) r = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (elev > -0.575) r = 1735 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)));
  else r = -20.774 / te;
  return r / 3600;
}

/**
 * Position du soleil à un instant donné.
 * @param {Date} date instant (UTC interne)
 * @param {number} lat latitude en degrés
 * @param {number} lng longitude en degrés (est positif)
 * @returns {{azimuth:number, altitude:number, altitudeGeometric:number, declination:number, equationOfTime:number, hourAngle:number}}
 *   azimuth : 0 = nord, 90 = est, 180 = sud, 270 = ouest. altitude : degrés au-dessus de l'horizon (avec réfraction).
 */
export function sunPosition(date, lat, lng) {
  const t = (julianDay(date) - 2451545) / 36525;
  const { declination, eqTime } = solarParams(t);
  const minutesUTC =
    date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60 + date.getUTCMilliseconds() / 60000;
  let tst = (minutesUTC + eqTime + 4 * lng) % 1440;
  if (tst < 0) tst += 1440;
  let ha = tst / 4 - 180;
  if (ha < -180) ha += 360;
  const phi = lat * RAD;
  const har = ha * RAD;
  const cosZen = Math.sin(phi) * Math.sin(declination) + Math.cos(phi) * Math.cos(declination) * Math.cos(har);
  const zen = Math.acos(clamp(cosZen, -1, 1));
  const elev = 90 - zen * DEG;

  let az;
  const denom = Math.cos(phi) * Math.sin(zen);
  if (Math.abs(denom) > 1e-12) {
    const cosAz = clamp((Math.sin(phi) * Math.cos(zen) - Math.sin(declination)) / denom, -1, 1);
    const a = Math.acos(cosAz) * DEG;
    az = ha > 0 ? (a + 180) % 360 : (540 - a) % 360;
  } else {
    // Soleil au zénith (ou au pôle) : l'azimut n'est pas défini, on prend une valeur continue.
    az = lat >= 0 ? 180 : 0;
  }

  return {
    azimuth: az,
    altitude: elev + refraction(elev),
    altitudeGeometric: elev,
    declination: declination * DEG,
    equationOfTime: eqTime,
    hourAngle: ha,
  };
}

/**
 * Instants UTC auxquels le centre du soleil atteint le zénith `zenith` (degrés) un jour donné.
 * `noonUTC` : un instant proche du midi local du jour considéré (Date).
 * Retourne { rise: Date|null, set: Date|null, status: 'normal'|'polar-day'|'polar-night' }.
 */
export function timesForZenith(noonUTC, lat, lng, zenith) {
  const phi = lat * RAD;
  let rise = null;
  let set = null;
  let status = 'normal';
  // Deux passes : la seconde affine avec les paramètres solaires de l'instant trouvé.
  let tRise = noonUTC;
  let tSet = noonUTC;
  for (let pass = 0; pass < 2; pass++) {
    const pr = solarParams((julianDay(tRise) - 2451545) / 36525);
    const ps = solarParams((julianDay(tSet) - 2451545) / 36525);
    const argR = Math.cos(zenith * RAD) / (Math.cos(phi) * Math.cos(pr.declination)) - Math.tan(phi) * Math.tan(pr.declination);
    const argS = Math.cos(zenith * RAD) / (Math.cos(phi) * Math.cos(ps.declination)) - Math.tan(phi) * Math.tan(ps.declination);
    if (argR > 1 || argS > 1) {
      status = 'polar-night';
      return { rise: null, set: null, status };
    }
    if (argR < -1 || argS < -1) {
      status = 'polar-day';
      return { rise: null, set: null, status };
    }
    const haR = Math.acos(argR) * DEG;
    const haS = Math.acos(argS) * DEG;
    const dayStart = Date.UTC(noonUTC.getUTCFullYear(), noonUTC.getUTCMonth(), noonUTC.getUTCDate());
    // Minutes UTC depuis minuit UTC du jour de référence. On ramène d'abord le MIDI SOLAIRE à moins de 12 h du midi
    // civil fourni, puis on en déduit lever et coucher sans autre repliement : un coucher peut tomber plus de 12 h
    // après le midi civil (jours très longs + fuseau décalé, ex. Nome en Alaska) sans être rejeté d'un jour.
    const refMin = (noonUTC.getTime() - dayStart) / 60000;
    let noonR = 720 - 4 * lng - pr.eqTime;
    while (noonR - refMin > 720) noonR -= 1440;
    while (noonR - refMin < -720) noonR += 1440;
    let noonS = 720 - 4 * lng - ps.eqTime;
    while (noonS - refMin > 720) noonS -= 1440;
    while (noonS - refMin < -720) noonS += 1440;
    const riseMin = noonR - 4 * haR;
    const setMin = noonS + 4 * haS;
    tRise = new Date(dayStart + riseMin * 60000);
    tSet = new Date(dayStart + setMin * 60000);
  }
  rise = tRise;
  set = tSet;
  return { rise, set, status };
}

/** Midi solaire (UTC) du jour contenant `noonUTC`. */
export function solarNoon(noonUTC, lat, lng) {
  let t = noonUTC;
  for (let pass = 0; pass < 2; pass++) {
    const p = solarParams((julianDay(t) - 2451545) / 36525);
    const dayStart = Date.UTC(noonUTC.getUTCFullYear(), noonUTC.getUTCMonth(), noonUTC.getUTCDate());
    let noonMin = 720 - 4 * lng - p.eqTime;
    const refMin = (noonUTC.getTime() - dayStart) / 60000;
    while (noonMin - refMin > 720) noonMin -= 1440;
    while (noonMin - refMin < -720) noonMin += 1440;
    t = new Date(dayStart + noonMin * 60000);
  }
  return t;
}

/**
 * Résumé du jour : lever, coucher, midi solaire, crépuscules, heures dorées.
 * `noonUTC` doit être le midi (heure civile locale) du jour voulu, exprimé en Date.
 */
export function dayInfo(noonUTC, lat, lng) {
  const sun = timesForZenith(noonUTC, lat, lng, SUNRISE_ZENITH);
  const civil = timesForZenith(noonUTC, lat, lng, 96); // -6°
  const golden = timesForZenith(noonUTC, lat, lng, 84); // +6°
  const blue = timesForZenith(noonUTC, lat, lng, 94); // -4°
  const noon = solarNoon(noonUTC, lat, lng);
  const noonPos = sunPosition(noon, lat, lng);
  let dayLengthMin = null;
  if (sun.status === 'normal') dayLengthMin = (sun.set - sun.rise) / 60000;
  else if (sun.status === 'polar-day') dayLengthMin = 1440;
  else dayLengthMin = 0;
  return {
    sunrise: sun.rise,
    sunset: sun.set,
    status: sun.status,
    solarNoon: noon,
    noonAltitude: noonPos.altitude,
    dayLengthMinutes: dayLengthMin,
    civilDawn: civil.rise,
    civilDusk: civil.set,
    goldenMorningEnd: golden.rise,
    goldenEveningStart: golden.set,
    blueMorningStart: blue.rise,
    blueEveningEnd: blue.set,
  };
}

/** Longueur d'ombre (m) d'un objet de hauteur h (m) pour une élévation solaire (degrés). Infinity si soleil couché. */
export function shadowLength(h, altitude) {
  if (altitude <= 0) return Infinity;
  return h / Math.tan(altitude * RAD);
}

/** Qualifie la lumière pour une élévation donnée (étiquette FR + clé). */
export function lightPhase(altitude) {
  if (altitude >= 6) return { key: 'day', label: 'Jour' };
  if (altitude >= -4) return { key: 'golden', label: altitude >= 0 ? 'Heure dorée' : 'Heure dorée (soleil couché)' };
  if (altitude >= -6) return { key: 'blue', label: 'Heure bleue' };
  if (altitude >= -12) return { key: 'nautical', label: 'Crépuscule nautique' };
  if (altitude >= -18) return { key: 'astro', label: 'Crépuscule astronomique' };
  return { key: 'night', label: 'Nuit' };
}
