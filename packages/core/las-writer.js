/**
 * las-writer.js — out-of-core LAS 1.4 writer (PDRF 7: XYZ + intensity + RGB).
 *
 * There is no maintained JS/WASM LAS *writer* (readers only; laz-perf is decode-only; no PDAL-Node
 * binding), so we hand-write the binary. LAS is a fixed 375-byte 1.4 header + fixed-size point records,
 * which makes streaming trivial: write the header with placeholder counts, append records, and at the
 * end seek back and patch the 64-bit point count + bounding box. **O(1) memory regardless of total size**
 * — a 500 GB LAS needs ~constant RAM. For LAZ/COPC, hand this LAS to `laszip` / `pdal writers.copc` /
 * `untwine` (all out-of-core) — see [[dump-tiles-feature-idea]].
 *
 *   Node (streaming):   const w = new LasWriter('out.las', {scale, offset}); await w.open();
 *                       w.writePoint(x,y,z, {r,g,b,intensity}); … ; await w.close();
 *   Browser/Node (RAM): const ab = writeLasBuffer(pointsIterable, {scale, offset, count?});
 */
import { open as fsOpen } from 'node:fs/promises';

import { lasHeaderBytes, writeLasRecord, LAS_HEADER_SIZE, LAS_RECORD_LEN as RECORD_LEN } from './las-format.js';

const HEADER_SIZE = LAS_HEADER_SIZE;
// The header and the records are las-format.js's (shared with the browser); here they are handed out as Buffers.
const asBuffer = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
const buildHeader = (opts) => asBuffer(lasHeaderBytes(opts));
const viewOf = (buf) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const writeRecord = (buf, o, ix, iy, iz, intensity, r, g, b) => writeLasRecord(buf._view ?? (buf._view = viewOf(buf)), o, ix, iy, iz, intensity, r, g, b);

// ── disk-free streaming helpers (2-pass: count in pass 1, write header, stream records in pass 2) ──
export const LAS_RECORD_LEN = RECORD_LEN;
/** 375-byte LAS 1.4 header (count + bbox known upfront). */
export const lasHeaderBuffer = (opts) => buildHeader(opts);
/** One PDRF-7 record → a fresh 36-byte Buffer (world coords; quantized against scale/offset). */
export function lasRecordBuffer(x, y, z, attrs, scale, offset) {
  const buf = Buffer.allocUnsafe(RECORD_LEN);
  writeRecord(buf, 0, Math.round((x - offset[0]) / scale[0]), Math.round((y - offset[1]) / scale[1]), Math.round((z - offset[2]) / scale[2]),
    attrs?.intensity || 0, attrs?.r || 0, attrs?.g || 0, attrs?.b || 0);
  return buf;
}

/** Streaming Node writer — constant memory; back-patches count + bbox on close(). */
export class LasWriter {
  constructor(path, { scale = [0.001, 0.001, 0.001], offset = [0, 0, 0], bufferBytes = 1 << 20 } = {}) {
    this.path = path; this.scale = scale; this.offset = offset;
    this.count = 0; this.min = [Infinity, Infinity, Infinity]; this.max = [-Infinity, -Infinity, -Infinity];
    this._buf = Buffer.allocUnsafe(Math.max(bufferBytes - (bufferBytes % RECORD_LEN), RECORD_LEN * 256));
    this._o = 0; this._fh = null;
  }
  async open() {
    this._fh = await fsOpen(this.path, 'w');
    await this._fh.write(buildHeader({ scale: this.scale, offset: this.offset }));   // placeholder
  }
  async _flush() { if (this._o) { await this._fh.write(this._buf.subarray(0, this._o)); this._o = 0; } }
  /** Append a point in world coords. `attrs` = {r,g,b (0–65535), intensity}. */
  async writePoint(x, y, z, attrs = {}) {
    if (this._o + RECORD_LEN > this._buf.length) await this._flush();
    const ix = Math.round((x - this.offset[0]) / this.scale[0]);
    const iy = Math.round((y - this.offset[1]) / this.scale[1]);
    const iz = Math.round((z - this.offset[2]) / this.scale[2]);
    writeRecord(this._buf, this._o, ix, iy, iz, attrs.intensity || 0, attrs.r || 0, attrs.g || 0, attrs.b || 0);
    this._o += RECORD_LEN;
    this.count++;
    if (x < this.min[0]) this.min[0] = x; if (x > this.max[0]) this.max[0] = x;
    if (y < this.min[1]) this.min[1] = y; if (y > this.max[1]) this.max[1] = y;
    if (z < this.min[2]) this.min[2] = z; if (z > this.max[2]) this.max[2] = z;
  }
  async close() {
    await this._flush();
    // back-patch the header (count + bbox now known) at offset 0.
    const bbox = this.count ? { min: this.min, max: this.max } : null;
    const h = buildHeader({ scale: this.scale, offset: this.offset, count: this.count, bbox });
    await this._fh.write(h, 0, h.length, 0);
    await this._fh.close(); this._fh = null;
    return { count: this.count, bbox };
  }
}

/** In-memory LAS (browser/Node): `points` = iterable of {x,y,z,r?,g?,b?,intensity?}. */
export function writeLasBuffer(points, { scale = [0.001, 0.001, 0.001], offset = [0, 0, 0] } = {}) {
  const pts = Array.isArray(points) ? points : [...points];
  const out = Buffer.alloc(HEADER_SIZE + pts.length * RECORD_LEN);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let o = HEADER_SIZE;
  for (const p of pts) {
    writeRecord(out, o,
      Math.round((p.x - offset[0]) / scale[0]), Math.round((p.y - offset[1]) / scale[1]), Math.round((p.z - offset[2]) / scale[2]),
      p.intensity || 0, p.r || 0, p.g || 0, p.b || 0);
    o += RECORD_LEN;
    for (const k of [0, 1, 2]) { const v = [p.x, p.y, p.z][k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  }
  buildHeader({ scale, offset, count: pts.length, bbox: pts.length ? { min, max } : null }).copy(out, 0);
  return out;
}
