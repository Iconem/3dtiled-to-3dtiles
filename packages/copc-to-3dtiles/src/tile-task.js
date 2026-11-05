/**
 * tile-task.js (copc-to-3dtiles) — one COPC node → its GLB file, as a tile worker runs it (core's task-worker.js,
 * behind TILED_WORKERS / the `workers` option). The worker reads the node's chunk from the input itself, so
 * nothing but the task's description crosses threads.
 */
import { Copc } from 'copc';
import { writeTileGlb } from './glbWriter.js';

/** @param {{input:string, header:object, eb:any, node:object, origin:number[], tilePath:string}} a */
export async function copcNodeToFile({ input, header, eb, node, origin, tilePath }) {
  const view = await Copc.loadPointDataView(input, { header, eb }, node);
  await writeTileGlb(view, origin, tilePath);
  return true;
}
