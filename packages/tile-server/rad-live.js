/**
 * rad-live.js — live **RAD → OGC 3D Tiles** streaming middleware (on-the-fly serving).
 *
 * RAD persists no per-tile spatial bounds and no top-level spatial index, so building the tileset
 * inherently requires reading EVERY chunk once: the LoD-tree topology comes from each chunk's
 * `child_count`/`child_start` columns, and each node's AABB from its `center` column. We do that in a
 * single, parallel, **HTTP-range** pass (one combined decode per chunk via `chunkBoundsAndTopology`),
 * then serve each tile's full SPZ-v2 GLB on demand:
 *
 *   tileset.json  → range-fetch the header, then range-fetch every chunk IN PARALLEL, decoding only
 *                   center + child columns (no SPZ encode, no gzip). Build the explicit tree.
 *   tile/<i>.glb  → range-fetch that ONE chunk and full-decode + SPZ-v2 encode it.
 *
 * Range requests avoid ever buffering the whole (multi-GB) file and let chunks decode concurrently.
 * If the host doesn't support range (returns 200 for a ranged GET), we fall back to a single full
 * download + the same combined pass over real offsets. Only **monolithic** .rad is supported
 * (a streaming-manifest .rad stores chunk data in separate files — use those directly / `/convert`).
 *
 * No lazy/fragment mode (2026-07-02 simplification): RAD has no persisted spatial index to make a
 * cheap "just the first few levels" read meaningful — `chunkBoundsAndTopology` needs each chunk's full
 * bytes regardless of how many levels you ask for, so a lazy N-level fragment costs nearly the same
 * range traffic as the full eager pass while adding a whole continuation-route code path. Measured
 * against the 1.28 GB `coit.rad` sample: eager (all 1000s of chunks) ≈ 9.7 s, the old 4-level lazy
 * fragment ≈ 7.6 s — not enough of a win to justify the complexity, so `cache=none` and `cache=hierarchy`
 * now both eager-scan once (cached per URL) and serve the same explicit tree.
 *
 *   GET /stream/tileset.json?url=<.rad URL>&format=rad
 *   GET /stream/tile/<nodeIndex>.glb?url=<.rad URL>&format=rad
 */
import { chunkBoundsAndTopology, encodeChunkGlb } from '../rad-to-3dtiles/src/index.js';
import { buildTileset } from '../rad-to-3dtiles/src/tilesetBuilder.js';
import { parallelMap, defaultConcurrency, Source, memoizeAsync } from '../core/index.js';

const pad8 = (n) => Math.ceil(n / 8) * 8;
const HEADER_PROBE = 1 << 18;   // 256 KiB — enough for the RAD0 JSON header of large clouds

// Per-URL context: parsed header + node table with bounds/topology. Cached forever (.rad is immutable).
// Tiles are NOT cached (range-fetched + encoded fresh; the HTTP client caches via response headers).
// memoizeAsync caches FAILURES too — without that, a client retrying a broken RAD source (corrupt
// chunk, non-RAD file, streaming-manifest RAD, ...) re-launches the WHOLE expensive parallel
// range-fetch+decode pass — up to 16 concurrent range workers over a multi-GB file — on every single
// retry, only to fail at the same chunk again. That repeated-work pattern is what actually exhausted
// resources and took the middleware down, not any one request.
const getCtx = memoizeAsync(async (url) => {
  const src = new Source(url);

  // 1) Probe the header region with a ranged GET — also tells us file size + range support.
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
  const chunks = header.chunks || [];

  // Streaming manifest = chunk data not embedded (allChunkBytes exceeds the file's payload region).
  if (total != null && header.allChunkBytes > (total - payloadBase)) {
    throw new Error(`"${url}" is a streaming-manifest RAD (chunk data not embedded). /rad needs a monolithic .rad.`);
  }

  const readChunk = rangeSupported
    ? async (c) => src.range(payloadBase + c.offset, c.bytes)
    : async (c) => fileBuf.slice(payloadBase + c.offset, payloadBase + c.offset + c.bytes);

  // Single parallel pass: per chunk, get its bytes (range or slice) and decode center + topology.
  const t0 = Date.now();
  const nodes = new Array(chunks.length);
  await parallelMap(chunks, async (chunk, ci) => {
    const cbuf = await readChunk(chunk);
    // Per-chunk buffer → chunk lives at offset 0 (payloadBase 0). Full-file fallback → real offsets.
    const local = rangeSupported ? { offset: 0, bytes: chunk.bytes } : chunk;
    const base  = rangeSupported ? 0 : payloadBase;
    const { bounds, count, children } = chunkBoundsAndTopology(cbuf, local, base, chunkSize, ci, chunks.length);
    nodes[ci] = { nodeIndex: ci, chunkIndex: ci, children, bounds, splatCount: count };
  }, { concurrency: Math.min(defaultConcurrency(), 16) });

  console.log(`[rad-live] ${url} → ${nodes.length} chunks, ${(header.count/1e6).toFixed(2)}M splats, `
    + `${rangeSupported ? 'range' : 'full-download'} pass in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  return { url, header, payloadBase, chunkSize, rangeSupported, fileBuf, nodes, readChunk };
});

function makeTileset(ctx, urlParam, centroids = false) {
  const enc = encodeURIComponent(urlParam);
  const cq = centroids ? '&centroids=1' : '';
  const ts = buildTileset(ctx.nodes, { tileUriTemplate: `tile/{index}.glb?url=${enc}${cq}` });
  ts.extensionsUsed = ['3DTILES_content_gltf'];
  // centroids mode emits glTF POINTS tiles → do NOT advertise the gaussian-splatting extension.
  if (!centroids) ts.extensions = { '3DTILES_content_gltf': {
    extensionsUsed:     ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
    extensionsRequired: ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
  }};
  return ts;
}

async function serveTileGlb(ctx, nodeIndex, centroids = false) {
  const node = ctx.nodes[nodeIndex];
  if (!node) return null;
  const chunk = ctx.header.chunks[node.chunkIndex];
  const cbuf = await ctx.readChunk(chunk);
  const local = ctx.rangeSupported ? { offset: 0, bytes: chunk.bytes } : chunk;
  const base  = ctx.rangeSupported ? 0 : ctx.payloadBase;
  const { glb } = await encodeChunkGlb(cbuf, local, base, { centroidsOnly: centroids });
  return Buffer.from(glb);
}

// Pure builders for the /stream dispatcher.
export const radTileRe = /^\d+$/;
export async function radTileset(url, opts = {}) { return makeTileset(await getCtx(url), url, opts.centroids); }
export async function radTile(url, key, opts = {}) { return serveTileGlb(await getCtx(url), Number(key), opts.centroids); }

// Direct /rad/* HTTP routes were removed 2026-07-02 — /stream/tileset.json?format=rad&url=<…> (+
// /stream/tile/…) already cover tileset/tile serving. The lazy fragment continuation route
// (/stream/rad/subtree/<n>.json) was removed the same day — see the file header note above.
