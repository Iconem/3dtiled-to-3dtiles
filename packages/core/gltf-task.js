/**
 * gltf-task.js — what a tile worker runs for the per-tile glTF transforms (core's task-worker.js imports this module
 * by URL). Decoding Draco / meshopt / KTX2 and encoding them are the CPU cost of a transformed tile; behind
 * TILED_WORKERS they leave the server's thread this way. See gltf-tiles.js for the callers' side.
 */
import { decompressGlb } from './gltf-decompress.js';
import { compressGlb } from './gltf-compress.js';

const view = (b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

/** @param {{glb:Uint8Array, opts:object}} a */
export const decompressTask = async ({ glb, opts }) => view((await decompressGlb(glb, opts)).glb);
/** @param {{glb:Uint8Array, opts:object}} a */
export const compressTask = async ({ glb, opts }) => view((await compressGlb(glb, opts)).glb);
