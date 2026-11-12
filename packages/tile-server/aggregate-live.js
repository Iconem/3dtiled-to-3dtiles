/**
 * aggregate-live.js — MosaicJSON/STAC-style **meta-tileset** endpoint: point it at N tileset URLs and
 * it serves ONE 3D Tiles tileset whose children external-reference each of them, with per-child
 * bounding volumes derived from each child's own root (fetched once, cached). 3D Tiles supports this
 * natively (a tile's `content.uri` may be another tileset.json), so "all our datasets in a single
 * endpoint" is just: fetch each child root, compute an enclosing bounding sphere IN THE PARENT (ECEF /
 * identity) frame from the child's root boundingVolume × root transform, and emit an ADD-refine root.
 *
 * Children can be ANY 3D-Tiles-serving URL — including this server's own /stream, /convert, /bing or
 * /3dtiles-self-contained endpoints, so one meta-tileset can mix COPC + Potree + LCC + RAD + …, and a
 * LOCAL child can be globe-placed first via /stream's &lon=&lat= placement params (see stream-live).
 *
 *   GET /aggregate/tileset.json?urls=<u1>,<u2>,…     (each URL-encoded; commas separate)
 *   GET /aggregate/tileset.json?url=<u1>&url=<u2>…   (repeated form, equivalent)
 *   …&nest=auto|mercator|geodetic|flat   &bv=sphere|region   &ttl=<seconds>
 *   …&cut=auto|<depth>|0  &cell=<key>       external tilesets every <depth> group levels (see the depth cut below)
 *   …&format=  &only=  &exclude=  &hide=<id>  &latest=1  &from=YYYY[-MM]  &to=YYYY[-MM]
 *
 *   GET /aggregate/tileset.json?vpc=<url of a .vpc>  a PDAL/QGIS virtual point cloud as the set: its COPC
 *                                                    items, placed from their own extents (vpc-live.js)
 *
 * Child fetch failures don't kill the aggregate: failed children are skipped and listed in
 * `asset.extras.failed` (with the error), so a mosaic of 40 datasets survives one dead host.
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { datasetGroundSamples, offsetFromSamples } from '../core/dataset-ground.js';
import { sampleTerrain, TERRAINS } from '../core/terrain.js';
import { llhToEcef, ecefToLlh, curvedParam, httpStatusOf } from '../core/index.js';
import { vpcSet, sniffParam } from './vpc-live.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };

/**
 * Time-bounded memo. Deliberately NOT core's `memoizeAsync`, whose cache is permanent: that is right
 * for an adapter's per-source ctx (the source file is immutable for the life of the process) and
 * wrong here, because every child of an aggregate is a REMOTE tileset that can be re-tiled or
 * re-published underneath us. A day-scale TTL is the useful middle: assembling 500 children costs 500
 * round-trips, so it must not happen per request, but a mosaic that can never notice a child moved is
 * a stale-data bug waiting to happen. Failures get a much shorter TTL so one dead host doesn't pin a
 * degraded mosaic for a whole day.
 */
const DEFAULT_TTL_MS = 24 * 3600 * 1000;
const FAILURE_TTL_MS = 60 * 1000;

// Where persisted caches live: next to the local manifests, git-ignored (the keys are share-link
// URLs, i.e. credentials). Override with AGGREGATE_CACHE_DIR.
const CACHE_DIR = process.env.AGGREGATE_CACHE_DIR || fileURLToPath(new URL('../../.local/aggregate-cache/', import.meta.url));

/**
 * In-memory TTL cache, optionally mirrored to disk (`persist`: a file name under CACHE_DIR).
 *
 * A persisted cache survives restarts and deploys: the child roots of a 700-dataset mosaic no longer
 * have to be re-fetched from the share-link API before the first client sees a tree (60+ s cold on
 * prod, and the "server stalls on the open mosaic" family of reports). An entry older than its TTL is
 * still served when it comes from disk — stale-while-revalidate: the builder runs in the background
 * and replaces it, so the mosaic is instant and a day old at worst, never blocked. Failures are never
 * persisted. Writes are debounced; a corrupt or missing file is an empty cache.
 */
function ttlCache(builder, { persist = null, normalize = null } = {}) {
  const cache = new Map();                       // key → { at, ttl, value | error, fromDisk? }
  const file = persist ? path.join(CACHE_DIR, persist) : null;
  let loaded = !persist, saveTimer = null;
  const load = async () => {
    if (loaded) return; loaded = true;
    try {
      const entries = JSON.parse(await readFile(file, 'utf8'));
      for (const [k, e] of Object.entries(entries)) { const key = normalize ? normalize(k) : k; if (e && e.value !== undefined && !cache.has(key)) cache.set(key, { at: e.at, ttl: e.ttl, value: e.value, fromDisk: true }); }
      console.log(`[aggregate] ${persist}: ${Object.keys(entries).length} entries from disk`);
    } catch { /* no cache yet */ }
  };
  const save = () => {
    if (!file || saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      const entries = {};
      for (const [key, e] of cache) if (e.value !== undefined && !e.error) entries[key] = { at: e.at, ttl: e.ttl, value: e.value };
      try { await mkdir(CACHE_DIR, { recursive: true }); await writeFile(file, JSON.stringify(entries)); }
      catch (err) { console.warn(`[aggregate] could not write ${file}: ${err.message}`); }
    }, 2000);
  };
  const refreshing = new Set();
  const inflight = new Map();                    // key → the build under way: a second caller joins it
  const build = (key, ttlMs) => {
    if (!(ttlMs > 0)) return run(key, ttlMs);
    let p = inflight.get(key);
    if (!p) { p = run(key, ttlMs).finally(() => inflight.delete(key)); inflight.set(key, p); }
    return p;
  };
  const run = async (key, ttlMs) => {
    try {
      const value = await builder(key);
      if (ttlMs > 0) { cache.set(key, { at: Date.now(), ttl: ttlMs, value }); save(); }
      return value;
    } catch (error) {
      if (ttlMs > 0) cache.set(key, { at: Date.now(), ttl: Math.min(ttlMs, FAILURE_TTL_MS), error });
      throw error;
    }
  };
  const get = async (key, ttlMs = DEFAULT_TTL_MS) => {
    await load();
    // ttl=0 must bypass the cache in BOTH directions. Skipping only the write would still serve a
    // previously-cached mosaic, which defeats the one thing `&ttl=0` exists for: forcing a re-read
    // while a dataset is being re-tiled underneath you.
    const hit = ttlMs > 0 ? cache.get(key) : undefined;
    if (hit && Date.now() - hit.at < hit.ttl) {
      if (hit.error) throw hit.error;
      return hit.value;
    }
    if (hit && hit.fromDisk && !hit.error) {
      // stale from disk: serve it, refresh behind
      if (!refreshing.has(key)) { refreshing.add(key); build(key, ttlMs).catch(() => {}).finally(() => refreshing.delete(key)); }
      return hit.value;
    }
    return build(key, ttlMs);
  };
  get.isWarm = (key, ttlMs = DEFAULT_TTL_MS) => {
    const hit = ttlMs > 0 ? cache.get(key) : undefined;
    return !!hit && (Date.now() - hit.at < hit.ttl || (hit.fromDisk && !hit.error));
  };
  get.load = load;
  return get;
}

// ── enclosing sphere [cx,cy,cz,r] of a child root boundingVolume, in the child tileset frame ──
function sphereOfVolume(bv) {
  if (bv.sphere) return bv.sphere.slice(0, 4);
  if (bv.box) {
    const b = bv.box, c = [b[0], b[1], b[2]];
    const ax = b.slice(3, 6), ay = b.slice(6, 9), az = b.slice(9, 12);
    let r = 0;                                    // max corner distance over the 4 sign-distinct corners
    for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]])
      r = Math.max(r, Math.hypot(sx*ax[0]+sy*ay[0]+az[0], sx*ax[1]+sy*ay[1]+az[1], sx*ax[2]+sy*ay[2]+az[2]));
    return [c[0], c[1], c[2], r];
  }
  if (bv.region) {                                // [W,S,E,N,minH,maxH] radians — sample a lon/lat/h grid
    const [w, s, e, n, h0, h1] = bv.region;
    const pts = [];
    for (let i = 0; i <= 2; i++) for (let j = 0; j <= 2; j++) for (const h of [h0, h1])
      pts.push(llhToEcef((w + (e - w) * i / 2) * 180 / Math.PI, (s + (n - s) * j / 2) * 180 / Math.PI, h));
    const c = [0, 1, 2].map(k => pts.reduce((a, p) => a + p[k], 0) / pts.length);
    const r = Math.max(...pts.map(p => Math.hypot(p[0]-c[0], p[1]-c[1], p[2]-c[2])));
    return [c[0], c[1], c[2], r * 1.05];          // 5% slack for surface bulge between samples
  }
  throw new Error('unsupported boundingVolume (need box, sphere, or region)');
}

// Transform a child-frame sphere by the child's root transform (column-major 4×4) → parent frame.
// Region volumes are ALREADY in ECEF per spec — the root transform does not apply to them.
function sphereToParent(sphere, transform, isRegion) {
  if (!transform || isRegion) return sphere;
  const t = transform, [x, y, z, r] = sphere;
  const cx = t[0]*x + t[4]*y + t[8]*z + t[12];
  const cy = t[1]*x + t[5]*y + t[9]*z + t[13];
  const cz = t[2]*x + t[6]*y + t[10]*z + t[14];
  const scale = Math.max(Math.hypot(t[0],t[1],t[2]), Math.hypot(t[4],t[5],t[6]), Math.hypot(t[8],t[9],t[10]));
  return [cx, cy, cz, r * scale];
}

/**
 * The child-root cache key, and the URL the probe fetches: the child URL without `cache=` or
 * `prefetch=`. The root a
 * mosaic places is the same whether the client later streams the hierarchy lazily or eagerly, and
 * probing with cache=hierarchy would make /stream drain a child's WHOLE hierarchy before answering
 * (measured cold on Iconem share links: 183 s for one cloud, over 300 s for the next) just to read
 * one bounding volume. Without `cache=`, /stream is lazy.
 */
function infoKey(url) {
  if (!/\/stream\/tileset\.json\?/.test(url)) return url;
  return url.replace(/&(cache|prefetch)=[^&]*/g, '').replace(/\?(cache|prefetch)=[^&]*&?/, '?');
}

// One child's meta entry: fetch its tileset.json (cached per URL, persisted to disk), derive sphere + GE.
const childInfo = ttlCache(async (url) => {
  // Only the root is read here, so ask our own /stream for just that (`depth=0`): a curved COPC
  // child otherwise builds and serialises its whole 15–25 k-tile tree, ~1 s of CPU each (8 s on
  // prod), 113 times for the flai set, on the event loop — the "server stalls on the open mosaic".
  const infoUrl = /\/stream\/tileset\.json\?/.test(url) && !/[?&]depth=/.test(url) ? `${url}&depth=0` : url;
  const r = await fetch(infoUrl);
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
  const ts = await r.json();
  const root = ts.root || {};
  const sphere = sphereToParent(sphereOfVolume(root.boundingVolume || {}), root.transform, !!root.boundingVolume?.region);
  // The reference tile's GE gates when the renderer LOADS the child tileset, so it has to mean "the
  // error of not showing this dataset at all" — which is its SIZE. Trusting the child's own tileset GE
  // alone breaks on real data: Iconem's Angkor site tilesets declare GE √3 ≈ 1.73 at both tileset and
  // root level for ~240 m sites, so the reference tile (and every group above it, which doubles from
  // there) only refined within ~100 m of the camera — the Angkor mosaic loaded nothing from any
  // sensible viewpoint. max() keeps well-formed tilesets as they were (GE ≥ radius already) and lifts
  // degenerate ones to their bounding radius; ≥ the child root's GE keeps refinement monotonic.
  const declared = [ts.geometricError, root.geometricError].filter(Number.isFinite);
  const geometricError = Math.max(sphere[3] || 0, ...declared, declared.length ? 0 : 1e6);
  return { sphere, geometricError, native: nativeSource(url, root) };
}, { persist: 'child-roots.json', normalize: infoKey });

