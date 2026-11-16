/**
 * gltf-tiles.js — the per-tile glTF transforms as the live server calls them: one GLB in, one GLB out.
 *   - a tile with nothing to decode is returned as it came, without being parsed and written again;
 *   - with TILED_WORKERS the work runs on a tile worker, so the texture encode (most of a decode, measured) does
 *     not hold the event loop; a tile the workers had no memory for is done on this thread instead.
 * decompressGlb / compressGlb stay the plain single-thread functions (offline tools, the extract endpoint).
 */
import { tilePool, runTileTaskOr, ownBytes } from './parallel.js';
import { decompressGlb, glbNeedsDecode } from './gltf-decompress.js';
import { compressGlb } from './gltf-compress.js';

const TASKS = new URL('./gltf-task.js', import.meta.url).href;
const asBuffer = (b) => (!b || Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength));

async function run(fn, glb, opts, here) {
  const pool = tilePool();
  if (!pool) return here();
  const bytes = ownBytes(glb);   // a copy to hand over: `glb` stays here for the fallback
  return asBuffer(await runTileTaskOr(pool, TASKS, fn, { glb: bytes, opts }, [bytes.buffer], here));
}

/**
 * Decode Draco / meshopt / KTX2 of one tile. `opts` as decompressGlb: { draco, meshopt, ktx, texFormat }, where
 * `texFormat: 'ktx2'` keeps the KTX2 textures (only the geometry is decoded).
 * @returns {Promise<Buffer>} the decoded GLB, or `glb` itself when it holds nothing to decode
 */
export async function decompressTile(glb, opts = {}) {
  if (!glbNeedsDecode(glb, opts)) return glb;
  return run('decompressTask', glb, opts, async () => (await decompressGlb(glb, opts)).glb);
}

/** Encode one tile (meshopt, Draco, KTX2). `opts` as compressGlb. */
export async function compressTile(glb, opts = {}) {
  return run('compressTask', glb, opts, async () => (await compressGlb(glb, opts)).glb);
}
