/**
 * potree-live.js — live **Potree → OGC 3D Tiles** middleware (true online, build-on-the-fly).
 *
 * The same model as `/copc`, generalised to Potree's octree: NOTHING is pre-converted or fully
 * downloaded. The hierarchy is fetched to emit the 3D Tiles tree, then each tile request fetches just
 * that node's data, decodes it, and returns a glTF POINTS GLB. Handles BOTH:
 *   • Potree 2.0 (metadata.json + hierarchy.bin + octree.bin) — one HTTP **range** read of octree.bin
 *     per tile (true range-streaming).
 *   • Potree 1.x (cloud.js + .hrc + per-node .bin/.laz) — one whole-file fetch per node (the nodes
 *     ARE the files), via the shared loadPotree1 reader with an injected fetch source.
 *
 *   GET /potree/tileset.json?url=<metadata.json | cloud.js URL>
 *   GET /potree/tile/<name>.glb?url=<…>                       → that node's points as a POINTS GLB
 */
import { buildPointsGlb, coordsToKey, keyToCoords, buildSubtreeBuffer, georefFromCrs, buildImplicitTileset, parallelMap, defaultConcurrency, progressStart, progressTick, progressDone, memoizeAsync } from '../core/index.js';
import { preparePotree2Schema, parsePotree2Hierarchy, parsePotree2Chunk, decodePotree2Node } from '../potree-to-3dtiles/src/potree2.js';
import { loadPotree1 } from '../potree-to-3dtiles/src/potree1.js';
import { withCrsOverride } from './copc-live.js';

const SUBTREE_LEVELS = 3;
// Spatial octree (level,x,y,z) of a node from its box vs root box (exact ints — robust to Potree's
// octant-bit convention). Same derivation the offline converter uses for implicit tiling.
function coordsOfBox(box, rootBox, depth) {
  const cells = 2 ** depth;
  const idx = k => { const span = (rootBox.max[k] - rootBox.min[k]) / cells; return span > 0 ? Math.min(cells - 1, Math.max(0, Math.round((box.min[k] - rootBox.min[k]) / span))) : 0; };
  return { level: depth, x: idx(0), y: idx(1), z: idx(2) };
}

const georef = (origin, crs) => georefFromCrs(origin, crs, 'potree-live');