// ── &native=1: leaves a renderer may load in their SOURCE format ─────────────────────────────────
//
// Every leaf stays a /stream 3D Tiles child — `content.uri` is untouched, so CesiumJS and every spec
// client render exactly what they did. With &native=1 a leaf whose /stream root reports its native
// frame (root.extras.native, see potree-live's nativeInfo) also carries the source itself:
//
//   content.extensions.ICONEM_content_source = { format, version, encoding, uri, transform }
//
// `transform` (column-major 4×4) maps the source's OWN coordinates — what 3DTRjs's PotreePlugin
// draws — to the leaf's frame: the child root transform (CRS georef, &crs=, &lon=&lat= placement)
// composed with translate(−origin). Listed in `extensionsUsed`, never `extensionsRequired`: a client
// that does not know it falls back to content.uri. Prior art: MAXAR_content_geojson.
const NATIVE_EXT = 'ICONEM_content_source';
function nativeSource(url, root) {
  const n = root.extras?.native;
  if (!n || !Array.isArray(n.origin)) return null;
  let src;
  try { src = new URL(url).searchParams.get('url'); } catch { return null; }
  if (!src) return null;
  const T = Array.isArray(root.transform) && root.transform.length === 16 ? root.transform : [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  const [ox, oy, oz] = n.origin;
  const M = T.slice();
  for (let r = 0; r < 3; r++) M[12 + r] = T[12 + r] - (T[r] * ox + T[4 + r] * oy + T[8 + r] * oz);
  return { format: n.format, version: n.version, encoding: n.encoding, uri: src, transform: M };
}

// ── spatial auto-nesting ─────────────────────────────────────────────────────────────────────────
//
// A FLAT root is fine for a dozen datasets and wrong for 500: every child sits directly under the
// root, so as soon as the root refines, all 500 child `tileset.json`s are candidates. Nesting gives
// the renderer something to cull. The tree is built from nothing but each child's root bounding
// volume — centre and radius — which is all we can know without opening the datasets.
//
// Each dataset is placed at the DEEPEST level whose cell still comfortably contains it, so a 200 m
// scan lands deep (its own city cell) while a country-wide dataset stays shallow — a dataset is never
// forced into a cell smaller than itself. The trie is then path-compressed, so you get continent →
// country → city only where datasets actually diverge, not 20 levels of single-child nodes.
//
// Culling does the work at render time, but the GEOMETRIC ERROR is what stops the fetch: an internal
// node's GE is 2× its children's, so from a world view the SSE of a site-sized node is a fraction of
// a pixel and the renderer never traverses into it. Zoom to Paris and only the nodes whose bounding
// spheres intersect the frustum refine — so only Paris's tilesets are fetched.
//
// ── TWO SCHEMES, because "Morton order" and "web-mercator quadtree" are NOT the same thing ────────
//
// Morton (Z-order) is an ADDRESSING scheme — interleave the bits of a cell's x/y — and it says
// nothing about which projection those cells live in. Two different trees both use it:
//
//   mercator  Bing/OSM/slippy-map tiling. Level L is a 2^L × 2^L grid over the WEB-MERCATOR square,
//             latitude clamped at ±85.05°. A Bing quadkey is exactly the base-4 Morton code of the
//             cell. Cells are square on screen; their ground size shrinks with cos(lat).
//
//   geodetic  What 3D Tiles implicit tiling actually does, and therefore what Cesium walks. The
//             spec subdivides the ROOT BOUNDING VOLUME in its own coordinate space — for a `region`,
//             "`x`, `y`, `z` refer to `longitude`, `latitude`, `height`" and each child extent is a
//             plain arithmetic bisection of that range. So it is a GEODETIC quadtree (Cesium's
//             GeographicTilingScheme: 2×1 cells at level 0, lon/lat halved per level), with tiles
//             *within a level* ordered along the Morton Z-curve. No mercator anywhere.
//
// Both are offered because they answer different questions: `mercator` lines a mosaic's grouping up
// with the raster basemap and with /bing's own quadkeys, while `geodetic` lines it up with how a
// 3D Tiles client subdivides a region — so a group's cell is the cell an implicit tileset would have
// used. The grouping is a pure BVH either way, so neither is "wrong"; they just cut different seams.
const EARTH_CIRCUMFERENCE = 40075017;
const METERS_PER_DEG_LAT = 111320;
const MAX_NEST_LEVEL = 16;          // ~600 m cells at the equator; deeper separates nothing useful
const NEST_THRESHOLD = 8;           // below this, a flat root is simpler and just as cullable
const CELL_SLACK = 4;               // a cell must be ≥4× the dataset radius before we descend into it

/** Interleave x/y bits → Morton (Z-order) index, the ordering 3D Tiles uses within a level. */
function mortonIndex(x, y, level) {
  let m = 0;
  for (let i = 0; i < level; i++) m |= ((x >> i) & 1) << (2 * i) | ((y >> i) & 1) << (2 * i + 1);
  return m;
}

/** Path digits (base-4, coarsest first) from a level's x/y — identical maths to a Bing quadkey. */
function digitsFromXY(x, y, level, rootDigits = '') {
  let s = rootDigits;
  for (let i = level; i > 0; i--) {
    const mask = 1 << (i - 1);
    s += ((x & mask) ? 1 : 0) + ((y & mask) ? 2 : 0);
  }
  return s;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const SCHEMES = {
  // Web-mercator / Bing-quadkey grid: 2^L × 2^L over the mercator square.
  mercator: {
    cellMeters: (level, latDeg) => (EARTH_CIRCUMFERENCE * Math.max(0.05, Math.cos(latDeg * Math.PI / 180))) / 2 ** level,
    cellAt(lonDeg, latDeg, level) {
      const n = 2 ** level;
      const x = clamp(Math.floor(((lonDeg + 180) / 360) * n), 0, n - 1);
      const latRad = clamp(latDeg * Math.PI / 180, -1.4844, 1.4844);   // ±85.05°, the mercator cutoff
      const y = clamp(Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n), 0, n - 1);
      return { x, y, key: digitsFromXY(x, y, level), morton: mortonIndex(x, y, level) };
    },
  },
  // Geodetic quadtree: 2×1 root cells, lon/lat bisected per level — Cesium's GeographicTilingScheme
  // and the subdivision a 3D Tiles implicit `region` tileset performs.
  geodetic: {
    // Cells are 360/2^(L+1)° wide and 180/2^L° tall; the binding constraint is whichever is smaller
    // on the ground, which flips from lat-bound to lon-bound as you approach the poles.
    cellMeters: (level, latDeg) => Math.min(
      (360 / 2 ** (level + 1)) * METERS_PER_DEG_LAT * Math.max(0.05, Math.cos(latDeg * Math.PI / 180)),
      (180 / 2 ** level) * METERS_PER_DEG_LAT,
    ),
    cellAt(lonDeg, latDeg, level) {
      const nx = 2 ** (level + 1), ny = 2 ** level;                   // 2:1 at level 0
      const x = clamp(Math.floor(((lonDeg + 180) / 360) * nx), 0, nx - 1);
      const y = clamp(Math.floor(((latDeg + 90) / 180) * ny), 0, ny - 1);
      // The extra lon bit selects the root cell (W/E hemisphere); the remaining `level` lon bits and the
      // `level` lat bits bisect in lockstep. (Passing `x >> 1` here, as this once did, re-encoded the
      // hemisphere bit and dropped the finest lon bit: cells were twice as wide as their key said.)
      const key = digitsFromXY(x & ((1 << level) - 1), y, level, String(x >> level));
      return { x, y, key, morton: mortonIndex(x, y, level + 1) };
    },
  },
};

/**
 * Lon/lat bounds (degrees) of the cell a path key names — the inverse of `cellAt`. Path digits are
 * base 4, coarsest first: bit 0 = the x half, bit 1 = the y half (see digitsFromXY).
 */
function cellBounds(schemeName, key) {
  if (schemeName === 'geodetic') {
    if (!key) return { west: -180, south: -90, east: 180, north: 90 };
    let west = -180 + 180 * Number(key[0]), south = -90, w = 180, h = 180;
    for (const ch of key.slice(1)) {
      const d = Number(ch);
      w /= 2; h /= 2;
      if (d & 1) west += w;
      if (d & 2) south += h;                   // geodetic y grows northwards
    }
    return { west, south, east: west + w, north: south + h };
  }
  let x = 0, y = 0;
  for (const ch of key) { const d = Number(ch); x = x * 2 + (d & 1); y = y * 2 + ((d >> 1) & 1); }
  const n = 2 ** key.length;
  const lat = (row) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return { west: (x / n) * 360 - 180, east: ((x + 1) / n) * 360 - 180, north: lat(y), south: lat(y + 1) };   // mercator y grows southwards
}

/** Deepest level whose cell still comfortably contains a sphere of this radius. */
function levelForRadius(scheme, radiusM, latDeg) {
  if (!(radiusM > 0)) return MAX_NEST_LEVEL;
  for (let L = MAX_NEST_LEVEL; L >= 0; L--) {
    if (scheme.cellMeters(L, latDeg) >= radiusM * CELL_SLACK) return L;
  }
  return 0;
}

/** Normalize the `nest` param into { enabled-decision, scheme name }. */
function parseNest(nest) {
  const v = String(nest ?? 'auto').toLowerCase();
  if (v === '0' || v === 'false' || v === 'flat' || v === 'none') return { mode: 'off' };
  if (v === 'auto' || v === '' ) return { mode: 'auto', scheme: 'mercator' };
  if (v === '1' || v === 'true' || v === 'mercator' || v === 'webmerc' || v === 'quadtree') return { mode: 'on', scheme: 'mercator' };
  if (v === 'geodetic' || v === 'morton' || v === 'implicit' || v === 'cesium') return { mode: 'on', scheme: 'geodetic' };
  return { mode: 'auto', scheme: 'mercator' };                        // unknown value → the default
}

/** Minimal sphere enclosing two spheres (same maths the flat root already used). */
function unionSphere(a, b) {
  if (!a) return b;
  if (!b) return a;
  const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  if (d + b[3] <= a[3]) return a;
  if (d + a[3] <= b[3]) return b;
  const R = (d + a[3] + b[3]) / 2, k = (R - a[3]) / d;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, R];
}

/**
 * A `region` [west, south, east, north, minH, maxH] (radians, metres) enclosing an ECEF sphere.
 *
 * The angular half-extent is asin(r/|c|) — the cone a ball subtends from the Earth's centre — plus 1%
 * for the gap between geocentric and geodetic latitude (≤0.19°, at most a ~1% change of scale).
 * Longitude widens by 1/cos of the most poleward latitude the ball reaches; a ball that reaches a pole
 * or crosses the antimeridian gets the full longitude range, which is loose but never wrong.
 */
function sphereToRegion([x, y, z, r]) {
  const d = Math.hypot(x, y, z);
  const [lonDeg, latDeg, h] = ecefToLlh(x, y, z);
  const lon = lonDeg * Math.PI / 180, lat = latDeg * Math.PI / 180;
  const a = r >= d ? Math.PI : Math.asin(r / d) * 1.01;
  const south = Math.max(-Math.PI / 2, lat - a), north = Math.min(Math.PI / 2, lat + a);
  const polar = Math.max(Math.abs(south), Math.abs(north));
  const dLon = polar >= Math.PI / 2 - 1e-6 ? Math.PI * 2 : a / Math.cos(polar);
  let west = lon - dLon, east = lon + dLon;
  if (west < -Math.PI || east > Math.PI) { west = -Math.PI; east = Math.PI; }
  return [west, south, east, north, h - r, h + r];
}

