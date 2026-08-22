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
import { memoizeAsync, llhToEcef } from '../core/index.js';

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

export async function buildAggregate(urls) {
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
  // Meta root: sphere enclosing all child spheres; GE above every child's so all children load.
  const rootSphere = children.reduce((acc, ch) => {
    const [x, y, z, r] = ch.boundingVolume.sphere;
    if (!acc) return [x, y, z, r];
    const d = Math.hypot(x-acc[0], y-acc[1], z-acc[2]);
    if (d + r <= acc[3]) return acc;                       // child inside current
    if (d + acc[3] <= r) return [x, y, z, r];              // current inside child
    const R = (d + r + acc[3]) / 2, k = (R - acc[3]) / d;  // minimal sphere over both
    return [acc[0]+(x-acc[0])*k, acc[1]+(y-acc[1])*k, acc[2]+(z-acc[2])*k, R];
  }, null);
  const maxGE = Math.max(...children.map(c => c.geometricError));
  const ts = {
    asset: { version: '1.1', ...(failed.length ? { extras: { failed } } : {}) },
    geometricError: maxGE * 2,
    root: {
      boundingVolume: { sphere: rootSphere },
      geometricError: maxGE,
      refine: 'ADD',
      children,
    },
  };
  return ts;
}

/** Try to handle an /aggregate/* request. Returns true iff it owned the response. */
export async function handleAggregate(req, res, u) {
  if (u.pathname !== '/aggregate/tileset.json') return false;
  const urls = [
    ...u.searchParams.getAll('url'),
    ...(u.searchParams.get('urls') || '').split(',').map(s => s.trim()).filter(Boolean).map(decodeURIComponent),
  ];
  if (!urls.length) { res.writeHead(400, CORS); res.end('missing ?urls=<u1>,<u2>,… (each URL-encoded) or repeated ?url='); return true; }
  const ts = await buildAggregate(urls);
  res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(ts));
  return true;
}
