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
 *   …&nest=auto|mercator|geodetic|flat   &ttl=<seconds>
 *
 * Child fetch failures don't kill the aggregate: failed children are skipped and listed in
 * `asset.extras.failed` (with the error), so a mosaic of 40 datasets survives one dead host.
 */
import { llhToEcef, ecefToLlh } from '../core/index.js';

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

function ttlCache(builder) {
  const cache = new Map();                       // key → { at, ttl, value | error }
  return async (key, ttlMs = DEFAULT_TTL_MS) => {
    // ttl=0 must bypass the cache in BOTH directions. Skipping only the write would still serve a
    // previously-cached mosaic, which defeats the one thing `&ttl=0` exists for: forcing a re-read
    // while a dataset is being re-tiled underneath you.
    const hit = ttlMs > 0 ? cache.get(key) : undefined;
    if (hit && Date.now() - hit.at < hit.ttl) {
      if (hit.error) throw hit.error;
      return hit.value;
    }
    try {
      const value = await builder(key);
      if (ttlMs > 0) cache.set(key, { at: Date.now(), ttl: ttlMs, value });
      return value;
    } catch (error) {
      if (ttlMs > 0) cache.set(key, { at: Date.now(), ttl: Math.min(ttlMs, FAILURE_TTL_MS), error });
      throw error;
    }
  };
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

// One child's meta entry: fetch its tileset.json (cached per URL), derive sphere + GE.
const childInfo = ttlCache(async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
  const ts = await r.json();
  const root = ts.root || {};
  const sphere = sphereToParent(sphereOfVolume(root.boundingVolume || {}), root.transform, !!root.boundingVolume?.region);
  // The child tile's GE gates when the renderer LOADS the child tileset; use the child's own tileset
  // GE so it appears exactly when the child's own root would have.
  const geometricError = Number.isFinite(ts.geometricError) ? ts.geometricError : (root.geometricError ?? 1e6);
  return { sphere, geometricError };
});

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
      // The extra lon bit selects the root cell (W/E hemisphere); the rest bisect in lockstep.
      const key = digitsFromXY(x >> 1, y, level, String(x >> level));
      return { x, y, key, morton: mortonIndex(x, y, level + 1) };
    },
  },
};

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
 * Build the nested tile tree from leaf entries [{ key, tile }]. Returns a 3D Tiles tile.
 *
 * Each emitted group carries `extras.cell` — its path digits, level and Morton index — so the
 * grouping a mosaic chose is inspectable from the tileset alone (and by /stats, which walks it like
 * any other tileset). Nothing renders off it; it is there so "why did this dataset end up here" has
 * an answer that doesn't require re-running the server.
 */
function nestLeaves(leaves, schemeName) {
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

    const sphere = children.reduce((acc, c) => unionSphere(acc, c.boundingVolume.sphere), null);
    // Parent GE must exceed every child's (3D Tiles requires monotonic decrease on refine); 2× keeps
    // it monotonic while staying small enough that a distant group is never traversed.
    const geometricError = Math.max(...children.map(c => c.geometricError)) * 2;
    // The geodetic path's first digit is the 2×1 root-cell selector, so its level is one shorter.
    const level = schemeName === 'geodetic' ? Math.max(0, node.path.length - 1) : node.path.length;
    return {
      boundingVolume: { sphere },
      geometricError,
      refine: 'ADD',
      extras: { cell: { scheme: schemeName, key: node.path || '(root)', level } },
      children,
    };
  };
  return build(root);
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

