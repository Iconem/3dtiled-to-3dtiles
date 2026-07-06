/**
 * sog-live.js — live **streamed-SOG → OGC 3D Tiles** middleware (true on-the-fly serving).
 *
 * streamed-SOG persists everything needed up front: `lod-meta.json` carries the full spatial tree
 * (per-node bounds) and, at each leaf, the per-LOD `{file, offset, count}` runs. So the tileset is
 * built from one fetch (no decode), and each tile fetches just that **chunk's WebP set** (the WebPs
 * are the leaf data), decodes it once (cached), extracts the `[offset,count)` run, and re-encodes a
 * KHR_gaussian_splatting SPZ-v2 GLB.
 *
 *   GET /sog/tileset.json?url=<lod-meta.json URL>
 *   GET /sog/tile/<file>_<offset>_<count>.glb?url=<lod-meta.json URL>   (run encoded in the name)
 */
import path from 'node:path';
import { readFile as readSplatFile, MemoryReadFileSystem } from '@playcanvas/splat-transform';
import { extractRange } from '../sog-to-3dtiles/src/sogChunk.js';
import { buildSplatTileGlb, computeBounds, memoizeAsync } from '../core/index.js';

// glTF Y-up → 3D Tiles Z-up box (RX +90°): centre (cx,cy,cz)→(cx,−cz,cy); half-extents y↔z.
function boundToZUpBox(min, max) {
  const cx=(min[0]+max[0])/2, cy=(min[1]+max[1])/2, cz=(min[2]+max[2])/2;
  const hx=Math.max((max[0]-min[0])/2,1e-4), hy=Math.max((max[1]-min[1])/2,1e-4), hz=Math.max((max[2]-min[2])/2,1e-4);
  return [cx, -cz, cy, hx,0,0, 0,hz,0, 0,0,hy];
}
const boundDiagonal = (min, max) => Math.hypot(max[0]-min[0], max[1]-min[1], max[2]-min[2]) || 1e-3;
const ROOT_GE_FACTOR = 0.05, DEPTH_RATIO = 0.5;

async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Per-URL context (just the lod-meta + a small decoded-chunk LRU), cached. memoizeAsync caches
// FAILURES too — a broken source fails fast on retry (see cache.js's own comment).
const getCtx = memoizeAsync(async (url) => {
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  const lod = JSON.parse((await fetchBuf(url)).toString('utf8'));
  if (lod.version != null && lod.version > 1) throw new Error(`Unsupported streamed-SOG version ${lod.version} (v1 only)`);
  console.log(`[sog-live] ${url} → ${lod.filenames.length} chunks`);
  return { base, lod, chunks: new Map() };           // chunks: fileIdx → decoded DataTable (LRU)
});

// Decode one chunk SOG (meta.json + WebPs) fetched into an in-memory FS — mirrors sogChunk.decodeChunk
// but over HTTP. Cached per ctx as an in-flight PROMISE (not just the resolved table): a chunk backs
// many leaf tiles at different offsets (Roman Parish: 5548 leaves share just 131 files), so a burst of
// concurrent /stream/tile requests routinely lands several requests for the SAME fileIdx before the
// first decode finishes — caching only post-decode let each one kick off its own ~1s WebP-decode
// independently, multiplying real CPU-bound work. Caching the promise means every concurrent caller
// awaits the one decode already underway.
async function getChunkTable(ctx, fileIdx) {
  if (ctx.chunks.has(fileIdx)) { const p = ctx.chunks.get(fileIdx); ctx.chunks.delete(fileIdx); ctx.chunks.set(fileIdx, p); return p; }
  const promise = (async () => {
    const rel = ctx.lod.filenames[fileIdx];                 // e.g. "1_0/meta.json"
    const chunkDir = path.posix.dirname(rel);
    const metaBuf = await fetchBuf(ctx.base + rel);
    const meta = JSON.parse(metaBuf.toString('utf8'));
    const fileSystem = new MemoryReadFileSystem();
    const put = (name, bytes) => { fileSystem.set(name, bytes); fileSystem.set('./' + name, bytes); };
    put('meta.json', new Uint8Array(metaBuf));
    const names = new Set();
    for (const k of Object.keys(meta)) { const f = meta[k]?.files; if (Array.isArray(f)) for (const n of f) names.add(n); }
    await Promise.all([...names].map(async n => put(n, new Uint8Array(await fetchBuf(ctx.base + path.posix.join(chunkDir, n))))));
    const tables = await readSplatFile({ filename: 'meta.json', inputFormat: 'sog', options: {}, params: [], fileSystem });
    return tables[0];
  })();
  promise.catch(() => ctx.chunks.delete(fileIdx));   // don't poison the cache with a failed decode
  ctx.chunks.set(fileIdx, promise);
  if (ctx.chunks.size > 24) ctx.chunks.delete(ctx.chunks.keys().next().value);   // evict oldest
  return promise;
}