async function fetchFull(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
// One contiguous range read from octree.bin (the per-tile fetch — this is the streaming core).
async function rangeGet(url, begin, length) {
  const r = await fetch(url, { headers: { Range: `bytes=${begin}-${begin + length - 1}` } });
  if (r.status !== 206 && r.status !== 200) throw new Error(`range ${url} → ${r.status} (server must support HTTP 206)`);
  return Buffer.from(await r.arrayBuffer());
}
const finishCtx = (nodes, rootBox, crs, spacingMeta, readTile) => {
  const origin = [0,1,2].map(k => (rootBox.min[k] + rootBox.max[k]) / 2);
  const rootDiag = Math.hypot(rootBox.max[0]-rootBox.min[0], rootBox.max[1]-rootBox.min[1], rootBox.max[2]-rootBox.min[2]);
  // Spatial coord index for implicit tiling: coordKey "level-x-y-z" → node name; availability set.
  const byCoord = new Map(), avail = new Set();
  let maxLevel = 0;
  for (const [name, node] of nodes) {
    if (!(node.numPoints > 0)) continue;
    const { level, x, y, z } = coordsOfBox(node.box, rootBox, node.depth);
    const key = coordsToKey(level, x, y, z);
    byCoord.set(key, name); avail.add(key);
    if (level > maxLevel) maxLevel = level;
  }
  return { nodes, rootBox, origin, transform: georef(origin, crs), rootDiag, spacing: spacingMeta || rootDiag / 128, readTile, byCoord, avail, maxLevel };
};

// Azure-specific query inheritance: container/account SAS can authorize sibling blobs.
// Object-bound signatures (including Azure blob SAS and S3 presigned URLs) and other queries stay on metadata.
function createAzureSasSourceResolver(source) {
  const params = source.searchParams;
  const reusableAzureSas = Boolean(params.get('sv') && params.get('sig') &&
    (params.get('sr') === 'c' || (!params.has('sr') &&
      params.get('ss')?.includes('b') && params.get('srt')?.includes('o'))));
  return (rel) => {
    const child = new URL(rel, source);
    if (reusableAzureSas && child.origin === source.origin && !child.search) child.search = source.search;
    return child.href;
  };
}

// Per-URL context (hierarchy + georef + a readTile(name) closure), cached. 2.0 → range reads of
// octree.bin; 1.x → whole-file fetch per node through loadPotree1's injectable reader.
// memoizeAsync caches FAILURES too — a broken source fails fast on retry instead of redoing the
// full metadata/hierarchy read every time (see cache.js's own comment) — for a minute, so a
// transient network error on the first read does not pin the source as broken.
const getCtx = memoizeAsync(async (url) => {
  const source = new URL(url);
  const resolveSource = createAzureSasSourceResolver(source);
  let ctx;

  if (/cloud\.js(\?|$)/i.test(url)) {                       // ── Potree 1.x ──
    // lazy: skip the eager full-.hrc walk; we load one .hrc chunk per request (see buildLazyFragment).
    const src = await loadPotree1('', {
      read: rel => fetchFull(rel === 'cloud.js' ? source.href : resolveSource(rel)), lazy: true,
    });
    if (src.loadChunk) {
      // .hrc layout → LAZY hierarchy. Default output is IMPLICIT tiling: the tileset is one tiny root
      // with an implicitTiling block; each `.subtree` is generated on demand by loading ONLY the .hrc
      // chunk(s) covering that subtree's node block (no full-tree walk). `explicit` mode (opt-in) emits
      // external-tileset fragments per chunk instead. Geometry is per-node on demand either way.
      const origin = [0,1,2].map(k => (src.rootBox.min[k] + src.rootBox.max[k]) / 2);
      const rootDiag = Math.hypot(src.rootBox.max[0]-src.rootBox.min[0], src.rootBox.max[1]-src.rootBox.min[1], src.rootBox.max[2]-src.rootBox.min[2]);
      const availSet = new Set(), loadedChunks = new Set(), processed = new Set();
      const stepSize = src.stepSize;

      // coord (level-x-y-z) → Potree node name, by forward box-containment from the root using the
      // authoritative octant subdivision (src.boxOf) — no hand-coded octant convention.
      const nameForCoord = (L, x, y, z) => {
        const cells = 2 ** L;
        const center = [0,1,2].map(k => src.rootBox.min[k] + (([x,y,z][k]) + 0.5) * (src.rootBox.max[k]-src.rootBox.min[k]) / cells);
        const inBox = (b) => center.every((v,k) => v >= b.min[k] && v <= b.max[k]);
        let name = 'r';
        for (let d = 0; d < L; d++) { let f = -1; for (let o = 0; o < 8; o++) if (inBox(src.boxOf(name + o))) { f = o; break; } if (f < 0) break; name += f; }
        return name;
      };
      const chunkRootOf = (nm) => nm.slice(0, 1 + Math.floor((nm.length - 1) / stepSize) * stepSize);
      const indexLoadedNodes = () => {        // fold newly-loaded nodes into the availability set
        for (const [nm, node] of src.nodes) { if (processed.has(nm)) continue; processed.add(nm);
          if (node.numPoints > 0) { const c = coordsOfBox(node.box, src.rootBox, node.depth); availSet.add(coordsToKey(c.level, c.x, c.y, c.z)); } }
      };
      // Idempotent single-chunk load: concurrent subtree requests SHARE one in-flight fetch and only
      // mark `loadedChunks` AFTER the chunk's nodes land in src.nodes. (The old code marked loaded
      // *before* awaiting, so a concurrent request would skip the chunk and index empty availability →
      // implicit refinement stalled until something else warmed the cache.) Returns the chunk boundaries.
      // Boundaries are CACHED per chunk (chunkBoundaries): an already-loaded chunk must still hand its
      // boundary children back so a LATER, deeper walk can traverse THROUGH it. (Returning [] for
      // loaded chunks — the old behavior — killed the BFS at every re-visited chunk root: the root
      // subtree loads chunk 'r' with a shallow depth target, then the level-3 subtree's walk starts at
      // 'r', receives no boundaries, and never reaches the level-5 .hrc chunks → availability silently
      // truncated at level stepSize-1, i.e. "Geghard stops streaming past level 4".)
      const inFlight = new Map();          // chunkName → Promise<boundaries[]>
      const chunkBoundaries = new Map();   // chunkName → boundary[{name,box}] of the loaded chunk
      const loadOne = (cr) => {
        if (loadedChunks.has(cr)) return Promise.resolve(chunkBoundaries.get(cr) || []);
        if (inFlight.has(cr)) return inFlight.get(cr);
        const p = Promise.resolve(src.loadChunk(cr, src.boxOf(cr)))
          .then(b => { loadedChunks.add(cr); chunkBoundaries.set(cr, b || []); inFlight.delete(cr); progressTick(url); return b || []; })
          .catch(e => { inFlight.delete(cr); throw e; });
        inFlight.set(cr, p);
        return p;
      };
      // PARALLEL chunk-root BFS: load each band of .hrc chunks concurrently, enqueue qualifying
      // boundaries (next-band roots) per `accept`. One round-trip-batch per band, not per chunk.
      const loadChunkRoots = async (roots, accept) => {
        let frontier = [...new Set(roots)];
        while (frontier.length) {
          const boundaries = await parallelMap(frontier, loadOne, { concurrency: Math.min(defaultConcurrency(), 16) });
          const next = [];
          for (const boundary of boundaries) for (const b of boundary) if (!loadedChunks.has(b.name) && !inFlight.has(b.name) && accept(b.name)) next.push(b.name);
          frontier = [...new Set(next)];
        }
        indexLoadedNodes();
      };
      // Ensure every .hrc chunk intersecting a subtree block [L, L+subtreeLevels] under `rootName` is loaded.
      const ensureBlock = async (rootName, L, subtreeLevels) => {
        const targetMax = L + subtreeLevels;
        await loadChunkRoots([chunkRootOf(rootName)],
          (name) => (name.length - 1) <= targetMax && (name.startsWith(rootName) || rootName.startsWith(name)));
      };
      // cache=hierarchy: load the WHOLE .hrc tree (every chunk) — full availability resident.
      const drainAll = async () => { await loadChunkRoots([chunkRootOf('r')], () => true); };

      ctx = { lazy: true, src, origin, transform: georef(origin, src.crs), rootDiag,
              spacing: src.spacing || rootDiag / 128, rootBox: src.rootBox,
              maxLevel: 24,                       // generous cap; subtrees report 0 children at the real leaf level
              availSet, nameForCoord, ensureBlock, drainAll,
              readTile: name => src.readNode({ name, box: src.boxOf(name) }) };
      console.log(`[potree-live] (1.x lazy implicit) ${url} → .hrc chunked (stepSize=${stepSize}), georef=${!!ctx.transform}`);
    } else {
      // inline (1.4) layout → whole tiny hierarchy is in cloud.js already; build it eagerly.
      ctx = { ...finishCtx(src.nodes, src.rootBox, src.crs, src.spacing, name => src.readNode(src.nodes.get(name))), src };
      console.log(`[potree-live] (1.4 inline) ${url} → ${src.nodes.size} nodes, georef=${!!ctx.transform}`);
    }
  } else {                                                  // ── Potree 2.0 (lazy) ──
    const meta = JSON.parse((await fetchFull(url)).toString('utf8'));
    if ((meta.version || '').toString()[0] !== '2') console.warn(`[potree-live] ${url}: metadata.version=${meta.version} — expected 2.x`);
    const schema = preparePotree2Schema(meta);
    const rootBox = { min: meta.boundingBox.min.slice(), max: meta.boundingBox.max.slice() };
    const hierUrl = resolveSource('hierarchy.bin');
    const octreeUrl = resolveSource('octree.bin');
    const firstChunkSize = meta.hierarchy?.firstChunkSize;

    // Load only the first hierarchy chunk (range read, no full download).
    const firstBuf = await rangeGet(hierUrl, 0, firstChunkSize);
    const { nodes, proxies: pendingChunks2 } = parsePotree2Chunk(firstBuf, 'r', rootBox);
    const loadedChunks2 = new Set(['r']);

    // Live coord→name index (maintained as chunks load).
    const byCoord2 = new Map();
    const updateByCoord2 = (nodeMap) => {
      for (const [name, node] of nodeMap) {
        if (node.numPoints > 0) { const c = coordsOfBox(node.box, rootBox, node.depth); byCoord2.set(coordsToKey(c.level, c.x, c.y, c.z), name); }
      }
    };
    updateByCoord2(nodes);

    // Load one deferred proxy chunk, fold its nodes+proxies in. Idempotent + shares one in-flight fetch
    // across concurrent callers (mirrors the 1.x `loadOne` fix): the FIRST implicit-tiling load fires
    // many concurrent `.subtree` requests, and several can want the same still-pending chunk. Marking
    // `loadedChunks2`/removing from `pendingChunks2` BEFORE awaiting (the old code) let a second,
    // concurrent `ensureBlock2` see the chunk as "already loaded" and index availability from `nodes`
    // before the first caller's fetch had actually landed — its `.subtree` came back with that branch
    // empty, and 3d-tiles-renderer never retries a subtree it already resolved as empty. A later,
    // separately-triggered reload (e.g. switching to explicit and back) worked because by then the
    // chunk really was in `nodes` from the earlier attempt.
    const inFlightChunks2 = new Map();          // name → Promise<void>
    const loadChunk2 = (name) => {
      if (loadedChunks2.has(name)) return Promise.resolve();
      if (inFlightChunks2.has(name)) return inFlightChunks2.get(name);
      const p = pendingChunks2.get(name); if (!p) return Promise.resolve();
      const promise = rangeGet(hierUrl, p.byteOffset, p.byteSize).then(buf => {
        const { nodes: nn, proxies: pp } = parsePotree2Chunk(buf, name, p.box);
        for (const [k, v] of nn) nodes.set(k, v);
        for (const [k, v] of pp) if (!loadedChunks2.has(k)) pendingChunks2.set(k, v);
        updateByCoord2(nn);
        loadedChunks2.add(name);
        pendingChunks2.delete(name);
        inFlightChunks2.delete(name);
      }).catch(e => { inFlightChunks2.delete(name); throw e; });
      inFlightChunks2.set(name, promise);
      return promise;
    };

    // For a subtree at (L,x,y,z): load all pending proxy chunks overlapping the block [L, L+subtreeLevels].
    const ensureBlock2 = async (L, x, y, z) => {
      const maxLvl = L + SUBTREE_LEVELS;
      const cells = 2 ** L;
      const span = [0,1,2].map(k => (rootBox.max[k] - rootBox.min[k]) / cells);
      const tMin = [x,y,z].map((v,k) => rootBox.min[k] + v * span[k]);
      const tMax = tMin.map((v, k) => v + span[k]);
      const overlaps = (b) => [0,1,2].every(k => b.min[k] < tMax[k] && b.max[k] > tMin[k]);
      let changed = true;
      while (changed) {
        changed = false;
        const toLoad = [];
        for (const [nm, p] of pendingChunks2) {
          if (nm.length - 1 > maxLvl) continue;
          if (overlaps(p.box)) toLoad.push(nm);
        }
        if (toLoad.length) { changed = true; await Promise.all(toLoad.map(loadChunk2)); }
      }
    };

    // hierarchy=eager: drain every pending proxy chunk (whole hierarchy in RAM). Bounded concurrency
    // (mirrors the 1.x loadChunkRoots band fix above) — an unbounded Promise.all over every pending
    // chunk in one shot can fire hundreds/thousands of simultaneous range reads against the remote
    // source; a single connection reset/429 anywhere in that batch rejects the whole drain, which
    // surfaces as a broken/patchy octree once cache=hierarchy is requested (subtree requests then see
    // whatever partial `nodes` state existed at the moment of failure).
    const drainAll2 = async () => {
      while (pendingChunks2.size) {
        const batch = [...pendingChunks2.keys()];
        await parallelMap(batch, loadChunk2, { concurrency: Math.min(defaultConcurrency(), 16) });
      }
    };

    // Build avail from currently-loaded nodes (called fresh each subtree request).
    const buildAvail2 = () => {
      const avail = new Set();
      for (const [, node] of nodes) {
        if (node.numPoints > 0) { const c = coordsOfBox(node.box, rootBox, node.depth); avail.add(coordsToKey(c.level, c.x, c.y, c.z)); }
      }
      return avail;
    };

    const readTile = async name => {
      const n = nodes.get(name);
      if (!n || !n.byteSize) return null;
      return decodePotree2Node(meta, schema, n, await rangeGet(octreeUrl, n.byteOffset, n.byteSize));
    };

    const origin2 = [0,1,2].map(k => (rootBox.min[k] + rootBox.max[k]) / 2);
    const rootDiag2 = Math.hypot(rootBox.max[0]-rootBox.min[0], rootBox.max[1]-rootBox.min[1], rootBox.max[2]-rootBox.min[2]);
    ctx = { lazy2: true, nodes, pendingChunks2, ensureBlock2, drainAll2, buildAvail2, byCoord: byCoord2, schema, meta,
            rootBox, origin: origin2, transform: georef(origin2, meta.projection || meta.crs || meta.wkt || null),
            rootDiag: rootDiag2, spacing: meta.spacing || rootDiag2 / 128,
            maxLevel: 24,
            readTile };
    console.log(`[potree-live] (2.0 lazy) ${url} → first chunk loaded (${nodes.size} nodes), pending=${pendingChunks2.size} proxy chunks`);
  }
  return ctx;
}, { failureTtlMs: 60_000 });   // a transient network failure must not pin the source as broken (see cache.js)

// Explicit 3D Tiles tree from the Potree octree. Box = node AABB relative to the dataset origin
// (≈ ENU near the origin); geometric error = point spacing at that depth; ADD refine (children densify).
function buildTilesetExplicit(ctx, urlParam) {
  const { nodes, origin, transform, rootDiag, spacing } = ctx;
  const enc = encodeURIComponent(urlParam);
  const tileFor = (name) => {
    const node = nodes.get(name);
    const b = node.box;
    const c = [0,1,2].map(k => (b.min[k] + b.max[k]) / 2 - origin[k]);
    const h = [0,1,2].map(k => Math.max((b.max[k] - b.min[k]) / 2, 0.01));
    const tile = {
      boundingVolume: { box: [c[0],c[1],c[2], h[0],0,0, 0,h[1],0, 0,0,h[2]] },
      geometricError: spacing / (2 ** node.depth),
      refine: 'ADD',
    };
    if (node.numPoints > 0) tile.content = { uri: `tile/${name}.glb?url=${enc}` };
    const kids = [];
    for (let c2 = 0; c2 < 8; c2++) { const ck = name + c2; if (nodes.has(ck)) kids.push(tileFor(ck)); }
    if (kids.length) tile.children = kids;
    return tile;
  };
  const root = tileFor('r');
  if (transform) root.transform = transform;
  return { asset: { version: '1.1' }, geometricError: rootDiag, root, extensionsUsed: ['3DTILES_content_gltf'] };
}

// Implicit octree: root box = full extent (centred at origin → 0); content/subtree templates use the
// "level-x-y-z" coord token; subtrees are built on the fly from the availability set.
function buildTilesetImplicit(ctx, urlParam) {
  const { rootBox, origin, transform, rootDiag, spacing, maxLevel } = ctx;
  const h = [0,1,2].map(k => Math.max((rootBox.max[k] - rootBox.min[k]) / 2, 0.01));
  const c = [0,1,2].map(k => (rootBox.min[k] + rootBox.max[k]) / 2 - origin[k]);   // = 0
  const box = [c[0],c[1],c[2], h[0],0,0, 0,h[1],0, 0,0,h[2]];
  return buildImplicitTileset({ box, rootGeometricError: rootDiag, contentGeometricError: spacing,
    maxLevel, subtreeLevels: SUBTREE_LEVELS, transform, urlParam });
}

async function serveTileGlb(ctx, name) {
  // Eager ctx has a full node map to gate on; lazy ctx (1.x .hrc) has no map — rely on readTile
  // returning null for a missing/empty node.
  if (ctx.nodes) { const node = ctx.nodes.get(name); if (!node || !node.numPoints) return null; }
  const data = await ctx.readTile(name);                    // 2.0: range read+decode; 1.x: per-node fetch+decode
  if (!data || !data.count) return null;
  const { positions, colors, count } = data;
  const [ox, oy, oz] = ctx.origin;                          // world → tile-local (float32-safe)
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) { pos[i*3]=positions[i*3]-ox; pos[i*3+1]=positions[i*3+1]-oy; pos[i*3+2]=positions[i*3+2]-oz; }
  return Buffer.from(await buildPointsGlb(pos, colors, count));   // core applies the (E,U,−N) Y-up swizzle
}