/**
 * An oriented `box` around a set of spheres, aligned with the local east/north/up frame at their
 * union's centre: the tightest simple box for datasets spread over the ground (flat and wide), where
 * a sphere is mostly empty sky and rock. Null when there is no meaningful "up" (a centre near the
 * Earth's core, i.e. a continent-spanning group), in which case the caller keeps a sphere.
 */
function boxAround(spheres, centreSphere) {
  const [cx, cy, cz] = centreSphere;
  if (Math.hypot(cx, cy, cz) < 1e6) return null;
  const [lon, lat] = ecefToLlh(cx, cy, cz);
  const lo = lon * Math.PI / 180, la = lat * Math.PI / 180;
  const E = [-Math.sin(lo), Math.cos(lo), 0];
  const N = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
  const U = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const [x, y, z, r] of spheres) {
    const d = [x - cx, y - cy, z - cz];
    [E, N, U].forEach((ax, i) => {
      const t = d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2];
      min[i] = Math.min(min[i], t - r);
      max[i] = Math.max(max[i], t + r);
    });
  }
  const mid = [0, 1, 2].map((i) => (min[i] + max[i]) / 2);
  const half = [0, 1, 2].map((i) => Math.max((max[i] - min[i]) / 2, 1e-3));
  const c = [0, 1, 2].map((k) => [cx, cy, cz][k] + mid[0] * E[k] + mid[1] * N[k] + mid[2] * U[k]);
  return [...c, ...E.map((v) => v * half[0]), ...N.map((v) => v * half[1]), ...U.map((v) => v * half[2])];
}

/**
 * The volumes `&bv=` can emit for groups; `cell` is the default — the group IS its quadtree cell.
 * Leaves always keep their own root's sphere, and each dataset keeps its own volumes below that.
 */
const BV_MODES = ['cell', 'sphere', 'region', 'box'];
const DEFAULT_BV = 'cell';

/**
 * &snap=<terrain> — put each dataset on the ground, separately. The offset comes from the dataset's
 * own top geometry (core/dataset-ground.js: 8×8 bins, 10th-percentile heights) against open terrain
 * (core/terrain.js), and is applied as the leaf tile's `transform`: a translation along the local up,
 * which chains into the external tileset below it. The leaf's bounding sphere stays as it is — it is
 * expressed in the leaf's own (translated) frame. Cached per dataset like the child roots.
 */
const snapSamples = ttlCache((url) => datasetGroundSamples(url));   // per dataset, whatever the terrain
const snapOffset = ttlCache(async (key) => {
  const { url, terrain, ttlMs } = JSON.parse(key);
  const samples = await snapSamples(url, ttlMs);
  if (!samples) return null;
  const heights = await Promise.all(samples.map((s) => sampleTerrain(terrain, s.lon, s.lat)));
  return offsetFromSamples(samples, heights);
}, { persist: 'snap-offsets.json' });

/**
 * GET /aggregate/snap.ndjson?<same query as the snapped mosaic> — the offsets of &snap=, one line per
 * dataset as each resolves, after a first line { total }. The offsets land in the cache the mosaic reads,
 * so a viewer can show the unsnapped mosaic at once and ask for the snapped one when this ends.
 */
async function streamSnapOffsets(res, tree, items, terrain, ttlMs) {
  const byUrl = new Map(items.map((it) => [it.url, it]));
  const leaves = [];
  (function walk(t) { if (t.content?.uri) leaves.push(t); for (const c of t.children || []) walk(c); })(tree.root);
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', ...CORS });
  res.write(`${JSON.stringify({ total: leaves.length })}\n`);
  await pooledSettled(leaves, async (t) => {
    if (res.destroyed) return;
    const r = await snapOffset(JSON.stringify({ url: t.content.uri, terrain, ttlMs }), ttlMs).catch(() => null);
    const [x, y, z] = t.boundingVolume.sphere;
    const dz = r ? +r.dz.toFixed(2) : null;
    res.write(`${JSON.stringify({
      id: byUrl.get(t.content.uri)?.id ?? idOf(t.content.uri),
      height: +(ecefToLlh(x, y, z)[2] + (dz ?? 0)).toFixed(1),
      snap: r ? { terrain, dz, bins: r.used, spread: +r.spread.toFixed(1) } : { terrain, dz: null },
    })}\n`);
  });
  res.end();
}

function unionRegion(a, b) {
  if (!a) return b;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3]),
    Math.min(a[4], b[4]), Math.max(a[5], b[5])];
}

/**
 * Build the nested tile tree from leaf entries [{ key, tile }]. Returns a 3D Tiles tile.
 *
 * Each emitted group carries `extras.cell` — its path digits, level and Morton index — so the
 * grouping a mosaic chose is inspectable from the tileset alone (and by /stats, which walks it like
 * any other tileset). Nothing renders off it; it is there so "why did this dataset end up here" has
 * an answer that doesn't require re-running the server.
 */
function nestLeaves(leaves, schemeName, bv = 'sphere') {
  // Groups may be emitted as regions, but unions are always computed from the children's spheres:
  // a sphere enclosing a region's corners would be far looser than the union of the original balls.
  const sphereOf = new Map();
  const sph = (t) => sphereOf.get(t) ?? t.boundingVolume.sphere;
  const reg = (t) => t.boundingVolume.region ?? sphereToRegion(t.boundingVolume.sphere);
  // trie over path digits; a node holds the datasets whose own cell stops at that node's level
  const root = { kids: new Map(), here: [], path: '' };
  for (const lf of leaves) {
    let node = root;
    for (const digit of lf.key) {
      if (!node.kids.has(digit)) node.kids.set(digit, { kids: new Map(), here: [], path: node.path + digit });
      node = node.kids.get(digit);
    }
    node.here.push(lf.tile);
  }

  const build = (node) => {
    // path-compress: a node with no datasets of its own and exactly one child adds no information
    while (!node.here.length && node.kids.size === 1) node = [...node.kids.values()][0];

    const children = [...node.here];
    for (const kid of node.kids.values()) {
      const t = build(kid);
      if (t) children.push(t);
    }
    if (!children.length) return null;
    if (children.length === 1) return children[0];        // don't wrap a lone child in a group

    const sphere = children.reduce((acc, c) => unionSphere(acc, sph(c)), null);
    // Parent GE must exceed every child's (3D Tiles requires monotonic decrease on refine); 2× keeps
    // it monotonic while staying small enough that a distant group is never traversed.
    const geometricError = Math.max(...children.map(c => c.geometricError)) * 2;
    // The geodetic path's first digit is the 2×1 root-cell selector, so its level is one shorter.
    const level = schemeName === 'geodetic' ? Math.max(0, node.path.length - 1) : node.path.length;
    const union = () => children.reduce((acc, c) => unionRegion(acc, reg(c)), null);
    let volume;
    if (bv === 'region') volume = { region: union() };
    else if (bv === 'cell') {
      // The quadtree cell itself — what an implicit QUADTREE tileset would use — widened where a
      // dataset near the cell's edge pokes out (it is placed by its centre), and given the
      // children's height range. Exactly the cell whenever everything fits.
      const u = union();
      const c = cellBounds(schemeName, node.path);
      const D = Math.PI / 180;
      volume = { region: [Math.min(u[0], c.west * D), Math.min(u[1], c.south * D), Math.max(u[2], c.east * D), Math.max(u[3], c.north * D), u[4], u[5]] };
    } else if (bv === 'box') {
      const box = boxAround(children.map(sph), sphere);
      volume = box ? { box } : { sphere };
    } else volume = { sphere };
    const group = {
      boundingVolume: volume,
      geometricError,
      refine: 'ADD',
      extras: { cell: { scheme: schemeName, key: node.path || '(root)', level } },
      children,
    };
    sphereOf.set(group, sphere);
    return group;
  };
  const tree = build(root);
  return tree && { tree, sphere: sph(tree) };
}

// ── the depth cut: external tilesets per group ───────────────────────────────────────────────────
//
// The nested tree is a quadtree, but the ROOT carries all of it inline: 616 bytes per dataset, so a
// country of 1 km LiDAR tiles is a 6 MB root at 10 000 tiles, 62 MB at 100 000, 208 MB at 337 000
// (IGN's LiDAR HD, measured). A 3D Tiles client cannot show the first tile before it has parsed the
// whole thing. So past `cut` group levels a group is emitted as a tile whose CONTENT is another
// tileset.json, this same endpoint with `&cell=<its key>`, and no children: the one form the spec
// allows for an external tileset. That request answers with the group as a root, cut again the same
// way, so every tileset.json on the way down holds a few hundred tiles at most whatever the size of
// the set, and a client fetches only the branches it looks at.
//
// The cut is a VIEW of the one cached tree: the subtree is the same node, so geometric errors and
// bounding volumes are the ones the inline tree had, and index.json still walks every leaf. The
// default (`cut=auto`) leaves a set under 1 024 datasets as it was, byte for byte.
const CUT_AUTO_MIN = 1024;          // datasets: below this the whole tree stays inline
const CUT_AUTO_DEPTH = 4;           // then every 4 group levels are their own tileset.json
const CUT_MIN_DATASETS = 8;         // a group with fewer datasets below is inlined whole: not worth a round-trip

/** `cut=` of a request → the depth to cut at, 0 for none. */
export function parseCut(v, datasets) {
  const s = String(v ?? 'auto').toLowerCase();
  if (['0', 'off', 'false', 'none', 'no', 'flat'].includes(s)) return 0;
  const n = Math.trunc(Number(s));
  if (Number.isInteger(n) && n >= 1) return n;
  return datasets >= CUT_AUTO_MIN ? CUT_AUTO_DEPTH : 0;                   // 'auto', '', unknown
}

/** Datasets (content tiles) at or below a tile. */
export const datasetsBelow = (t) => (t.children ? t.children.reduce((n, c) => n + datasetsBelow(c), 0) : t.content?.uri ? 1 : 0);

/**
 * The tree cut at `depth` group levels (the root is depth 0): a group at that depth or deeper, with
 * at least CUT_MIN_DATASETS datasets below it, becomes a childless tile whose content is `uriFor(its
 * cell key)`. Nodes above the cut are shallow copies; the tree given is not touched. Returns
 * `{ root, externals }`; with `depth` 0 the tree as it is.
 */
export function cutTree(root, depth, uriFor) {
  if (!(depth > 0) || !root.children) return { root, externals: 0 };
  let externals = 0;
  const walk = (t, d) => {
    if (!t.children) return t;
    const key = t.extras?.cell?.key;
    if (d >= depth && key && key !== '(root)') {
      const n = datasetsBelow(t);
      if (n >= CUT_MIN_DATASETS) {
        externals++;
        const { children, ...rest } = t;
        return { ...rest, extras: { ...t.extras, datasets: n }, content: { uri: uriFor(key) } };
      }
    }
    return { ...t, children: t.children.map((c) => walk(c, d + 1)) };
  };
  return { root: walk(root, 0), externals };
}

/** The group whose cell key is `key`, anywhere under `root`, or null. */
export function subtreeOf(root, key) {
  let found = null;
  (function walk(t) {
    if (found || !t.children) return;
    if (t.extras?.cell?.key === key) { found = t; return; }
    for (const c of t.children) walk(c);
  })(root);
  return found;
}

/**
 * A group of a built mosaic as a tileset of its own, cut again at `depth`: what `&cell=<key>` answers.
 * The root tile is the group itself (volume and geometric error unchanged, so the parent's external
 * tile and this root agree), and `asset.extras` says which cell this is and how many datasets it holds.
 */
export function subtreeTileset(ts, node, depth, uriFor, key) {
  const { root, externals } = cutTree(node, depth, uriFor);
  return {
    asset: { ...ts.asset, extras: { ...ts.asset.extras, datasets: datasetsBelow(node), cell: key, cut: { depth, externals } } },
    schema: ts.schema,
    ...(ts.extensionsUsed ? { extensionsUsed: ts.extensionsUsed } : {}),
    geometricError: node.geometricError * 2,
    root,
  };
}

