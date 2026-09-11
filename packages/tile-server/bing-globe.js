/**
 * bing-globe.js — low-zoom **globe shell** content for the Bing Maps 3D adapter.
 *
 * WHY THIS EXISTS. Bing's `tf=3dv4` mesh does not exist at low zoom. Its `td1` tree has *tiles* from
 * level 0, but tile CONTENT only starts at face-local level 12 (global mercator z13) — verified with
 * `scripts/debug-bing-coverage.mjs` over London: levels 0–11 return 0-byte bodies, level 12 returns a
 * 155 KB GLB. So a plain `/bing/tileset.json` renders as **empty space** until you zoom to city scale:
 * there is nothing to draw, no horizon, no landmass, no sense of where you are ("Bing low zoom level
 * add globe view?").
 *
 * WHAT IT DOES. For any Bing tile that has no mesh of its own and sits at or above `globeMaxLevel`,
 * we synthesize a textured **ellipsoid patch** covering exactly that tile's web-mercator region, draped
 * with a raster basemap tile. Because Bing's face-local (level, x, y) IS the global mercator tile at
 * (level+1), the raster tile is a direct 1:1 lookup — no resampling, no reprojection. The result is a
 * normal 3D Tiles GLB, so the globe appears in **every** client (Cesium for Unreal/Unity, QGIS,
 * CesiumJS), not just in a viewer that happens to draw its own basemap. As you zoom in, REPLACE
 * refinement swaps the shell for real Bing mesh where it exists, and keeps the shell where it doesn't
 * (oceans, uncovered regions) — so there is never a hole.
 *
 * BASEMAP SOURCE. Defaults to OpenStreetMap, which needs no token. It is a URL template, overridable
 * per-request (`&basemap=`) or per-deployment (`BING_GLOBE_BASEMAP`), so nothing pins a raster provider
 * into the repo and you can point it at your own tile server. Attribution rides along in the tileset's
 * `asset.copyright` — OSM requires it, and 3D Tiles clients surface that string.
 *
 * COORDINATE CONVENTION — and why there is deliberately NO tile `transform` here. A 3D Tiles tile
 * transform is INHERITED by every descendant. The globe shell hangs on tiles that also parent real
 * Bing tiles, and Bing's GLBs already bake their own ECEF placement into the glTF node matrix — so
 * putting an ENU transform on a shell tile would silently displace the entire Bing subtree under it.
 * Instead the shell stores ABSOLUTE ECEF positions, swizzled to the Y-up glTF frame as (X, Z, −Y) so
 * that Cesium's glTF→Z-up RX(+90°) maps them back to (X, Y, Z). (Same algebra as the point path's
 * (East, Up, −North); that one is just the local-ENU case of it.)
 *
 * The float32 cost of absolute ECEF is ~0.5 m of quantization at earth radius. That is irrelevant
 * here and only here: the shell exists for levels 0–11, where one tile spans ~20 km at the finest and
 * a whole quadrant at the coarsest, and its vertex normals are supplied analytically rather than
 * derived from the quantized positions. Real content (Bing mesh, and every other adapter in this
 * repo) keeps using local frames plus a transform.
 */
import { llhToEcef, enuFrame, DEG } from '../core/index.js';
import { buildGlb } from '../i3s-to-3dtiles/src/glbBuild.js';

// Bing mesh starts at face-local level 12 (see scripts/debug-bing-coverage.mjs). Default the shell to
// span everything shallower, so the handoff is seamless rather than leaving a gap of empty levels.
export const DEFAULT_GLOBE_MAX_LEVEL = 11;
const DEFAULT_BASEMAP = process.env.BING_GLOBE_BASEMAP || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const BASEMAP_ATTRIBUTION = process.env.BING_GLOBE_ATTRIBUTION || '© OpenStreetMap contributors';

const SEG = 16;                       // grid quads per side; 16 keeps a whole quadrant visibly curved
const MAX_RASTER_CACHE = 4096;
const rasterCache = new Map();
const glbCache = new Map();

const merc = (lat) => Math.asinh(Math.tan(lat));          // lat radians → mercator y (radians)
const invMerc = (m) => Math.atan(Math.sinh(m));

/**
 * The global slippy-map tile whose extent equals this Bing tile's region.
 * Bing's 4 root faces are the level-1 mercator quadrants, so face-local level L ⇒ global zoom L+1.
 * Derived from the region itself (not from face indices) so it cannot drift out of sync with
 * bing-live's `tileRegion`.
 */
