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
 *   GET /rad/tileset.json?url=<.rad URL>
 *   GET /rad/tile/<nodeIndex>.glb?url=<.rad URL>
 */
import { chunkBoundsAndTopology, encodeChunkGlb } from '../rad-to-3dtiles/src/index.js';
import { buildTileset } from '../rad-to-3dtiles/src/tilesetBuilder.js';
import { parallelMap, defaultConcurrency } from '../core/index.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
const pad8 = (n) => Math.ceil(n / 8) * 8;
const HEADER_PROBE = 1 << 18;   // 256 KiB — enough for the RAD0 JSON header of large clouds

// One ranged GET. Returns { buf, status, total } where total is the file size (from Content-Range).
async function fetchRange(url, start, end) {
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (r.status !== 206 && r.status !== 200) throw new Error(`range ${start}-${end} of ${url} → ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  let total = null;
  const cr = r.headers.get('content-range');             // "bytes start-end/total"
  if (cr) { const m = cr.match(/\/(\d+)\s*$/); if (m) total = Number(m[1]); }
  else if (r.headers.get('content-length')) total = Number(r.headers.get('content-length'));
  return { buf, status: r.status, total };
}

// Per-URL context: parsed header + node table with bounds/topology. Cached forever (.rad is immutable).
// Tiles are NOT cached (range-fetched + encoded fresh; the HTTP client caches via response headers).
const ctxCache = new Map();
async function getCtx(url) {
  if (ctxCache.has(url)) return ctxCache.get(url);

  // 1) Probe the header region with a ranged GET — also tells us file size + range support.
  let { buf: headBuf, status, total } = await fetchRange(url, 0, HEADER_PROBE - 1);
  const rangeSupported = status === 206;
  let fileBuf = null;                                    // set only in the no-range fallback
  if (!rangeSupported) { fileBuf = headBuf; total = headBuf.length; }   // server ignored Range → whole file

  if (headBuf.toString('utf8', 0, 4) !== 'RAD0') throw new Error(`${url}: not a RAD0 file`);
  const jsonLen = headBuf.readUInt32LE(4);
  // Grow the probe if the JSON header is larger than our initial read (big chunk lists).
  if (8 + jsonLen > headBuf.length) {
    if (rangeSupported) headBuf = (await fetchRange(url, 0, 8 + jsonLen - 1)).buf;
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

  // 2) Single parallel pass: per chunk, get its bytes (range or slice) and decode center + topology.
  const t0 = Date.now();
  const readChunk = rangeSupported
    ? async (c) => (await fetchRange(url, payloadBase + c.offset, payloadBase + c.offset + c.bytes - 1)).buf
    : async (c) => fileBuf.slice(payloadBase + c.offset, payloadBase + c.offset + c.bytes);

  const nodes = new Array(chunks.length);
  await parallelMap(chunks, async (chunk, ci) => {
    const cbuf = await readChunk(chunk);
    // Per-chunk buffer → chunk lives at offset 0 (payloadBase 0). Full-file fallback → real offsets.
    const local = rangeSupported ? { offset: 0, bytes: chunk.bytes } : chunk;
    const base  = rangeSupported ? 0 : payloadBase;
    const { bounds, count, children } = chunkBoundsAndTopology(cbuf, local, base, chunkSize, ci, chunks.length);
    nodes[ci] = { nodeIndex: ci, chunkIndex: ci, children, bounds, splatCount: count };
  }, { concurrency: Math.min(defaultConcurrency(), 16) });

  const ctx = { url, header, payloadBase, chunkSize, rangeSupported, fileBuf, nodes, readChunk };
  ctxCache.set(url, ctx);
  console.log(`[rad-live] ${url} → ${nodes.length} chunks, ${(header.count/1e6).toFixed(2)}M splats, `
    + `${rangeSupported ? 'range' : 'full-download'} pass in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  return ctx;
}

function makeTileset(ctx, urlParam) {
  const enc = encodeURIComponent(urlParam);
  const ts = buildTileset(ctx.nodes, { tileUriTemplate: `tile/{index}.glb?url=${enc}` });
  ts.extensionsUsed = ['3DTILES_content_gltf'];
  ts.extensions = { '3DTILES_content_gltf': {
    extensionsUsed:     ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
    extensionsRequired: ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
  }};
  return ts;
}

async function serveTileGlb(ctx, nodeIndex) {
  const node = ctx.nodes[nodeIndex];
  if (!node) return null;
  const chunk = ctx.header.chunks[node.chunkIndex];
  const cbuf = await ctx.readChunk(chunk);
  const local = ctx.rangeSupported ? { offset: 0, bytes: chunk.bytes } : chunk;
  const base  = ctx.rangeSupported ? 0 : ctx.payloadBase;
  const { glb } = await encodeChunkGlb(cbuf, local, base);
  return Buffer.from(glb);
}

// Pure builders for the /stream dispatcher.
export const radTileRe = /^\d+$/;
export async function radTileset(url) { return makeTileset(await getCtx(url), url); }
export async function radTile(url, key) { return serveTileGlb(await getCtx(url), Number(key)); }

/** Try to handle a /rad/* request. Returns true iff it owned the response. */
export async function handleRad(req, res, u) {
  if (!u.pathname.startsWith('/rad/')) return false;
  const url = u.searchParams.get('url');
  if (!url) { res.writeHead(400, CORS); res.end('missing ?url=<.rad URL>'); return true; }

  try {
    if (u.pathname === '/rad/tileset.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(await radTileset(url)));
      return true;
    }
    const m = u.pathname.match(/^\/rad\/tile\/(\d+)\.glb$/);
    if (m) {
      const glb = await radTile(url, m[1]);
      if (!glb) { res.writeHead(404, CORS); res.end('no such node'); return true; }
      res.writeHead(200, { 'Content-Type': 'model/gltf-binary', ...CORS });
      res.end(glb);
      return true;
    }
    res.writeHead(404, CORS); res.end('not found');
  } catch (e) {
    console.error('[rad-live]', e.message);
    if (!res.headersSent) { res.writeHead(500, CORS); res.end(e.message); }
    else res.end();
  }
  return true;
}
