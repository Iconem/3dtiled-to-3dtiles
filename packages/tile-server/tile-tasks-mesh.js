/**
 * tile-tasks-mesh.js — what a tile worker runs for the live server's mesh formats (see tile-tasks.js for the point
 * clouds, core's task-worker.js for the worker). Each task takes what the server's thread fetched and returns the GLB.
 */
import { i3sNodeGlb, threemxNodeGlb, osgbUnitGlb } from './mesh-tile.js';

const asBuffer = (u8) => (u8 ? Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength) : u8);

/** @param {{buf:Uint8Array, spec:object, texture?:{bytes:Uint8Array,mimeType:string}, rgbBuf?:Uint8Array|null}} a */
export const i3sTileTask = ({ buf, spec, texture, rgbBuf }) =>
  i3sNodeGlb(asBuffer(buf), spec, async () => (texture ? { ...texture, bytes: asBuffer(texture.bytes) } : undefined), async () => asBuffer(rgbBuf));

/** @param {{bytes:Uint8Array, nodeIdx:number}} a one .3mxb file and the node of it to build */
export const threemxTileTask = ({ bytes, nodeIdx }) => threemxNodeGlb(asBuffer(bytes), nodeIdx);

/** @param {{bytes:Uint8Array, unitIdx:number}} a one .osgb file and the unit of it to build */
export const osgbTileTask = ({ bytes, unitIdx }) => osgbUnitGlb(asBuffer(bytes), unitIdx);
