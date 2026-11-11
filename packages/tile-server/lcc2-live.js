/**
 * lcc2-live.js — live **XGRIDS LCC2 → OGC 3D Tiles** middleware (on-the-fly, one chunk file per group of tiles).
 *
 * An LCC2 scene is a JSON manifest (`*.lcc2`) beside a `data/3dgs/` folder of chunk files. The manifest holds the whole
 * tree with a bounding box per node, and each node names a run of splats in one chunk: so the tileset is built from
 * the manifest alone (lcc-to-3dtiles/src/lcc2Manifest.js, where the mapping is described), and a tile is rows
 * [start, start+count) of its chunk.
 *
 *   GET /stream/tileset.json?format=lcc2&url=<….lcc2>
 *   GET /stream/tile/<file>_<start>_<count>.glb?format=lcc2&url=<….lcc2>   (run encoded in the name)
 *
 * It is its own adapter and not a branch of lcc-live.js because the two share a frame and nothing of the layout: LCC
 * range-reads 32-byte splats out of one data.bin by index.bin, LCC2 reads a tree of bundled SOG chunks. What LCC2 does
 * share is used as it is: LCC's georeferencing and upright transform (core), and streamed SOG's chunk decode, chunk
 * cache and range → GLB (sog-live.js), a chunk being a SOG either way.
 *
 * A chunk is a bundled `.sog` (a ZIP). Its `shN_*` planes are not in the tiles, so they are not downloaded: the ZIP's
 * directory is read from the file's last bytes, then the span of the planes that are needed (sogBundle.js). A `.spz` or
 * `.ply` chunk (the whitepaper's other two types; LCC Studio writes SPZ too) is downloaded whole and decoded by
 * splat-transform's reader into the same table (sogChunk.js), so the tiles are cut the same way.
 */
import { memoizeAsync, fetchSource as fetchBuf, requestSource } from '../core/index.js';
import { readRange } from './range-getter.js';
import { parseLcc2, lcc2Tileset as buildTileset } from '../lcc-to-3dtiles/src/lcc2Manifest.js';
import { bundledSogFiles } from '../sog-to-3dtiles/src/sogBundle.js';
import { decodeSplatFile } from '../sog-to-3dtiles/src/sogChunk.js';
import { cachedChunk, decodeSogFiles, sogRangeGlb } from './sog-live.js';

// What is asked of a chunk first: its end, where the ZIP directory is and, in the bundles seen, meta.json too.
const TAIL_BYTES = 64 * 1024;

// Per-URL context: the parsed manifest and a small LRU of decoded chunks. memoizeAsync caches FAILURES too (cache.js).
const getCtx = memoizeAsync(async (url) => {
  const manifest = parseLcc2((await fetchBuf(url)).toString('utf8'));
  console.log(`[lcc2-live] ${url} → ${manifest.files.length} ${manifest.splatType} chunk files, ${manifest.totalLevels} LODs, ${manifest.totalSplats} splats${manifest.meta.epsg ? ` (EPSG:${manifest.meta.epsg})` : ' (local upright, no EPSG)'}`);
  return { url, manifest, chunks: new Map() };           // chunks: file index → promise of the decoded table (LRU)
});

/** The files of one bundled chunk, by name, without its shN planes: the tail, then the spans still missing. */
async function fetchBundle(url) {
  const { status, headers, body } = await requestSource(url, { headers: { Range: `bytes=-${TAIL_BYTES}` }, ok: (s) => (s >= 200 && s < 300) || s === 416 });
  // A host that ignores Range answers with the whole bundle, which is then all there is to read. One that refuses a
  // suffix range (416), or does not say how long the file is, is asked for the whole bundle.
  const total = status === 206 ? Number(headers.get('content-range')?.match(/\/(\d+)\s*$/)?.[1]) : status === 416 ? NaN : body.length;
  if (!Number.isFinite(total)) { const whole = await fetchBuf(url); return bundledSogFiles(whole, whole.length); }
  // The spans missing from the tail are asked for together, through the bundle's shared getter (range-getter.js): the
  // planes that are kept are merged into one read where the shN planes between them are small, left out where they are not.
  return bundledSogFiles(body, total, (begin, length) => readRange(url, begin, length));
}

// A chunk backs many tiles (Tunis: 570 tiles in 140 chunks), so its decode is cached as an in-flight promise, like sog-live's.
// A bundled SOG is read in part and decoded as streamed SOG's chunks are (on a tile worker when there are any); an SPZ or
// PLY chunk is read whole and decoded on this thread.
const getChunkTable = (ctx, file) => cachedChunk(ctx.chunks, file, async () => {
  const url = chunkUrl(ctx, file), name = ctx.manifest.files[file].split('/').pop();
  if (/\.(spz|ply)$/i.test(name)) return decodeSplatFile(await fetchBuf(url), name);
  return decodeSogFiles(new Map(Object.entries(await fetchBundle(url))));
});
// Chunk paths are relative to the manifest; its query string (a signed URL's token) is carried over to them.
function chunkUrl(ctx, file) {
  const u = new URL(ctx.manifest.files[file], ctx.url);
  u.search = new URL(ctx.url).search;
  return u.href;
}

// Pure builders for the /stream dispatcher.
export const lcc2TileRe = /^\d+_\d+_\d+$/;
// hierarchy/prefetch are no-ops (the whole tree is in the manifest: cache=none ≡ cache=hierarchy). `centroids` → POINTS preview.
export async function lcc2Tileset(url, opts = {}) {
  const { manifest } = await getCtx(url);
  const enc = encodeURIComponent(url);
  return buildTileset(manifest, (run) => `tile/${run.file}_${run.start}_${run.count}.glb?url=${enc}`, { centroids: !!opts.centroids, tag: 'lcc2-live' }).tileset;
}

export async function lcc2Tile(url, key, opts = {}) {
  const [file, start, count] = key.split('_').map(Number);
  const ctx = await getCtx(url);
  if (!ctx.manifest.files[file] || file === ctx.manifest.envFile) return null;
  return sogRangeGlb(await getChunkTable(ctx, file), start, count, opts.centroids);
}
