/**
 * One COPC chunk (LAZ, point formats 6 to 8) → the arrays a geometry is made of, packed in ONE
 * ArrayBuffer. No three.js here: the same code runs in a worker (./copcWorker.js) and, when no worker
 * can be started, on the main thread.
 *
 * Why one buffer: it crosses from the worker to the page as a single transfer (no copy), it is what
 * the renderer's download step hands to its parse step (which wants an ArrayBuffer and reads its first
 * four bytes as a magic), and the geometry's attributes are views on it, so nothing is copied again.
 *
 * Layout (little endian):
 *    0  'CPCD'
 *    4  uint32   point count
 *    8  uint32   bit 0: the colour width is known, bit 1: colours are on 16 bits, bits 8-15: attribute mask
 *   16  float64  GPS time base (the `gpsTime` values are seconds after it)
 *   24  float64 × 3  the centre the positions are relative to
 *   48  float32 × 3n  position
 *       float32 × n   gpsTime                (ATTR.gpsTime)
 *       uint16 × 3n   color, linear          (always: the file's RGB, or its intensity as a grey)
 *       uint16 × n    intensity              (ATTR.intensity)
 *       uint16 × n    pointSourceId          (ATTR.pointSourceId)
 *       uint8 × n     classification, returnNumber, numberOfReturns, userData (each when asked for)
 */
import { createLazPerf } from 'laz-perf';
import lazPerfWasm from 'laz-perf/lib/web/laz-perf.wasm?url';

/** The attributes read beside position and colour, as bits of a mask. */
export const ATTR = { intensity: 1, classification: 2, returnNumber: 4, numberOfReturns: 8, pointSourceId: 16, userData: 32, gpsTime: 64 };
export const ATTR_ALL = 127;
export const HEADER_BYTES = 48;
const MAGIC = 0x44435043;        // 'CPCD' read as a little-endian uint32

/** `['intensity', 'classification']` → mask. Unknown names are ignored. */
export function attributeMask(names) {
  let mask = 0;
  for (const n of names) mask |= ATTR[n] || 0;
  return mask;
}

// sRGB byte → linear, as a normalized uint16 (what three expects of a vertex colour)
const SRGB_TO_LINEAR16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR16[i] = Math.round((c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * 65535);
}

/** laz-perf (wasm). The web build also runs in a worker once it is told where its wasm is. */
export function loadLazPerf() {
  return createLazPerf({ locateFile: () => lazPerfWasm });
}

/** Where each array sits in a packed buffer of `n` points with the attributes of `mask`. */
export function packedLayout(n, mask) {
  let at = HEADER_BYTES;
  const take = (bytes) => { const o = at; at += bytes; return o; };
  const l = { position: take(12 * n) };
  if (mask & ATTR.gpsTime) l.gpsTime = take(4 * n);
  l.color = take(6 * n);
  if (mask & ATTR.intensity) l.intensity = take(2 * n);
  if (mask & ATTR.pointSourceId) l.pointSourceId = take(2 * n);
  if (mask & ATTR.classification) l.classification = take(n);
  if (mask & ATTR.returnNumber) l.returnNumber = take(n);
  if (mask & ATTR.numberOfReturns) l.numberOfReturns = take(n);
  if (mask & ATTR.userData) l.userData = take(n);
  l.byteLength = at;
  return l;
}

/** Typed-array views on a packed buffer, and what its header says. */
export function unpack(buffer) {
  const head = new DataView(buffer, 0, HEADER_BYTES);
  if (head.getUint32(0, true) !== MAGIC) throw new Error('COPC: not a decoded chunk');
  const n = head.getUint32(4, true), flags = head.getUint32(8, true), mask = (flags >> 8) & 0xff;
  const l = packedLayout(n, mask);
  const out = {
    count: n, mask,
    wide: flags & 1 ? Boolean(flags & 2) : null,
    gpsBase: head.getFloat64(16, true),
    center: [head.getFloat64(24, true), head.getFloat64(32, true), head.getFloat64(40, true)],
    position: new Float32Array(buffer, l.position, 3 * n),
    color: new Uint16Array(buffer, l.color, 3 * n),
  };
  if (l.gpsTime !== undefined) out.gpsTime = new Float32Array(buffer, l.gpsTime, n);
  if (l.intensity !== undefined) out.intensity = new Uint16Array(buffer, l.intensity, n);
  if (l.pointSourceId !== undefined) out.pointSourceId = new Uint16Array(buffer, l.pointSourceId, n);
  for (const k of ['classification', 'returnNumber', 'numberOfReturns', 'userData']) if (l[k] !== undefined) out[k] = new Uint8Array(buffer, l[k], n);
  return out;
}

/**
 * Decompress one chunk and write its arrays. `job`: { pointCount, format, recordLength, scale,
 * offset, center, mask, wide (true, false, or null: find out), gpsBase (a number, or null: the first
 * point's time) }. Each LAS record is read where laz-perf leaves it in the wasm heap: no copy of the
 * records is kept.
 */
