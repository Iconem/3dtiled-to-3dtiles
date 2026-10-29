/**
 * copc-live.js — live **COPC → OGC 3D Tiles** middleware (true online range-streaming).
 *
 * The original "TiTiler for 3D" endpoint, extracted from server.js so every streamed format is a
 * uniform `*-live.js` module (copc, potree, …) the `/stream` dispatcher can delegate to. Nothing is
 * pre-converted: range-read the COPC header + hierarchy to emit the tileset, then range-read just one
 * octree node's point block per tile request → glTF POINTS GLB. The COPC octree maps ~1:1 onto 3D Tiles.
 *
 *   GET /copc/tileset.json?url=<COPC_URL>          → 3D Tiles 1.1 tileset (explicit tree, ADD refine)
 *   GET /copc/tile/<D-X-Y-Z>.glb?url=<COPC_URL>    → that node's points as a POINTS GLB
 */
import { Copc } from 'copc';
import { rangeGetter } from './range-getter.js';
import { buildPointsGlb, keyToCoords, coordsToKey, buildSubtreeBuffer, georefFromCrs, curvedLocalizer, curvedTileLocalizer, buildImplicitTileset, memoizeAsync } from '../core/index.js';

const SUBTREE_LEVELS = 3;

// Read the LASF_Projection/2112 WKT VLR via a range read (copc exposes offset+length, not bytes).
async function readWkt(getter, copc) {
  const vlr = (copc.vlrs ?? []).find(v => v.userId === 'LASF_Projection' && v.recordId === 2112);
  if (!vlr || !vlr.contentOffset || !vlr.contentLength) return null;
  const buf = await getter(vlr.contentOffset, vlr.contentOffset + vlr.contentLength);
  let raw = Buffer.from(buf).toString('utf8').replace(/\0/g, '').trim();
  if (raw.startsWith('COMPD_CS[')) {                       // strip vertical CRS; proj4 wants the 2D part
    const inner = raw.slice(raw.indexOf(',') + 1).trim();
    let depth = 0, end = 0;
    for (let i = 0; i < inner.length; i++) { if (inner[i]==='[') depth++; else if (inner[i]===']' && --depth===0) { end = i+1; break; } }
    if (end > 0) raw = inner.slice(0, end);
  }
  return raw || null;
}

