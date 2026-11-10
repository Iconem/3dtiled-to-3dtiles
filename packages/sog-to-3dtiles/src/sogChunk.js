/**
 * sogChunk.js  (sog-to-3dtiles)
 *
 * Decodes an unbundled SOG chunk (meta.json + WebP textures) into a splat-transform
 * DataTable using the official @playcanvas/splat-transform `readSog`, then extracts
 * renderer-ready per-splat arrays for an arbitrary [offset, count) row range.
 *
 * We delegate ALL WebP decoding + dequantization to splat-transform (the reference
 * implementation) rather than re-deriving it — `readSog` returns standard columns:
 *   x,y,z            position (linear scene units)
 *   scale_0..2       LOG-domain per-axis size  → linear = exp()
 *   rot_0..3         quaternion in (w,x,y,z) order (PLY convention)
 *   f_dc_0..2        SH DC coefficient          → color = 0.5 + SH_C0·f_dc
 *   opacity          logit                      → alpha = sigmoid()
 */

import fs   from 'fs/promises';
import path from 'path';
import { readSog, readSpz, readPly, materializeToDataTable, createChunkDataPool, MemoryReadFileSystem } from '@playcanvas/splat-transform';
import { bundledSogFiles } from './sogBundle.js';

const SH_C0 = 0.28209479177387814;

/** A chunk file name this can decode: a bundled SOG, an SPZ or a 3DGS PLY (the three chunk types the LCC2 whitepaper lists). */
export const SPLAT_CHUNK_RE = /\.(sog|spz|ply)$/i;

/**
 * One whole `.spz` or `.ply` chunk file → the DataTable `readSog` gives for a SOG chunk (the same columns: x, y, z,
 * scale_*, rot_*, f_dc_*, opacity, in the PLY conventions listed above), through splat-transform's own readers. Neither
 * format can be read in part the way a bundled SOG's planes can, so the whole file is decoded; its f_rest_* columns,
 * if any, are left unused by extractRange.
 * @param {Uint8Array|Buffer} bytes  the file
 * @param {string} name  its name, for the extension
 */
export async function decodeSplatFile(bytes, name) {
  const fileSystem = new MemoryReadFileSystem();
  fileSystem.set(name, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const source = await fileSystem.createSource(name);
  const pool = createChunkDataPool();
  const src = /\.spz$/i.test(name) ? await readSpz(source, pool) : await readPly(source, pool);
  try { return await materializeToDataTable(src, pool); } finally { src.destroy?.(); pool.destroy(); }
}

/**
 * Load + decode one chunk into a DataTable: an unbundled SOG chunk directory, a bundled `.sog` file (as an LCC2
 * scene stores its chunks), of which the higher-order SH planes are left unread (see sogBundle.js), or an LCC2
 * scene's `.spz` or `.ply` chunk.
 * @param {string} metaJsonPath  absolute path to the chunk's meta.json, or to a bundled `.sog`, `.spz` or `.ply`
 * @returns {Promise<import('@playcanvas/splat-transform').DataTable>}
 */
export async function decodeChunk(metaJsonPath) {
  if (/\.(spz|ply)$/i.test(metaJsonPath)) return decodeSplatFile(await fs.readFile(metaJsonPath), path.basename(metaJsonPath));
  if (/\.sog$/i.test(metaJsonPath)) {
    const bundle = await fs.readFile(metaJsonPath);
    const bundled = new MemoryReadFileSystem();
    for (const [name, bytes] of Object.entries(await bundledSogFiles(bundle, bundle.length))) { bundled.set(name, bytes); bundled.set('./' + name, bytes); }
    return readSog(bundled, 'meta.json', { logging: 'silent' });
  }
  const dir  = path.dirname(metaJsonPath);
  const meta = JSON.parse(await fs.readFile(metaJsonPath, 'utf8'));

  // Gather every file the meta references (means/scales/quats/sh0/shN…) and preload
  // them into an in-memory file system keyed by basename, matching how meta.json
  // references them (all siblings of meta.json in the same chunk dir).
  // readSog resolves files as join(dirname(filename), name). We pass filename
  // 'meta.json' (dir '.'), so it requests bare names — but register './'-prefixed
  // variants too, in case its path-join keeps the leading './'.
  const fileSystem = new MemoryReadFileSystem();
  const put = (name, bytes) => { fileSystem.set(name, bytes); fileSystem.set('./' + name, bytes); };
  put('meta.json', new Uint8Array(await fs.readFile(metaJsonPath)));
  const names = new Set();
  for (const key of Object.keys(meta)) {
    const f = meta[key]?.files;
    if (Array.isArray(f)) for (const n of f) names.add(n);
  }
  for (const n of names) {
    put(n, new Uint8Array(await fs.readFile(path.join(dir, n))));
  }

  // readSog returns a whole DataTable (splat-transform 3.x's readFile returns lazy chunk sources instead).
  return readSog(fileSystem, 'meta.json', { logging: 'silent' });
}

const sigmoid = x => 1 / (1 + Math.exp(-x));

/**
 * Extract renderer-ready arrays for rows [offset, offset+count) of a decoded chunk.
 * Returns the exact inputs buildSpzBuffer expects.
 * @returns {{positions:Float32Array, alphas:Float32Array, rgb:Float32Array, scales:Float32Array, rotations:Float32Array}}
 */
export function extractRange(table, offset, count) {
  const col = name => table.getColumnByName(name)?.data ?? null;
  const x = col('x'), y = col('y'), z = col('z');
  const s0 = col('scale_0'), s1 = col('scale_1'), s2 = col('scale_2');
  const r0 = col('rot_0'), r1 = col('rot_1'), r2 = col('rot_2'), r3 = col('rot_3');
  const c0 = col('f_dc_0'), c1 = col('f_dc_1'), c2 = col('f_dc_2');
  const op = col('opacity');

  const positions = new Float32Array(count * 3);
  const alphas    = new Float32Array(count);
  const rgb       = (c0 && c1 && c2) ? new Float32Array(count * 3) : null;
  const scales    = (s0 && s1 && s2) ? new Float32Array(count * 3) : null;
  const rotations = (r0 && r1 && r2 && r3) ? new Float32Array(count * 4) : null;

  for (let j = 0; j < count; j++) {
    const i = offset + j;
    positions[j*3]   = x[i]; positions[j*3+1] = y[i]; positions[j*3+2] = z[i];

    // opacity is a logit in the DataTable (PLY/SOG convention) → sigmoid to [0,1].
    alphas[j] = op ? Math.max(0, Math.min(1, sigmoid(op[i]))) : 1;

    if (rgb) {
      rgb[j*3]   = Math.max(0, Math.min(1, 0.5 + c0[i] * SH_C0));
      rgb[j*3+1] = Math.max(0, Math.min(1, 0.5 + c1[i] * SH_C0));
      rgb[j*3+2] = Math.max(0, Math.min(1, 0.5 + c2[i] * SH_C0));
    }
    if (scales) {
      // scale_* columns are LOG-domain → exp() to linear scene units.
      scales[j*3]   = Math.exp(s0[i]);
      scales[j*3+1] = Math.exp(s1[i]);
      scales[j*3+2] = Math.exp(s2[i]);
    }
    if (rotations) {
      // DataTable rot order is (w,x,y,z); SPZ encoder wants xyzw.
      rotations[j*4]   = r1[i]; rotations[j*4+1] = r2[i];
      rotations[j*4+2] = r3[i]; rotations[j*4+3] = r0[i];
    }
  }
  return { positions, alphas, rgb, scales, rotations };
}