export function decodeChunk(LazPerf, compressed, job) {
  const { pointCount: n, format, recordLength, scale, offset, center, mask } = job;
  const l = packedLayout(n, mask);
  const buffer = new ArrayBuffer(l.byteLength);
  const head = new DataView(buffer, 0, HEADER_BYTES);
  const position = new Float32Array(buffer, l.position, 3 * n);
  const color = new Uint16Array(buffer, l.color, 3 * n);
  const gpsTime = l.gpsTime !== undefined ? new Float32Array(buffer, l.gpsTime, n) : null;
  const intensity = l.intensity !== undefined ? new Uint16Array(buffer, l.intensity, n) : null;
  const pointSourceId = l.pointSourceId !== undefined ? new Uint16Array(buffer, l.pointSourceId, n) : null;
  const classification = l.classification !== undefined ? new Uint8Array(buffer, l.classification, n) : null;
  const returnNumber = l.returnNumber !== undefined ? new Uint8Array(buffer, l.returnNumber, n) : null;
  const numberOfReturns = l.numberOfReturns !== undefined ? new Uint8Array(buffer, l.numberOfReturns, n) : null;
  const userData = l.userData !== undefined ? new Uint8Array(buffer, l.userData, n) : null;

  const [sx, sy, sz] = scale, [ox, oy, oz] = offset, [cx, cy, cz] = center;
  const hasRgb = format >= 7;                       // formats 7 and 8: red, green, blue at byte 30
  let gpsBase = job.gpsBase ?? null, maxRgb = 0;

  if (n) {
    const blob = LazPerf._malloc(compressed.byteLength);
    const p = LazPerf._malloc(recordLength);
    const decoder = new LazPerf.ChunkDecoder();
    try {
      LazPerf.HEAPU8.set(compressed, blob);
      decoder.open(format, recordLength, blob);
      let heap = new DataView(LazPerf.HEAPU8.buffer);
      for (let i = 0; i < n; i++) {
        decoder.getPoint(p);
        if (heap.buffer !== LazPerf.HEAPU8.buffer) heap = new DataView(LazPerf.HEAPU8.buffer);   // the heap grew
        position[i * 3] = heap.getInt32(p, true) * sx + ox - cx;
        position[i * 3 + 1] = heap.getInt32(p + 4, true) * sy + oy - cy;
        position[i * 3 + 2] = heap.getInt32(p + 8, true) * sz + oz - cz;
        const it = heap.getUint16(p + 12, true);
        if (hasRgb) {
          const r = heap.getUint16(p + 30, true), g = heap.getUint16(p + 32, true), b = heap.getUint16(p + 34, true);
          color[i * 3] = r; color[i * 3 + 1] = g; color[i * 3 + 2] = b;
          if (r > maxRgb) maxRgb = r; if (g > maxRgb) maxRgb = g; if (b > maxRgb) maxRgb = b;
        } else {
          // no colour in the file: its intensity, as a grey (the top byte, or the value itself when it fits one)
          color[i * 3] = color[i * 3 + 1] = color[i * 3 + 2] = SRGB_TO_LINEAR16[it > 255 ? it >> 8 : it];
        }
        if (intensity) intensity[i] = it;
        if (returnNumber || numberOfReturns) {
          const returns = heap.getUint8(p + 14);    // low nibble: return number, high nibble: number of returns
          if (returnNumber) returnNumber[i] = returns & 15;
          if (numberOfReturns) numberOfReturns[i] = returns >> 4;
        }
        if (classification) classification[i] = heap.getUint8(p + 16);
        if (userData) userData[i] = heap.getUint8(p + 17);
        if (pointSourceId) pointSourceId[i] = heap.getUint16(p + 20, true);
        if (gpsTime) {
          const t = heap.getFloat64(p + 22, true);
          if (gpsBase === null) gpsBase = t;
          gpsTime[i] = t - gpsBase;
        }
      }
    } finally {
      LazPerf._free(blob);
      LazPerf._free(p);
      decoder.delete();
    }
  }

  // RGB is 16 bits by the specification, but many files store 8-bit values as they are: the first
  // chunk with points decides for the file (a value above 255 means 16 bits)
  let wide = job.wide ?? null;
  if (hasRgb && n) {
    if (wide === null) wide = maxRgb > 255;
    const shift = wide ? 8 : 0;
    for (let i = 0; i < color.length; i++) { const v = color[i] >> shift; color[i] = SRGB_TO_LINEAR16[v > 255 ? 255 : v]; }
  }

  head.setUint32(0, MAGIC, true);
  head.setUint32(4, n, true);
  head.setUint32(8, (wide === null ? 0 : 1) | (wide ? 2 : 0) | (mask << 8), true);
  head.setFloat64(16, gpsBase ?? 0, true);
  head.setFloat64(24, cx, true); head.setFloat64(32, cy, true); head.setFloat64(40, cz, true);
  return buffer;
}
