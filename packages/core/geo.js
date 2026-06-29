/**
 * geo.js — shared geo-referencing math for the live stream adapters.
 *
 * Previously duplicated verbatim across copc-live / potree-live / lcc-live (llhToEcef + enuMatrix) and
 * inline in i3s-live (ENU frame). One authoritative copy here. All matrices are column-major 4×4 in
 * glTF/3D-Tiles convention (translation in the last column m[12..14]).
 */
import proj4 from 'proj4';

export const DEG = Math.PI / 180;
const A = 6378137.0, E2 = 0.00669437999014;   // WGS84 semi-major axis + first eccentricity²

/** Geodetic (lon°, lat°, h) → geocentric ECEF [x,y,z]. */
export const llhToEcef = (lon, lat, h) => {
  const sLat = Math.sin(lat*DEG), cLat = Math.cos(lat*DEG), sLon = Math.sin(lon*DEG), cLon = Math.cos(lon*DEG);
  const N = A / Math.sqrt(1 - E2*sLat*sLat);
  return [(N+h)*cLat*cLon, (N+h)*cLat*sLon, (N*(1-E2)+h)*sLat];
};

/** ENU basis vectors at (lon°, lat°): { EAST, NORTH, UP } (unit, ECEF). */
export const enuFrame = (lon, lat) => {
  const sl = Math.sin(lon*DEG), cl = Math.cos(lon*DEG), sp = Math.sin(lat*DEG), cp = Math.cos(lat*DEG);
  return { EAST: [-sl, cl, 0], NORTH: [-sp*cl, -sp*sl, cp], UP: [cp*cl, cp*sl, sp] };
};

/** Column-major ENU→ECEF placement matrix (columns East, North, Up, origin). */
export const enuMatrix = (lon, lat, cx, cy, cz) => {
  const { EAST: E, NORTH: N, UP: U } = enuFrame(lon, lat);
  return [E[0],E[1],E[2],0, N[0],N[1],N[2],0, U[0],U[1],U[2],0, cx,cy,cz,1];
};

/** Georeference a local origin via a proj4-parsable CRS/WKT → ENU→ECEF transform, or null. */
export function georefFromCrs(origin, crs, tag = 'geo') {
  if (!crs) return null;
  try {
    const [lon, lat, h] = proj4(crs, 'WGS84').forward(origin);
    const e = llhToEcef(lon, lat, h ?? origin[2]);
    return enuMatrix(lon, lat, e[0], e[1], e[2]);
  } catch (e) { console.warn(`[${tag}] georef failed:`, e.message); return null; }
}
