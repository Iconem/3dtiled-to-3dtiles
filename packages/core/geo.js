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

/** Geocentric ECEF [x,y,z] → geodetic [lon°, lat°, h] (closed-form Bowring). */
export const ecefToLlh = (x, y, z) => {
  const b = A * Math.sqrt(1 - E2), ep2 = (A * A - b * b) / (b * b);
  const p = Math.hypot(x, y), th = Math.atan2(A * z, b * p);
  const lat = Math.atan2(z + ep2 * b * Math.sin(th) ** 3, p - E2 * A * Math.cos(th) ** 3);
  const N = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  return [Math.atan2(y, x) / DEG, lat / DEG, p / Math.cos(lat) - N];
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

// proj4 cannot parse a COMPD_CS[...] (compound horizontal+vertical CRS — common in ContextCapture/3MX
// WKT, e.g. "RGF93 / Lambert-93 + NGF-IGN69 height"). Unwrap it to the inner horizontal PROJCS/GEOGCS
// (the vertical component is just height, already carried by origin[2]).
function unwrapCompoundWkt(crs) {
  if (typeof crs !== 'string' || !/^\s*COMPD_CS/i.test(crs)) return crs;
  const start = crs.search(/PROJCS\[/i) >= 0 ? crs.search(/PROJCS\[/i) : crs.search(/GEOGCS\[/i);
  if (start < 0) return crs;
  let depth = 0;                                            // extract the first balanced [...] block
  for (let i = crs.indexOf('[', start); i < crs.length; i++) {
    if (crs[i] === '[') depth++;
    else if (crs[i] === ']' && --depth === 0) return crs.slice(start, i + 1);
  }
  return crs.slice(start);
}

/** Column-major 4×4 multiply: (a·b) v = a (b v). Both flat 16-arrays in glTF/3D-Tiles layout. */
export function mat4Multiply(a, b) {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++)
    for (let k = 0; k < 4; k++) r[c*4 + row] += a[k*4 + row] * b[c*4 + k];
  return r;
}

/**
 * User-directed globe placement for a LOCAL (non-georeferenced) tileset: ENU frame at (lon°, lat°,
 * alt m) with an optional compass `heading` (degrees CLOCKWISE from north, rotating the dataset about
 * local Up) and uniform `scale`. Returns the column-major root `transform`. Compose it ON TOP of a
 * tileset's existing local-upright flip (mat4Multiply(placement, flip)) — the flip maps content →
 * upright Z-up local, this maps upright local → ECEF.
 */
export function placementMatrix(lon, lat, alt = 0, heading = 0, scale = 1) {
  const e = llhToEcef(lon, lat, alt);
  let m = enuMatrix(lon, lat, e[0], e[1], e[2]);
  if (heading) {                                   // compass CW → math-positive CCW about +Z (Up)
    const h = -heading * DEG, c = Math.cos(h), s = Math.sin(h);
    m = mat4Multiply(m, [c,s,0,0, -s,c,0,0, 0,0,1,0, 0,0,0,1]);
  }
  if (scale !== 1) m = mat4Multiply(m, [scale,0,0,0, 0,scale,0,0, 0,0,scale,0, 0,0,0,1]);
  return m;
}

/** True iff a root `transform` already places content at ECEF scale (translation ≫ any local frame). */
export const isEcefPlaced = (t) => !!t && Math.hypot(t[12], t[13], t[14]) > 1e6;

/**
 * Apply the user-directed placement query params (&lon=&lat=[&alt=][&heading=][&scale=]) to a tileset
 * root. Composes placementMatrix ON TOP of any existing local-upright root transform (each format's
 * own up-axis flip stays baked in), and refuses to override a source's own real georeference (its ECEF
 * placement wins — pass no lon/lat to keep it). Returns true iff a placement was applied.
 */
export function applyPlacement(root, sp, tag = 'place') {
  if (!sp.has('lon') || !sp.has('lat')) return false;
  const lon = Number(sp.get('lon')), lat = Number(sp.get('lat'));
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  if (isEcefPlaced(root.transform)) { console.warn(`[${tag}] source is already georeferenced — ignoring &lon/&lat placement`); return false; }
  const place = placementMatrix(lon, lat, Number(sp.get('alt') || 0), Number(sp.get('heading') || 0), Number(sp.get('scale') || 1));
  root.transform = root.transform ? mat4Multiply(place, root.transform) : place;
  return true;
}

/** Georeference a local origin via a proj4-parsable CRS/WKT → ENU→ECEF transform, or null. */
export function georefFromCrs(origin, crs, tag = 'geo') {
  if (!crs) return null;
  crs = unwrapCompoundWkt(crs);
  try {
    const [lon, lat, h] = proj4(crs, 'WGS84').forward(origin);
    const e = llhToEcef(lon, lat, h ?? origin[2]);
    return enuMatrix(lon, lat, e[0], e[1], e[2]);
  } catch (e) { console.warn(`[${tag}] georef failed:`, e.message); return null; }
}

/** Central meridian (lon_0) for the CGCS2000 3°-Gauss-Krüger EPSG codes XGRIDS LCC uses, or null. */
export function cgcs2000Lon0(epsg) {
  if (epsg >= 4513 && epsg <= 4533) return 75 + 3 * (epsg - 4513);
  if (epsg >= 4534 && epsg <= 4554) return 3 * (25 + (epsg - 4534));
  return null;
}

// Fallback root `transform` for LCC scenes with no usable EPSG (meta.epsg 0/unknown — Guanlan Ancient
// Town, religious_center_L2_P). MUST match lccGeoref's own flip, NOT boundToZUpBox's — those two are
// different conventions (a 2026-07-02 bug: this constant was first built to match boundToZUpBox's
// `(x,y,z)→(x,−z,y)`, which rendered content flat but upside-down). Decomposing lccGeoref's actual
// working matrix (columns [East,−Up,North,origin], applied as East·x − Up·y + North·z + origin) against
// local axes East=(1,0,0), North=(0,1,0), Up=(0,0,1) — i.e. Up maps to output Z, the 3D-Tiles up axis —
// gives (x,y,z)→(x,z,−y), the SAME flip extract-live.js's `YUP_ZUP_P90` uses for LCC crops (already
// verified there against 10 real Guan_Temple tiles). No ENU placement (local origin, unit basis).
export const LCC_LOCAL_UPRIGHT = [1,0,0,0, 0,0,-1,0, 0,1,0,0, 0,0,0,1];

// Georeference an LCC scene from its meta (`epsg` + projected `offset`) → root `transform` placing the
// local frame on the globe. The column layout [East, −Up, North, origin] bakes the splat glTF Y-up→Z-up
// RX(+90°) into the frame (SPZ-verbatim positions sit upright + located). null if no/unknown CRS — so
// it's the single source of truth shared by the live `/lcc` adapter and the offline converter ("reuse
// the georef meta"). XGRIDS sometimes stores a CM-based easting (x_0=500000) even under a zone-prefixed
// EPSG, so the false easting is detected from the magnitude of offset.x rather than assumed from the code.
export function lccGeoref(meta, tag = 'lcc') {
  if (!meta || !meta.epsg || !Array.isArray(meta.offset)) return null;
  const lon0 = cgcs2000Lon0(meta.epsg);
  if (lon0 == null) { console.warn(`[${tag}] EPSG:${meta.epsg} not a known CGCS2000 GK zone — local origin`); return null; }
  const x0 = meta.offset[0] >= 1e6 ? Math.floor(meta.offset[0] / 1e6) * 1e6 + 5e5 : 5e5;   // strip zone prefix if present
  const def = `+proj=tmerc +lat_0=0 +lon_0=${lon0} +k=1 +x_0=${x0} +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
  try {
    const [lon, lat] = proj4(def, 'WGS84').forward([meta.offset[0], meta.offset[1]]);
    const e = llhToEcef(lon, lat, meta.offset[2] || 0);
    const { EAST: East, NORTH: North, UP: Up } = enuFrame(lon, lat);   // columns East, −Up, North, origin
    console.log(`[${tag}] georef EPSG:${meta.epsg} (lon_0=${lon0}) → ${lon.toFixed(4)},${lat.toFixed(4)}`);
    return [East[0],East[1],East[2],0, -Up[0],-Up[1],-Up[2],0, North[0],North[1],North[2],0, e[0],e[1],e[2],1];
  } catch (err) { console.warn(`[${tag}] georef failed for EPSG:${meta.epsg}: ${err.message} — local origin`); return null; }
}
