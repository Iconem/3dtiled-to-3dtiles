/**
 * nexus-live.js — live **Nexus (.nxs / .nxz, CNR-ISTI multiresolution mesh, 3DHOP) → OGC 3D Tiles** middleware.
 *
 * A Nexus file is one file that was made for range requests: the viewer reads its 88-byte header, then the node,
 * patch and texture tables (44, 12 and 68 bytes an entry), then each node's bytes and each texture's at the offsets
 * the tables give. The tileset is built from the tables alone (two range requests; packages/nexus-to-3dtiles reads
 * them and maps the DAG to a tree, see nexus-tileset.js), and a tile is one node's range, plus the ranges of the
 * textures its patches name, decoded and written as a GLB (nexus-glb.js), on a tile worker when there are any.
 *
 *   GET /stream/tileset.json?format=nexus&url=<….nxs | ….nxz>[&dag=levels|paths][&ge=<scale, default 8>]
 *   GET /stream/tile/<node>.glb?format=nexus&url=<same>
 *
 * `url` is an http(s) URL or a local path. A host that ignores Range answers the header request with the whole file,
 * which is then kept and sliced (core's fetchSourceRange), so such a host still works, at the cost of one download.
 */
import fs from 'node:fs/promises';
import { memoizeAsync, fetchSourceRange, tilePool, runTileTaskOr } from '../core/index.js';
import { parseNexusHeader, parseNexusIndex, indexBytes, HEADER_BYTES, nodeRange, nodeTextures } from '../nexus-to-3dtiles/src/nexus-reader.js';
import { nexusTileset as buildTileset, DAG_MODES, DEFAULT_GE_SCALE } from '../nexus-to-3dtiles/src/nexus-tileset.js';
import { nexusNodeGlb } from '../nexus-to-3dtiles/src/nexus-glb.js';
import { plainIndex } from '../nexus-to-3dtiles/src/index.js';

const isHttp = (u) => /^https?:\/\//i.test(u);
const MESH_TASKS = new URL('./tile-tasks-mesh.js', import.meta.url).href;
const TEXTURE_CACHE = 64;                                   // raw images kept per file (a texture serves several nodes)

/** `[begin, begin + length)` of the source, from the host or the disk. */
async function readRange(ctx, begin, length) {
  if (length <= 0) return Buffer.alloc(0);
  if (ctx.http) return fetchSourceRange(ctx.url, begin, length);
  const fh = await fs.open(ctx.url, 'r').catch((e) => { throw e.code === 'ENOENT' ? Object.assign(e, { status: 404 }) : e; });
  try { const b = Buffer.alloc(length); const { bytesRead } = await fh.read(b, 0, length, begin); return b.subarray(0, bytesRead); }
  finally { await fh.close(); }
}

// Per-URL context: the parsed tables and a small cache of raw textures. memoizeAsync caches FAILURES too (cache.js).
const getCtx = memoizeAsync(async (url) => {
  const ctx = { url, http: isHttp(url), index: null, textures: new Map() };
  const header = parseNexusHeader(await readRange(ctx, 0, HEADER_BYTES));
  if (header.deepzoom) throw new Error('nexus: DEEPZOOM files (nodes in a _files/ folder beside the .nxs) are not supported');
  const index = parseNexusIndex(header, await readRange(ctx, HEADER_BYTES, indexBytes(header)));
  ctx.index = { header, ...index };
  ctx.plain = plainIndex(ctx.index);
  console.log(`[nexus-live] ${url.split('?')[0].slice(-100)} → ${header.nodesCount - 1} nodes, ${header.patchesCount} patches, ${index.textures.length} textures, ${header.nvert} vertices, ${header.nface} triangles, ${header.codec || 'uncompressed'}`);
  return ctx;
});

function textureBytes(ctx, t) {
  const hit = ctx.textures.get(t);
  if (hit) { ctx.textures.delete(t); ctx.textures.set(t, hit); return hit; }
  const tx = ctx.index.textures[t];
  const p = readRange(ctx, tx.offset, tx.end - tx.offset).catch((e) => { ctx.textures.delete(t); throw e; });
  ctx.textures.set(t, p);
  if (ctx.textures.size > TEXTURE_CACHE) ctx.textures.delete(ctx.textures.keys().next().value);
  return p;
}

async function buildNodeGlb(ctx, i) {
  const { index } = ctx;
  if (!(i >= 0 && i < index.nodes.length - 1) || !index.nodes[i].nface) return null;
  const r = nodeRange(index, i);
  const [nodeBytes, ...tex] = await Promise.all([readRange(ctx, r.begin, r.length), ...nodeTextures(index, i).map((t) => textureBytes(ctx, t).then((b) => [t, b]))]);
  const here = async () => { const glb = await nexusNodeGlb(index, i, nodeBytes, new Map(tex)); return glb ? Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength) : null; };
  const pool = tilePool();
  if (!pool) return here();
  const bytes = new Uint8Array(nodeBytes).slice(), textures = tex.map(([t, b]) => [t, new Uint8Array(b).slice()]);
  const glb = await runTileTaskOr(pool, MESH_TASKS, 'nexusTileTask', { index: ctx.plain, i, nodeBytes: bytes, textures }, [bytes.buffer, ...textures.map(([, b]) => b.buffer)], here);
  return !glb || Buffer.isBuffer(glb) ? glb : Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength);
}

// Pure builders for the /stream dispatcher.
export const nexusTileRe = /^\d+$/;                         // the node index
/** hierarchy/prefetch are no-ops: the whole DAG is in the tables (cache=none ≡ cache=hierarchy). */
export async function nexusTileset(url, opts = {}) {
  const ctx = await getCtx(url);
  const enc = encodeURIComponent(url);
  const dag = DAG_MODES.includes(opts.dag) ? opts.dag : 'levels';
  const geScale = Number.isFinite(opts.geScale) && opts.geScale > 0 ? opts.geScale : DEFAULT_GE_SCALE;
  return buildTileset(ctx.index, (i) => `tile/${i}.glb?url=${enc}`, { dag, geScale, tag: 'nexus-live' }).tileset;
}
export async function nexusTile(url, key) { return buildNodeGlb(await getCtx(url), Number(key)); }
