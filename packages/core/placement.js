/**
 * placement.js — a dataset set on the globe by hand, and how that is written down.
 *
 * `/stream` places a local dataset with five numbers (`&lon=&lat=&alt=&heading=&scale=`, geo.js's applyPlacement):
 * an East/North/Up frame at a point, turned about its vertical, scaled. A viewer's gizmo yields a matrix instead.
 * This module goes both ways, with no imports beyond ecef.js, so the viewer uses it too:
 *
 *   placementMatrix(lon, lat, alt, heading, scale)   the five numbers → the matrix (what the server applies)
 *   decomposePlacement(matrix)                       a matrix → the five numbers, and how far it is from being
 *                                                    exactly that (a tilt, a scale that differs by axis)
 *   placedStreamUrl(url, placement)                  a /stream URL with the five numbers set
 *   placedTileset(url, matrix, …)                    a tileset.json that holds the source under the matrix itself:
 *                                                    the transform burnt into a root, tilt and all
 *
 * All matrices are column-major 4×4, as in glTF and 3D Tiles.
 */
import { DEG, llhToEcef, ecefToLlh, enuFrame } from './ecef.js';

const mul = (a, b) => {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) r[c * 4 + row] += a[k * 4 + row] * b[c * 4 + k];
  return r;
};

/**
 * User-directed globe placement for a LOCAL (non-georeferenced) tileset: ENU frame at (lon°, lat°, alt m) with an
 * optional compass `heading` (degrees CLOCKWISE from north, rotating the dataset about local Up) and uniform
 * `scale`. Returns the column-major root `transform`. Compose it ON TOP of a tileset's existing local-upright flip:
 * the flip maps content → upright Z-up local, this maps upright local → ECEF.
 */
export function placementMatrix(lon, lat, alt = 0, heading = 0, scale = 1) {
  const e = llhToEcef(lon, lat, alt);
  const { EAST: E, NORTH: N, UP: U } = enuFrame(lon, lat);
  let m = [E[0], E[1], E[2], 0, N[0], N[1], N[2], 0, U[0], U[1], U[2], 0, e[0], e[1], e[2], 1];
  if (heading) {                                   // compass CW → math-positive CCW about +Z (Up)
    const h = -heading * DEG, c = Math.cos(h), s = Math.sin(h);
    m = mul(m, [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  }
  if (scale !== 1) m = mul(m, [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, 1]);
  return m;
}

/**
 * A placement matrix back to the five numbers `/stream` takes.
 * @param {number[]} m  column-major 4×4: upright local (X east, Y north, Z up before any turn) → ECEF
 * @returns {{ lon:number, lat:number, alt:number, heading:number, scale:number, tilt:number, stretch:number, exact:boolean }}
 *   `heading` degrees clockwise from north, in (−180, 180]; `tilt`: degrees between the matrix's own vertical and
 *   the ellipsoid's at that point; `stretch`: the largest axis scale over the smallest, 1 when uniform. `exact`: the
 *   five numbers reproduce the matrix (tilt under 0.05°, stretch under 0.1 %, no mirror); otherwise they are its
 *   nearest upright, uniform placement and only the matrix itself says the rest.
 */
export function decomposePlacement(m) {
  const [lon, lat, alt] = ecefToLlh(m[12], m[13], m[14]);
  const { EAST: E, NORTH: N, UP: U } = enuFrame(lon, lat);
  const col = (i) => [m[i * 4], m[i * 4 + 1], m[i * 4 + 2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const x = col(0), y = col(1), z = col(2);
  const sx = len(x), sy = len(y), sz = len(z);
  const scale = Math.cbrt(sx * sy * sz) || 1;
  const stretch = Math.max(sx, sy, sz) / (Math.min(sx, sy, sz) || 1e-12);
  const tilt = Math.acos(Math.max(-1, Math.min(1, dot(z, U) / (sz || 1)))) / DEG;
  // the heading from the horizontal part of both horizontal axes, so that a small tilt does not bias it
  const hx = Math.atan2(-dot(x, N), dot(x, E)), hy = Math.atan2(dot(y, E), dot(y, N));
  let heading = Math.atan2(Math.sin(hx) + Math.sin(hy), Math.cos(hx) + Math.cos(hy)) / DEG;
  if (Math.abs(heading) < 1e-9) heading = 0;
  // a mirror (negative determinant) is not a placement the five numbers can say
  const cross = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  const mirrored = dot(cross, z) < 0;
  return { lon, lat, alt, heading, scale, tilt, stretch, exact: tilt < 0.05 && stretch < 1.001 && !mirrored };
}

const round = (v, digits) => Number(v.toFixed(digits));

/**
 * A `/stream/tileset.json` URL with a placement set: its `lon`, `lat`, `alt`, `heading` and `scale` replaced (a
 * heading of 0 and a scale of 1 are left out). Longitude and latitude keep 8 decimals (a millimetre), the others 3.
 */
export function placedStreamUrl(url, p) {
  const u = new URL(url);
  for (const k of ['lon', 'lat', 'alt', 'heading', 'scale']) u.searchParams.delete(k);
  u.searchParams.set('lon', String(round(p.lon, 8)));
  u.searchParams.set('lat', String(round(p.lat, 8)));
  if (Math.abs(p.alt) >= 0.0005) u.searchParams.set('alt', String(round(p.alt, 3)));
  if (Math.abs(p.heading) >= 0.0005) u.searchParams.set('heading', String(round(p.heading, 3)));
  if (Math.abs(p.scale - 1) >= 0.00005) u.searchParams.set('scale', String(round(p.scale, 4)));
  return u.href;
}

/** Can this URL carry a placement: is it a `/stream/tileset.json` of the tile server? */
export const isStreamUrl = (url) => /\/stream\/tileset\.json(\?|$)/.test(String(url));

/**
 * The placement a `/stream` URL already carries (its `lon` and `lat`, with `alt`, `heading`, `scale`), as a matrix;
 * null when it has none.
 */
export function streamUrlPlacement(url) {
  let sp; try { sp = new URL(url).searchParams; } catch { return null; }
  if (!sp.has('lon') || !sp.has('lat')) return null;
  const lon = Number(sp.get('lon')), lat = Number(sp.get('lat'));
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return placementMatrix(lon, lat, Number(sp.get('alt') || 0), Number(sp.get('heading') || 0), Number(sp.get('scale') || 1));
}

/**
 * A tileset.json that holds a source tileset under a transform: the gizmo's matrix burnt into a root, exactly
 * (a tilt and a scale by axis included), for any client. The source is referenced, not copied.
 * @param {string} sourceUrl   the source tileset's absolute URL
 * @param {number[]} matrix    column-major 4×4 applied on top of the source's own root transform
 * @param {{ sphere:number[], geometricError:number, placement?:object }} o
 *   `sphere`: [x, y, z, radius] bounding the source in ITS frame (after its own root transform, before `matrix`)
 */
export function placedTileset(sourceUrl, matrix, { sphere, geometricError, placement }) {
  return {
    asset: { version: '1.1', extras: { placedFrom: sourceUrl, ...(placement ? { placement } : {}) } },
    geometricError,
    root: {
      transform: Array.from(matrix),
      boundingVolume: { sphere: Array.from(sphere) },
      geometricError,
      refine: 'ADD',
      content: { uri: sourceUrl },
    },
  };
}
