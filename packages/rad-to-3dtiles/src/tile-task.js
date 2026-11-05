/**
 * tile-task.js (rad-to-3dtiles) — one RAD chunk → its GLB file, as a tile worker runs it (core's convertTiles). The
 * worker reads the chunk's own range of the .rad file, so nothing but the task's description crosses threads.
 */
import fs from 'fs/promises';
import { encodeChunkGlb } from './index.js';

/**
 * @param {{radPath:string, start:number, bytes:number, outPath:string, opts:object}} a
 *        `start`: the chunk's offset in the file (payloadBase + chunk.offset); `opts`: the converter's options
 * @returns {{bounds:object, featureSize:number, kept:number}} what the converter records on the node
 */
export async function radChunkToFile({ radPath, start, bytes, outPath, opts }) {
  const buf = Buffer.allocUnsafe(bytes);
  const fh = await fs.open(radPath, 'r');
  try {
    const { bytesRead } = await fh.read(buf, 0, bytes, start);
    if (bytesRead !== bytes) throw new Error(`${radPath}: ${bytesRead} of ${bytes} bytes at ${start}`);
  } finally { await fh.close(); }
  const { glb, bounds, featureSize, kept } = await encodeChunkGlb(buf, { offset: 0, bytes }, 0, opts);
  await fs.writeFile(outPath, glb);
  return { bounds, featureSize, kept };
}
