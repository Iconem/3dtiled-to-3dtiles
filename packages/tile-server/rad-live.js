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
import { parallelMap, defaultConcurrency, CORS, Source } from '../core/index.js';

const pad8 = (n) => Math.ceil(n / 8) * 8;
const HEADER_PROBE = 1 << 18;   // 256 KiB — enough for the RAD0 JSON header of large clouds

// Per-URL context: parsed header + node table with bounds/topology. Cached forever (.rad is immutable).
// Tiles are NOT cached (range-fetched + encoded fresh; the HTTP client caches via response headers).
const ctxCache = new Map();
async function getCtx(url, lazy = true) {
  const cacheKey = url + (lazy ? ':lazy' : ':eager');
  if (ctxCache.has(cacheKey)) return ctxCache.get(cacheKey);
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

  if (lazy) {
    // Lazy: don't fetch any chunk data yet. Load chunk bounds/topology on demand.
    const nodeCache = new Map();   // chunkIdx → { nodeIndex, chunkIndex, children, bounds, splatCount }
    const loadChunkNode = async (ci) => {
      if (nodeCache.has(ci)) return nodeCache.get(ci);
      const chunk = chunks[ci];
      const cbuf = await readChunk(chunk);
      const local = rangeSupported ? { offset: 0, bytes: chunk.bytes } : chunk;
      const base2 = rangeSupported ? 0 : payloadBase;
      const { bounds, count, children } = chunkBoundsAndTopology(cbuf, local, base2, chunkSize, ci, chunks.length);
      const node = { nodeIndex: ci, chunkIndex: ci, children, bounds, splatCount: count };
      nodeCache.set(ci, node);
      return node;
    };
    const ctx = { url, lazy: true, header, payloadBase, chunkSize, rangeSupported, fileBuf, readChunk, chunks, nodeCache, loadChunkNode };
    ctxCache.set(cacheKey, ctx);
    console.log(`[rad-live] ${url} → ${chunks.length} chunks (lazy mode, header only), ${(header.count/1e6).toFixed(2)}M splats`);
    return ctx;
  }

  // Eager: 2) Single parallel pass: per chunk, get its bytes (range or slice) and decode center + topology.
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

  const ctx = { url, header, payloadBase, chunkSize, rangeSupported, fileBuf, nodes, readChunk };
  ctxCache.set(cacheKey, ctx);
  console.log(`[rad-live] ${url} → ${nodes.length} chunks, ${(header.count/1e6).toFixed(2)}M splats, `
    + `${rangeSupported ? 'range' : 'full-download'} pass in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  return ctx;
}

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
  const node = ctx.lazy ? await ctx.loadChunkNode(nodeIndex) : ctx.nodes[nodeIndex];
  if (!node) return null;
  const chunk = ctx.header.chunks[node.chunkIndex];
  const cbuf = await ctx.readChunk(chunk);
  const local = ctx.rangeSupported ? { offset: 0, bytes: chunk.bytes } : chunk;
  const base  = ctx.rangeSupported ? 0 : ctx.payloadBase;
  const { glb } = await encodeChunkGlb(cbuf, local, base, { centroidsOnly: centroids });
  return Buffer.from(glb);
}

const RAD_SUB_DEPTH = 4;                 // levels per lazy fragment (user: "4 next levels")
// RAD bounds are [cx,cy,cz,hx,hy,hz] in glTF Y-up; tileset boxes are Z-up (renderers RX(+90°)).
const radYUpBoxToZUp = (b) => [b[0], -b[2], b[1], Math.max(b[3],1e-4),0,0, 0,Math.max(b[5],1e-4),0, 0,0,Math.max(b[4],1e-4)];
// Spatial geometric error: 2× representative-splat spacing (matches tilesetBuilder.js 'spatial' basis).
const radGeOf = (node) => { const b = node.bounds; const diag = 2*Math.hypot(b[3],b[4],b[5]); const cnt = node.splatCount>0?node.splatCount:1; return 2*diag/Math.cbrt(cnt) || 1e-3; };
// Axis-aligned union of a Z-up box with child Z-up boxes (parent must ⊇ children for correct culling).
function radUnionBox(own, childBoxes) {
  const aabb = (x) => ({ min:[x[0]-Math.abs(x[3]),x[1]-Math.abs(x[7]),x[2]-Math.abs(x[11])], max:[x[0]+Math.abs(x[3]),x[1]+Math.abs(x[7]),x[2]+Math.abs(x[11])] });
  const { min, max } = aabb(own);
  for (const c of childBoxes) { const a = aabb(c); for (let k=0;k<3;k++){ if(a.min[k]<min[k])min[k]=a.min[k]; if(a.max[k]>max[k])max[k]=a.max[k]; } }
  const c=[0,1,2].map(k=>(min[k]+max[k])/2), h=[0,1,2].map(k=>Math.max((max[k]-min[k])/2,1e-3));
  return [c[0],c[1],c[2], h[0],0,0, 0,h[1],0, 0,0,h[2]];
}

// Build one lazy RAD fragment (RAD_SUB_DEPTH levels rooted at `rootChunkIdx`). Each fragment loads only
// its own chunks' topology; at the boundary (relative depth RAD_SUB_DEPTH) children become EXTERNAL
// tileset refs (/rad/subtree/<ci>.json) fetched only as the camera refines in — never a full-tree walk.
// The boundary child's geometry lives in ITS fragment's root, so the stub here carries no own content.
async function buildRadLazySubtree(ctx, rootChunkIdx, urlParam, isRoot, centroids = false) {
  const enc = encodeURIComponent(urlParam);
  const cq = centroids ? '&centroids=1' : '';   // ride along on tile + external-fragment refs

  // PARALLEL load of root + RAD_SUB_DEPTH descendant levels: fetch each BFS level's chunk topology
  // concurrently (massive multi-page clouds → ~depth round-trips instead of one-per-node). Build is
  // then synchronous (all nodes resident). loadChunkNode caches, so duplicate ids cost nothing.
  const loaded = new Set();
  let frontier = [rootChunkIdx];
  for (let d = 0; d <= RAD_SUB_DEPTH && frontier.length; d++) {
    frontier = frontier.filter(ci => !loaded.has(ci)); frontier.forEach(ci => loaded.add(ci));
    const nodes = await parallelMap(frontier, ci => ctx.loadChunkNode(ci), { concurrency: Math.min(defaultConcurrency(), 16) });
    const next = [];
    if (d < RAD_SUB_DEPTH) for (const n of nodes) if (n) for (const c of n.children) next.push(c);
    frontier = next;
  }

  const visited = new Set();               // guard RAD's rare DAG cross-edges (emit each node once)
  const buildNode = (ci, d, parentGE) => {
    const node = ctx.nodeCache.get(ci);
    if (!node || visited.has(ci)) return null;
    visited.add(ci);
    let ge = radGeOf(node);
    if (parentGE != null && ge >= parentGE) ge = parentGE * 0.5;   // strict decrease for REPLACE
    const box = radYUpBoxToZUp(node.bounds);
    if (d >= RAD_SUB_DEPTH)                 // boundary → external fragment (no own content here)
      return { boundingVolume: { box }, geometricError: ge, refine: 'REPLACE', content: { uri: `/rad/subtree/${ci}.json?url=${enc}${cq}` } };
    const tile = { boundingVolume: { box }, geometricError: ge, refine: 'REPLACE', content: { uri: `tile/${ci}.glb?url=${enc}${cq}` } };
    if (node.children.length) {
      const kids = node.children.map(c => buildNode(c, d + 1, ge)).filter(Boolean);
      if (kids.length) { tile.children = kids; tile.boundingVolume = { box: radUnionBox(box, kids.map(k => k.boundingVolume.box)) }; }
    }
    return tile;
  };

  const root = buildNode(rootChunkIdx, 0, null);
  if (!root) return null;
  root.geometricError = Math.max(root.geometricError, (root.children?.[0]?.geometricError ?? root.geometricError) * 2);
  // RX(180°) upright correction on the TRUE root only; external fragments inherit it via the ref chain.
  if (isRoot) root.transform = [1,0,0,0, 0,-1,0,0, 0,0,-1,0, 0,0,0,1];
  const ts = { asset: { version: '1.1' }, geometricError: root.geometricError, root, extensionsUsed: ['3DTILES_content_gltf'] };
  // centroids mode emits glTF POINTS tiles → do NOT advertise the gaussian-splatting extension.
  if (!centroids) ts.extensions = { '3DTILES_content_gltf': {
    extensionsUsed:     ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
    extensionsRequired: ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
  }};
  return ts;
}

// Pure builders for the /stream dispatcher.
export const radTileRe = /^\d+$/;
export async function radTileset(url, opts = {}) {
  // cache=hierarchy → eager full explicit tree (one parallel chunk pass); cache=none → lazy 4-level fragments.
  const ctx = await getCtx(url, opts.hierarchy !== 'eager');
  if (ctx.lazy) return buildRadLazySubtree(ctx, 0, url, true, opts.centroids);
  return makeTileset(ctx, url, opts.centroids);
}
export async function radSubtree(url, chunkIdx, opts = {}) {
  const ctx = await getCtx(url);
  if (!ctx.lazy) return null;
  return buildRadLazySubtree(ctx, chunkIdx, url, false, opts.centroids);
}
export async function radTile(url, key, opts = {}) { return serveTileGlb(await getCtx(url), Number(key), opts.centroids); }

/** Try to handle a /rad/* request. Returns true iff it owned the response. */
export async function handleRad(req, res, u) {
  if (!u.pathname.startsWith('/rad/')) return false;
  const url = u.searchParams.get('url');
  if (!url) { res.writeHead(400, CORS); res.end('missing ?url=<.rad URL>'); return true; }
  // centroids rides on the absolute /rad/ fragment + tile URIs the lazy builder emits (it bypasses /stream).
  const centroids = u.searchParams.get('centroids') === '1' || u.searchParams.get('centroids') === 'true';
  const hierarchy = u.searchParams.get('hierarchy');

  try {
    if (u.pathname === '/rad/tileset.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(await radTileset(url, { centroids, hierarchy })));
      return true;
    }
    const s = u.pathname.match(/^\/rad\/subtree\/(\d+)\.json$/);
    if (s) {
      const ts = await radSubtree(url, Number(s[1]), { centroids });
      if (!ts) { res.writeHead(404, CORS); res.end('not a lazy rad dataset'); return true; }
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(ts));
      return true;
    }
    const m = u.pathname.match(/^\/rad\/tile\/(\d+)\.glb$/);
    if (m) {
      const glb = await radTile(url, m[1], { centroids });
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