/**
 * Bounded-concurrency `Promise.allSettled`.
 *
 * MEASURED, not defensive: firing all 500 children at once with a plain `Promise.allSettled` loses
 * more than half of them — a 500-dataset mosaic came back with 232 datasets and 268 bare
 * "fetch failed" entries, and still answered 200, because failed children degrade into
 * `asset.extras.failed` by design. The mosaic looked fine and was missing half the world. Worse, the
 * survivors varied run to run, so the tree shape was not reproducible.
 *
 * A small pool fixes it outright and costs nothing: the children are independent round-trips, so 16
 * in flight already saturates the link, and going wider only buys socket exhaustion — against our own
 * loopback here, and against whatever remote host is serving a real mosaic's children.
 */
/** max over an array, as a loop: `Math.max(...arr)` overflows the call stack past ~125 000 children (337 206 IGN tiles did). */
const maxOf = (arr, f) => { let m = -Infinity; for (const x of arr) { const v = f(x); if (v > m) m = v; } return m; };

const FETCH_CONCURRENCY = 16;

async function pooledSettled(items, worker, limit = FETCH_CONCURRENCY) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      try { out[i] = { status: 'fulfilled', value: await worker(items[i]) }; }
      catch (reason) { out[i] = { status: 'rejected', reason }; }
    }
  }));
  return out;
}

/**
 * 3D Tiles 1.1 tile metadata for the dataset entries, so a mosaic is self-describing: any 1.1 client
 * can read which dataset a tile is (Cesium: `tile.metadata.getProperty('name')`) without the
 * side-channel index.json. Every property is optional; entries carry only the ones they know.
 */
const DATASET_SCHEMA = {
  id: 'aggregate',
  classes: {
    dataset: {
      description: 'One source dataset referenced by an /aggregate mosaic',
      properties: Object.fromEntries(['id', 'name', 'project', 'scene', 'date', 'format', 'licence', 'provider', 'attribution', 'country']
        .map((k) => [k, { type: 'STRING' }])),
    },
  },
};

export async function buildAggregate(urls, { nest = 'auto', ttlMs = DEFAULT_TTL_MS, bv = DEFAULT_BV, labels = {}, snap = null, native = false, known = {} } = {}) {
  // Timings are part of the output because they are the whole cost story of a mosaic: fetching every
  // child root dominates a cold build by orders of magnitude, while the tree itself takes milliseconds.
  const t0 = performance.now();
  await childInfo.load();
  // `known`: bounds baked into the manifest (scripts/aggregate-bake-bounds.mjs) — no probe at all.
  const baked = urls.filter((u) => known[u]).length;
  const cold = urls.filter((u) => !known[u] && !childInfo.isWarm(infoKey(u), ttlMs)).length;
  const results = await pooledSettled(urls, (u) => known[u] ? Promise.resolve(known[u]) : childInfo(infoKey(u), ttlMs));
  const t1 = performance.now();
  const children = [], failed = [], unplaced = [];
  results.forEach((res, i) => {
    if (res.status === 'rejected') { failed.push({ url: urls[i], error: String(res.reason?.message || res.reason) }); return; }
    const { sphere, geometricError, native: nativeSrc } = res.value;
    // A dataset in its own local frame (no georeference, no root transform) has its centre near the
    // ECEF origin — i.e. inside the Earth. Mosaicking it is worse than useless: ecefToLlh of a point
    // at the core yields an arbitrary lon/lat, so it lands in a random quadtree cell, and its sphere
    // drags the root bound past the planet's own radius (observed: 32 of 692 Iconem datasets, root
    // radius 9 235 km). Same 1 000 km rule as isEcefPlaced. Reported, not silently dropped — place
    // them with /stream's &lon=&lat= and they become regular children.
    if (Math.hypot(sphere[0], sphere[1], sphere[2]) < 1e6) {
      unplaced.push({ url: urls[i], reason: 'no georeference — centre is at the ECEF origin' });
      return;
    }
    const props = Object.fromEntries(Object.entries(labels[urls[i]] || {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]));
    children.push({
      boundingVolume: { sphere },
      geometricError,
      refine: 'ADD',
      content: { uri: urls[i], ...(native && nativeSrc ? { extensions: { [NATIVE_EXT]: nativeSrc } } : {}) },
      ...(Object.keys(props).length ? { metadata: { class: 'dataset', properties: props } } : {}),
    });
  });
  if (!children.length) {
    const err = new Error(`no placeable children (${failed.length} failed, ${unplaced.length} without georeference${failed.length ? ': ' + failed.map(f => f.error).join('; ') : ''})`);
    // A client-side problem (bad URLs, or datasets that need &lon=&lat= placement first), not a
    // server fault — the handler maps this to 422 with the lists attached.
    err.status = 422;
    err.detail = { failed, unplaced };
    throw err;
  }

  if (snap) {
    const offsets = await pooledSettled(children, (c) => snapOffset(JSON.stringify({ url: c.content.uri, terrain: snap, ttlMs }), ttlMs));
    children.forEach((c, i) => {
      const r = offsets[i].status === 'fulfilled' ? offsets[i].value : null;
      if (!r) { c.extras = { ...(c.extras || {}), snap: { terrain: snap, dz: null } }; return; }
      const [x, y, z] = c.boundingVolume.sphere;
      const n = Math.hypot(x, y, z);
      const [lon, lat] = ecefToLlh(x, y, z);
      const lo = lon * Math.PI / 180, la = lat * Math.PI / 180;
      const up = n ? [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)] : [0, 0, 0];
      const dz = +r.dz.toFixed(2);
      c.transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, up[0] * dz, up[1] * dz, up[2] * dz, 1];
      c.extras = { ...(c.extras || {}), snap: { terrain: snap, dz, bins: r.used, spread: +r.spread.toFixed(1) } };
    });
  }

  const want = parseNest(nest);
  const doNest = want.mode === 'on' || (want.mode === 'auto' && children.length >= NEST_THRESHOLD);

  let root, rootSphere, nesting = { mode: 'flat' };
  if (doNest) {
    const schemeName = want.scheme;
    const scheme = SCHEMES[schemeName];
    const leaves = children.map((tile) => {
      const [cx, cy, cz, r] = tile.boundingVolume.sphere;
      const [lon, lat] = ecefToLlh(cx, cy, cz);
      const cell = scheme.cellAt(lon, lat, levelForRadius(scheme, r, lat));
      // Stamp each dataset with the cell it landed in — the "why is this grouped here" breadcrumb.
      tile.extras = { ...(tile.extras || {}), cell: { scheme: schemeName, key: cell.key, morton: cell.morton } };
      return { key: cell.key, tile };
    });
    const nested = nestLeaves(leaves, schemeName, bv);
    root = nested?.tree;
    rootSphere = nested?.sphere;
    nesting = { mode: 'quadtree', scheme: schemeName, bv };
  }
  if (!root) {                                   // flat: one root, every dataset a direct child
    rootSphere = children.reduce((acc, ch) => unionSphere(acc, ch.boundingVolume.sphere), null);
    root = {
      boundingVolume: { sphere: rootSphere },
      // ×2, not max(): 3D Tiles requires geometric error to DECREASE on refine, and plain max() ties
      // the root to its largest child — so the root and that child become selectable at the same SSE.
      // The nested path has always doubled; this keeps the flat path consistent with it.
      geometricError: maxOf(children, (c) => c.geometricError) * 2,
      refine: 'ADD',
      children,
    };
  }

  // A mosaic spread across continents is better bounded by an EARTH-CENTRED sphere than by the greedy
  // pairwise union (whose centre drifts and whose radius overshoots: 9 526 km for the Iconem set,
  // larger than the planet). Both enclose every child; keep whichever is smaller.
  // A lone child is its own root and keeps its own volume. With bv=region the root is a region too.
  if (root.children) {
    const earthR = maxOf(children, (c) => { const [x, y, z, r] = c.boundingVolume.sphere; return Math.hypot(x, y, z) + r; });
    // union of the children's regions — the nested root already is one; a region around the union
    // SPHERE would be useless (that sphere can be larger than the planet)
    const regionOf = (c) => c.boundingVolume.region ?? sphereToRegion(c.boundingVolume.sphere ?? sphereOfVolume(c.boundingVolume));
    if (bv === 'region' || bv === 'cell') {
      root.boundingVolume = { region: root.boundingVolume.region ?? root.children.reduce((acc, c) => unionRegion(acc, regionOf(c)), null) };
    } else if (bv === 'box' && root.boundingVolume.box) {
      // a box that is looser than the Earth-centred sphere (a world mosaic) falls back to the sphere
      const [, , , ...axes] = root.boundingVolume.box;
      const boxR = Math.hypot(...axes.slice(0, 3)) + Math.hypot(...axes.slice(3, 6)) + Math.hypot(...axes.slice(6, 9));
      if (earthR < boxR) root.boundingVolume = { sphere: [0, 0, 0, earthR] };
    } else if (earthR < rootSphere[3]) root.boundingVolume = { sphere: [0, 0, 0, earthR] };
  }

  // depth/fanout of what we produced — cheap to compute, and the only way to see the nesting worked
  const shape = (t, d = 0) => t.children
    ? t.children.reduce((a, c) => { const s = shape(c, d + 1); return { depth: Math.max(a.depth, s.depth), groups: a.groups + s.groups }; },
                        { depth: d, groups: 1 })
    : { depth: d, groups: 0 };
  const { depth, groups } = shape(root);
  const t2 = performance.now();

  return {
    asset: {
      version: '1.1',
      extras: {
        datasets: children.length,
        build: {
          builtAt: new Date().toISOString(),
          childRoots: urls.length,
          childRootsFetched: cold,          // the rest came from the child-root cache or the manifest
          childRootsBaked: baked,           // bounds read from the manifest itself
          fetchConcurrency: FETCH_CONCURRENCY,
          fetchMs: Math.round(t1 - t0),
          treeMs: +(t2 - t1).toFixed(2),
        },
        nesting: nesting.mode === 'flat' ? nesting
          : { ...nesting, depth, groups, rootFanout: root.children?.length ?? 0 },
        ...(failed.length ? { failed } : {}),
        ...(unplaced.length ? { unplaced } : {}),
      },
    },
    schema: DATASET_SCHEMA,
    ...(children.some((c) => c.content?.extensions?.[NATIVE_EXT]) ? { extensionsUsed: [NATIVE_EXT] } : {}),
    geometricError: root.geometricError * 2,
    root,
  };
}

// ── demo sets ────────────────────────────────────────────────────────────────────────────────────
//
// Curated, ready-to-open mosaics so `/aggregate` can be SEEN rather than described. Defined here, on
// the server, rather than in the viewer: the desktop app, the docs and the hierarchy explorer all
// want the same list, and three copies of 30 URLs would drift apart within a week.
//
// Every entry is a real, public, key-less tileset.json that was probed before being added.

