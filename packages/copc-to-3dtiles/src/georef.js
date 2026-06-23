/**
 * georef.js  (copc-to-3dtiles)
 *
 * Converts COPC/LAS WKT CRS to an ECEF root transform for 3D Tiles.
 * Returns a column-major 4×4 ENU→ECEF matrix at the dataset origin.
 *
 * The copc library exposes VLR metadata (userId, recordId, contentOffset,
 * contentLength) but not the raw VLR data bytes.  We read them directly
 * from the file when needed.
 */

import proj4 from 'proj4';
import fs    from 'fs/promises';

const DEG     = Math.PI / 180;
const WGS84_A = 6378137.0;
const WGS84_E2 = 0.00669437999014;

function llhToEcef(lon, lat, h) {
  const sinLat = Math.sin(lat * DEG), cosLat = Math.cos(lat * DEG);
  const sinLon = Math.sin(lon * DEG), cosLon = Math.cos(lon * DEG);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return [
    (N + h) * cosLat * cosLon,
    (N + h) * cosLat * sinLon,
    (N * (1 - WGS84_E2) + h) * sinLat
  ];
}

/** Column-major 4×4 ENU→ECEF rotation+translation at (lon, lat) with ECEF origin. */
function enuMatrix(lon, lat, cx, cy, cz) {
  const sl = Math.sin(lon * DEG), cl = Math.cos(lon * DEG);
  const sp = Math.sin(lat * DEG), cp = Math.cos(lat * DEG);
  // East, North, Up column vectors
  return [
    -sl,       cl,       0,   0,
    -sp*cl,   -sp*sl,    cp,  0,
     cp*cl,    cp*sl,    sp,  0,
     cx,       cy,       cz,  1
  ];
}

/**
 * Read WKT string from LASF_Projection/2112 VLR directly from the LAZ file.
 * The copc library exposes VLR offset+length but not the byte content.
 */
async function readWktFromFile(filename, copc) {
  // Prefer whatever the library already parsed
  const fromLib = copc.info?.wkt ?? copc.header?.wkt;
  if (fromLib) return fromLib;

  const vlrs = copc.vlrs ?? copc.header?.vlrs ?? [];
  const vlr = vlrs.find(v => v.userId === 'LASF_Projection' && v.recordId === 2112);
  if (!vlr || !vlr.contentOffset || !vlr.contentLength) return null;

  let fh;
  try {
    fh = await fs.open(filename, 'r');
    const buf = Buffer.alloc(vlr.contentLength);
    await fh.read(buf, 0, vlr.contentLength, vlr.contentOffset);
    // Trim null bytes (LAS WKT records are often null-padded)
    const raw = buf.toString('utf8').replace(/\0/g, '').trim();
    // COMPD_CS wraps a 2D CRS + a vertical CRS.  proj4 only understands the
    // horizontal part (PROJCS or GEOGCS), so extract the first nested CRS.
    if (raw.startsWith('COMPD_CS[')) {
      const inner = raw.slice(raw.indexOf(',') + 1).trim();
      const match = inner.match(/^(PROJCS|GEOGCS)\[/);
      if (match) {
        // Extract balanced brackets
        let depth = 0, end = 0;
        for (let i = 0; i < inner.length; i++) {
          if (inner[i] === '[') depth++;
          else if (inner[i] === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        return end > 0 ? inner.slice(0, end) : raw;
      }
    }
    return raw || null;
  } catch (e) {
    console.warn('[georef] Failed to read VLR bytes:', e.message);
    return null;
  } finally {
    // Always close — a throw in fh.read() would otherwise leak the handle.
    if (fh) await fh.close().catch(() => {});
  }
}

/**
 * @param {object}   copc      Copc instance
 * @param {string}   filename  Path to the .copc.laz file
 * @param {number[]} origin    [x, y, z] in dataset CRS (bbox centre)
 * @returns {{ transform: number[]|null, hasGeoref: boolean }}
 */
export async function buildEcefTransform(copc, filename, origin) {
  const wkt = await readWktFromFile(filename, copc);
  if (!wkt) {
    console.warn('[georef] No WKT CRS in COPC VLRs — local coordinate output');
    return { transform: null, hasGeoref: false };
  }

  let lon, lat, h;
  try {
    const [ox, oy, oz] = origin;
    [lon, lat, h] = proj4(wkt, 'WGS84').forward([ox, oy, oz]);
  } catch (e) {
    console.warn('[georef] proj4 failed:', e.message);
    return { transform: null, hasGeoref: false };
  }

  if (!isFinite(lon) || !isFinite(lat)) {
    console.warn('[georef] Non-finite lon/lat from proj4 — skipping transform');
    return { transform: null, hasGeoref: false };
  }

  const [cx, cy, cz] = llhToEcef(lon, lat, h ?? origin[2]);
  console.log(`[georef] lon=${lon.toFixed(6)} lat=${lat.toFixed(6)} → ECEF [${cx.toFixed(0)},${cy.toFixed(0)},${cz.toFixed(0)}]`);
  return { transform: enuMatrix(lon, lat, cx, cy, cz), hasGeoref: true };
}
