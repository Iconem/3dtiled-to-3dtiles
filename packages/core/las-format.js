/**
 * las-format.js — the bytes of a LAS 1.4 file (PDRF 7: XYZ + intensity + RGB): its 375-byte header and its 36-byte
 * point records. No imports and no Buffer, so the same code writes a LAS on the server (las-writer.js, which adds the
 * file handling) and in a browser (extract-core.js).
 */
export const LAS_HEADER_SIZE = 375;   // LAS 1.4
export const LAS_RECORD_LEN = 36;
const PDRF = 7;                       // XYZ + intensity + return/classification + GPS time + RGB

const ascii = (u8, text, at) => { for (let i = 0; i < text.length; i++) u8[at + i] = text.charCodeAt(i) & 0xff; };

/**
 * The 375-byte LAS 1.4 header. `count` and `bbox` may be written later: write it first with neither, then again at
 * offset 0 once they are known.
 * @param {{scale:number[], offset:number[], count?:number, bbox?:{min:number[], max:number[]}|null}} o
 * @returns {Uint8Array}
 */
export function lasHeaderBytes({ scale, offset, count = 0, bbox = null }) {
  const u8 = new Uint8Array(LAS_HEADER_SIZE), h = new DataView(u8.buffer);
  ascii(u8, 'LASF', 0);
  h.setUint8(24, 1); h.setUint8(25, 4);                      // version 1.4
  ascii(u8, '3dtiled las-writer', 58);                       // generating software
  h.setUint16(94, LAS_HEADER_SIZE, true);                    // header size
  h.setUint32(96, LAS_HEADER_SIZE, true);                    // offset to point data (no VLRs)
  h.setUint32(100, 0, true);                                 // # VLRs
  h.setUint8(104, PDRF);                                     // point data record format
  h.setUint16(105, LAS_RECORD_LEN, true);                    // point data record length
  // legacy 32-bit count: valid only for PDRF 0–5; PDRF 6–10 → must be 0 (use the 64-bit field).
  h.setUint32(107, 0, true);
  h.setFloat64(131, scale[0], true); h.setFloat64(139, scale[1], true); h.setFloat64(147, scale[2], true);
  h.setFloat64(155, offset[0], true); h.setFloat64(163, offset[1], true); h.setFloat64(171, offset[2], true);
  const b = bbox || { min: [0, 0, 0], max: [0, 0, 0] };
  h.setFloat64(179, b.max[0], true); h.setFloat64(187, b.min[0], true);   // MaxX, MinX
  h.setFloat64(195, b.max[1], true); h.setFloat64(203, b.min[1], true);   // MaxY, MinY
  h.setFloat64(211, b.max[2], true); h.setFloat64(219, b.min[2], true);   // MaxZ, MinZ
  h.setBigUint64(247, BigInt(count), true);                  // 64-bit number of point records
  return u8;
}

/** One PDRF-7 record into `view` at byte `o`. Coordinates are already quantized int32; colours 0..65535. */
export function writeLasRecord(view, o, ix, iy, iz, intensity, r, g, b) {
  view.setInt32(o, ix, true); view.setInt32(o + 4, iy, true); view.setInt32(o + 8, iz, true);
  view.setUint16(o + 12, intensity & 0xffff, true);
  view.setUint8(o + 14, 0x11);      // return number 1 / number of returns 1
  view.setUint8(o + 15, 0);         // classification flags / scanner channel / dir / edge
  view.setUint8(o + 16, 0);         // classification
  view.setUint8(o + 17, 0);         // user data
  view.setInt16(o + 18, 0, true);   // scan angle
  view.setUint16(o + 20, 0, true);  // point source id
  view.setFloat64(o + 22, 0, true); // GPS time (PDRF 6+ requires it)
  view.setUint16(o + 30, r & 0xffff, true); view.setUint16(o + 32, g & 0xffff, true); view.setUint16(o + 34, b & 0xffff, true);
}
