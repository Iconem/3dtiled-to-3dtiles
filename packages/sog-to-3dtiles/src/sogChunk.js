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
 *   opacity_linear   the opacity itself, only when some splat's exceeds 1 (SOG v3) → alpha = min(1, ·)
 *
 * SOG v2 and v3 (splat-transform 3.11, November 2026) come out of `readSog` through the same columns: v3 keeps its
 * rotation in the alpha channels of means_l/means_u/scales instead of a quats.webp, its SH palette labels on 24 bits
 * and up to 4 SH bands, none of which this reader sees. What it does see is v3's opacity, a byte `(b/204)²` that
 * reaches 1.5625 for gaussians merged by decimation: the DataTable's `opacity` logit is then `+Infinity` for exactly 1
 * and the logit of the largest float below 1 (16.64) for anything above, both of which sigmoid to 1, and the true
 * value is in `opacity_linear`. A tile here is SPZ v2, whose alpha is one byte of [0, 1]: opacity above 1 is clamped
 * to 1 (the renderers of this repo draw no opaque core), so a v3 chunk gives the same tile its v2 encoding would.
 */

import fs   from 'fs/promises';
import path from 'path';
import { readSog, readSpz, readPly, materializeToDataTable, createChunkDataPool, MemoryReadFileSystem } from '@playcanvas/splat-transform';
import { bundledSogFiles, withShN, withoutShN, sogMetaFiles } from './sogBundle.js';

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
 * @param {number} [sh=0]  above 0, the higher-order harmonics planes are read too (the table then has `f_rest_*`)
 * @returns {Promise<import('@playcanvas/splat-transform').DataTable>}
 */
export async function decodeChunk(metaJsonPath, sh = 0) {
  if (/\.(spz|ply)$/i.test(metaJsonPath)) return decodeSplatFile(await fs.readFile(metaJsonPath), path.basename(metaJsonPath));
  if (/\.sog$/i.test(metaJsonPath)) {
    const bundle = await fs.readFile(metaJsonPath);
    const bundled = new MemoryReadFileSystem();
    for (const [name, bytes] of Object.entries(await bundledSogFiles(bundle, bundle.length, undefined, sh > 0 ? withShN : withoutShN))) { bundled.set(name, bytes); bundled.set('./' + name, bytes); }
    return readSog(bundled, 'meta.json', { logging: 'silent' });
  }
  const dir  = path.dirname(metaJsonPath);
  // Without `sh` the shN planes are neither read nor decoded: the tiles do not use them.
  const { meta, names } = sogMetaFiles(await fs.readFile(metaJsonPath), sh > 0);

  // Gather every file the meta references (means/scales/quats/sh0/shN…) and preload
  // them into an in-memory file system keyed by basename, matching how meta.json
  // references them (all siblings of meta.json in the same chunk dir).
  // readSog resolves files as join(dirname(filename), name). We pass filename
  // 'meta.json' (dir '.'), so it requests bare names — but register './'-prefixed
  // variants too, in case its path-join keeps the leading './'.
  const fileSystem = new MemoryReadFileSystem();
  const put = (name, bytes) => { fileSystem.set(name, bytes); fileSystem.set('./' + name, bytes); };
  put('meta.json', meta);
  for (const n of names) {
    put(n, new Uint8Array(await fs.readFile(path.join(dir, n))));
  }

  // readSog returns a whole DataTable (splat-transform 3.x's readFile returns lazy chunk sources instead).
  return readSog(fileSystem, 'meta.json', { logging: 'silent' });
}

const sigmoid = x => 1 / (1 + Math.exp(-x));

/** How many `f_rest_*` columns a table has: 3 × the coefficients per colour channel (9, 24, 45 for degrees 1, 2, 3). */
export function restColumns(table) { let n = 0; while (table.getColumnByName(`f_rest_${n}`)) n++; return n; }

/**
 * The spherical-harmonic bands of rows [offset, offset+count), up to degree `want`, in the layout the tile writer
 * takes (core/spz-glb.js): per splat, per coefficient, RGB together. The table's `f_rest_*` columns are the PLY
 * layout: every coefficient of red, then green, then blue. Same basis and signs (SPZ and SOG both keep 3DGS's), and
 * no reader here turns the splats (a tileset's root transform does), so the values go through as they are.
 * @returns {{sh1:Float32Array, sh2?:Float32Array, sh3?:Float32Array}|null}  null when none is asked or held
 */
export function shBands(table, offset, count, want) {
  if (!(want > 0)) return null;
  const K = Math.floor(restColumns(table) / 3);                 // coefficients per channel
  const degree = Math.min(want, K >= 15 ? 3 : K >= 8 ? 2 : K >= 3 ? 1 : 0);
  if (!degree) return null;
  const out = {};
  for (let b = 0; b < degree; b++) {
    const first = [0, 3, 8][b], n = [3, 5, 7][b], band = new Float32Array(count * n * 3);
    for (let k = 0; k < n; k++) for (let ch = 0; ch < 3; ch++) {
      const col = table.getColumnByName(`f_rest_${ch * K + first + k}`).data;
      for (let j = 0, o = k * 3 + ch; j < count; j++, o += n * 3) band[o] = col[offset + j];
    }
    out[`sh${b + 1}`] = band;
  }
  return out;
}

/**
 * Extract renderer-ready arrays for rows [offset, offset+count) of a decoded chunk.
 * Returns the exact inputs buildSpzBuffer expects.
 * @param {number} [sh=0]  spherical-harmonic degree to return as well (`sh`), when the table holds it
 * @returns {{positions:Float32Array, alphas:Float32Array, rgb:Float32Array, scales:Float32Array, rotations:Float32Array, sh:object|null}}
 */
export function extractRange(table, offset, count, sh = 0) {
  const col = name => table.getColumnByName(name)?.data ?? null;
  const x = col('x'), y = col('y'), z = col('z');
  const s0 = col('scale_0'), s1 = col('scale_1'), s2 = col('scale_2');
  const r0 = col('rot_0'), r1 = col('rot_1'), r2 = col('rot_2'), r3 = col('rot_3');
  const c0 = col('f_dc_0'), c1 = col('f_dc_1'), c2 = col('f_dc_2');
  const ol = col('opacity_linear'), op = col('opacity');

  const positions = new Float32Array(count * 3);
  const alphas    = new Float32Array(count);
  const rgb       = (c0 && c1 && c2) ? new Float32Array(count * 3) : null;
  const scales    = (s0 && s1 && s2) ? new Float32Array(count * 3) : null;
  const rotations = (r0 && r1 && r2 && r3) ? new Float32Array(count * 4) : null;

  for (let j = 0; j < count; j++) {
    const i = offset + j;
    positions[j*3]   = x[i]; positions[j*3+1] = y[i]; positions[j*3+2] = z[i];

    // opacity is a logit in the DataTable (PLY/SOG convention) → sigmoid to [0,1]; a SOG v3 chunk with opacity above
    // 1 carries the true value in opacity_linear, clamped to 1 here (SPZ alpha is a byte of [0, 1], see above).
    const a = ol ? ol[i] : op ? sigmoid(op[i]) : 1;
    alphas[j] = a > 1 ? 1 : a >= 0 ? a : 0;   // NaN → 0

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
  return { positions, alphas, rgb, scales, rotations, sh: shBands(table, offset, count, sh) };
}