// ── countries ────────────────────────────────────────────────────────────────────────────────────
//
// Every dataset row carries the ISO 3166-1 alpha-3 of its country when it can be known: from an
// explicit `country` on the manifest entry, else from an "(XX)" alpha-2 in its project or name (the
// flai manifest's "Maa_amet (EE)", RESOURCES.md's "Soest 3D mesh (DE)"). The viewer's picker groups
// by it — country → agency → site, the way a national catalogue (STAC, Terria) is laid out.
const ISO2_TO_3 = {
  AT: 'AUT', AU: 'AUS', BE: 'BEL', CA: 'CAN', CH: 'CHE', DE: 'DEU', DK: 'DNK', EE: 'EST', ES: 'ESP', FI: 'FIN',
  FR: 'FRA', GB: 'GBR', UK: 'GBR', IE: 'IRL', IT: 'ITA', JP: 'JPN', KH: 'KHM', LU: 'LUX', LV: 'LVA', MM: 'MMR',
  MX: 'MEX', NL: 'NLD', NO: 'NOR', PL: 'POL', PT: 'PRT', RU: 'RUS', SE: 'SWE', SI: 'SVN', US: 'USA', AM: 'ARM', IN: 'IND',
};
export const COUNTRY_NAMES = {
  AUT: 'Austria', AUS: 'Australia', BEL: 'Belgium', CAN: 'Canada', CHE: 'Switzerland', DEU: 'Germany', DNK: 'Denmark',
  EST: 'Estonia', ESP: 'Spain', FIN: 'Finland', FRA: 'France', GBR: 'United Kingdom', IRL: 'Ireland', ITA: 'Italy',
  JPN: 'Japan', KHM: 'Cambodia', LUX: 'Luxembourg', LVA: 'Latvia', MMR: 'Myanmar', MEX: 'Mexico', NLD: 'Netherlands',
  NOR: 'Norway', POL: 'Poland', PRT: 'Portugal', RUS: 'Russia', SWE: 'Sweden', SVN: 'Slovenia', USA: 'United States',
  ARM: 'Armenia', IND: 'India',
};
/** ISO alpha-3 of a manifest / code-set entry, or null. */
export function countryOf(e) {
  if (!e) return null;
  const c = String(e.country ?? '').trim().toUpperCase();
  if (c.length === 3) return c;
  if (c.length === 2 && ISO2_TO_3[c]) return ISO2_TO_3[c];
  const m = /\(([A-Z]{2})\)/.exec(`${e.project ?? ''} ${e.name ?? e.label ?? ''}`);
  return m && ISO2_TO_3[m[1]] ? ISO2_TO_3[m[1]] : null;
}
const countryFields = (iso) => (iso ? { country: iso, countryName: COUNTRY_NAMES[iso] ?? null } : {});

/** Open data from the 3D Tiles spec's own RESOURCES.md — nine cities on four continents. */
const OPEN_DATA = [
  { id: 'strasbourg', provider: "Eurométropole de Strasbourg", country: 'FRA', attribution: "© Eurométropole de Strasbourg, Od@CiT", label: 'Strasbourg Od@CiT (FR)', url: 'https://s3.eu-west-2.wasabisys.com/ems-sgct-photomaillage/ODACIT/EMS_PM2022/tileset.json' },
  { id: 'clermont', provider: "CRAIG", country: 'FRA', attribution: "© CRAIG / Clermont Auvergne Métropole", label: 'Clermont-Ferrand (FR)', url: 'https://3d.craig.fr/datasets/Clermont/3dtiles/tileset.json' },
  { id: 'st-etienne', provider: "CRAIG", country: 'FRA', attribution: "© CRAIG / Saint-Étienne Métropole", label: 'Saint-Étienne (FR)', url: 'https://3d.craig.fr/datasets/St-Etienne/3dtiles/tileset.json' },
  { id: 'lille', provider: "Métropole Européenne de Lille", country: 'FRA', attribution: "© Métropole Européenne de Lille", label: 'Métropole de Lille (FR)', url: 'https://webimaging.lillemetropole.fr/externe/maillage/2016_mel_10cm/3dtiles/tileset.json' },
  { id: 'angkor-planet', provider: "Planet", country: 'KHM', attribution: "© Planet Labs PBC, SkySat; 3D by geofox.ai", label: 'Angkor Wat — Planet SkySat (KH)', url: 'https://storage.googleapis.com/open-cogs/planet-stac/angkor-wat/3d-geofox.ai/3DTiles/tileset.json' },
  { id: 'utrecht', provider: "Gemeente Utrecht", country: 'NLD', attribution: "© Gemeente Utrecht, hosted by Esri", label: 'Utrecht integrated mesh (NL)', url: 'https://tiles.arcgis.com/tiles/V6ZHFr6zdgNZuVG0/arcgis/rest/services/Utrecht_3D_Tiles_Integrated_Mesh/3DTilesServer/tileset.json' },
  { id: 'soest', provider: "Stadt Soest", country: 'DEU', attribution: "© Stadt Soest, virtualcitySYSTEMS", label: 'Soest 3D mesh (DE)', url: 'https://soest.virtualcitymap.de/datasource-data/HOSTING-Soest/3D-Mesh_2023/tileset.json' },
  { id: 'aarhus', provider: "SDFI", country: 'DNK', attribution: "© Klimadatastyrelsen (SDFI) / Aarhus Kommune", label: 'Aarhus mesh (DK)', url: 'https://sdfe-hosting.virtualcitymap.de/Aarhus/datasource-data/Aarhus_Mesh/tileset.json' },
  { id: 'agi-hq', provider: "Cesium", country: 'USA', attribution: "© Cesium (AGI)", label: 'AGI Headquarters (US)', url: 'https://pelican-public.s3.amazonaws.com/3dtiles/agi-hq/tileset.json' },
  { id: 'minato', provider: "Project PLATEAU", country: 'JPN', attribution: "© MLIT Japan, Project PLATEAU", label: 'Tokyo Minato-ku LOD4 — PLATEAU (JP)', url: 'https://assets.cms.plateau.reearth.io/assets/99/e2a800-7d75-4d11-94e1-bef604c39d01/13103_minato-ku_pref_2023_citygml_1_op_bldg_3dtiles_13103_minato-ku_lod4/tileset.json' },
];

// Iconem's own demo sets (`iconem-open`: the 23 Angkor sites as individual tilesets
// plus Geghard; `iconem-public`: a selection of them) are NOT here: their URLs are Iconem share links, which stay out of the repository.
// They live as machine-local manifests in .local/aggregate-sets/ (iconem-open.json, iconem-public.json),
// same shape as the iconem.json that scripts/iconem-share-links.mjs writes, and appear only where
// those files exist. Everything committed below is open or evaluation data from outside Iconem.

export const DEMO_SETS = {
  opendata: {
    label: '3D Tiles RESOURCES.md open data — 10 datasets, 4 continents',
    urls: OPEN_DATA.map((d) => d.url),
    entries: OPEN_DATA,
  },
  /** Every open or evaluation dataset from outside Iconem: the demo app's "Open data" pill. */
  open: {
    label: 'Open data — RESOURCES.md + national/city 3D Tiles + Esri meshes + Open Heritage 3D + Aerometrex + flai + Vexcel',
    urls: OPEN_DATA.map((d) => d.url),
    entries: OPEN_DATA,
    include: ['cities', 'esri-3d', 'openheritage3d', 'aerometrex', 'flai', 'vexcel'],
  },
  /** Everything committed at once — the "one endpoint, heterogeneous sources, whole planet" pitch. */
  world: {
    label: 'Open data + national/city 3D Tiles + Esri meshes + Aerometrex + Vexcel — every committed dataset',
    urls: OPEN_DATA.map((d) => d.url),
    entries: OPEN_DATA,
    // Aerometrex's US city previews come from the committed manifest (proxied, with its attribution)
    include: ['cities', 'esri-3d', 'aerometrex', 'vexcel'],
  },
};

/**
 * Assembled mosaics are cached whole, keyed by the exact child set + nesting scheme. Without this,
 * every client that opens a 500-dataset mosaic pays 500 tileset.json round-trips before seeing a
 * single tile — and a 3D Tiles client re-requests the root more than once per session.
 */
const aggregateCached = ttlCache(async (key) => {
  const { urls, nest, ttlMs, bv, labels, snap, native, known } = JSON.parse(key);
  return buildAggregate(urls, { nest, ttlMs, bv, labels, snap, native, known });
});

// ── local sets ───────────────────────────────────────────────────────────────────────────────────
//
// Machine-local mosaics, read from `.local/aggregate-sets/<name>.json` (gitignored; override the
// directory with AGGREGATE_SETS_DIR). This is where `scripts/iconem-share-links.mjs` writes its
// manifest, so `?set=iconem` becomes "every Iconem dataset with a single-meta-tileset share link".
//
// They live on disk rather than in DEMO_SETS because their URLs are share links — bearer credentials
// that must never be committed — and because hundreds of them could not travel in a query string
// anyway (that would blow straight past the HTTP header size limit).
//
// Manifest shape: { label, entries: [{ url, format: 'potree'|'copc'|'3dtiles', name?, project?, scene? }] }
const LOCAL_SETS_DIR = process.env.AGGREGATE_SETS_DIR
  || fileURLToPath(new URL('../../.local/aggregate-sets/', import.meta.url));
// Committed manifests of PUBLIC data, same shape (flai open LiDAR, Aerometrex previews): no secrets,
// so their URLs may be listed, and they exist on every deployment.
const PUBLIC_SETS_DIR = fileURLToPath(new URL('./aggregate-sets/', import.meta.url));

async function readSetsDir(dir, local) {
  let files = [];
  try { files = (await readdir(dir)).filter((f) => f.endsWith('.json')); }
  catch { return {}; }                             // no directory = no sets, not an error
  const sets = {};
  for (const f of files) {
    try {
      const m = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
      // a set that needs a secret (VEXCEL_API_KEY …) only exists where that secret is configured
      if (m.requiresEnv && !process.env[m.requiresEnv]) continue;
      if (Array.isArray(m.entries)) sets[f.replace(/\.json$/, '')] = { label: m.label ?? f, entries: m.entries, manifest: true, local,
        provider: m.provider ?? null, attribution: m.attribution ?? null };
    } catch (e) { console.warn(`[aggregate] ignoring unreadable set ${f}: ${e.message}`); }
  }
  return sets;
}

/** Read on every request: a regenerated manifest is picked up without a restart. Local names win. */
async function loadLocalSets() {
  return { ...(await readSetsDir(PUBLIC_SETS_DIR, false)), ...(await readSetsDir(LOCAL_SETS_DIR, true)) };
}

/**
 * A manifest entry → the URL the mosaic's child should reference. Source formats (a Potree cloud.js,
 * a .copc.laz) are not 3D Tiles, so they are wrapped through THIS server's /stream — absolute, since
 * the child URI is resolved by the client, not by us.
 */
function childUrlFor(entry, origin, cache = 'none', prefetch = null) {
  const fmt = entry.format || '3dtiles';
  // `proxy`: a host that sends no CORS (Aerometrex). /proxy is tileset-aware — it rewrites every child
  // content.uri to come back through itself — so the whole tree, not just the root, becomes readable.
  if (fmt === '3dtiles') return entry.proxy ? `${origin}/proxy?url=${encodeURIComponent(entry.url)}` : entry.url;
  // `crs`: for point clouds whose file declares none (flai's COPC overviews).
  // `lon`/`lat` (+ `alt`, `heading`): placement for clouds in a LOCAL frame (Open Heritage 3D's TLS
  // scans) — /stream's own &lon=&lat= placement, which a real georeference always overrides.
  const place = Number.isFinite(entry.lon) && Number.isFinite(entry.lat)
    ? `&lon=${entry.lon}&lat=${entry.lat}` + (entry.alt != null ? `&alt=${entry.alt}` : '') + (entry.heading != null ? `&heading=${entry.heading}` : '') : '';
  return `${origin}/stream/tileset.json?format=${encodeURIComponent(fmt)}&url=${encodeURIComponent(entry.url)}&cache=${cache}`
    + (prefetch != null ? `&prefetch=${prefetch}` : '')
    + (entry.crs ? `&crs=${encodeURIComponent(entry.crs)}` : '') + place;
}

/** Source format of an ad-hoc ?url= child: this server's /stream URLs say so; anything else is 3D Tiles. */
function formatOfUrl(x) {
  try {
    const u = new URL(x);
    if (/\/(stream|tiles|convert)\/tileset\.json$/.test(u.pathname)) return (u.searchParams.get('format') || '3dtiles').toLowerCase();
  } catch { /* not absolute — treat as a tileset */ }
  return '3dtiles';
}

