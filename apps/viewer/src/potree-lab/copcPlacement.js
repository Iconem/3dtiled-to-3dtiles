/**
 * Where a COPC file sits on the WGS84 globe, from the CRS it declares (its WKT VLR): the matrix that
 * takes the file's own coordinates to earth-centred ones (ECEF, metres), fit to be a root tile's
 * `transform`.
 *
 * The method is the tile server's (packages/core/geo.js, georefFromCrs), with the ellipsoid of
 * 3DTilesRendererJS:
 * - a compound CRS is reduced to its horizontal part, which is what proj4 reads;
 * - the centre of the octree cube goes to longitude and latitude;
 * - the x and y columns are the ECEF images of the file's own unit vectors there, measured with proj4
 *   by central differences over ±50 m. That one measure holds the three corrections at once: the unit
 *   (a foot is 0.3048 m), the grid convergence (grid north is not true north away from the central
 *   meridian) and the scale factor of the projection;
 * - the z column is the ellipsoid normal times the vertical unit, read from the vertical part of a
 *   compound CRS, else taken to be the horizontal one.
 *
 * What it does not do: heights are taken as heights above the ellipsoid (no geoid model: a
 * gravity-related height is off by the local geoid undulation, tens of metres at most), and the frame
 * is a plane tangent at the centre, so a cloud wider than about 20 km leaves the ellipsoid by several
 * metres at its edges (the server bends such clouds point by point; this does not).
 *
 * Never throws: a CRS that is missing or that proj4 cannot read gives `{ placed: false, note }`.
 */
import proj4 from 'proj4';
import { Vector3 } from 'three';
import { WGS84_ELLIPSOID } from '3d-tiles-renderer';

const DEG = Math.PI / 180;

/** The horizontal part of a compound WKT (WKT1 COMPD_CS, WKT2 COMPOUNDCRS): its first projected or geographic block. */
export function horizontalWkt(wkt) {
  if (typeof wkt !== 'string' || !/^\s*(COMPD_CS|COMPOUNDCRS)/i.test(wkt)) return wkt;
  const starts = [/PROJCS\[/i, /PROJCRS\[/i, /GEOGCS\[/i, /GEOGCRS\[/i, /GEODCRS\[/i, /GEOGRAPHICCRS\[/i].map((re) => wkt.search(re)).filter((i) => i >= 0);
  if (!starts.length) return wkt;
  const start = starts[0];
  let depth = 0;
  for (let i = wkt.indexOf('[', start); i < wkt.length; i++) {
    if (wkt[i] === '[') depth++;
    else if (wkt[i] === ']' && --depth === 0) return wkt.slice(start, i + 1);
  }
  return wkt.slice(start);
}

/** Metres per vertical unit, from the vertical part of a compound WKT; null when there is none. */
export function verticalUnit(wkt) {
  if (typeof wkt !== 'string') return null;
  const at = wkt.search(/VERT_CS\[|VERTCRS\[|VERTICALCRS\[/i);
  if (at < 0) return null;
  const m = /(?:LENGTHUNIT|UNIT)\[\s*"([^"]*)"\s*,\s*([0-9.eE+-]+)/i.exec(wkt.slice(at));
  const f = m ? Number(m[2]) : NaN;
  return Number.isFinite(f) && f > 0 ? { name: m[1], toMetre: f } : null;
}

/**
 * @param {string|undefined} crs  WKT of the file, or anything else proj4 reads (a proj string, a code it knows).
 * @param {number[]} cube         [minx, miny, minz, maxx, maxy, maxz] of the octree, in the file's coordinates.
 * @param {number[]} zRange       [min z, max z] of the points, for the height reported.
 * @returns {{ placed: boolean, note: string, transform?: number[], lon?: number, lat?: number, height?: number,
 *   convergence?: number, unit?: number, verticalUnit?: number, crsName?: string }}
 *   `transform` is column-major. Angles in degrees, `height` in metres (the middle of the points' heights),
 *   `unit` the metres one horizontal unit of the file covers on the ground at the centre.
 */
export function placementFromCrs(crs, cube, zRange = [0, 0]) {
  if (!crs) return { placed: false, note: 'the file declares no CRS' };
  const horizontal = horizontalWkt(String(crs));
  let P, proj;
  try {
    P = proj4(horizontal, 'WGS84');
    proj = new proj4.Proj(horizontal);
  } catch (e) {
    return { placed: false, note: `proj4 cannot read the CRS of the file${e?.message ? ` (${String(e.message).slice(0, 80)})` : ''}` };
  }
  try {
    const cx = (cube[0] + cube[3]) / 2, cy = (cube[1] + cube[4]) / 2;
    const geographic = proj.projName === 'longlat';
    const toMetre = geographic ? 1 : (Number.isFinite(proj.to_meter) && proj.to_meter > 0 ? proj.to_meter : 1);
    const [lon, lat] = P.forward([cx, cy]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90) return { placed: false, note: 'the CRS of the file gives no position for its centre' };

    const ecef = (x, y) => { const [lo, la] = P.forward([x, y]); return WGS84_ELLIPSOID.getCartographicToPosition(la * DEG, lo * DEG, 0, new Vector3()); };
    const d = geographic ? 1e-4 : 50 / toMetre;                         // ±50 m, in the file's unit
    const colX = ecef(cx + d, cy).sub(ecef(cx - d, cy)).divideScalar(2 * d);
    const colY = ecef(cx, cy + d).sub(ecef(cx, cy - d)).divideScalar(2 * d);
    const east = new Vector3(), north = new Vector3(), up = new Vector3();
    WGS84_ELLIPSOID.getEastNorthUpAxes(lat * DEG, lon * DEG, east, north, up);
    const origin = WGS84_ELLIPSOID.getCartographicToPosition(lat * DEG, lon * DEG, 0, new Vector3());
    if (![colX, colY, origin].every((v) => Number.isFinite(v.x + v.y + v.z)) || !(colX.length() > 0)) return { placed: false, note: 'the CRS of the file gives no frame at its centre' };

    const vertical = verticalUnit(String(crs));
    const zUnit = geographic ? (vertical?.toMetre ?? 1) : (vertical?.toMetre ?? toMetre);
    const colZ = up.clone().multiplyScalar(zUnit);
    // file (x, y, z) → origin + colX (x − cx) + colY (y − cy) + colZ z
    const t = origin.clone().addScaledVector(colX, -cx).addScaledVector(colY, -cy);
    const transform = [colX.x, colX.y, colX.z, 0, colY.x, colY.y, colY.z, 0, colZ.x, colZ.y, colZ.z, 0, t.x, t.y, t.z, 1];

    const side = (cube[3] - cube[0]) * colX.length();
    const name = /^\s*\w+\[\s*"([^"]+)"/.exec(String(crs))?.[1] ?? String(crs).slice(0, 40);
    return {
      placed: true,
      transform, lon, lat,
      height: (zRange[0] + zRange[1]) / 2 * zUnit,
      // grid north against true north, positive when grid north points east of true north
      convergence: Math.atan2(colY.dot(east), colY.dot(north)) / DEG,
      unit: colX.length(),
      verticalUnit: zUnit,
      crsName: name,
      note: (vertical || geographic ? '' : 'no vertical CRS: heights read in the horizontal unit; ')
        + (side > 20000 ? `flat frame over ${(side / 1000).toFixed(0)} km: the edges leave the ellipsoid; ` : '')
        + 'heights taken as ellipsoidal (no geoid)',
    };
  } catch (e) {
    return { placed: false, note: `the CRS of the file could not be applied (${String(e?.message ?? e).slice(0, 80)})` };
  }
}