export function rasterTileFor(region, level) {
  const [W, , , N] = region;
  const z = level + 1;
  const n = 2 ** z;
  const x = Math.round(((W + Math.PI) / (2 * Math.PI)) * n);
  const y = Math.round(((1 - merc(N) / Math.PI) / 2) * n);   // slippy y is top-down from the north edge
  return { z, x: Math.min(Math.max(x, 0), n - 1), y: Math.min(Math.max(y, 0), n - 1) };
}

async function fetchRaster(tmpl, { z, x, y }) {
  const url = tmpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  if (rasterCache.has(url)) return rasterCache.get(url);
  let out = null;
  try {
    // OSM's tile usage policy requires an identifying User-Agent; anonymous bulk clients get blocked.
    const r = await fetch(url, { headers: { 'User-Agent': '3dtiled-to-3dtiles/0.1 (+https://github.com/jo-chemla/3dtiled-to-3dtiles)' } });
    if (r.ok) {
      const bytes = Buffer.from(await r.arrayBuffer());
      const mimeType = /^\x89PNG/.test(bytes.toString('latin1', 0, 4)) ? 'image/png' : 'image/jpeg';
      if (bytes.length > 0) out = { bytes, mimeType };
    }
  } catch { /* fall through — an untextured shell still beats empty space */ }
  if (rasterCache.size >= MAX_RASTER_CACHE) rasterCache.clear();
  rasterCache.set(url, out);
  return out;
}

/**
 * Build the textured ellipsoid patch GLB for one Bing tile region.
 * @param {number[]} region [W,S,E,N,minH,maxH] in radians (as bing-live's tileRegion emits)
 * @param {number} level face-local level
 * @param {string} [basemap] URL template with {z}/{x}/{y}
 */
export async function globeTileGlb(region, level, basemap = DEFAULT_BASEMAP) {
  const rt = rasterTileFor(region, level);
  const key = `${basemap}|${rt.z}/${rt.x}/${rt.y}`;
  if (glbCache.has(key)) return glbCache.get(key);

  const [W, S, E, N] = region;
  const mS = merc(S), mN = merc(N);

  // Grid corner (i, j) → absolute ECEF swizzled to Y-up, outward normal, and UV.
  const corner = (i, j) => {
    const u = i / SEG, t = j / SEG;
    const lon = (W + (E - W) * u) / DEG;
    const mY = mS + (mN - mS) * t;
    const lat = invMerc(mY) / DEG;
    const p = llhToEcef(lon, lat, 0);
    const vu = enuFrame(lon, lat).UP;         // analytic ellipsoid normal at this vertex
    return {
      pos: [p[0], p[2], -p[1]],               // (X, Z, −Y) — see the header's convention note
      nrm: [vu[0], vu[2], -vu[1]],
      uv: [u, (mN - mY) / (mN - mS)],         // v=0 at the north edge, matching top-down raster rows
    };
  };

  // buildGlb writes a non-indexed triangle soup, so emit 3 vertices per triangle.
  const tris = SEG * SEG * 2;
  const positions = new Float32Array(tris * 3 * 3);
  const normals = new Float32Array(tris * 3 * 3);
  const uvs = new Float32Array(tris * 3 * 2);
  let vi = 0;
  const push = (c) => {
    positions[vi * 3] = c.pos[0]; positions[vi * 3 + 1] = c.pos[1]; positions[vi * 3 + 2] = c.pos[2];
    normals[vi * 3] = c.nrm[0]; normals[vi * 3 + 1] = c.nrm[1]; normals[vi * 3 + 2] = c.nrm[2];
    uvs[vi * 2] = c.uv[0]; uvs[vi * 2 + 1] = c.uv[1];
    vi++;
  };
  for (let j = 0; j < SEG; j++) {
    for (let i = 0; i < SEG; i++) {
      const a = corner(i, j), b = corner(i + 1, j), c = corner(i + 1, j + 1), d = corner(i, j + 1);
      // CCW seen from outside (+Up), so backface culling keeps the patch visible from space
      push(a); push(b); push(c);
      push(a); push(c); push(d);
    }
  }

  const texture = await fetchRaster(basemap, rt);
  // No raster? Emit an untextured matte patch rather than failing: a plain shell still gives the
  // horizon and silhouette that the whole feature exists to provide.
  const glb = Buffer.from(buildGlb({ mode: 'TRIANGLES', positions, normals, uvs, ...(texture ? { texture } : {}) }));
  if (glbCache.size >= 512) glbCache.clear();
  glbCache.set(key, glb);
  return glb;
}
