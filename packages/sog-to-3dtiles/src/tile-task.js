/**
 * tile-task.js (sog-to-3dtiles) — one streamed-SOG chunk → the GLB files of every tile cut from it, as the converter's
 * thread or a tile worker runs it (core's convertTiles). The unit of work is the chunk, not the tile: its WebP planes
 * are decoded once per thread that works on it and every tile of the chunk is a range of that one table.
 */
import fs from 'fs/promises';
import path from 'path';
import { decodeChunk, extractRange } from './sogChunk.js';
import { buildSplatTileGlb, computeBounds, parallelMap } from '../../core/index.js';

// The chunk decoded last, kept: with tile workers a big chunk's tiles come as several batches (index.js), and the ones
// that land on this thread one after the other share the decode. One table, so memory stays one chunk per thread.
let last = null;
async function chunkTable(metaPath) {
  if (last?.metaPath !== metaPath) { last = null; last = { metaPath, table: decodeChunk(metaPath) }; }
  return last.table;
}

/**
 * @param {{metaPath:string, tiles:{uri:string, offset:number, count:number}[], outDir:string, centroids?:boolean, concurrency?:number}} a
 *        `concurrency`: tiles of the chunk encoded at once (their gzip runs on Node's own thread pool)
 * @returns {Promise<number>} tiles written
 */
export async function sogChunkToFiles({ metaPath, tiles, outDir, centroids = false, concurrency = 2 }) {
  const table = await chunkTable(metaPath);
  await parallelMap(tiles, async ({ uri, offset, count }) => {
    const { positions, alphas, rgb, scales, rotations } = extractRange(table, offset, count);
    const bounds = computeBounds(positions, count);
    const glb = await buildSplatTileGlb({ positions, alphas, rgb, scales, rotations }, count, bounds, centroids);
    await fs.writeFile(path.join(outDir, uri), glb);
  }, { concurrency });
  return tiles.length;
}