// Per-URL context (COPC header + full node hierarchy + georef), cached.
// memoizeAsync caches FAILURES too — a broken source (bad LAS header, unreachable URL, ...) fails
// fast on retry instead of redoing the range-read pass every time (see cache.js's own comment) — but
// only for a minute: the first read is a network round-trip, and one S3 "socket hang up" there used
// to mark the dataset broken until the process was restarted.
const getCtx = memoizeAsync(async (url) => {
  // Our own range getter (range-getter.js), not the library's `Getter.http`: coalesced reads, a
  // per-host in-flight cap, retries on hang-ups, and a thrown error on non-2xx instead of parsing
  // the error body as hierarchy or points.
  const rawGetter = rangeGetter(url);
  // Cold-load latency fix: this used to do a SEPARATE 4-byte range request just to check the "LASF"
  // magic before handing off to Copc.create(), which then issues its OWN first range read (the LAS
  // header + VLR block, ~64KB) — two round-trips where one suffices. Fetch that head block ourselves,
  // check the magic from it directly, and wrap the getter so Copc.create()'s own header/VLR reads (which
  // fall well within this same range) are served from memory instead of hitting the network again.
  const HEAD_BYTES = 65536;
  const head = Buffer.from(await rawGetter(0, HEAD_BYTES));
  const magic = head.toString('latin1', 0, 4);
  if (magic !== 'LASF') throw new Error(`not a LAS/COPC file (got "${magic}" not "LASF") — is this the right URL for /copc?`);
  const getter = async (begin, end) => (end <= head.length ? head.subarray(begin, end) : rawGetter(begin, end));
  const copc = await Copc.create(getter);
  const nodeMap = new Map();
  const pendingPages = new Map();    // key → pageRef (known but not yet loaded)
  const inFlight = new Map();        // key → { ref, promise } (being loaded right now)

  // Load ONE hierarchy page: fold its nodes into nodeMap, its sub-pages into pendingPages.
  const loadOnePage = async (ref) => {
    const { nodes: pn, pages: pp } = await Copc.loadHierarchyPage(getter, ref);
    for (const k of Object.keys(pn)) nodeMap.set(k, pn[k]);
    for (const k of Object.keys(pp)) if (pp[k] && !nodeMap.has(k)) pendingPages.set(k, pp[k]);
  };
  // Load a PENDING page once: concurrent subtree requests share the in-flight promise (a request
  // that found the page neither pending nor loaded would otherwise answer with an empty block), and
  // a failed read puts the page back in `pendingPages` so the next request retries it — the old
  // `pendingPages.delete(k); await loadOnePage(ref)` dropped a page whose range read hung up, and
  // every subtree under it came back empty for the life of the process, with no error anywhere.
  const loadPage = (k, ref) => {
    if (inFlight.has(k)) return inFlight.get(k).promise;
    pendingPages.delete(k);
    const promise = loadOnePage(ref)
      .catch(e => { if (process.env.RANGE_DEBUG) console.log(`[copc-live] page ${k} failed, restored`); if (!nodeMap.has(k)) pendingPages.set(k, ref); throw e; })
      .finally(() => inFlight.delete(k));
    inFlight.set(k, { ref, promise });
    return promise;
  };
  const candidates = () => [...pendingPages, ...[...inFlight].map(([k, v]) => [k, v.ref])];
  // Eagerly load only the root page (fast — small, contains the top levels).
  await loadOnePage(copc.info.rootHierarchyPage);

  const cube = copc.info.cube;
  const origin = [(cube[0]+cube[3])/2, (cube[1]+cube[4])/2, (cube[2]+cube[5])/2];
  let transform = null, crs = null;
  try {
    const wkt = await readWkt(getter, copc);
    if (wkt) { transform = georefFromCrs(origin, wkt, 'copc-live'); crs = wkt; }
    else console.warn(`[copc-live] no WKT CRS in ${url} — local-origin (not geo-referenced)`);
  } catch (e) { console.warn('[copc-live] georef failed:', e.message); }
  const rootDiag = Math.hypot(cube[3]-cube[0], cube[4]-cube[1], cube[5]-cube[2]);
  const curvedCache = new Map();                   // crs → curved placement (see curvedFor)

  // For subtree (L,x,y,z): load pending pages whose cells overlap the [L, L+SUBTREE_LEVELS] block.
  const ensureForSubtree = async (L, x, y, z) => {
    const maxLvl = L + SUBTREE_LEVELS;
    const cells = 2 ** L;
    const span = [(cube[3]-cube[0])/cells, (cube[4]-cube[1])/cells, (cube[5]-cube[2])/cells];
    const tMin = [cube[0]+x*span[0], cube[1]+y*span[1], cube[2]+z*span[2]];
    const tMax = [tMin[0]+span[0], tMin[1]+span[1], tMin[2]+span[2]];
    let changed = true;
    while (changed) {
      changed = false;
      const toLoad = [];
      for (const [pageKey, pageRef] of candidates()) {
        const { level: pl, x: px, y: py, z: pz } = keyToCoords(pageKey);
        if (pl > maxLvl) continue;
        const pCells = 2 ** pl;
        const pSp = [(cube[3]-cube[0])/pCells, (cube[4]-cube[1])/pCells, (cube[5]-cube[2])/pCells];
        const pMin = [cube[0]+px*pSp[0], cube[1]+py*pSp[1], cube[2]+pz*pSp[2]];
        const pMax = [pMin[0]+pSp[0], pMin[1]+pSp[1], pMin[2]+pSp[2]];
        if ([0,1,2].every(k => pMin[k] < tMax[k] && pMax[k] > tMin[k])) toLoad.push([pageKey, pageRef]);
      }
      if (toLoad.length) {
        changed = true;
        await Promise.all(toLoad.map(([k, ref]) => loadPage(k, ref)));
      }
    }
  };

  // cache=hierarchy: drain ALL pending pages into the shared ctx (whole index in RAM, warm forever).
  // Mutates the single cached ctx (like Potree's drainAll2) so later subtree requests reuse it.
  // Shared promise so concurrent callers wait for the same drain; a failed drain resets it (the
  // unread pages are back in `pendingPages`) so the next request finishes the job.
  let draining = null;
  const drainAll = () => {
    if (!draining) draining = (async () => {
      while (pendingPages.size || inFlight.size) await Promise.all(candidates().map(([k, ref]) => loadPage(k, ref)));
    })().catch(e => { draining = null; throw e; });
    return draining;
  };

  let warmed = false;   // guard so background prefetch fires at most once per ctx
  console.log(`[copc-live] ${url} → root page loaded (${nodeMap.size} nodes), pending=${pendingPages.size} child pages, georef=${!!transform}`);
  return { getter, copc, nodeMap, origin, transform, crs, rootDiag, cube, curvedCache, ensureForSubtree, drainAll,
                get warmed() { return warmed; }, set warmed(v) { warmed = v; } };
}, { failureTtlMs: 60_000 });

