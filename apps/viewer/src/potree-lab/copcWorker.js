/**
 * Worker of CopcLoader (./copcPlugin.js): one compressed COPC chunk in, one packed buffer of geometry
 * arrays out (./copcDecode.js), transferred back. The page fetches; the worker only decodes.
 *
 * In:  { id, compressed: ArrayBuffer, job }
 * Out: { id, buffer: ArrayBuffer, decodeMs } or { id, error: string }
 */
import { decodeChunk, loadLazPerf } from './copcDecode.js';

let lazPerf = null;

self.onmessage = async ({ data }) => {
  const { id, compressed, job } = data;
  try {
    lazPerf ??= loadLazPerf();
    const LazPerf = await lazPerf;
    const t0 = performance.now();
    const buffer = decodeChunk(LazPerf, new Uint8Array(compressed), job);
    self.postMessage({ id, buffer, decodeMs: performance.now() - t0 }, [buffer]);
  } catch (e) {
    self.postMessage({ id, error: String(e?.message ?? e) });
  }
};
