/**
 * sparkRad.js — Spark's own RAD decoder, called from Node.
 *
 * `vendor/spark-rad-wasm` is Spark's Rust library (`rust/spark-lib`, feature `rad`) compiled to WebAssembly behind
 * two functions (source and build notes in `rust/spark-rad-wasm`). It is the reference for the format: our own
 * reader (`radHeader.js`, `index.js`) was written from reading the format, this one is the code that writes it.
 * Used to check our reader (`sparkRad.test.js`), and as the source of what ours does not decode: the
 * spherical-harmonic bands.
 *
 * The module is loaded on first use (a synchronous WebAssembly compile of 250 KB), once per thread.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let mod = null;
const load = () => (mod ??= require('../vendor/spark-rad-wasm/spark_rad_wasm.js'));

/**
 * The header of a `.rad` file, from its first bytes.
 * @param {Uint8Array} bytes  the start of the file (the whole header must be in it)
 * @returns {{meta:object, chunksStart:number}|null} null when `bytes` stops before the header's end
 */
export function sparkRadHeader(bytes) {
  const h = load().radHeader(bytes);
  return h ? { meta: JSON.parse(h.meta), chunksStart: h.chunksStart } : null;
}

/**
 * One `RADC` chunk, header and payload as stored in the file, decoded by Spark.
 * Values are those Spark's renderer receives: `opacity` is the stored one (a `lodOpacity` file stores half),
 * `quat` is x, y, z, w, `sh1`/`sh2`/`sh3` hold 9, 15 and 21 values per splat (3, 5 and 7 coefficients, RGB each).
 * @param {Uint8Array} bytes
 * @returns {{count:number, maxSh:number, lodTree:boolean, lodOpacity?:boolean, center:Float32Array,
 *   opacity:Float32Array, rgb:Float32Array, scale:Float32Array, quat:Float32Array, sh1?:Float32Array,
 *   sh2?:Float32Array, sh3?:Float32Array, sh1Codes?:Float32Array, sh2Codes?:Float32Array, sh3Codes?:Float32Array,
 *   shLabels?:Uint32Array, childCount?:Uint16Array, childStart?:Uint32Array}}
 */
export function sparkDecodeChunk(bytes) {
  return load().decodeRadChunk(bytes);
}