// ── curved placement for country-scale sources ───────────────────────────────────────────────────
//
// Tile content is "source coordinates minus origin", placed by ONE root transform: the tangent
// trihedron at the origin. Correct to centimetres for a site, wrong by kilometres for a national
// LiDAR overview: the tangent plane leaves the ellipsoid as d²/2R (20 km at 500 km — Corsica, from
// the centre of a France-wide cube), and the projection's scale distortion shifts points sideways.
// Past this extent each point is placed on the ellipsoid (core's curvedLocalizer: proj4 → ECEF →
// root frame, sampled per tile on a grid and interpolated, curvedTileLocalizer), and the tree is
// EXPLICIT: implicit tiling subdivides the root box, which the curved content no longer fits, so
// each tile gets its own box measured on the placed corners instead. `&curved=on|off` overrides
// the extent rule (a tile URL carries it too, so tiles and tileset agree).
const CURVED_MIN_DIAG = 20000;                     // 20 km: the plane is 8 m off at the edge
const EARTH_R = 6378137;

/** The curved placement of a context for a CRS (the file's own, or the &crs= override), or null. */
function curvedFor(ctx, crsOverride, mode = null) {
  const crs = ctx.crs ?? crsOverride ?? null;
  if (!crs || mode === 'off' || (mode !== 'on' && ctx.rootDiag < CURVED_MIN_DIAG)) return null;
  if (ctx.curvedCache.has(crs)) return ctx.curvedCache.get(crs);
  const transform = ctx.transform ?? georefFromCrs(ctx.origin, crs, 'copc-live');
  const toLocal = transform && curvedLocalizer(ctx.origin, crs, transform, 'copc-live');
  const curved = toLocal ? { transform, toLocal } : null;
  ctx.curvedCache.set(crs, curved);
  if (curved) console.log(`[copc-live] curved placement on (${Math.round(ctx.rootDiag / 1000)} km extent)`);
  return curved;
}

/**
 * A tile box fitted to a sub-cube's PLACED corners, plus the sag between samples. Tiles wider than
 * 20 km (where the tangent plane is metres off) sample a 5×5 grid of the top and bottom faces; smaller
 * ones only their 8 corners — the surface between corners of a 20 km tile dips 8 m below the chord,
 * which the `sag` term already adds, and the projection is linear enough over that span. This is the
 * whole cost of a curved tileset (one proj4 round-trip per sample over 15–25 k tiles): 50 samples per
 * tile took ~1 s per national overview locally and ~8 s on prod, and the `flai` mosaic builds 113 of
 * them back to back on the event loop.
 */
const CURVED_FINE_GRID = 20000;
function curvedBox(sc, toLocal) {
  const p = new Float64Array(3);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const N = Math.max(sc[3]-sc[0], sc[4]-sc[1]) > CURVED_FINE_GRID ? 4 : 1;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) for (const z of [sc[2], sc[5]]) {
    toLocal(sc[0] + (sc[3]-sc[0]) * i / N, sc[1] + (sc[4]-sc[1]) * j / N, z, p);
    for (let k = 0; k < 3; k++) { if (p[k] < min[k]) min[k] = p[k]; if (p[k] > max[k]) max[k] = p[k]; }
  }
  const step = Math.max(sc[3]-sc[0], sc[4]-sc[1]) / N;
  const sag = (step / 2) ** 2 / (2 * EARTH_R) + 1;  // the surface between two samples dips below their chord
  min[2] -= sag; max[2] += sag;
  const c = [0,1,2].map((k) => (min[k] + max[k]) / 2), h = [0,1,2].map((k) => Math.max((max[k] - min[k]) / 2, 0.01));
  return [c[0],c[1],c[2], h[0],0,0, 0,h[1],0, 0,0,h[2]];
}

const subCube = (cube, level, x, y, z) => {
  const n = 2**level, dx = (cube[3]-cube[0])/n, dy = (cube[4]-cube[1])/n, dz = (cube[5]-cube[2])/n;
  return [cube[0]+x*dx, cube[1]+y*dy, cube[2]+z*dz, cube[0]+(x+1)*dx, cube[1]+(y+1)*dy, cube[2]+(z+1)*dz];
};