// ── 1.x explicit tree (&tiling=explicit): drains every .hrc chunk up front, then builds one complete
// tree with plain relative-through-/stream tile URIs — no cross-endpoint fragment continuation. (An
// earlier version lazily fragmented this the same way the top-level 1.x LAZY tileset's own tree does,
// with chunk boundaries as external-tileset refs — dropped as unnecessary complexity: full
// materialization is fine size-wise since Potree is already well-chunked, and implicit tiling, the
// default, remains the path for genuinely huge datasets.)
async function buildTilesetExplicit1x(ctx, urlParam) {
  const { src, origin, transform, rootDiag, spacing } = ctx;
  const enc = encodeURIComponent(urlParam);
  await ctx.drainAll();
  const boxOfTile = (b) => {
    const c = [0,1,2].map(k => (b.min[k]+b.max[k])/2 - origin[k]);
    const h = [0,1,2].map(k => Math.max((b.max[k]-b.min[k])/2, 0.01));
    return [c[0],c[1],c[2], h[0],0,0, 0,h[1],0, 0,0,h[2]];
  };
  const geAt = (depth) => spacing / (2 ** depth);
  const tileFor = (name) => {
    const node = src.nodes.get(name);
    if (!node) return null;
    const tile = { boundingVolume: { box: boxOfTile(node.box) }, geometricError: geAt(node.depth), refine: 'ADD' };
    if (node.numPoints > 0) tile.content = { uri: `/stream/tile/${name}.glb?url=${enc}&format=potree` };
    const kids = [];
    for (let c = 0; c < 8; c++) {
      if (!((node.mask >> c) & 1)) continue;            // child doesn't exist
      const t = tileFor(name + c); if (t) kids.push(t); // drained → every child is resident
    }
    if (kids.length) tile.children = kids;
    return tile;
  };
  const root = tileFor('r') || { boundingVolume: { box: boxOfTile(src.boxOf('r')) }, geometricError: geAt(0), refine: 'ADD' };
  if (transform) root.transform = transform;
  return { asset: { version: '1.1' }, geometricError: rootDiag, root, extensionsUsed: ['3DTILES_content_gltf'] };
}

