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
import { readSog, MemoryReadFileSystem } from '@playcanvas/splat-transform';
import { extractRange } from '../sog-to-3dtiles/src/sogChunk.js';
import { lodGeometricErrors } from '../sog-to-3dtiles/src/lodMeta.js';
import { memoizeAsync, fetchSource as fetchBuf, tilePool, runTileTaskOr, ownBytes } from '../core/index.js';
import { splatArraysGlb } from './splat-tile.js';

const SPLAT_TASKS = new URL('./tile-tasks-splats.js', import.meta.url).href;   // what a tile worker runs (TILED_WORKERS)

// glTF Y-up → 3D Tiles Z-up box (RX +90°): centre (cx,cy,cz)→(cx,−cz,cy); half-extents y↔z.
function boundToZUpBox(min, max) {
  const cx=(min[0]+max[0])/2, cy=(min[1]+max[1])/2, cz=(min[2]+max[2])/2;
  const hx=Math.max((max[0]-min[0])/2,1e-4), hy=Math.max((max[1]-min[1])/2,1e-4), hz=Math.max((max[2]-min[2])/2,1e-4);
  return [cx, -cz, cy, hx,0,0, 0,hz,0, 0,0,hy];
}
const boundDiagonal = (min, max) => Math.hypot(max[0]-min[0], max[1]-min[1], max[2]-min[2]) || 1e-3;
const ROOT_GE_FACTOR = 0.05, DEPTH_RATIO = 0.5;

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
// How many decoded chunks a scene keeps (TILED_SOG_CHUNK_CACHE, default 24). A decoded chunk is its splats as 14
// float columns, 30 to 45 MB for the usual half-million splats, so 24 is already up to a gigabyte for one scene: a
// chunk evicted and asked for again costs a third of a second, which is cheaper than holding many more of them.
const CHUNK_CACHE = Math.max(1, Math.floor(Number(process.env.TILED_SOG_CHUNK_CACHE)) || 24);
/** The decoded chunk `key` of a scene's LRU `chunks` (key → promise of a table), loaded with `load` when it is not there. Shared with lcc2-live.js. */
export function cachedChunk(chunks, key, load) {
  if (chunks.has(key)) { const p = chunks.get(key); chunks.delete(key); chunks.set(key, p); return p; }
  const promise = load();
  promise.catch(() => chunks.delete(key));   // don't poison the cache with a failed decode
  chunks.set(key, promise);
  if (chunks.size > CHUNK_CACHE) chunks.delete(chunks.keys().next().value);   // evict oldest
  return promise;
}

/** One SOG chunk's files (`raw`: Map of name → bytes, meta.json and its WebP planes) → its decoded table. Shared with lcc2-live.js. */
export async function decodeSogFiles(raw) {
  const here = () => {
    const fileSystem = new MemoryReadFileSystem();
    for (const [name, bytes] of raw) { fileSystem.set(name, bytes); fileSystem.set('./' + name, bytes); }
    return readSog(fileSystem, 'meta.json', { logging: 'silent' });
  };
  const pool = tilePool();
  if (!pool) return here();
  // TILED_WORKERS: the chunk's WebP decode (about a second) runs on a worker, which hands its columns back; the
  // table stays cached on this thread as before, since many leaf tiles read ranges of the same chunk.
  const files = Object.fromEntries([...raw].map(([n, bytes]) => [n, ownBytes(bytes)]));
  const cols = await runTileTaskOr(pool, SPLAT_TASKS, 'sogChunkTask', { files }, Object.values(files).map((b) => b.buffer), async () => null);
  return cols ? { numRows: cols.numRows, getColumnByName: (name) => (cols[name] ? { data: cols[name] } : undefined) } : here();
}

function getChunkTable(ctx, fileIdx) {
  return cachedChunk(ctx.chunks, fileIdx, async () => {
    const rel = ctx.lod.filenames[fileIdx];                 // e.g. "1_0/meta.json"
    const chunkDir = path.posix.dirname(rel);
    const metaBuf = await fetchBuf(ctx.base + rel);
    const meta = JSON.parse(metaBuf.toString('utf8'));
    const raw = new Map([['meta.json', new Uint8Array(metaBuf)]]);   // name → bytes, as fetched (what a tile worker is handed)
    const names = new Set();
    for (const k of Object.keys(meta)) { const f = meta[k]?.files; if (Array.isArray(f)) for (const n of f) names.add(n); }
    await Promise.all([...names].map(async n => raw.set(n, new Uint8Array(await fetchBuf(ctx.base + path.posix.join(chunkDir, n))))));
    return decodeSogFiles(raw);
  });
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
    // Halving per LOD level, or the leaf's own `errors` when lod-meta.json carries them (sog-to-3dtiles/lodMeta.js).
    const ges = lodGeometricErrors(node, levels, depth, geAt, ctx.lod.lodErrors === true);
    let child = null;
    for (const level of levels) {
      const r = node.lods[String(level)];
      const uri = `tile/${r.file}_${r.offset}_${r.count}.glb?url=${enc}`;
      const tile = { boundingVolume: { box }, geometricError: ges.get(level), refine: 'REPLACE', content: { uri } };
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

/** Rows [offset, offset+count) of a decoded chunk → the tile's GLB, null when the chunk has no such rows. Shared with lcc2-live.js. */
export async function sogRangeGlb(table, offset, count, centroids = false) {
  if (!(count > 0 && offset + count <= table.numRows)) return null;
  const { positions, alphas, rgb, scales, rotations } = extractRange(table, offset, count);
  const here = async () => Buffer.from(await splatArraysGlb({ positions, alphas, rgb, scales, rotations }, count, centroids));
  const pool = tilePool();
  if (!pool) return here();
  // TILED_WORKERS: the range is cut out here (the chunk's table lives on this thread), a worker encodes it.
  const copy = (a) => (a ? a.slice() : a);   // the worker takes its own copies: `here` may still need these
  const arrays = { positions: copy(positions), alphas: copy(alphas), rgb: copy(rgb), scales: copy(scales), rotations: copy(rotations) };
  const glb = await runTileTaskOr(pool, SPLAT_TASKS, 'splatArraysTask', { arrays, count, centroids }, Object.values(arrays).filter(Boolean).map((a) => a.buffer), here);
  return Buffer.isBuffer(glb) ? glb : Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength);
}

// Pure builders for the /stream dispatcher.
export const sogTileRe = /^\d+_\d+_\d+$/;
// hierarchy/prefetch are no-ops (streamed-SOG's whole tree lives in one lod-meta.json — monolithic
// index, cache=none ≡ cache=hierarchy; cache=full routes to /convert). `centroids` → POINTS preview.
export async function sogTileset(url, opts = {}) { return buildTileset(await getCtx(url), url, opts.centroids); }
export async function sogTile(url, key, opts = {}) {
  const [f, o, c] = key.split('_').map(Number);
  const ctx = await getCtx(url);
  if (!ctx.lod.filenames[f]) return null;
  return sogRangeGlb(await getChunkTable(ctx, f), o, c, opts.centroids);
}

// Direct /sog/* HTTP routes were removed 2026-07-02 — /stream/tileset.json?format=sog&url=<…> (+
// /stream/tile/…) already cover every case these exposed. See CHANGELOG.
