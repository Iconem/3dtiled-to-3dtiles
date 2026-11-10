/**
 * tile-task.js — what a tile worker runs for the offline converter (core/task-worker.js): one node → one GLB file.
 */
import fs from 'node:fs/promises';
import { nexusNodeGlb } from './nexus-glb.js';

const asBuffer = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);

/** @param {{index:object, i:number, nodeBytes:Uint8Array, textures:[number,Uint8Array][], outPath:string}} a */
export async function nexusNodeToFile({ index, i, nodeBytes, textures, outPath }) {
  const glb = await nexusNodeGlb(index, i, asBuffer(nodeBytes), new Map(textures.map(([t, b]) => [t, asBuffer(b)])));
  if (!glb) return { written: false, bytes: 0 };
  await fs.writeFile(outPath, glb);
  return { written: true, bytes: glb.byteLength };
}
