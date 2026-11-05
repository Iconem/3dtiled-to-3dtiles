/**
 * rad-live.js — live **RAD → OGC 3D Tiles** streaming middleware (on-the-fly serving).
 *
 * RAD persists no per-tile spatial bounds and no top-level spatial index, so building the tileset
 * inherently requires reading each visited chunk once: the LoD-tree topology comes from each chunk's
 * `child_count`/`child_start` columns, and each node's AABB from its `center` column.
 *
 *   tileset.json (cache=hierarchy)  → range-fetch EVERY chunk's topology in one parallel pass (see
 *                   fetchChunkTopology), cached forever per URL, and materialize the FULL explicit
 *                   tree once. Pay once, get everything — the point of "hierarchy" cache mode.
 *   tileset.json (cache=none, default) → range-fetch topology for only the first RAD_LAZY_DEPTH
 *                   levels from the root (see scanBoundedTopology). Nodes at that frontier that still
 *                   have real children (per their own child_count) get a synthetic child tile whose
 *                   content is an EXTERNAL tileset.json continuing the same bounded scan rooted THERE
 *                   — the same "cut the tree every N levels" shape Potree's own HLOD output uses.
 *                   Served at /stream/rad/subtree/<chunkIndex>.json (see stream-live.js).
 *   tile/<i>.glb  → range-fetch that ONE chunk's full bytes and full-decode + SPZ-v2 encode it (every
 *                   property is needed here, so no selective fetch — see serveTileGlb).
 *
 * Range requests avoid ever buffering the whole (multi-GB) file and let chunks decode concurrently.
 * If the host doesn't support range (returns 200 for a ranged GET), we fall back to a single full
 * download + the same combined pass over real offsets — cache=none has no benefit there (the whole
 * file is already in memory), so the lazy path is only taken when rangeSupported.  Only **monolithic**
 * .rad is supported (a streaming-manifest .rad stores chunk data in separate files — use those
 * directly / `/convert`).
 *
 * History: a lazy/fragment mode existed once, was removed 2026-07-02 because — with the OLD
 * whole-chunk-per-node topology read — a lazy N-level fragment cost nearly the same range traffic as
 * the full eager pass (measured: eager ≈ 9.7s vs a 4-level lazy fragment ≈ 7.6s, not worth the
 * complexity). `fetchChunkTopology` below changes that calculus: topology properties are a MINORITY of
 * a chunk's bytes (measured on coit-40m-sh1-lod.rad: center 36.6% + child_count 1.5% + child_start
 * 5.3% = 43.3%, vs. 56.7% spent on alpha/rgb/scales/orientation/sh1 the topology pass never reads),
 * fetched by probing each chunk's own embedded meta JSON (lists every property's exact byte
 * offset/length — see radHeader.js's parseRadcChunkHeader) then range-fetching ONLY the 3 wanted
 * properties. That alone cut the FULL eager pass from a measured 109.5s to 40.6s cold over the real
 * hosting CDN (bandwidth-bound there, ~11 MB/s sustained regardless of concurrency). Reading only the
 * first few levels on top of THAT touches a handful of chunks instead of all ~778, making the lazy
 * mode worth reintroducing for cache=none's "fast first paint" use case.
 *
 *   GET /stream/tileset.json?url=<.rad URL>&format=rad[&cache=hierarchy]
 *   GET /stream/tile/<nodeIndex>.glb?url=<.rad URL>&format=rad
 *   GET /stream/rad/subtree/<chunkIndex>.json?url=<.rad URL>   (cache=none continuation)
 */
import { inflateRawSync } from 'node:zlib';
import { chunkBoundsAndTopology, topologyFromProps } from '../rad-to-3dtiles/src/index.js';
import { parseRadcChunkHeader } from '../rad-to-3dtiles/src/radHeader.js';
import { buildTileset } from '../rad-to-3dtiles/src/tilesetBuilder.js';
import { parallelMap, defaultConcurrency, Source, memoizeAsync, tilePool, runTileTaskOr, ownBytes } from '../core/index.js';
import { radChunkGlb } from './splat-tile.js';

const SPLAT_TASKS = new URL('./tile-tasks-splats.js', import.meta.url).href;   // what a tile worker runs (TILED_WORKERS)

