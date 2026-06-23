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
import { readFile as readSplatFile, MemoryReadFileSystem } from '@playcanvas/splat-transform';

const SH_C0 = 0.28209479177387814;

/**
 * Load + decode one unbundled SOG chunk directory into a DataTable.
 * @param {string} metaJsonPath  absolute path to the chunk's meta.json
 * @returns {Promise<import('@playcanvas/splat-transform').DataTable>}
 */
export async function decodeChunk(metaJsonPath) {
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

  const tables = await readSplatFile({
    filename: 'meta.json',
    inputFormat: 'sog',
    options: {},
    params: [],
    fileSystem,
  });
  return tables[0];
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