// ── drafts: hand-built mosaics from the viewer's Aggregate Builder ─────────────────────────────────
//
// The builder assembles a tileset.json client-side. To PREVIEW it, a renderer needs a URL, and a
// blob: URL does not work: every child content.uri is absolute already, but Cesium and 3DTRjs both
// resolve the root through fetch + URL maths that a blob: base breaks, and the search overlay needs an
// index.json next to it. So the draft is parked here, in memory, under an unguessable id.
//
// In memory on purpose: a draft is a preview, not a publication — a restart losing it is fine, and
// nothing on disk has to be cleaned up. Bounded three ways (count, size, age) because the endpoint
// accepts writes from anyone who can reach the server.
//
//   POST /aggregate/draft                         body = tileset.json → { id, url }
//   GET  /aggregate/draft/<id>/tileset.json       [&hide=] [&format=] [&from=] [&to=] [&latest=1]
//   GET  /aggregate/draft/<id>/index.json         same rows as /aggregate/index.json
const DRAFT_MAX = 50;
const DRAFT_TTL_MS = 24 * 3600 * 1000;
const DRAFT_MAX_BYTES = 5 * 1024 * 1024;
const drafts = new Map();                          // id → { at, tileset }; Map order = LRU order
const DRAFT_PATH = /^\/aggregate\/draft\/([0-9a-f-]{36})\/(tileset|index)\.json$/;

function getDraft(id) {
  const d = drafts.get(id);
  if (!d) return null;
  if (Date.now() - d.at > DRAFT_TTL_MS) { drafts.delete(id); return null; }
  drafts.delete(id);                               // re-insert: most recently used goes last
  drafts.set(id, d);
  return d.tileset;
}

function putDraft(tileset) {
  const now = Date.now();
  for (const [id, d] of drafts) if (now - d.at > DRAFT_TTL_MS) drafts.delete(id);
  while (drafts.size >= DRAFT_MAX) drafts.delete(drafts.keys().next().value);
  const id = randomUUID();
  drafts.set(id, { at: now, tileset });
  return id;
}

async function readJsonBody(req, limit) {
  if (Number(req.headers['content-length']) > limit) throw Object.assign(new Error(`draft larger than ${limit} bytes`), { status: 413 });
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw Object.assign(new Error(`draft larger than ${limit} bytes`), { status: 413 });
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (e) { throw Object.assign(new Error(`body is not JSON: ${e.message}`), { status: 400 }); }
}

/**
 * One row per content tile of a draft, in the /aggregate/index.json shape. `group` is the builder
 * group path, so the viewer's picker lists a hand-made group's datasets together, as it does a site.
 */
function draftRows(ts) {
  const rows = [];
  (function walk(t, groupPath) {
    const props = t.metadata?.properties || {};
    if (t.content?.uri) {
      const bv = t.boundingVolume || {};
      const [x, y, z, r] = sphereToParent(sphereOfVolume(bv), t.transform, !!bv.region);
      const [lon, lat, height] = ecefToLlh(x, y, z);
      rows.push({ tile: t, row: {
        id: props.id || idOf(t.content.uri), name: props.name || nameFromUrl(t.content.uri),
        project: props.project, scene: props.scene, group: groupPath || null, date: props.date || null,
        ...(props.licence ? { licence: props.licence } : {}), format: props.format || formatOfUrl(t.content.uri),
        provider: props.provider ?? null, ...(props.attribution ? { attribution: props.attribution } : {}),
        ...countryFields(props.country || null),
        url: t.content.uri, lon: +lon.toFixed(6), lat: +lat.toFixed(6), height: +height.toFixed(1), radius: +r.toFixed(1),
      } });
    }
    // The root's own name is the project's, not a grouping — only groups below it make a path.
    const here = t === ts.root ? '' : (groupPath ? `${groupPath}/` : '') + (props.name || '');
    for (const c of t.children || []) walk(c, t.content?.uri ? groupPath : here);
  })(ts.root, '');
  return rows;
}

/**
 * The picker params (&hide= &format= &from= &to= &latest=) applied to a draft, so the viewer's
 * show/hide panel works on a preview exactly as on a server-built mosaic. Pruned groups keep their
 * original bounds: still enclosing, merely looser — recomputing them is the builder's job.
 */
function selectDraft(ts, u) {
  const rows = draftRows(ts);
  const formats = u.searchParams.getAll('format').flatMap((s) => s.split(',')).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const hide = new Set(u.searchParams.getAll('hide').flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean));
  const from = u.searchParams.get('from'), to = u.searchParams.get('to');
  let kept = rows.filter(({ row }) => (!formats.length || formats.includes(row.format)) && !hide.has(row.id)
    && (!from || !row.date || dateSpan(row.date)[1] >= dateSpan(from)[0])
    && (!to || !row.date || dateSpan(row.date)[0] <= dateSpan(to)[1]));
  if (['1', 'true'].includes(u.searchParams.get('latest') ?? '')) {
    const pts = kept.filter((k) => k.row.date).map((k) => ({ it: k, s: sphereToParent(sphereOfVolume(k.tile.boundingVolume), k.tile.transform, !!k.tile.boundingVolume.region), date: k.row.date }));
    const dropped = supersededSet(pts);
    kept = kept.filter((k) => !dropped.has(k));
  }
  if (kept.length === rows.length) return { tileset: ts, rows: kept.map((k) => k.row) };
  const keep = new Set(kept.map((k) => k.tile));
  const prune = (t) => {
    const children = (t.children || []).map(prune).filter(Boolean);
    const hasContent = !!t.content?.uri && keep.has(t);
    if (!hasContent && !children.length) return null;
    const out = { ...t, children };
    if (!children.length) delete out.children;
    if (t.content?.uri && !hasContent) delete out.content;
    return out;
  };
  // A root that pruned to nothing still has to be a valid tileset: keep it, childless and empty.
  const root = prune(ts.root) ?? { ...ts.root, children: [] };
  if (root.content && !keep.has(ts.root)) delete root.content;
  return { tileset: { ...ts, root }, rows: kept.map((k) => k.row) };
}

async function handleDraft(req, res, u, origin) {
  if (u.pathname === '/aggregate/draft') {
    if (req.method === 'OPTIONS') {                // server.js answers preflights first; kept for direct use
      res.writeHead(204, { ...CORS, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
      res.end();
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405, { ...CORS, Allow: 'POST' }); res.end('POST a tileset.json'); return; }
    let ts;
    try { ts = await readJsonBody(req, DRAFT_MAX_BYTES); }
    catch (e) { res.writeHead(e.status || 400, CORS); res.end(e.message); return; }
    if (!ts || typeof ts !== 'object' || typeof ts.asset !== 'object' || !ts.asset || typeof ts.root !== 'object' || !ts.root) {
      res.writeHead(400, CORS); res.end('not a tileset: needs an `asset` and a `root` object'); return;
    }
    const id = putDraft(ts);
    res.writeHead(201, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ id, url: `${origin}/aggregate/draft/${id}/tileset.json`, expiresInS: DRAFT_TTL_MS / 1000 }));
    return;
  }
  const m = DRAFT_PATH.exec(u.pathname);
  const ts = m && getDraft(m[1]);
  if (!ts) { res.writeHead(404, CORS); res.end('no such draft (drafts live in memory for 24 h, and a restart clears them)'); return; }
  const sel = selectDraft(ts, u);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS });
  res.end(JSON.stringify(m[2] === 'tileset' ? sel.tileset
    : { count: sel.rows.length, datasets: sel.rows, unplaced: [], failed: [] }));
}

// ── uploaded manifests: a local set, sent from the browser ───────────────────────────────────────
//
// The same manifest shape as `.local/aggregate-sets/<name>.json`, POSTed by the viewer's "manifest"
// button, so a deployment that has none of your local files can still mosaic your datasets:
//
//   POST /aggregate/set            body = { label?, entries: [{ url, format, name?, … }] } (or the bare array)
//                                  → { set: 'upload-<hash>', url, count, expiresInS }
//   GET  /aggregate/tileset.json?set=upload-<hash>&…   every selection param works, as for any set
//
// The name is a hash of the manifest: re-sending the same file gives the same URL, so a client that
// kept the file can restore a mosaic link after a server restart just by POSTing it again. Without the
// file the hash is unguessable, and uploads are never listed in demo.json or in error messages —
// their URLs are share links. In memory, bounded like drafts (count, size, age since last use).
const UPLOAD_MAX = 20;
const UPLOAD_TTL_MS = 24 * 3600 * 1000;
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const UPLOAD_FORMATS = new Set(['potree', 'copc', '3dtiles']);
const uploads = new Map();                         // name → { at, set }; Map order = LRU order
const UPLOAD_NAME = /^upload-[0-9a-f]{32}$/;

function getUpload(name) {
  const d = uploads.get(name);
  if (!d) return null;
  if (Date.now() - d.at > UPLOAD_TTL_MS) { uploads.delete(name); return null; }
  uploads.delete(name);
  uploads.set(name, { ...d, at: Date.now() });     // sliding expiry: a mosaic in use stays
  return d.set;
}