const pad8 = (n) => Math.ceil(n / 8) * 8;
const HEADER_PROBE = 1 << 18;   // 256 KiB — enough for the RAD0 JSON header of large clouds
const CHUNK_HEADER_PROBE = 1 << 13;   // 8 KiB — comfortably covers a RADC chunk's own meta JSON
// How many LoD levels cache=none materializes inline before cutting to an external tileset.json —
// same idea as Potree's own HLOD depth cutoff. tilesetBuilder.js's "~1.5×/level" fanout is a WHOLE-TREE
// average, not a per-node bound: measured on coit-40m-sh1-lod.rad, the levels right below the root
// fan out much wider (a coarse node's representative splats can reference dozens of children at once —
// depths 0-4 there touch 1, 2, 13, 158, then 466 of the file's 778 total chunks). 3 keeps the bounded
// scan to a genuinely small fraction of the tree across files with that shape; scanBoundedTopology's
// own concurrency cap is the real backstop against a file that's bushier still.
const RAD_LAZY_DEPTH = 3;

// Range-fetch just the topology properties of one chunk instead of its full bytes (see file header).
// Falls back to a wider probe if 8 KiB doesn't cover an unusually large per-chunk meta JSON.
async function fetchChunkTopology(src, chunk, payloadBase, chunkSize, ci, totalChunks) {
  const chunkStart = payloadBase + chunk.offset;
  let probeLen = Math.min(CHUNK_HEADER_PROBE, chunk.bytes);
  let probe = await src.range(chunkStart, probeLen);
  let head = parseRadcChunkHeader(probe, 0);
  while (head.meta === null && probeLen < chunk.bytes) {
    probeLen = Math.min(head.need, chunk.bytes);
    probe = await src.range(chunkStart, probeLen);
    head = parseRadcChunkHeader(probe, 0);
  }
  const { meta, count, propDataStart } = head;
  const wanted = new Set(['center', 'child_count', 'child_start']);
  const props = new Map();
  await Promise.all((meta.properties ?? []).filter(p => wanted.has(p.property)).map(async (p) => {
    const absStart = chunkStart + propDataStart + p.offset;
    const compressed = await src.range(absStart, p.bytes);
    props.set(p.property, inflateRawSync(compressed));
  }));
  return topologyFromProps(count, props, chunkSize, ci, totalChunks);
}

// Per-URL context: parsed header + node table with bounds/topology. Cached forever (.rad is immutable).
// Tiles are NOT cached (range-fetched + encoded fresh; the HTTP client caches via response headers).
// memoizeAsync caches FAILURES too — without that, a client retrying a broken RAD source (corrupt
// chunk, non-RAD file, streaming-manifest RAD, ...) re-launches the WHOLE expensive parallel
// range-fetch+decode pass — up to 16 concurrent range workers over a multi-GB file — on every single
// retry, only to fail at the same chunk again. That repeated-work pattern is what actually exhausted
// resources and took the middleware down, not any one request.
// Cheap per-URL context: just the parsed root header (one small range probe). Shared by BOTH the
// eager full-scan path (cache=hierarchy) and the lazy bounded-scan path (cache=none) below — neither
// needs more than this to get started. memoizeAsync caches FAILURES too — see the full-scan comment
// below for why that matters (a broken source must fail fast on retry, not repeat expensive work).
const getHeaderCtx = memoizeAsync(async (url) => {
  const src = new Source(url);

  // Probe the header region with a ranged GET — also tells us file size + range support.
  let { buf: headBuf, rangeSupported, total } = await src.probe(HEADER_PROBE);
  let fileBuf = null;                                    // set only in the no-range fallback
  if (!rangeSupported) { fileBuf = headBuf; total = headBuf.length; }   // server ignored Range → whole file

  if (headBuf.toString('utf8', 0, 4) !== 'RAD0') throw new Error(`${url}: not a RAD0 file`);
  const jsonLen = headBuf.readUInt32LE(4);
  // Grow the probe if the JSON header is larger than our initial read (big chunk lists).
  if (8 + jsonLen > headBuf.length) {
    if (rangeSupported) headBuf = await src.range(0, 8 + jsonLen);
    else throw new Error(`${url}: header (${8 + jsonLen} B) exceeds downloaded body`);
  }
  const header = JSON.parse(headBuf.slice(8, 8 + jsonLen).toString('utf8'));
  const payloadBase = pad8(8 + jsonLen);
  const chunkSize = header.chunkSize ?? 65536;

  // Streaming manifest = chunk data not embedded (allChunkBytes exceeds the file's payload region).
  if (total != null && header.allChunkBytes > (total - payloadBase)) {
    throw new Error(`"${url}" is a streaming-manifest RAD (chunk data not embedded). /rad needs a monolithic .rad.`);
  }

  const readChunk = rangeSupported
    ? async (c) => src.range(payloadBase + c.offset, c.bytes)
    : async (c) => fileBuf.slice(payloadBase + c.offset, payloadBase + c.offset + c.bytes);

  return { url, src, header, payloadBase, chunkSize, rangeSupported, fileBuf, readChunk };
});