// Pure builders the /stream dispatcher reuses. Tile token is a Potree name (explicit, "r012") OR a
// "level-x-y-z" coord (implicit) — potreeTile resolves either.
export const potreeTileRe = /^([r0-7]+|\d+-\d+-\d+-\d+)$/;
// What a client needs to read this cloud ITSELF instead of through /stream (the aggregate's
// `&native=1` leaves, rendered by 3DTRjs's PotreePlugin): the source version and node encoding, so it
// can tell whether its own loader copes, and `origin` — the point in SOURCE coordinates that tile
// coordinates are relative to. Native-coords → ECEF is then `root.transform · translate(−origin)`,
// with any &crs= override and &lon=&lat= placement already folded into root.transform.
function nativeInfo(ctx) {
  const origin = ctx.origin.map((v) => +v.toFixed(4));
  if (ctx.meta) return { format: 'potree', version: String(ctx.meta.version ?? '2.0'), encoding: String(ctx.meta.encoding || 'DEFAULT').toUpperCase(), origin };
  const pa = ctx.src?.meta?.pointAttributes;
  // 1.x: a pointAttributes STRING ("LAS"/"LAZ") means each node is a LAS/LAZ file; a list means .bin
  return { format: 'potree', version: String(ctx.src?.version ?? '1.x'), encoding: typeof pa === 'string' ? pa.toUpperCase() : 'BINARY', origin };
}

