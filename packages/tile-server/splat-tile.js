/**
 * splat-tile.js — the CPU half of a live splat tile (LCC, RAD, streamed SOG, GeoSplats): fetched bytes → GLB, with
 * no network and no cached context, so that it runs the same on the server's thread (the *-live.js modules) and on a
 * tile worker (tile-tasks-splats.js, behind TILED_WORKERS).
 */
import { readSog, MemoryReadFileSystem } from '@playcanvas/splat-transform';
import { decodeSplats } from '../lcc-to-3dtiles/src/lccDecode.js';
import { encodeChunkGlb } from '../rad-to-3dtiles/src/index.js';
import { buildSplatTileGlb, computeBounds } from '../core/index.js';
import { extractRange } from '../sog-to-3dtiles/src/sogChunk.js';

/** Renderer-ready splat arrays ({ positions, alphas, rgb, scales, rotations }) → the _spz_2 GLB every splat tile here is. */
export const splatArraysGlb = (arrays, count, centroids = false) => buildSplatTileGlb(arrays, count, computeBounds(arrays.positions, count), centroids);

/** One LCC data range (`pts` splats) → GLB. */
export function lccSplatGlb(buf, pts, scaleMin, scaleMax, centroids = false) {
  const { positions, alphas, rgb, scales, rotations } = decodeSplats(buf, 0, pts, scaleMin, scaleMax);
  return splatArraysGlb({ positions, alphas, rgb, scales, rotations }, pts, centroids);
}

/** One RAD chunk → GLB (`local`, `base`: where the chunk sits in `cbuf`, as rad-live.js reads it). */
export async function radChunkGlb(cbuf, local, base, centroids = false) {
  return (await encodeChunkGlb(cbuf, local, base, { centroidsOnly: centroids })).glb;
}

/** One streamed-SOG chunk (its meta.json and WebP files, by name) → the decoded table's columns, as plain typed arrays. */
export async function sogChunkColumns(files) {
  const fileSystem = new MemoryReadFileSystem();
  for (const [name, bytes] of Object.entries(files)) { fileSystem.set(name, bytes); fileSystem.set('./' + name, bytes); }
  const table = await readSog(fileSystem, 'meta.json', { logging: 'silent' });
  const out = { numRows: table.numRows };
  for (const name of SOG_COLUMNS) { const d = table.getColumnByName(name)?.data; if (d) out[name] = d; }
  return out;
}
// `opacity_linear` is there when a SOG v3 chunk holds opacity above 1 (see sogChunk.js).
const SOG_COLUMNS = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'opacity_linear'];

// readSog yields a PLY-convention DataTable (SH-DC colour, logit opacity, ln scale, quat rot_0=w). sogChunk.js's
// extractRange turns it into the renderer-ready linear arrays buildSplatTileGlb wants (SOG v2 and v3 alike), and the
// tile is a KHR_gaussian_splatting_compression_spz_2 GLB — the SAME format every other splat tile in this repo uses
// (the uncompressed writeGlb variant is not read by our viewer's GaussianSplat plugin, which is why those tiles
// failed to load).
function dataTableToSplatGlb(dt) {
  const n = dt.numRows;
  const arrays = extractRange(dt, 0, n);
  return buildSplatTileGlb(arrays, n, computeBounds(arrays.positions, n));
}

/** One MapTiler GeoSplats octant bundle (`files`: [name, size] in the order they are concatenated in `buf`) → GLB. */
export async function geosplatsBundleGlb(buf, files) {
  const fs = new MemoryReadFileSystem();
  let off = 0;
  for (const [name, size] of files) { fs.set(name, buf.subarray(off, off + size)); off += size; }
  return dataTableToSplatGlb(await readSog(fs, 'meta.json', { logging: 'silent' }));
}
