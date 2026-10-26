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
// proj4 only knows EPSG:4326/3857 by itself. These are the projected CRSs the national open-LiDAR
// catalogues use (flai-ai/open-lidar-data declares one per dataset, and its COPC files carry NO CRS
// VLR at all), taken from epsg.io. OSGB36 (27700) uses the 7-parameter Helmert instead of the OSTN15
// grid proj4js cannot load: metres-level, plenty for placing a dataset on a globe.
const EPSG_DEFS = {
  2056: '+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs',
  2154: '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  2169: '+proj=tmerc +lat_0=49.8333333333333 +lon_0=6.16666666666667 +k=1 +x_0=80000 +y_0=100000 +ellps=intl +towgs84=-265.8867,76.9851,20.2667,0.33746,3.09264,-2.53861,0.4598 +units=m +no_defs',
  2177: '+proj=tmerc +lat_0=0 +lon_0=18 +k=0.999923 +x_0=6500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  2180: '+proj=tmerc +lat_0=0 +lon_0=19 +k=0.9993 +x_0=500000 +y_0=-5300000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  3059: '+proj=tmerc +lat_0=0 +lon_0=24 +k=0.9996 +x_0=500000 +y_0=-6000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  3067: '+proj=utm +zone=35 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  3301: '+proj=lcc +lat_0=57.5175539305556 +lon_0=24 +lat_1=59.3333333333333 +lat_2=58 +x_0=500000 +y_0=6375000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  3794: '+proj=tmerc +lat_0=0 +lon_0=15 +k=0.9999 +x_0=500000 +y_0=-5000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  3812: '+proj=lcc +lat_0=50.797815 +lon_0=4.35921583333333 +lat_1=49.8333333333333 +lat_2=51.1666666666667 +x_0=649328 +y_0=665262 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  4083: '+proj=utm +zone=28 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  27700: '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs',
  28992: '+proj=sterea +lat_0=52.1561605555556 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.4171,50.3319,465.5524,1.9342,-1.6677,9.1019,4.0725 +units=m +no_defs',
  29902: '+proj=tmerc +lat_0=53.5 +lon_0=-8 +k=1.000035 +x_0=200000 +y_0=250000 +a=6377340.189 +rf=299.3249646 +towgs84=482.5,-130.6,564.6,-1.042,-0.214,-0.631,8.15 +units=m +no_defs',
  31370: '+proj=lcc +lat_0=90 +lon_0=4.36748666666667 +lat_1=51.1666672333333 +lat_2=49.8333339 +x_0=150000.013 +y_0=5400088.438 +ellps=intl +towgs84=-106.8686,52.2978,-103.7239,0.3366,-0.457,1.8422,-1.2747 +units=m +no_defs',
};

/**
 * `EPSG:<n>` → a proj4 definition. Also derives the UTM families by rule: WGS84 (326xx north,
 * 327xx south) and ETRS89 (258xx). Anything else (WKT, a proj string) passes through unchanged.
 */