export async function potreeTileset(url, opts = {}) {
  const ts = await potreeTilesetInner(url, opts);
  const ctx = await getCtx(url);
  ts.root.extras = { ...(ts.root.extras || {}), native: nativeInfo(ctx) };
  return ts;
}
async function potreeTilesetInner(url, opts) {
  const ctx = await getCtx(url);
  const eager = opts.hierarchy === 'eager';
  if (eager) progressStart(url, 'Potree hierarchy drain (cache=hierarchy)');   // reported via /progress?key=url
  if (eager && ctx.drainAll2) await ctx.drainAll2();        // Potree 2.0 eager hierarchy (all chunks)
  if (eager && ctx.drainAll)  await ctx.drainAll();         // Potree 1.x eager hierarchy (all .hrc)
  if (eager) progressDone(url);
  else if (!eager) {                                        // cache=none: background prefetch
    const pf = opts.prefetch ?? 1;                          // 0 = none · N = N levels · -1 = all
    const drain = ctx.drainAll2 || ctx.drainAll;
    if (pf === -1 && drain) drain().catch(e => console.warn(`[potree-live] background drain failed: ${e.message}`));
    else if (pf > 0) {
      // background: a failed prefetch is retried by the next subtree request, so only log it
      const bg = (e) => console.warn(`[potree-live] background prefetch failed for ${url.split('?')[0].slice(-80)}: ${e.message}`);
      if (ctx.ensureBlock2) (async () => { for (let L = 0; L < pf; L++) await ctx.ensureBlock2(L * SUBTREE_LEVELS, 0, 0, 0); })().catch(bg); // 2.0
      else if (ctx.ensureBlock) Promise.resolve().then(() => ctx.ensureBlock('r', 0, SUBTREE_LEVELS * pf)).catch(bg);                      // 1.x
    }
  }
  if (ctx.lazy)   // 1.x .hrc: implicit by default (lazy subtrees); explicit = full materialization (drains every chunk)
    return withCrsOverride(opts.tiling === 'explicit' ? buildTilesetExplicit1x(ctx, url) : buildTilesetImplicit(ctx, url), ctx, opts.crs, 'potree-live');
  return withCrsOverride(opts.tiling === 'explicit' ? buildTilesetExplicit(ctx, url) : buildTilesetImplicit(ctx, url), ctx, opts.crs, 'potree-live');
}
export async function potreeTile(url, token) {
  const ctx = await getCtx(url);
  // token is a Potree name ("r012", explicit) or a "level-x-y-z" coord (implicit). Lazy ctx resolves
  // coords by box-containment (nameForCoord); lazy2/eager ctx uses the byCoord map (populated as chunks load).
  const name = /^[r0-7]+$/.test(token) ? token
    : (ctx.lazy ? ctx.nameForCoord(...token.split('-').map(Number)) : ctx.byCoord?.get(token));
  return name ? serveTileGlb(ctx, name) : null;
}
export async function potreeSubtree(url, key) {
  const ctx = await getCtx(url);
  if (ctx.lazy) {                                // load only the .hrc chunk(s) this subtree block needs
    const { level, x, y, z } = keyToCoords(key);
    const rootName = ctx.nameForCoord(level, x, y, z);
    await ctx.ensureBlock(rootName, level, SUBTREE_LEVELS);
    if (process.env.POTREE_DEBUG) console.log(`[potree-dbg] subtree ${key} rootName=${rootName} availSet=${ctx.availSet.size} has(key)=${ctx.availSet.has(key)}`);
    return buildSubtreeBuffer(key, ctx.availSet, SUBTREE_LEVELS);
  }
  if (ctx.lazy2) {
    const { level, x, y, z } = keyToCoords(key);
    await ctx.ensureBlock2(level, x, y, z);
    return buildSubtreeBuffer(key, ctx.buildAvail2(), SUBTREE_LEVELS);
  }
  return buildSubtreeBuffer(key, ctx.avail, SUBTREE_LEVELS);
}

/** Try to handle a /potree/* request. Returns true iff it owned the response. */
// Direct /potree/* HTTP routes were removed 2026-07-02 — /stream/tileset.json?format=potree&url=<…>
// (and /stream/tile/…, /stream/subtrees/…) already cover every case these exposed; see CHANGELOG.