/** A manifest body → a set, or a message saying why not. Unknown entry fields pass through. */
function manifestToSet(m) {
  const entries = Array.isArray(m) ? m : m?.entries;
  if (!Array.isArray(entries) || !entries.length) return { error: 'expected { entries: [{ url, format }, …] } or a bare array of entries' };
  for (const [i, e] of entries.entries()) {
    if (!e || typeof e.url !== 'string' || !/^https?:\/\//.test(e.url)) return { error: `entry ${i}: needs an absolute http(s) \`url\`` };
    if (e.format != null && !UPLOAD_FORMATS.has(e.format)) return { error: `entry ${i}: format "${e.format}" is not one of ${[...UPLOAD_FORMATS].join(', ')}` };
  }
  return { set: { label: (!Array.isArray(m) && m.label) || 'Uploaded manifest', entries, manifest: true, local: true,
    provider: (!Array.isArray(m) && m.provider) || null, attribution: (!Array.isArray(m) && m.attribution) || null } };
}

async function handleUpload(req, res, origin) {
  if (req.method !== 'POST') { res.writeHead(405, { ...CORS, Allow: 'POST' }); res.end('POST a set manifest'); return; }
  let m;
  try { m = await readJsonBody(req, UPLOAD_MAX_BYTES); }
  catch (e) { res.writeHead(e.status || 400, CORS); res.end(e.message); return; }
  const { set, error } = manifestToSet(m);
  if (error) { res.writeHead(400, CORS); res.end(error); return; }
  // `bounds` is left out of the hash: baking a manifest (scripts/aggregate-bake-bounds.mjs) keeps its
  // set name, so links and the browser's stored copy keep working; the newest upload's bounds win.
  const name = 'upload-' + createHash('sha256').update(JSON.stringify(set.entries.map(({ bounds, ...e }) => e))).digest('hex').slice(0, 32);
  const now = Date.now();
  for (const [k, d] of uploads) if (now - d.at > UPLOAD_TTL_MS) uploads.delete(k);
  uploads.delete(name);
  while (uploads.size >= UPLOAD_MAX) uploads.delete(uploads.keys().next().value);
  uploads.set(name, { at: now, set });
  res.writeHead(201, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify({ set: name, label: set.label, count: set.entries.length,
    url: `${origin}/aggregate/tileset.json?set=${name}&nest=geodetic`, expiresInS: UPLOAD_TTL_MS / 1000 }));
}

/** Try to handle an /aggregate/* request. Returns true iff it owned the response. */
export async function handleAggregate(req, res, u) {
  // Before the set lookup: drafts never need the manifests read from disk.
  if (u.pathname === '/aggregate/draft' || u.pathname.startsWith('/aggregate/draft/')) {
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    await handleDraft(req, res, u, `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`);
    return true;
  }
  if (u.pathname === '/aggregate/set') {
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    await handleUpload(req, res, `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`);
    return true;
  }
  const localSets = await loadLocalSets();
  const sets = { ...DEMO_SETS, ...localSets };
  // an uploaded manifest joins the lookup only when asked for by name: never listed
  const setParam = u.searchParams.get('set') ?? '';
  if (UPLOAD_NAME.test(setParam)) {
    const up = getUpload(setParam);
    if (!up) { res.writeHead(404, CORS); res.end('no such uploaded manifest (uploads live in memory for 24 h, and a restart clears them): POST it to /aggregate/set again'); return true; }
    sets[setParam] = up;
  }

  // Machine-readable index of the available sets, so a UI can list them without hardcoding contents.
  // Local sets report counts and names only: their URLs are share links, and this index is a far
  // easier place to scrape them from than a mosaic.
  if (u.pathname === '/aggregate/demo.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, v.local
      ? { label: v.label, count: v.entries.length, local: true, names: v.entries.map((e) => e.name ?? null) }
      : { label: v.label, count: v.entries.length + (v.include || []).reduce((n, i) => n + (sets[i]?.entries.length ?? 0), 0), entries: v.entries, ...(v.include ? { include: v.include } : {}) }]))));
    return true;
  }
  const isTileset = u.pathname === '/aggregate/tileset.json';
  const isIndex = u.pathname === '/aggregate/index.json';
  const isSnapStream = u.pathname === '/aggregate/snap.ndjson';
  if (!isTileset && !isIndex && !isSnapStream) return false;

  // ?vpc=<url of a .vpc>: a PDAL/QGIS virtual point cloud is a set read from that one file (vpc-live.js),
  // its COPC items placed from their own extents. It takes the place of ?set=, and composes with ?url=.
  let vpc = null;
  const vpcUrl = u.searchParams.get('vpc');
  if (vpcUrl) {
    if (setParam) { res.writeHead(400, CORS); res.end('?vpc= and ?set= are two ways of naming the children: give one'); return true; }
    const ttlQ = u.searchParams.get('ttl');
    try {
      vpc = { ...(await vpcSet(vpcUrl, { ttlMs: ttlQ == null ? DEFAULT_TTL_MS : Math.max(0, Number(ttlQ) || 0) * 1000, sniff: sniffParam(u.searchParams.get('sniff')) })) };
    } catch (e) {
      const status = e.status ?? httpStatusOf(e);
      res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: status === 404 ? `no .vpc at ${vpcUrl.split('?')[0]}` : String(e.message || e), ...(e.detail ?? {}) }));
      return true;
    }
    sets.vpc = vpc.set;
    u = new URL(u.href);
    u.searchParams.set('set', 'vpc');
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const origin = `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
    const r = vpc.report;
    // The overview of the whole set, when the VPC names one: reported as a ready stream, not placed in the tree (see the VPC docs page for why).
    vpc.extras = { ...r, ...(r.overviews ? { overviews: r.overviews.map((o) => ({ url: o, stream: childUrlFor({ format: 'copc', url: o, crs: vpc.set.entries[0]?.crs }, origin) })) } : {}) };
    vpc.headers = {
      'X-VPC-Items': String(r.items), 'X-VPC-Streamed': String(r.streamed), 'X-VPC-Skipped': String(r.skipped),
      ...(r.skipped ? { 'X-VPC-Skipped-Reasons': Object.entries(r.skippedReasons).map(([k, n]) => `${n} ${k}`).join('; ').replace(/[^\x20-\x7e]/g, '?') } : {}),
      'Access-Control-Expose-Headers': 'X-VPC-Items, X-VPC-Streamed, X-VPC-Skipped, X-VPC-Skipped-Reasons',
    };
  }

  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const origin = `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  // A &cell= request (a subtree of a cut mosaic) never comes first: the root request has just derived
  // the mosaic's cache key from this same selection. The key is remembered by request (minus &cell=)
  // and reused, instead of being derived again from every item: 0.8 s per subtree at 100 000 items.
  const cell = isTileset ? u.searchParams.get('cell') : null;
  const viewKey = viewKeyOf(u, origin);
  // A VPC's ROOT request reuses it too, for as long as the mosaic lives: the set comes whole from one URL (itself kept
  // a day), so the same request selects the same items, and deriving the key again costs 10 s at 337 206 items.
  const rootMemo = !!vpcUrl && isTileset && !cell;
  const memo = cell || rootMemo ? viewMemo.get(viewKey) : null;
  let key, ttlMs, sel = null, items = null;
  if (memo && Date.now() - memo.at < (rootMemo ? Math.max(VIEW_MEMO_MS, memo.ttlMs) : VIEW_MEMO_MS)) ({ key, ttlMs } = memo);
  else {
    sel = selectChildren(req, u, sets);
    if (sel.error) { res.writeHead(400, CORS); res.end(sel.error); return true; }
    if (isSnapStream && !sel.snap) { res.writeHead(400, CORS); res.end('snap.ndjson needs &snap=<terrain>'); return true; }
    const { nest, bv } = sel;
    ({ ttlMs, items } = sel);
    // &latest=1 needs every dataset's footprint, so it runs after selection, on the cached child roots.
    if (sel.latest) items = await keepLatest(items, ttlMs);
    // &curved=on|off: every /stream child of this server carries it (copc-live's ellipsoid placement
    // rule); the child URLs change, so the mosaic cache key does too.
    const curved = curvedParam(u.searchParams.get('curved'));
    if (curved) items = items.map((it) => /\/stream\/tileset\.json\?/.test(it.url) ? { ...it, url: `${it.url}&curved=${curved}` } : it);
    const urls = items.map((it) => it.url);
    const labels = Object.fromEntries(items.map((it) => [it.url, {
      id: it.id, name: it.name, project: it.project, scene: it.scene, date: it.date, format: it.fmt, licence: it.licence,
      provider: it.provider, attribution: it.attribution, country: it.country ?? null,
    }]));

    // Baked bounds are trusted unless the request forces a re-read (&ttl=0) or changes placement (&curved=).
    const known = ttlMs > 0 && !curved ? Object.fromEntries(items.filter((it) => it.bounds).map((it) => [it.url, it.bounds])) : {};
    key = JSON.stringify({ urls, nest, ttlMs, bv, labels, snap: isSnapStream ? null : sel.snap, native: sel.native, known });
    if (isTileset && ttlMs > 0) {
      viewMemo.delete(viewKey);
      viewMemo.set(viewKey, { at: Date.now(), key, ttlMs });
      while (viewMemo.size > VIEW_MEMO_MAX) viewMemo.delete(viewMemo.keys().next().value);
    }
  }
  let ts;
  try {
    ts = await aggregateCached(key, ttlMs);
  } catch (e) {
    if (e.status !== 422) throw e;
    res.writeHead(422, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: e.message, ...e.detail,
      hint: 'datasets without a georeference can be placed first: /stream/tileset.json?…&lon=<deg>&lat=<deg>' }));
    return true;
  }

  if (isSnapStream) { await streamSnapOffsets(res, ts, items, sel.snap, ttlMs); return true; }

  if (isIndex) {
    // Same selection and the same cached mosaic as tileset.json, flattened into one row per PLACED
    // dataset: what a client needs for a search box and for "there is data here" markers, without
    // walking the tree or opening a single child. Built from the mosaic's own leaves so positions are
    // exactly what the renderer sees.
    const byUrl = new Map(items.map((it) => [it.url, it]));
    const datasets = [];
    (function walk(t, depth = 0) {
      if (t.content?.uri) {
        const [x, y, z, r] = t.boundingVolume.sphere;
        const [lon, lat, h0] = ecefToLlh(x, y, z);
        const height = h0 + (t.extras?.snap?.dz ?? 0);          // where the dataset IS once snapped
        const it = byUrl.get(t.content.uri) || {};
        datasets.push({
          id: it.id ?? idOf(t.content.uri),
          name: it.name || nameFromUrl(t.content.uri), project: it.project, scene: it.scene,
          // `group` is the platform scene when known: datasets sharing one are either a diachronic
          // series (show the latest) or pieces of one site (show them all) — a UI decides which.
          group: it.group ?? null, date: it.date ?? null, ...(it.licence ? { licence: it.licence } : {}),
          // who the data comes from — the library/picker filter on it, and viewers show `attribution`
          provider: it.provider ?? null, set: it.set ?? null, ...(it.attribution ? { attribution: it.attribution } : {}),
          ...countryFields(it.country ?? null),
          // where the dataset's external root sits in the mosaic: its quadtree cell, and its depth
          ...(t.extras?.cell ? { cell: t.extras.cell } : {}), depth,
          ...(t.extras?.snap ? { snap: t.extras.snap } : {}),
          format: it.fmt || '3dtiles', url: t.content.uri,
          lon: +lon.toFixed(6), lat: +lat.toFixed(6), height: +height.toFixed(1), radius: +r.toFixed(1),
        });
      }
      for (const c of t.children || []) walk(c, depth + 1);
    })(ts.root);
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS, ...(vpc?.headers ?? {}) });
    res.end(JSON.stringify({
      count: datasets.length, build: ts.asset.extras.build, ...(vpc ? { vpc: vpc.extras } : {}), datasets,
      unplaced: ts.asset.extras.unplaced ?? [], failed: ts.asset.extras.failed ?? [],
    }));
    return true;
  }

  // The depth cut (see cutTree): groups past `cut` levels become external tilesets, each this same URL
  // with &cell=<key>; a &cell= request answers with that group as a root, cut the same way. Both are
  // views of the one cached tree, so a set below the threshold is served exactly as before.
  const cutDepth = parseCut(u.searchParams.get('cut'), ts.asset.extras.datasets);
  const self = new URL(u.pathname + u.search, origin);
  if (vpcUrl) self.searchParams.delete('set');               // ?vpc= named the children; ?set=vpc was our own alias
  const uriFor = (k) => { const x = new URL(self.href); x.searchParams.set('cell', k); return x.href; };
  let out = ts;
  if (cell) {
    const node = subtreeOf(ts.root, cell);
    if (!node) { res.writeHead(404, { 'Content-Type': 'application/json', ...CORS }); res.end(JSON.stringify({ error: `no group with cell key "${cell}" in this mosaic (keys are in each group's extras.cell)` })); return true; }
    out = subtreeTileset(ts, node, cutDepth, uriFor, cell);
  } else if (cutDepth) {
    const { root, externals } = cutTree(ts.root, cutDepth, uriFor);
    if (externals) out = { ...ts, asset: { ...ts.asset, extras: { ...ts.asset.extras, cut: { depth: cutDepth, externals } } }, root };
  }
  // the mosaic is cached and shared: a VPC's report (items streamed, skipped and why) goes on a copy
  if (vpc) out = { ...out, asset: { ...out.asset, extras: { ...out.asset.extras, vpc: vpc.extras } } };
  res.writeHead(200, { 'Content-Type': 'application/json', ...CORS, ...(vpc?.headers ?? {}) });
  res.end(JSON.stringify(out));
  return true;
}

// The mosaic cache key a request derived, by request: what a &cell= subtree request reuses (see handleAggregate).
const VIEW_MEMO_MS = 10 * 60 * 1000;
const VIEW_MEMO_MAX = 16;
const viewMemo = new Map();                        // origin + path + query without &cell= → { at, key, ttlMs }
const viewKeyOf = (u, origin) => `${origin}${u.pathname}?${[...u.searchParams].filter(([k]) => k !== 'cell').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&')}`;

/** Stable short id of a child — hashed from its SOURCE url, so it survives a change of server origin. */
const idOf = (x) => createHash('sha1').update(x).digest('hex').slice(0, 10);

/**
 * "2012" → ["2012-01-01", "2012-12-31"]; "2015-10" → ["2015-10-01", "2015-10-31"]; an ISO 8601
 * interval "2021-01-01/2025-01-01" (a multi-year national campaign) → its two ends.
 */
function dateSpan(d) {
  const slash = String(d).indexOf('/');
  if (slash > 0) return [dateSpan(d.slice(0, slash))[0], dateSpan(d.slice(slash + 1))[1]];
  const [y, m, day] = String(d).split('-');
  if (day) return [d, d];
  if (m) return [`${y}-${m}-01`, `${y}-${m}-31`];
  return [`${y}-01-01`, `${y}-12-31`];
}

