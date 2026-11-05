/**
 * tile-task.js (lcc-to-3dtiles) — one LCC unit at one LOD → its GLB file, as a tile worker runs it (core's
 * convertTiles). The worker reads the tile's own range of data.bin, so nothing but the task's description crosses
 * threads and no thread holds the whole file.
 */
import fs from 'fs/promises';
import { decodeSplats } from './lccDecode.js';
import { buildSplatTileGlb, computeBounds } from '../../core/index.js';

const SPLAT_BYTES = 32;   // data.bin, per splat (lccDecode.js)

/**
 * @param {{dataPath:string, off:number, pts:number, scaleMin:number[], scaleMax:number[], centroids?:boolean, outPath:string}} a
 * @returns the tile's bounds (computeBounds), which the converter turns into its bounding box
 */
export async function lccTileToFile({ dataPath, off, pts, scaleMin, scaleMax, centroids = false, outPath }) {
  const buf = Buffer.allocUnsafe(pts * SPLAT_BYTES);
  const fh = await fs.open(dataPath, 'r');
  try {
    const { bytesRead } = await fh.read(buf, 0, buf.length, off);
    if (bytesRead !== buf.length) throw new Error(`data.bin: ${bytesRead} of ${buf.length} bytes at ${off}`);
  } finally { await fh.close(); }
  const { positions, alphas, rgb, scales, rotations } = decodeSplats(buf, 0, pts, scaleMin, scaleMax);
  const bounds = computeBounds(positions, pts);
  await fs.writeFile(outPath, await buildSplatTileGlb({ positions, alphas, rgb, scales, rotations }, pts, bounds, centroids));
  return bounds;
}
