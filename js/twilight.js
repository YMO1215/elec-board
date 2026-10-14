// 시민박명 (civil twilight): the sun is 6° below the horizon. Pure functions, unit tested.
// NOAA solar-position formulas — no network, no key, so the time is recomputed for whatever day it is.

// 서울특별시 노들로 674 (approximate coordinates — a few hundred metres move the time by well under a minute).
export const SITE = { name: "노들로 674", lat: 37.52, lon: 126.96 };
export const KST_HOURS = 9;
const CIVIL_ZENITH = 96; // 90° + 6°

const rad = (deg) => (deg * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

function daysSinceEpoch(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/** Solar declination (degrees) and equation of time (minutes) around local noon of `iso`. */
function sunAt(iso, lon) {
  const jd = daysSinceEpoch(iso) + 2440587.5 + 0.5 - lon / 360; // ≈ solar noon, UT
  const t = (jd - 2451545) / 36525;
  const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c = Math.sin(rad(m)) * (1.914602 - t * (0.004817 + 0.000014 * t))
    + Math.sin(rad(2 * m)) * (0.019993 - 0.000101 * t) + Math.sin(rad(3 * m)) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const lambda = l0 + c - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(omega));
  const decl = deg(Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda))));
  const y = Math.tan(rad(eps / 2)) ** 2;
  const eqTime = 4 * deg(y * Math.sin(2 * rad(l0)) - 2 * e * Math.sin(rad(m))
    + 4 * e * y * Math.sin(rad(m)) * Math.cos(2 * rad(l0)) - 0.5 * y * y * Math.sin(4 * rad(l0)) - 1.25 * e * e * Math.sin(2 * rad(m)));
  return { decl, eqTime };
}

/** Minutes after local midnight (KST) of civil dawn and dusk on `iso` (YYYY-MM-DD), or null at latitudes with no twilight. */
export function civilTwilight(iso, { lat, lon } = SITE, tz = KST_HOURS) {
  const { decl, eqTime } = sunAt(iso, lon);
  const cosHa = (Math.cos(rad(CIVIL_ZENITH)) - Math.sin(rad(lat)) * Math.sin(rad(decl))) / (Math.cos(rad(lat)) * Math.cos(rad(decl)));
  if (cosHa < -1 || cosHa > 1) return null;
  const halfDay = 4 * deg(Math.acos(cosHa)); // minutes
  const noon = 720 - 4 * lon - eqTime + tz * 60; // solar noon, local clock minutes
  return { dawn: noon - halfDay, dusk: noon + halfDay };
}

/** "06:12" — minutes after midnight, rounded to the nearest minute. */
export function clock(minutes) {
  const total = Math.round(minutes);
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** { dawn: "06:12", dusk: "18:34" } for a date, or null. */
export function twilightText(iso, site = SITE) {
  const t = civilTwilight(iso, site);
  return t ? { dawn: clock(t.dawn), dusk: clock(t.dusk) } : null;
}

const API = "https://api.sunrise-sunset.org/json";

/** "2026-10-14T21:12:03+00:00" (UTC) -> minutes after KST midnight on that KST day. */
function kstMinutes(utcIso) {
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return null;
  const k = new Date(d.getTime() + KST_HOURS * 3600000);
  return k.getUTCHours() * 60 + k.getUTCMinutes() + k.getUTCSeconds() / 60;
}

/** Fetch the day's civil twilight from api.sunrise-sunset.org -> { dawn: "06:12", dusk: "18:23" }, or null on any failure. */
export async function fetchTwilight(iso, site = SITE, fetchFn = globalThis.fetch) {
  try {
    const res = await fetchFn(`${API}?lat=${site.lat}&lng=${site.lon}&date=${iso}&formatted=0`);
    if (!res.ok) return null;
    const body = await res.json();
    const r = body?.results;
    const dawn = kstMinutes(r?.civil_twilight_begin);
    const dusk = kstMinutes(r?.civil_twilight_end);
    if (body?.status !== "OK" || dawn === null || dusk === null) return null;
    return { dawn: clock(dawn), dusk: clock(dusk) };
  } catch {
    return null;
  }
}
