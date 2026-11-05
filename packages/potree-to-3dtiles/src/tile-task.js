/**
 * tile-task.js (potree-to-3dtiles) — one Potree node → its GLB file, as a tile worker runs it (core's
 * task-worker.js, behind TILED_WORKERS / the `workers` option). The worker reads the node's bytes from disk
 * itself, so nothing but the task's description crosses threads. `nodeGlb` is the same work on the caller's
 * thread, from an already decoded node.
 */
import fs from 'fs/promises';
import path from 'path';
import { buildPointsGlb } from '../../core/index.js';
import { decodePotree2Node } from './potree2.js';
import { decodePotree1Node } from './potree1.js';

/** A decoded node (world coords) → GLB bytes relative to the dataset centre `gc`, or null when it has no points. */
export async function nodeGlb(data, gc) {
  if (!data || data.count <= 0) return null;
  const local = new Float32Array(data.count * 3);
  for (let i = 0; i < data.count; i++) {
    local[i*3]   = data.positions[i*3]   - gc[0];
    local[i*3+1] = data.positions[i*3+1] - gc[1];
    local[i*3+2] = data.positions[i*3+2] - gc[2];
  }
  // buildPointsGlb applies the Y-up swizzle (E,U,−N) internally — pass (E,N,U).
  return buildPointsGlb(local, data.colors, data.count, { attributes: data.attributes });
}

const handles = new Map();   // octree.bin path → open handle, for the life of the worker

/**
 * @param {{kind:'2'|'1', file:string, node:object, gc:number[], tilePath:string, meta?:object, schema?:object, spec?:object}} a
 *   kind '2': `file` is octree.bin, node { byteOffset, byteSize, numPoints }; kind '1': `file` is the node's .bin/.laz, node { name, box }.
 * @returns {Promise<boolean>} whether a tile was written
 */
export async function potreeNodeToFile({ kind, file, node, gc, tilePath, meta, schema, spec }) {
  let data;
  if (kind === '2') {
    if (!node.byteSize) return false;
    let fh = handles.get(file); if (!fh) handles.set(file, fh = await fs.open(file, 'r'));
    const raw = Buffer.alloc(node.byteSize);
    await fh.read(raw, 0, node.byteSize, node.byteOffset);
    data = decodePotree2Node(meta, schema, node, raw);
  } else {
    const bytes = await fs.readFile(file).catch(() => null);
    if (!bytes) return false;
    data = await decodePotree1Node(spec, node, bytes);
  }
  const glb = await nodeGlb(data, gc);
  if (!glb) return false;
  await fs.mkdir(path.dirname(tilePath), { recursive: true });
  await fs.writeFile(tilePath, glb);
  return true;
}