export function crsDefinition(crs) {
  const m = /^\s*EPSG:(\d+)\s*$/i.exec(String(crs));
  if (!m) return crs;
  const code = +m[1];
  if (EPSG_DEFS[code]) return EPSG_DEFS[code];
  if (code >= 32601 && code <= 32660) return `+proj=utm +zone=${code - 32600} +datum=WGS84 +units=m +no_defs`;
  if (code >= 32701 && code <= 32760) return `+proj=utm +zone=${code - 32700} +south +datum=WGS84 +units=m +no_defs`;
  if (code >= 25828 && code <= 25838) return `+proj=utm +zone=${code - 25800} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
  return crs;                                   // EPSG:4326 / 3857 — proj4 knows them already
}

/**
 * Root transform placing content that is local to `origin` (source-CRS coordinates minus origin) on
 * the globe.
 *
 * A projected CRS's x/y axes are NOT east/north: they are rotated by the grid convergence (up to ~3°
 * at a UTM zone edge, more in Lambert grids far from the central meridian) and scaled by the point
 * scale factor (0.9996 on a UTM central meridian, up to ~1.001 at its edges). So instead of a plain
 * ENU frame, the x and y columns are the ECEF images of the source's own unit vectors at the origin —
 * a "1 m trihedron" measured with proj4 by central differences over ±50 m — and z is the ellipsoid
 * normal (heights are heights). For a geographic source CRS (lon/lat degrees) the plain ENU frame is
 * kept, since its axes are not metric.
 */
export function georefFromCrs(origin, crs, tag = 'geo') {
  if (!crs) return null;
  crs = unwrapCompoundWkt(crsDefinition(crs));
  try {
    const P = proj4(crs, 'WGS84');
    const [lon, lat, h] = P.forward(origin);
    const z = h ?? origin[2];
    const e = llhToEcef(lon, lat, z);
    const enu = enuMatrix(lon, lat, e[0], e[1], e[2]);
    if (Math.abs(origin[0]) <= 360 && Math.abs(origin[1]) <= 90) return enu;     // geographic source CRS
    const D = 50;
    const at = (dx, dy) => { const [lo, la] = P.forward([origin[0] + dx, origin[1] + dy, z]); return llhToEcef(lo, la, z); };
    const colX = at(D, 0).map((v, i) => (v - at(-D, 0)[i]) / (2 * D));
    const colY = at(0, D).map((v, i) => (v - at(0, -D)[i]) / (2 * D));
    if (![...colX, ...colY].every(Number.isFinite)) return enu;
    return [colX[0], colX[1], colX[2], 0, colY[0], colY[1], colY[2], 0, enu[8], enu[9], enu[10], 0, e[0], e[1], e[2], 1];
  } catch (e) { console.warn(`[${tag}] georef failed:`, e.message); return null; }
}

/** Column-major 4×4 inverse (general; null when singular). */
export function mat4Invert(m) {
  const [a00,a01,a02,a03, a10,a11,a12,a13, a20,a21,a22,a23, a30,a31,a32,a33] = m;
  const b00 = a00*a11 - a01*a10, b01 = a00*a12 - a02*a10, b02 = a00*a13 - a03*a10, b03 = a01*a12 - a02*a11;
  const b04 = a01*a13 - a03*a11, b05 = a02*a13 - a03*a12, b06 = a20*a31 - a21*a30, b07 = a20*a32 - a22*a30;
  const b08 = a20*a33 - a23*a30, b09 = a21*a32 - a22*a31, b10 = a21*a33 - a23*a31, b11 = a22*a33 - a23*a32;
  let det = b00*b11 - b01*b10 + b02*b09 + b03*b08 - b04*b07 + b05*b06;
  if (!det) return null;
  det = 1 / det;
  return [
    (a11*b11 - a12*b10 + a13*b09)*det, (a02*b10 - a01*b11 - a03*b09)*det, (a31*b05 - a32*b04 + a33*b03)*det, (a22*b04 - a21*b05 - a23*b03)*det,
    (a12*b08 - a10*b11 - a13*b07)*det, (a00*b11 - a02*b08 + a03*b07)*det, (a32*b02 - a30*b05 - a33*b01)*det, (a20*b05 - a22*b02 + a23*b01)*det,
    (a10*b10 - a11*b08 + a13*b06)*det, (a01*b08 - a00*b10 - a03*b06)*det, (a30*b04 - a31*b02 + a33*b00)*det, (a21*b02 - a20*b04 - a23*b00)*det,
    (a11*b07 - a10*b09 - a12*b06)*det, (a00*b09 - a01*b07 + a02*b06)*det, (a31*b01 - a30*b03 - a32*b00)*det, (a20*b03 - a21*b01 + a22*b00)*det,
  ];
}

/**
 * Exact placement for a PROJECTED source. georefFromCrs's root transform is the tangent trihedron at
 * the origin: fine within a few km, but a point 500 km away lands 20 km above the ellipsoid (the
 * plane leaves the curved surface as d²/2R) and sideways by the grid's scale distortion. Returns a
 * function writing the exact local coordinates of a source point — projected → lon/lat → ECEF, then
 * into `transform`'s own frame, so the root transform and every nearby point stay as they were —
 * or null for a geographic/unknown CRS. The caller pays one proj4 inverse per point.
 */
export function curvedLocalizer(origin, crs, transform, tag = 'geo') {
  if (!crs || !transform || Math.abs(origin[0]) <= 360 && Math.abs(origin[1]) <= 90) return null;
  const inv = mat4Invert(transform);
  if (!inv) return null;
  try {
    const P = proj4(unwrapCompoundWkt(crsDefinition(crs)), 'WGS84');
    const probe = P.forward([origin[0], origin[1]]);
    if (!probe.every(Number.isFinite)) return null;
    const [ox, oy, oz] = origin;
    return (x, y, z, out, o = 0) => {
      const [lon, lat] = P.forward([x, y]);
      const [ex, ey, ez] = llhToEcef(lon, lat, z);
      const lx = inv[0]*ex + inv[4]*ey + inv[8]*ez  + inv[12];
      const ly = inv[1]*ex + inv[5]*ey + inv[9]*ez  + inv[13];
      const lz = inv[2]*ex + inv[6]*ey + inv[10]*ez + inv[14];
      // an outlier outside the projection's domain (flai's Estonia file has points millions of metres
      // east) comes back NaN from proj4: keep it on the tangent plane rather than poison the buffer
      if (Number.isFinite(lx) && Number.isFinite(ly) && Number.isFinite(lz)) { out[o] = lx; out[o+1] = ly; out[o+2] = lz; }
      else { out[o] = x - ox; out[o+1] = y - oy; out[o+2] = z - oz; }
    };
  } catch (e) { console.warn(`[${tag}] curved placement unavailable:`, e.message); return null; }
}

/**
 * The curved placement of ONE tile's points, fast: `toLocal` (curvedLocalizer, ~1 µs a point through
 * proj4) sampled on a grid over the tile's source cube `sc = [x0,y0,z0, x1,y1,z1]`, then bilinear in
 * x/y and linear in z (the placement IS linear in z: ellipsoid normal × height). The sampled function
 * bends as 1/R, so a grid step h is wrong by at most h²/8R per axis, h²/4R for both: 505 m for 1 cm.
 * A tile under 505 m costs 8 proj4 calls instead of one per point; a 32 km tile (a 64 × 64 grid)
 * 8 450. Wider tiles, the few sparse ones at the top of a national cube, keep the exact per-point path.
 */
export function curvedTileLocalizer(toLocal, sc, { maxErr = 0.01, maxCells = 64 } = {}) {
  const sx = sc[3]-sc[0], sy = sc[4]-sc[1], z0 = sc[2], dz = sc[5]-sc[2];
  if (!(sx > 0) || !(sy > 0)) return toLocal;
  const step = Math.sqrt(4 * 6378137 * maxErr);
  const NX = Math.max(1, Math.ceil(sx / step)), NY = Math.max(1, Math.ceil(sy / step));
  if (NX > maxCells || NY > maxCells) return toLocal;
  const W = NX + 1, g = new Float64Array(W * (NY+1) * 6), p = new Float64Array(3);
  for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
    const x = sc[0] + sx * i / NX, y = sc[1] + sy * j / NY, k = (j*W + i) * 6;
    toLocal(x, y, z0, p);      g[k] = p[0]; g[k+1] = p[1]; g[k+2] = p[2];
    toLocal(x, y, z0 + dz, p); g[k+3] = p[0]; g[k+4] = p[1]; g[k+5] = p[2];
  }
  for (let k = 0; k < g.length; k++) if (!Number.isFinite(g[k])) return toLocal;   // a node outside the projection's domain
  const zs = dz > 0 ? 1 / dz : 0;
  return (x, y, z, out, o = 0) => {
    const u = (x - sc[0]) / sx * NX, v = (y - sc[1]) / sy * NY;
    // COPC nodes are not clipped to their cube: the few points outside it take the exact path
    if (!(u >= 0 && u <= NX && v >= 0 && v <= NY)) return toLocal(x, y, z, out, o);
    let i = Math.floor(u), j = Math.floor(v);
    if (i >= NX) i = NX-1; if (j >= NY) j = NY-1;
    const fu = u - i, fv = v - j, w = (z - z0) * zs;
    const k00 = (j*W + i) * 6, k10 = k00 + 6, k01 = k00 + W*6, k11 = k01 + 6;
    for (let c = 0; c < 3; c++) {
      const b = (g[k00+c] + (g[k10+c]-g[k00+c])*fu) + ((g[k01+c] + (g[k11+c]-g[k01+c])*fu) - (g[k00+c] + (g[k10+c]-g[k00+c])*fu))*fv;
      const t = (g[k00+3+c] + (g[k10+3+c]-g[k00+3+c])*fu) + ((g[k01+3+c] + (g[k11+3+c]-g[k01+3+c])*fu) - (g[k00+3+c] + (g[k10+3+c]-g[k00+3+c])*fu))*fv;
      out[o+c] = b + (t - b) * w;
    }
  };
}

/** `&curved=` of a /stream or /aggregate request: 'on' | 'off' | null (auto: on past 20 km). */
export function curvedParam(v) {
  if (v == null || v === '' || v === 'auto') return null;
  return ['0', 'off', 'false', 'no'].includes(String(v).toLowerCase()) ? 'off' : 'on';
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
