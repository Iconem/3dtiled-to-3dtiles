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

const HEADER_SIZE = 375;          // LAS 1.4
const PDRF = 7;                   // XYZ + intensity + return/classification + GPS time + RGB
const RECORD_LEN = 36;

// Build the 375-byte LAS 1.4 header. `count`/`bbox` may be patched later (write placeholders first).
function buildHeader({ scale, offset, count = 0, bbox = null }) {
  const h = Buffer.alloc(HEADER_SIZE);
  h.write('LASF', 0, 'latin1');
  h.writeUInt8(1, 24); h.writeUInt8(4, 25);                 // version 1.4
  h.write('3dtiled las-writer', 58, 'latin1');              // generating software
  h.writeUInt16LE(HEADER_SIZE, 94);                          // header size
  h.writeUInt32LE(HEADER_SIZE, 96);                          // offset to point data (no VLRs)
  h.writeUInt32LE(0, 100);                                   // # VLRs
  h.writeUInt8(PDRF, 104);                                   // point data record format
  h.writeUInt16LE(RECORD_LEN, 105);                          // point data record length
  // legacy 32-bit count: valid only for PDRF 0–5; PDRF 6–10 → must be 0 (use the 64-bit field).
  h.writeUInt32LE(0, 107);
  h.writeDoubleLE(scale[0], 131); h.writeDoubleLE(scale[1], 139); h.writeDoubleLE(scale[2], 147);
  h.writeDoubleLE(offset[0], 155); h.writeDoubleLE(offset[1], 163); h.writeDoubleLE(offset[2], 171);
  const b = bbox || { min: [0, 0, 0], max: [0, 0, 0] };
  h.writeDoubleLE(b.max[0], 179); h.writeDoubleLE(b.min[0], 187);   // MaxX, MinX
  h.writeDoubleLE(b.max[1], 195); h.writeDoubleLE(b.min[1], 203);   // MaxY, MinY
  h.writeDoubleLE(b.max[2], 211); h.writeDoubleLE(b.min[2], 219);   // MaxZ, MinZ
  h.writeBigUInt64LE(BigInt(count), 247);                   // 64-bit number of point records
  return h;
}

// Encode one PDRF-7 record into `buf` at `o`. coords are already quantized int32.
function writeRecord(buf, o, ix, iy, iz, intensity, r, g, b) {
  buf.writeInt32LE(ix, o); buf.writeInt32LE(iy, o + 4); buf.writeInt32LE(iz, o + 8);
  buf.writeUInt16LE(intensity & 0xffff, o + 12);
  buf.writeUInt8(0x11, o + 14);     // return number 1 / number of returns 1
  buf.writeUInt8(0, o + 15);        // classification flags / scanner channel / dir / edge
  buf.writeUInt8(0, o + 16);        // classification
  buf.writeUInt8(0, o + 17);        // user data
  buf.writeInt16LE(0, o + 18);      // scan angle
  buf.writeUInt16LE(0, o + 20);     // point source id
  buf.writeDoubleLE(0, o + 22);     // GPS time (PDRF 6+ requires it)
  buf.writeUInt16LE(r & 0xffff, o + 30); buf.writeUInt16LE(g & 0xffff, o + 32); buf.writeUInt16LE(b & 0xffff, o + 34);
}

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