export async function buildAggregate(urls, { nest = 'auto', ttlMs = DEFAULT_TTL_MS } = {}) {
  const results = await pooledSettled(urls, (u) => childInfo(u, ttlMs));
  const children = [], failed = [];
  results.forEach((res, i) => {
    if (res.status === 'rejected') { failed.push({ url: urls[i], error: String(res.reason?.message || res.reason) }); return; }
    const { sphere, geometricError } = res.value;
    children.push({
      boundingVolume: { sphere },
      geometricError,
      refine: 'ADD',
      content: { uri: urls[i] },
    });
  });
  if (!children.length) throw new Error(`no reachable children (${failed.map(f => f.error).join('; ')})`);

  const want = parseNest(nest);
  const doNest = want.mode === 'on' || (want.mode === 'auto' && children.length >= NEST_THRESHOLD);

  let root, nesting = { mode: 'flat' };
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
    root = nestLeaves(leaves, schemeName);
    nesting = { mode: 'quadtree', scheme: schemeName };
  }
  if (!root) {                                   // flat: one root, every dataset a direct child
    const rootSphere = children.reduce((acc, ch) => unionSphere(acc, ch.boundingVolume.sphere), null);
    root = {
      boundingVolume: { sphere: rootSphere },
      // ×2, not max(): 3D Tiles requires geometric error to DECREASE on refine, and plain max() ties
      // the root to its largest child — so the root and that child become selectable at the same SSE.
      // The nested path has always doubled; this keeps the flat path consistent with it.
      geometricError: Math.max(...children.map(c => c.geometricError)) * 2,
      refine: 'ADD',
      children,
    };
  }

  // depth/fanout of what we produced — cheap to compute, and the only way to see the nesting worked
  const shape = (t, d = 0) => t.children
    ? t.children.reduce((a, c) => { const s = shape(c, d + 1); return { depth: Math.max(a.depth, s.depth), groups: a.groups + s.groups }; },
                        { depth: d, groups: 1 })
    : { depth: d, groups: 0 };
  const { depth, groups } = shape(root);

  return {
    asset: {
      version: '1.1',
      extras: {
        datasets: children.length,
        nesting: nesting.mode === 'flat' ? nesting
          : { ...nesting, depth, groups, rootFanout: root.children?.length ?? 0 },
        ...(failed.length ? { failed } : {}),
      },
    },
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

/** Open data from the 3D Tiles spec's own RESOURCES.md — nine cities on four continents. */
const OPEN_DATA = [
  { id: 'strasbourg', label: 'Strasbourg Od@CiT (FR)', url: 'https://s3.eu-west-2.wasabisys.com/ems-sgct-photomaillage/ODACIT/EMS_PM2022/tileset.json' },
  { id: 'clermont', label: 'Clermont-Ferrand (FR)', url: 'https://3d.craig.fr/datasets/Clermont/3dtiles/tileset.json' },
  { id: 'st-etienne', label: 'Saint-Étienne (FR)', url: 'https://3d.craig.fr/datasets/St-Etienne/3dtiles/tileset.json' },
  { id: 'lille', label: 'Métropole de Lille (FR)', url: 'https://webimaging.lillemetropole.fr/externe/maillage/2016_mel_10cm/3dtiles/tileset.json' },
  { id: 'angkor-planet', label: 'Angkor Wat — Planet SkySat (KH)', url: 'https://storage.googleapis.com/open-cogs/planet-stac/angkor-wat/3d-geofox.ai/3DTiles/tileset.json' },
  { id: 'utrecht', label: 'Utrecht integrated mesh (NL)', url: 'https://tiles.arcgis.com/tiles/V6ZHFr6zdgNZuVG0/arcgis/rest/services/Utrecht_3D_Tiles_Integrated_Mesh/3DTilesServer/tileset.json' },
  { id: 'soest', label: 'Soest 3D mesh (DE)', url: 'https://soest.virtualcitymap.de/datasource-data/HOSTING-Soest/3D-Mesh_2023/tileset.json' },
  { id: 'aarhus', label: 'Aarhus mesh (DK)', url: 'https://sdfe-hosting.virtualcitymap.de/Aarhus/datasource-data/Aarhus_Mesh/tileset.json' },
  { id: 'agi-hq', label: 'AGI Headquarters (US)', url: 'https://pelican-public.s3.amazonaws.com/3dtiles/agi-hq/tileset.json' },
  { id: 'minato', label: 'Tokyo Minato-ku LOD4 — PLATEAU (JP)', url: 'https://assets.cms.plateau.reearth.io/assets/99/e2a800-7d75-4d11-94e1-bef604c39d01/13103_minato-ku_pref_2023_citygml_1_op_bldg_3dtiles_13103_minato-ku_lod4/tileset.json' },
];

/**
 * Iconem's Angkor campaign as 23 INDIVIDUAL tilesets rather than its hand-authored merged root.
 *
 * This is the interesting case for nesting, because the sites are not uniformly spread: 19 of them
 * sit inside the Angkor park (a few km apart) while the four PhnomKulen sites are ~30 km north-east.
 * A grouping derived only from bounding spheres should discover that split on its own.
 */
const ANGKOR_BASE = 'https://api.iconem.com/s/is52XRiz30fn30HPjbgGe-KrydjSA3r0';
const ANGKOR_SITES = [
  'AkYum_231M_d202411_p202412_epsg32648',
  'AngkorThom_SouthGate_817M_d202411_p202412_epsg32648',
  'AngkorTom_Baphuon_SleepingBuddha_342M_d202408_p202410_epsg32648',
  'Angkor_BakseiChamkrong', 'Angkor_BanteayThom', 'Angkor_PrasatKravan', 'Angkor_PrasatPrehko',
  'Bayon_2400M_d202203_p202209_epsg32648',
  'ElephantTerrace_1451M_d202411_p202412_epsg32648',
  'Mebon2',
  'NeakPean_168M_d202412_p202412_epsg32648',
  'Phimeanakas_218M_d202408_p202410_epsg32648',
  'PhnomBakeng_1726M_d202408_p202410_epsg32648',
  'PhnomKulen_01-2_KrorBeiKrab_456M_d202411_p202412_epsg32648',
  'PhnomKulen_02-1_OuThmorDab_280M_d202411_p202412_epsg32648',
  'PhnomKulen_02-2_NaekTa_184M_d202411_p202412_epsg32648',
  'PhnomKulen_02-3_OuPhaOng_213M_d202411_p202412_epsg32648',
  'PrasatPreimonti_271M_202001',
  'Prasat_Batchum_174M',
  'PreahKhan_Master2_2018-05-28_21h17_31_798',
  'ShausreBibol_complet_DronePercheSol_2018-05-29_23h37_49_523',
  'TaProhm_4128M_d202408_p202410_epsg32648',
  'TonleSnguot_221M_d202412_p202412_epsg32648',
];

export const DEMO_SETS = {
  opendata: {
    label: '3D Tiles RESOURCES.md open data — 10 datasets, 4 continents',
    urls: OPEN_DATA.map((d) => d.url),
    entries: OPEN_DATA,
  },
  angkor: {
    label: 'Iconem Angkor — 23 individual site tilesets',
    urls: ANGKOR_SITES.map((s) => `${ANGKOR_BASE}/${s}/tileset.json`),
    entries: ANGKOR_SITES.map((s) => ({ id: s, label: s.split('_')[0], url: `${ANGKOR_BASE}/${s}/tileset.json` })),
  },
  /** Everything at once — the "one endpoint, heterogeneous sources, whole planet" pitch. */
  world: {
    label: 'Open data + Angkor — 33 tilesets across four continents',
    urls: [...OPEN_DATA.map((d) => d.url), ...ANGKOR_SITES.map((s) => `${ANGKOR_BASE}/${s}/tileset.json`)],
    entries: [...OPEN_DATA, ...ANGKOR_SITES.map((s) => ({ id: s, label: s.split('_')[0], url: `${ANGKOR_BASE}/${s}/tileset.json` }))],
  },
};

/**
 * Assembled mosaics are cached whole, keyed by the exact child set + nesting scheme. Without this,
 * every client that opens a 500-dataset mosaic pays 500 tileset.json round-trips before seeing a
 * single tile — and a 3D Tiles client re-requests the root more than once per session.
 */
const aggregateCached = ttlCache(async (key) => {
  const { urls, nest, ttlMs } = JSON.parse(key);
  return buildAggregate(urls, { nest, ttlMs });
});

/** Try to handle an /aggregate/* request. Returns true iff it owned the response. */
export async function handleAggregate(req, res, u) {
  // Machine-readable index of the demo sets, so a UI can list them without hardcoding the contents.
  if (u.pathname === '/aggregate/demo.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(Object.fromEntries(
      Object.entries(DEMO_SETS).map(([k, v]) => [k, { label: v.label, count: v.urls.length, entries: v.entries }]),
    )));
    return true;
  }
  if (u.pathname !== '/aggregate/tileset.json') return false;

  // ?set=<name> expands to a curated demo list; it composes with ?url= so you can add your own
  // dataset to a demo mosaic without retyping the other 33.
  const setName = u.searchParams.get('set');
  if (setName && !DEMO_SETS[setName]) {
    res.writeHead(400, CORS);
    res.end(`unknown set "${setName}" — try one of: ${Object.keys(DEMO_SETS).join(', ')}`);
    return true;
  }
  const urls = [
    ...(setName ? DEMO_SETS[setName].urls : []),
    ...u.searchParams.getAll('url'),
    ...(u.searchParams.get('urls') || '').split(',').map(s => s.trim()).filter(Boolean).map(decodeURIComponent),
  ];
  if (!urls.length) { res.writeHead(400, CORS); res.end(`missing ?urls=<u1>,<u2>,… (each URL-encoded), repeated ?url=, or ?set=<${Object.keys(DEMO_SETS).join('|')}>`); return true; }
  const nest = u.searchParams.get('nest') ?? 'auto';
  // &ttl=<seconds>; ttl=0 bypasses the cache entirely (both the mosaic and its child roots), which is
  // what you want while iterating on a dataset that is actively being re-tiled.
  const ttlParam = u.searchParams.get('ttl');
  const ttlMs = ttlParam == null ? DEFAULT_TTL_MS : Math.max(0, Number(ttlParam) || 0) * 1000;
  const key = JSON.stringify({ urls, nest, ttlMs });
  const ts = await aggregateCached(key, ttlMs);
  res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(ts));
  return true;
}