// Full eager topology scan over EVERY chunk (cache=hierarchy) — cached forever per URL (.rad is
// immutable). memoizeAsync caches FAILURES too — without that, a client retrying a broken RAD source
// (corrupt chunk, non-RAD file, streaming-manifest RAD, ...) re-launches the WHOLE expensive parallel
// range-fetch+decode pass — up to 16 concurrent range workers over a multi-GB file — on every single
// retry, only to fail at the same chunk again. That repeated-work pattern is what actually exhausted
// resources and took the middleware down, not any one request.
const getFullCtx = memoizeAsync(async (url) => {
  const hctx = await getHeaderCtx(url);
  const { src, header, payloadBase, chunkSize, rangeSupported, readChunk } = hctx;
  const chunks = header.chunks || [];

  const t0 = Date.now();
  const nodes = new Array(chunks.length);
  await parallelMap(chunks, async (chunk, ci) => {
    let bounds, count, children;
    if (rangeSupported) {
      ({ bounds, count, children } = await fetchChunkTopology(src, chunk, payloadBase, chunkSize, ci, chunks.length));
    } else {
      const cbuf = await readChunk(chunk);
      ({ bounds, count, children } = chunkBoundsAndTopology(cbuf, chunk, payloadBase, chunkSize, ci, chunks.length));
    }
    nodes[ci] = { nodeIndex: ci, chunkIndex: ci, children, bounds, splatCount: count };
  }, { concurrency: Math.min(defaultConcurrency(), 16) });

  console.log(`[rad-live] ${url} → ${nodes.length} chunks, ${(header.count/1e6).toFixed(2)}M splats, `
    + `${rangeSupported ? 'range' : 'full-download'} eager pass in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  return { ...hctx, nodes };
});

// Bounded topology scan (cache=none): BFS from `rootIndex`, fetching topology only for chunks up to
// `maxDepth` levels deep. A node AT that depth whose own child_count says it still has children is
// flagged `frontier: true` — tilesetBuilder.js grafts an external-tileset reference there instead of
// expanding further, keeping bytes fetched bounded regardless of the file's total chunk count. Levels
// are fetched breadth-first, capped at the same concurrency as the eager full scan — a coarse node's
// fanout can be dozens-wide (see RAD_LAZY_DEPTH's comment), so an uncapped Promise.all per level did
// exhaust the HTTP client's connection pool once real files were tested (`TypeError: fetch failed`
// after ~100+ simultaneous range requests). No-range hosts already hold the whole file in memory, so
// they just run the full scan once (memoized) and slice out of ctx.nodes instead — a bounded scan buys
// nothing when there's no per-request network cost to bound.
async function scanBoundedTopology(hctx, rootIndex, maxDepth) {
  const { src, header, payloadBase, chunkSize } = hctx;
  const chunks = header.chunks, totalChunks = chunks.length;
  const nodes = new Map();
  let level = [{ index: rootIndex, depth: 0 }];
  const seen = new Set([rootIndex]);
  while (level.length) {
    const results = new Array(level.length);
    await parallelMap(level, async ({ index, depth }, i) => {
      const { bounds, count, children } = await fetchChunkTopology(src, chunks[index], payloadBase, chunkSize, index, totalChunks);
      results[i] = { index, depth, bounds, count, children };
    }, { concurrency: Math.min(defaultConcurrency(), 16) });
    const next = [];
    for (const { index, depth, bounds, count, children } of results) {
      const atCutoff = depth >= maxDepth;
      const node = { nodeIndex: index, chunkIndex: index, bounds, splatCount: count, frontier: atCutoff && children.length > 0 };
      if (!atCutoff) {
        node.children = children;
        for (const c of children) if (!seen.has(c)) { seen.add(c); next.push({ index: c, depth: depth + 1 }); }
      }
      nodes.set(index, node);
    }
    level = next;
  }
  return [...nodes.values()];
}

const GAUSSIAN_EXT = {
  extensionsUsed:     ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
  extensionsRequired: ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
};

function makeTileset(ctx, urlParam, centroids = false) {
  const enc = encodeURIComponent(urlParam);
  const cq = centroids ? '&centroids=1' : '';
  const ts = buildTileset(ctx.nodes, { tileUriTemplate: `tile/{index}.glb?url=${enc}${cq}` });
  ts.extensionsUsed = ['3DTILES_content_gltf'];
  // centroids mode emits glTF POINTS tiles → do NOT advertise the gaussian-splatting extension.
  if (!centroids) ts.extensions = { '3DTILES_content_gltf': GAUSSIAN_EXT };
  return ts;
}

// Builds a tileset.json from a BOUNDED node set (scanBoundedTopology's output). `isRoot` gates the
// dataset-wide RX(180°) root transform (tilesetBuilder.js applies it unconditionally to whatever tile
// it treats as root) — only the TRUE tree root needs it; a nested subtree.json's own "root" is really
// an interior node that already inherits the real root's transform once the external reference
// resolves, so re-applying it there would double-flip the content.
function makeLazyTileset(nodes, urlParam, centroids, isRoot) {
  const enc = encodeURIComponent(urlParam);
  const cq = centroids ? '&centroids=1' : '';
  // ABSOLUTE /stream/... URIs (baking &format=rad in ourselves) — this tileset.json can be served
  // from EITHER /stream/tileset.json (isRoot) or /stream/rad/subtree/<n>.json (nested); a relative
  // "tile/…" would resolve against whichever of those two paths actually served it, which is wrong
  // for the nested case (same reasoning as threemx-live.js's own absolute-URI fragments).
  const ts = buildTileset(nodes, {
    tileUriTemplate: `/stream/tile/{index}.glb?url=${enc}&format=rad${cq}`,
    subtreeUriTemplate: `/stream/rad/subtree/{index}.json?url=${enc}${cq}`,
  });
  if (!isRoot) delete ts.root.transform;
  ts.extensionsUsed = ['3DTILES_content_gltf'];
  if (!centroids) ts.extensions = { '3DTILES_content_gltf': GAUSSIAN_EXT };
  return ts;
}

async function serveTileGlb(hctx, nodeIndex, centroids = false) {
  // chunkIndex === nodeIndex always in this adapter (see getFullCtx above) — no need for the full
  // node table just to serve one tile, so this works unchanged for both cache modes.
  const chunk = hctx.header.chunks[nodeIndex];
  if (!chunk) return null;
  const cbuf = await hctx.readChunk(chunk);
  const local = hctx.rangeSupported ? { offset: 0, bytes: chunk.bytes } : chunk;
  const base  = hctx.rangeSupported ? 0 : hctx.payloadBase;
  const here = async () => Buffer.from(await radChunkGlb(cbuf, local, base, centroids));
  const pool = tilePool();
  if (!pool) return here();
  // TILED_WORKERS: a worker inflates the chunk and encodes the GLB; a tile it had no memory for is built here instead.
  const bytes = ownBytes(cbuf);
  const glb = await runTileTaskOr(pool, SPLAT_TASKS, 'radTileTask', { cbuf: bytes, local, base, centroids }, [bytes.buffer], here);
  return Buffer.isBuffer(glb) ? glb : Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength);
}

// Pure builders for the /stream dispatcher.
export const radTileRe = /^\d+$/;

export async function radTileset(url, opts = {}) {
  if (opts.hierarchy === 'eager') return makeTileset(await getFullCtx(url), url, opts.centroids);
  const hctx = await getHeaderCtx(url);
  if (!hctx.rangeSupported) return makeTileset(await getFullCtx(url), url, opts.centroids); // see scanBoundedTopology comment
  const nodes = await scanBoundedTopology(hctx, 0, RAD_LAZY_DEPTH);
  return makeLazyTileset(nodes, url, opts.centroids, true);
}
export async function radTile(url, key, opts = {}) { return serveTileGlb(await getHeaderCtx(url), Number(key), opts.centroids); }

// cache=none's external-tileset continuation — see the file header + scanBoundedTopology comment.
// Namespaced under /stream/rad/subtree/… (not the generic /stream/subtrees/ route, which is the
// binary 3DTILES_implicit_tiling subtree format used by the octree adapters, a different shape).
export async function radSubtree(url, chunkIndexStr, opts = {}) {
  const hctx = await getHeaderCtx(url);
  const nodes = await scanBoundedTopology(hctx, Number(chunkIndexStr), RAD_LAZY_DEPTH);
  return makeLazyTileset(nodes, url, opts.centroids, false);
}
