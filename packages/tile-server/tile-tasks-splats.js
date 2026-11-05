/**
 * tile-tasks-splats.js — what a tile worker runs for the live server's splat formats (see tile-tasks.js for the
 * point clouds, core's task-worker.js for the worker). Each task takes what the server's thread fetched and returns
 * the GLB, or for a streamed-SOG chunk its decoded columns.
 */
import { lccSplatGlb, radChunkGlb, sogChunkColumns, splatArraysGlb, geosplatsBundleGlb } from './splat-tile.js';

const asBuffer = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);

export const lccTileTask = ({ buf, pts, scaleMin, scaleMax, centroids }) => lccSplatGlb(asBuffer(buf), pts, scaleMin, scaleMax, centroids);
export const radTileTask = ({ cbuf, local, base, centroids }) => radChunkGlb(asBuffer(cbuf), local, base, centroids);
export const sogChunkTask = ({ files }) => sogChunkColumns(files);
export const splatArraysTask = ({ arrays, count, centroids }) => splatArraysGlb(arrays, count, centroids);
export const geosplatsTileTask = ({ buf, files }) => geosplatsBundleGlb(buf, files);
