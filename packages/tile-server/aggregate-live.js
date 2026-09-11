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
 *
 * Child fetch failures don't kill the aggregate: failed children are skipped and listed in
 * `asset.extras.failed` (with the error), so a mosaic of 40 datasets survives one dead host.
 */
import { memoizeAsync, llhToEcef, ecefToLlh } from '../core/index.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };

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
const childInfo = memoizeAsync(async (url) => {
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
// This is deliberately the same idea as 3D Tiles implicit tiling / Bing's quadkeys: a web-mercator
// quadtree, each node addressed by the base-4 digits of its x/y bits. Each dataset is placed at the
// DEEPEST level whose cell still comfortably contains it, so a 200 m scan lands deep (its own city
// cell) while a country-wide dataset stays shallow — a dataset is never forced into a cell smaller
// than itself. The trie is then path-compressed, so you get continent → country → city only where
// datasets actually diverge, not 20 levels of single-child nodes.
//
// Culling does the work at render time, but the GEOMETRIC ERROR is what stops the fetch: an internal
// node's GE is 2× its children's, so from a world view the SSE of a site-sized node is a fraction of
// a pixel and the renderer never traverses into it. Zoom to Paris and only the nodes whose bounding
// spheres intersect the frustum refine — so only Paris's tilesets are fetched.
const EARTH_CIRCUMFERENCE = 40075017;
const MAX_NEST_LEVEL = 16;          // ~600 m cells at the equator; deeper separates nothing useful
const NEST_THRESHOLD = 8;           // below this, a flat root is simpler and just as cullable

/** Deepest mercator level whose cell still comfortably contains a sphere of this radius. */
function levelForRadius(radiusM, latDeg) {
  if (!(radiusM > 0)) return MAX_NEST_LEVEL;
  const cosLat = Math.max(0.05, Math.cos(latDeg * Math.PI / 180));
  for (let L = MAX_NEST_LEVEL; L >= 0; L--) {
    const cell = (EARTH_CIRCUMFERENCE * cosLat) / 2 ** L;
    if (cell >= radiusM * 4) return L;       // 4× slack so a dataset isn't split across cells
  }
  return 0;
}

/** Quadkey digits for lon/lat at a given level (same addressing as Bing / implicit quadtree). */
function quadKeyAt(lonDeg, latDeg, level) {
  const n = 2 ** level;
  const x = Math.min(n - 1, Math.max(0, Math.floor(((lonDeg + 180) / 360) * n)));
  const latRad = Math.max(-1.4844, Math.min(1.4844, latDeg * Math.PI / 180));
  const y = Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n)));
  let qk = '';
  for (let i = level; i > 0; i--) {
    const mask = 1 << (i - 1);
    let d = 0;
    if (x & mask) d += 1;
    if (y & mask) d += 2;
    qk += d;
  }
  return qk;
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

/** Build the nested tile tree from leaf entries [{ qk, tile }]. Returns a 3D Tiles tile. */
function nestLeaves(leaves) {
  // trie over quadkey digits; a node holds leaves that stop at its own level
  const root = { kids: new Map(), here: [] };
  for (const lf of leaves) {
    let node = root;
    for (const digit of lf.qk) {
      if (!node.kids.has(digit)) node.kids.set(digit, { kids: new Map(), here: [] });
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
    return { boundingVolume: { sphere }, geometricError, refine: 'ADD', children };
  };
  return build(root);
}

export async function buildAggregate(urls, { nest = 'auto' } = {}) {
  const results = await Promise.allSettled(urls.map(childInfo));
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

  const doNest = nest === '1' || nest === 'true' || nest === true
    || (nest === 'auto' && children.length >= NEST_THRESHOLD);

  let root, nested = false;
  if (doNest) {
    const leaves = children.map((tile) => {
      const [cx, cy, cz, r] = tile.boundingVolume.sphere;
      const [lon, lat] = ecefToLlh(cx, cy, cz);
      return { qk: quadKeyAt(lon, lat, levelForRadius(r, lat)), tile };
    });
    root = nestLeaves(leaves);
    nested = true;
  }
  if (!root) {                                   // flat: one root, every dataset a direct child
    const rootSphere = children.reduce((acc, ch) => unionSphere(acc, ch.boundingVolume.sphere), null);
    root = {
      boundingVolume: { sphere: rootSphere },
      geometricError: Math.max(...children.map(c => c.geometricError)),
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
        nesting: nested ? { mode: 'quadtree', depth, groups, rootFanout: root.children?.length ?? 0 } : { mode: 'flat' },
        ...(failed.length ? { failed } : {}),
      },
    },
    geometricError: root.geometricError * 2,
    root,
  };
}

/** Try to handle an /aggregate/* request. Returns true iff it owned the response. */
export async function handleAggregate(req, res, u) {
  if (u.pathname !== '/aggregate/tileset.json') return false;
  const urls = [
    ...u.searchParams.getAll('url'),
    ...(u.searchParams.get('urls') || '').split(',').map(s => s.trim()).filter(Boolean).map(decodeURIComponent),
  ];
  if (!urls.length) { res.writeHead(400, CORS); res.end('missing ?urls=<u1>,<u2>,… (each URL-encoded) or repeated ?url='); return true; }
  const ts = await buildAggregate(urls, { nest: u.searchParams.get('nest') ?? 'auto' });
  res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(ts));
  return true;
}
