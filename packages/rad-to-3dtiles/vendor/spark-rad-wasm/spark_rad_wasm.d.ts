/* tslint:disable */
/* eslint-disable */

/**
 * One `RADC` chunk (its header and payload, as stored in the file) decoded by Spark's `RadDecoder`.
 * Returns `{ count, maxSh, lodTree, lodOpacity?, center, opacity, rgb, scale, quat, sh1?, sh2?, sh3?,
 * sh1Codes?, sh2Codes?, sh3Codes?, shLabels?, childCount?, childStart? }`: the values Spark's renderer receives,
 * before anything a renderer applies to them (a `lodOpacity` file stores half the opacity).
 */
export function decodeRadChunk(bytes: Uint8Array | number[]): any;

/**
 * The header of a `.rad` file: `{ meta: <JSON text>, chunksStart }`, or `undefined` when `bytes` stops before its end.
 */
export function radHeader(bytes: Uint8Array | number[]): any;
