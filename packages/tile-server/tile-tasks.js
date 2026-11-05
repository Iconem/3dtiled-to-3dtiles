/**
 * tile-tasks.js — what a tile worker runs for the live server (core's task-worker.js imports this module by URL
 * and calls one export per task). Each task takes the tile's raw bytes, fetched by the server's thread, and
 * returns the finished GLB: the LAZ / brotli decode and the glTF encode are the CPU cost of a tile, and they
 * leave the event loop this way. Only when TILED_WORKERS is set; otherwise the same functions of
 * points-tile.js run in the server's thread.
 */
import { Las } from 'copc';
import { curvedLocalizer } from '../core/index.js';
import { decodePotree2Node } from '../potree-to-3dtiles/src/potree2.js';
import { decodePotree1Node } from '../potree-to-3dtiles/src/potree1.js';
import { copcViewGlb, potreeDataGlb } from './points-tile.js';

export const TILE_TASKS = new URL(import.meta.url).href;

const asBuffer = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);

// A curved placement is a proj4 closure, which cannot cross to a worker: it is rebuilt here from what made it,
// once per dataset and CRS.
const localizers = new Map();
function localizerFor({ origin, crs, transform }) {
  const k = `${origin.join(',')}|${crs}`;
  if (!localizers.has(k)) { if (localizers.size > 64) localizers.clear(); localizers.set(k, curvedLocalizer(origin, crs, transform, 'copc-live')); }
  return localizers.get(k);
}

/**
 * @param {{compressed:Uint8Array, header:object, eb:any, pointCount:number, origin:number[], colors?:string,
 *          attributes?:string|null, curved?:{origin:number[],crs:string,transform:number[]}|null, subCube?:number[]}} a
 */
export async function copcTileTask({ compressed, header, eb, pointCount, origin, colors, attributes, curved, subCube }) {
  const { pointDataRecordFormat, pointDataRecordLength } = header;
  const buffer = await Las.PointData.decompressChunk(compressed, { pointCount, pointDataRecordFormat, pointDataRecordLength });
  const view = Las.View.create(buffer, header, eb);
  return copcViewGlb(view, { origin, colors, attributes, toLocal: curved ? localizerFor(curved) : null, subCube });
}

/**
 * @param {{kind:'2'|'1', raw:Uint8Array, node:object, origin:number[], colors?:string, attributes?:string|null,
 *          meta?:{scale:number[],offset:number[]}, schema?:object, spec?:object}} a
 *   kind '2': Potree 2.0 (`meta`, `schema`, node { numPoints }); kind '1': Potree 1.x (`spec`, node { name, box }).
 */
export async function potreeTileTask({ kind, raw, node, origin, colors, attributes, meta, schema, spec }) {
  const bytes = asBuffer(raw);
  const data = kind === '2' ? decodePotree2Node(meta, schema, node, bytes) : await decodePotree1Node(spec, node, bytes);
  return potreeDataGlb(data, { origin, colors, attributes });
}