// Explicit 3D Tiles tree from the COPC hierarchy. Boxes = octree sub-cube relative to the origin
// (or, with a curved placement, fitted to the placed sub-cube).
function buildTilesetExplicit(ctx, urlParam, curved = null, maxDepth = Infinity) {
  const { nodeMap, origin, rootDiag, cube } = ctx;
  const transform = curved?.transform ?? ctx.transform;
  const enc = encodeURIComponent(urlParam);
  const tileFor = (key) => {
    const { level, x, y, z } = keyToCoords(key);
    const sc = subCube(cube, level, x, y, z);
    const c = [(sc[0]+sc[3])/2-origin[0], (sc[1]+sc[4])/2-origin[1], (sc[2]+sc[5])/2-origin[2]];
    const h = [Math.max((sc[3]-sc[0])/2,0.01), Math.max((sc[4]-sc[1])/2,0.01), Math.max((sc[5]-sc[2])/2,0.01)];
    const node = nodeMap.get(key);
    const box = curved ? curvedBox(sc, curved.toLocal) : [c[0],c[1],c[2], h[0],0,0, 0,h[1],0, 0,0,h[2]];
    const tile = { boundingVolume: { box }, geometricError: rootDiag / (2**level), refine: 'ADD' };
    if (node && node.pointCount > 0) tile.content = { uri: `tile/${key}.glb?url=${enc}` };
    const kids = [];
    if (level < maxDepth) for (let i = 0; i < 8; i++) {
      const ck = `${level+1}-${2*x+(i&1)}-${2*y+((i>>1)&1)}-${2*z+((i>>2)&1)}`;
      if (nodeMap.has(ck)) kids.push(tileFor(ck));
    }
    if (kids.length) tile.children = kids;
    return tile;
  };
  const root = tileFor('0-0-0-0');
  if (transform) root.transform = transform;
  return { asset: { version: '1.1' }, geometricError: rootDiag, root, extensionsUsed: ['3DTILES_content_gltf'] };
}

// Implicit octree: one root with implicitTiling + content/subtree templates (subtrees built on the fly).
function buildTilesetImplicit(ctx, urlParam) {
  const { transform, rootDiag, cube } = ctx;
  let maxLevel = 0;
  for (const key of ctx.nodeMap.keys()) { const l = keyToCoords(key).level; if (l > maxLevel) maxLevel = l; }
  if (maxLevel < 8) maxLevel = 8;   // generous floor: lazy root page may cover only a few levels
  const box = [0,0,0, (cube[3]-cube[0])/2,0,0, 0,(cube[4]-cube[1])/2,0, 0,0,(cube[5]-cube[2])/2];
  return buildImplicitTileset({ box, rootGeometricError: rootDiag, contentGeometricError: rootDiag,
    maxLevel, subtreeLevels: SUBTREE_LEVELS, transform, urlParam });
}

async function serveTileGlb(ctx, key, curved = null) {
  const node = ctx.nodeMap.get(key);
  if (!node || !node.pointCount) return null;
  const view = await Copc.loadPointDataView(ctx.getter, ctx.copc, node);
  const n = view.pointCount, [ox, oy, oz] = ctx.origin;
  const gx = view.getter('X'), gy = view.getter('Y'), gz = view.getter('Z');
  const pos = new Float32Array(n * 3);
  if (curved) {
    const { level, x, y, z } = keyToCoords(key);
    const place = curvedTileLocalizer(curved.toLocal, subCube(ctx.cube, level, x, y, z));
    for (let i = 0; i < n; i++) place(gx(i), gy(i), gz(i), pos, i*3);
  }
  else for (let i = 0; i < n; i++) { pos[i*3] = gx(i)-ox; pos[i*3+1] = gy(i)-oy; pos[i*3+2] = gz(i)-oz; }
  const d = view.dimensions; let colors = null;
  if (d.Red && d.Green && d.Blue) {
    const gr = view.getter('Red'), gg = view.getter('Green'), gb = view.getter('Blue'), s = d.Red.size === 2 ? 1/65535 : 1/255;
    colors = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { colors[i*4]=gr(i)*s; colors[i*4+1]=gg(i)*s; colors[i*4+2]=gb(i)*s; colors[i*4+3]=1; }
  } else if (d.Intensity) {
    // T5: no RGB — use Intensity as greyscale so the point cloud isn't a featureless white blob.
    const gi = view.getter('Intensity'), s = d.Intensity.size === 2 ? 1/65535 : 1/255;
    colors = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { const v = gi(i)*s; colors[i*4]=v; colors[i*4+1]=v; colors[i*4+2]=v; colors[i*4+3]=1; }
  }
  return Buffer.from(await buildPointsGlb(pos, colors, n));   // core applies the (E,U,−N) Y-up swizzle
}