// Build the 3D Tiles tree from lod.tree (bounds persisted → no decode). Each leaf LOD run becomes a
// REPLACE-chain tile whose content URI encodes the run: tile/<file>_<offset>_<count>.glb.
function buildTileset(ctx, urlParam, centroids = false) {
  const enc = encodeURIComponent(urlParam);
  const rootDiag = boundDiagonal(ctx.lod.tree.bound.min, ctx.lod.tree.bound.max);
  const ROOT_GE = rootDiag * ROOT_GE_FACTOR;
  const geAt = d => ROOT_GE * Math.pow(DEPTH_RATIO, d);

  function build(node, depth) {
    const box = boundToZUpBox(node.bound.min, node.bound.max);
    if (node.children) {
      const ge = geAt(depth);
      return { tile: { boundingVolume: { box }, geometricError: ge, refine: 'REPLACE', children: node.children.map(c => build(c, depth + 1).tile) } };
    }
    const levels = Object.keys(node.lods ?? {}).map(Number).sort((p, q) => p - q);
    if (!levels.length) return { tile: { boundingVolume: { box }, geometricError: geAt(depth), refine: 'REPLACE' } };
    const maxL = levels[levels.length - 1];
    let child = null;
    for (const level of levels) {
      const r = node.lods[String(level)];
      const uri = `tile/${r.file}_${r.offset}_${r.count}.glb?url=${enc}`;
      const tile = { boundingVolume: { box }, geometricError: geAt(depth + (maxL - level)), refine: 'REPLACE', content: { uri } };
      if (child) tile.children = [child];
      child = tile;
    }
    return { tile: child };
  }
  const rootDiagGE = rootDiag * ROOT_GE_FACTOR;
  // SOG (PlayCanvas Y-up) needs RX(−90°) root transform so the scene appears upright in Cesium.
  // RX(+90°) was upside-down. Column-major: col0=X→X, col1=Y→−Z, col2=Z→Y; identity for w.
  const RX90 = [1,0,0,0, 0,0,-1,0, 0,1,0,0, 0,0,0,1];
  const root = build(ctx.lod.tree, 0).tile;
  root.transform = RX90;
  const ts = { asset: { version: '1.1' }, geometricError: rootDiagGE, root, extensionsUsed: ['3DTILES_content_gltf'] };
  // centroids mode emits glTF POINTS tiles → do NOT advertise the gaussian-splatting extension.
  if (!centroids) ts.extensions = { '3DTILES_content_gltf': {
    extensionsUsed: ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
    extensionsRequired: ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
  }};
  return ts;
}

async function serveTileGlb(ctx, file, offset, count, centroids = false) {
  const table = await getChunkTable(ctx, file);
  const { positions, alphas, rgb, scales, rotations } = extractRange(table, offset, count);
  const bounds = computeBounds(positions, count);
  return Buffer.from(await buildSplatTileGlb({ positions, alphas, rgb, scales, rotations }, count, bounds, centroids));
}

// Pure builders for the /stream dispatcher.
export const sogTileRe = /^\d+_\d+_\d+$/;
// hierarchy/prefetch are no-ops (streamed-SOG's whole tree lives in one lod-meta.json — monolithic
// index, cache=none ≡ cache=hierarchy; cache=full routes to /convert). `centroids` → POINTS preview.
export async function sogTileset(url, opts = {}) { return buildTileset(await getCtx(url), url, opts.centroids); }
export async function sogTile(url, key, opts = {}) { const [f, o, c] = key.split('_').map(Number); return serveTileGlb(await getCtx(url), f, o, c, opts.centroids); }

// Direct /sog/* HTTP routes were removed 2026-07-02 — /stream/tileset.json?format=sog&url=<…> (+
// /stream/tile/…) already cover every case these exposed. See CHANGELOG.