/**
 * &latest=1 — among datasets covering the SAME ground at different dates, keep only the newest.
 *
 * "Same ground" is geometric, not a naming rule: centres closer than 0.3× the larger radius and radii
 * within a factor of two. That separates a yearly re-scan of one site (Mes Aynak 2010…2022) from a
 * detail capture nested in a wider one (Piazza San Marco inside the Venice airborne scan, which has
 * a hole cut for it and must stay). Undated datasets are never superseded: there is nothing to compare.
 */
async function keepLatest(items, ttlMs) {
  const dated = items.filter((it) => it.date);
  const infos = await pooledSettled(dated, (it) => it.bounds && ttlMs > 0 ? Promise.resolve(it.bounds) : childInfo(infoKey(it.url), ttlMs));
  const pts = dated.map((it, i) => ({ it, date: it.date, s: infos[i].status === 'fulfilled' ? infos[i].value.sphere : null })).filter((p) => p.s);
  const dropped = supersededSet(pts);
  return items.filter((it) => !dropped.has(it));
}

/** The `it`s of `pts` ([{ it, s: sphere, date }]) that a newer capture of the same ground supersedes. */
function supersededSet(pts) {
  const parent = pts.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i].s, b = pts[j].s;
      const rMax = Math.max(a[3], b[3]), rMin = Math.min(a[3], b[3]);
      if (rMin < rMax / 2) continue;
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.3 * rMax) parent[find(i)] = find(j);
    }
  }
  // Superseded = ended before the newest capture STARTED. Comparing start to end keeps mixed precision
  // honest: "2022-05" and "2022-05-19" overlap, so neither replaces the other.
  const newest = new Map();
  pts.forEach((p, i) => {
    const r = find(i), start = dateSpan(p.date)[0];
    if (!newest.has(r) || start > newest.get(r)) newest.set(r, start);
  });
  return new Set(pts.filter((p, i) => dateSpan(p.date)[1] < newest.get(find(i))).map((p) => p.it));
}

/** A readable name for an ad-hoc child: the inner source file of a /stream URL, else the URL's tail. */
function nameFromUrl(x) {
  try {
    const u = new URL(x);
    const inner = u.searchParams.get('url');
    const p = (inner ? new URL(inner) : u).pathname.split('/').filter(Boolean);
    const last = p.pop() || u.hostname;
    return /^(tileset\.json|cloud\.js|metadata\.json|lod-meta\.json)$/i.test(last) ? (p.pop() || last) : last;
  } catch { return x.slice(-40); }
}

/**
 * Resolve ?set= / ?url= / ?urls= plus &format= / &only= / &exclude= into the child list. Shared by
 * tileset.json and index.json so the two can never disagree about which datasets a URL means.
 */
function selectChildren(req, u, sets) {
  // ?set=<name> expands to a curated or local list; it composes with ?url= so you can add your own
  // dataset to a demo mosaic without retyping the other 33.
  const setName = u.searchParams.get('set');
  if (setName && !sets[setName]) return { error: `unknown set "${setName}" — try one of: ${Object.keys(sets).join(', ')}` };
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const origin = `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  // Every /stream child of a mosaic opens lazily: a child is never asked for cache=hierarchy, which
  // drains the whole hierarchy before the root answers (183 s and over 300 s for two Iconem share
  // links, cold) — for every dataset the client merely sees from afar.
  //   &cache=none (default) [&prefetch=N]  children cache=none, prefetching N levels (/stream's default 1)
  //   &cache=hierarchy                      children cache=refine: nothing prefetched at open; the first
  //                                         tile request below a child's root drains that child's whole
  //                                         hierarchy in the background. Only datasets someone zooms
  //                                         into are drained, and no request waits on it.
  const wantsHierarchy = /^(hierarchy|refine)$/.test(u.searchParams.get('cache') || '');
  const prefetchQ = u.searchParams.has('prefetch') ? Math.trunc(Number(u.searchParams.get('prefetch')) || 0) : null;
  const childUrl = (e) => (wantsHierarchy ? childUrlFor(e, origin, 'refine') : childUrlFor(e, origin, 'none', prefetchQ));
  // `bounds` ({ sphere, geometricError, native? }) baked into a manifest entry: the mosaic places the
  // dataset without fetching its root (scripts/aggregate-bake-bounds.mjs writes them).
  const boundsOf = (e) => (e.bounds && Array.isArray(e.bounds.sphere) && e.bounds.sphere.length === 4 ? e.bounds : null);

  // Each child carries the text filters match against. For share links that must include the dataset
  // NAME: a share URL is an opaque token (/s/<token>/cloud.js), so `only=_d2024` could never match it.
  // Each also knows its source FORMAT, so `&format=` can split one mosaic into per-format variants,
  // and a display NAME for the index.
  const set = setName ? sets[setName] : null;
  const labelByUrl = new Map((set && !set.manifest ? set.entries : []).map((e) => [e.url, e.label || e.id]));
  const fromManifest = (entries, m) => entries.map((e) => ({ id: idOf(e.url), url: childUrl(e), fmt: e.format || '3dtiles', bounds: boundsOf(e),
        name: e.name, project: e.project, scene: e.scene, date: e.date ?? null, licence: e.licence,
        provider: e.provider ?? m.provider ?? null, attribution: e.attribution ?? m.attribution ?? null, set: m.name, country: countryOf(e),
        group: e.sceneId != null ? `scene:${e.sceneId}` : e.scene ? `scene:${e.project ?? ''}/${e.scene}` : null,
        text: [e.url, e.name, e.project, e.scene, e.date, e.provider ?? m.provider].filter(Boolean).join(' ') }));
  const fromSet = !set ? [] : set.manifest
    ? set.entries.map((e) => ({ id: idOf(e.url), url: childUrl(e), fmt: e.format || '3dtiles', bounds: boundsOf(e),
        name: e.name, project: e.project, scene: e.scene, date: e.date ?? null, licence: e.licence,
        provider: e.provider ?? set.provider ?? null, attribution: e.attribution ?? set.attribution ?? null, set: setName, country: countryOf(e),
        group: e.sceneId != null ? `scene:${e.sceneId}` : e.scene ? `scene:${e.project ?? ''}/${e.scene}` : null,
        text: [e.url, e.name, e.project, e.scene, e.date, e.provider ?? set.provider].filter(Boolean).join(' ') }))
    : [
        // a code-set entry with a `format` is a point cloud: wrapped by /stream like a manifest entry
        ...set.entries.map((e) => ({ id: idOf(e.url), url: e.format ? childUrl(e) : e.url, fmt: e.format || '3dtiles', bounds: boundsOf(e), name: e.label || e.id,
          provider: e.provider ?? null, attribution: e.attribution ?? null, set: setName, country: countryOf(e),
          text: [e.url, e.label, e.provider].filter(Boolean).join(' ') })),
        // code sets may pull in public manifests (the world set includes Aerometrex, through /proxy)
        ...(set.include || []).flatMap((name) => (sets[name]?.manifest ? fromManifest(sets[name].entries, { ...sets[name], name }) : [])),
      ];
  const adhoc = (x) => ({ id: idOf(x), url: x, fmt: formatOfUrl(x), name: nameFromUrl(x), text: x });
  let items = [
    ...fromSet,
    ...u.searchParams.getAll('url').map(adhoc),
    ...(u.searchParams.get('urls') || '').split(',').map(s => s.trim()).filter(Boolean).map(decodeURIComponent).map(adhoc),
  ];
  if (!items.length) return { error: `missing ?urls=<u1>,<u2>,… (each URL-encoded), repeated ?url=, or ?set=<${Object.keys(sets).join('|')}>` };

  // ── selection ──────────────────────────────────────────────────────────────────────────────────
  //
  // Overlapping captures are the motivating case: a site re-scanned yearly gives N tilesets covering
  // the SAME ground, and you usually want one. Filtering happens here rather than client-side so the
  // emitted tileset genuinely contains only the chosen datasets — the URL is the whole state, which
  // means a filtered view is still a plain 3D Tiles endpoint you can paste into Unreal.
  //
  // Matching is a case-insensitive substring over the child URL, repeatable, `only` before `exclude`.
  // Substring rather than regex on purpose: these go in query strings that people edit by hand.
  // &format=potree|copc|3dtiles (repeatable) — "only the 3D Tiles", "only the point clouds", … without
  // maintaining a manifest per variant.
  const formats = u.searchParams.getAll('format').flatMap(s => s.split(',')).map(s => s.trim().toLowerCase()).filter(Boolean);
  if (formats.length) items = items.filter(it => formats.includes(it.fmt));
  const only = u.searchParams.getAll('only').filter(Boolean).map(s => s.toLowerCase());
  const exclude = u.searchParams.getAll('exclude').filter(Boolean).map(s => s.toLowerCase());
  if (only.length) items = items.filter(it => only.some(s => it.text.toLowerCase().includes(s)));
  if (exclude.length) items = items.filter(it => !exclude.some(s => it.text.toLowerCase().includes(s)));
  // &hide=<id> (repeatable / comma-separated) — the ids index.json reports; what a show/hide picker sets.
  const hide = new Set(u.searchParams.getAll('hide').flatMap(s => s.split(',')).map(s => s.trim()).filter(Boolean));
  if (hide.size) items = items.filter(it => !hide.has(it.id));
  // &from= / &to= (YYYY, YYYY-MM or YYYY-MM-DD) keep datasets whose capture date overlaps the range.
  // Undated datasets are kept — a timeline must not silently empty a mosaic that is half undated.
  const from = u.searchParams.get('from'), to = u.searchParams.get('to');
  if (from) items = items.filter(it => !it.date || dateSpan(it.date)[1] >= dateSpan(from)[0]);
  if (to) items = items.filter(it => !it.date || dateSpan(it.date)[0] <= dateSpan(to)[1]);
  if (!items.length) return { error: `no children left after format=[${formats}] only=[${only}] exclude=[${exclude}] hide=${hide.size} from=${from ?? ''} to=${to ?? ''}` };
  const nest = u.searchParams.get('nest') ?? 'auto';
  // &ttl=<seconds>; ttl=0 bypasses the cache entirely (both the mosaic and its child roots), which is
  // what you want while iterating on a dataset that is actively being re-tiled.
  const ttlParam = u.searchParams.get('ttl');
  const ttlMs = ttlParam == null ? DEFAULT_TTL_MS : Math.max(0, Number(ttlParam) || 0) * 1000;
  const bv = BV_MODES.includes(u.searchParams.get('bv')) ? u.searchParams.get('bv') : DEFAULT_BV;
  const snapParam = u.searchParams.get('snap');
  const snap = !snapParam || snapParam === '0' ? null : TERRAINS[snapParam] ? snapParam : 'mapterhorn-ellipsoid';
  const latest = ['1', 'true'].includes(u.searchParams.get('latest') ?? '');
  // &native=1: leaves also carry their source (Potree …) for renderers that read it directly
  const native = ['1', 'true'].includes(u.searchParams.get('native') ?? '');
  return { items, nest, ttlMs, bv, latest, snap, native };
}

/** Internals exposed for scripts/debug-aggregate-nesting.mjs. */
export const __test = { cellBounds, SCHEMES };

/**
 * For scripts/aggregate-bake-bounds.mjs: the bounds /aggregate would compute for a manifest entry, via
 * a running server's /stream at `origin` (and the persisted child-root cache, so a warm cache bakes
 * without a single request). `fresh` re-probes.
 */
export async function probeEntryBounds(entry, origin, { fresh = false } = {}) {
  const url = (entry.format || '3dtiles') === '3dtiles' && !entry.proxy ? entry.url : childUrlFor(entry, origin);
  return childInfo(infoKey(url), fresh ? 0 : DEFAULT_TTL_MS);
}