// Pure builders the /stream dispatcher reuses. Tiles/subtrees are keyed "level-x-y-z" (explicit and
// implicit both use that token, so one tile route serves both modes).
export const copcTileRe = /^[0-9]+-[0-9]+-[0-9]+-[0-9]+$/;
export async function copcTileset(url, opts = {}) {
  const ctx = await getCtx(url);
  // depth=0 (the aggregate placing a child): the root tile alone, from the header and root page
  // already in ctx — no hierarchy drain, no background prefetch, no 15–25 k-tile tree. A curved root
  // box only needs the cube corners, so a 113-dataset mosaic costs 113 header reads, not 113 trees.
  if (opts.depth === 0) {
    const curved = curvedFor(ctx, opts.crs, opts.curved);
    const ts = curved || opts.tiling === 'explicit' ? buildTilesetExplicit(ctx, url, curved, 0) : buildTilesetImplicit(ctx, url);
    return withCrsOverride(ts, ctx, opts.crs, 'copc-live');
  }
  if (opts.hierarchy === 'eager') {
    await ctx.drainAll();                                   // cache=hierarchy: full index resident now
  } else if (!ctx.warmed) {                                 // cache=none: background prefetch (once)
    ctx.warmed = true;
    const pf = opts.prefetch ?? 1;                          // 0 = none · N = N levels · -1 = all
    // background: a failed prefetch is retried by the next subtree request, so only log it
    const bg = (e) => console.warn(`[copc-live] background prefetch failed for ${url.split('?')[0].slice(-80)}: ${e.message}`);
    if (pf === -1) ctx.drainAll().catch(bg);
    else if (pf > 0) (async () => { for (let L = 0; L < pf; L++) await ctx.ensureForSubtree(L, 0, 0, 0); })().catch(bg);
  }
  const curved = curvedFor(ctx, opts.crs, opts.curved);
  if (curved) {
    // per-tile boxes need the whole index, and the build is the expensive part (see curvedBox), so
    // the finished tree is kept on the curved entry: the aggregate reads it once for the root
    // bounds, then every client that opens the dataset gets the same object.
    await ctx.drainAll();
    curved.tileset ??= withCrsOverride(buildTilesetExplicit(ctx, url, curved), ctx, opts.crs, 'copc-live');
    return curved.tileset;
  }
  const ts = opts.tiling === 'explicit' ? buildTilesetExplicit(ctx, url, curved) : buildTilesetImplicit(ctx, url);
  return withCrsOverride(ts, ctx, opts.crs, 'copc-live');
}

/**
 * &crs=EPSG:<n> for sources that carry no CRS of their own (every flai-ai open-lidar COPC). Only the
 * ROOT transform depends on the CRS — tile content is local to `ctx.origin` either way — so this is
 * applied per request, without touching the cached context. A CRS the file DOES declare wins.
 */
export function withCrsOverride(ts, ctx, crs, tag) {
  if (!crs || ctx.transform) return ts;
  const transform = georefFromCrs(ctx.origin, crs, tag);
  if (transform) ts.root.transform = transform;
  return ts;
}
export async function copcTile(url, key, opts = {}) {
  const ctx = await getCtx(url);
  return serveTileGlb(ctx, key, curvedFor(ctx, opts.crs, opts.curved));   // &crs= / &curved= ride on the tile URL (stream-live tags them)
}
export async function copcSubtree(url, key) {
  const ctx = await getCtx(url);
  if (ctx.ensureForSubtree) {
    const { level, x, y, z } = keyToCoords(key);
    await ctx.ensureForSubtree(level, x, y, z);
  }
  return buildSubtreeBuffer(key, ctx.nodeMap, SUBTREE_LEVELS);
}

// Direct /copc/* HTTP routes were removed 2026-07-02 — /stream/tileset.json?format=copc&url=<…> (+
// /stream/tile/…, /stream/subtrees/…) already cover every case these exposed. See CHANGELOG.
