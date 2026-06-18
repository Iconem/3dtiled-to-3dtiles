/**
 * radHeader.js  (rad-to-3dtiles)
 *
 * Pure-JS parser for SparkJS .RAD binary format.
 * Verified against coit-40m-sh1-lod.rad and tastier500k.rad (Jun 2026).
 *
 * .RAD monolithic file layout:
 *   [0–3]   "RAD0"            4 bytes ASCII magic
 *   [4–7]   uint32 LE         JSON byte length
 *   [8..8+jsonLen-1]          UTF-8 root header JSON
 *   [aligned to 8 bytes]      padding
 *   [RADC chunk 0]
 *   [RADC chunk 1 padded to 8-byte boundary]
 *   ...
 *
 * .RAD streaming manifest layout:
 *   Same header structure, but allChunkBytes may exceed the file size.
 *   Chunk data is NOT embedded — it must be fetched via HTTP range requests.
 *   Detection: header.allChunkBytes > (fileSize - payloadBase)
 *
 * .RADC chunk layout (within payload, confirmed from Rust source):
 *   [0–3]   "RADC"            4 bytes ASCII magic
 *   [4–7]   uint32 LE         JSON byte length
 *   [8..8+jsonLen-1]          UTF-8 chunk meta JSON
 *   [padded to 8-byte boundary]
 *   [payloadBytesOffset..+8]  uint64 LE payload size
 *   [payload: property data]  padded to 8 bytes
 *
 * Root header chunks array: { "offset": N, "bytes": N }
 *   chunk.offset is relative to the aligned payload base (start of first RADC magic)
 *
 * Topology: child_count and child_start are stored at the SPLAT level, not the chunk level.
 *   child_start[0] = global splat index of first child splat
 *   → chunk index  = Math.floor(child_start[0] / header.chunkSize)
 *
 * Properties compressed with miniz_oxide compress_to_vec = RAW DEFLATE (no zlib header).
 * Use inflateRawSync, NOT gunzipSync or inflateSync.
 *
 * Property encodings (require SparkJS utils to fully decode):
 *   center:      f32_lebytes — raw float32 LE, 3 per splat (x,y,z)
 *   alpha:       f16         — float16, opacity [0..1], *2 if lodOpacity
 *   rgb:         r8_delta    — uint8, first splat absolute, rest are deltas
 *   scales:      ln_0r8      — uint8 log-encoded, 0=zero, 1..255=exp(lnMin+(v-1)/254*(lnMax-lnMin))
 *   orientation: oct88r8     — octahedral uint8 u,v + rotation angle uint8
 *   sh1:         s8          — signed int8 SH1 coefficients
 *   child_count: u16         — uint16, LoD tree children count per splat
 *   child_start: u32         — uint32, LoD tree first child SPLAT index (not chunk index)
 */

import { inflateRawSync } from 'zlib';

const MAGIC_RAD  = 'RAD0';
const MAGIC_RADC = 'RADC';

function readMagic(buf, offset = 0) {
  return String.fromCharCode(buf[offset], buf[offset+1], buf[offset+2], buf[offset+3]);
}

function readU32LE(buf, offset) {
  return (buf[offset] | (buf[offset+1]<<8) | (buf[offset+2]<<16) | (buf[offset+3]<<24)) >>> 0;
}

function readU64LE(buf, offset) {
  const lo = readU32LE(buf, offset);
  const hi = readU32LE(buf, offset + 4);
  return hi * 0x100000000 + lo;
}

function pad8(n) { return Math.ceil(n / 8) * 8; }

/**
 * Parse .RAD root header.
 * Returns header JSON, the byte offset where chunk data begins, and streaming flag.
 */
export function parseRadHeader(buf) {
  if (readMagic(buf) !== MAGIC_RAD) throw new Error(`Expected RAD0, got "${readMagic(buf)}"`);
  const jsonLen    = readU32LE(buf, 4);
  const header     = JSON.parse(buf.slice(8, 8 + jsonLen).toString('utf8'));
  const payloadBase = pad8(8 + jsonLen);

  // Streaming manifest: chunk data is not embedded in the file
  const isStreaming = header.allChunkBytes > (buf.length - payloadBase);
  return { header, payloadBase, isStreaming };
}

/**
 * Parse one RADC chunk and decompress specified properties.
 *
 * @param {Buffer}   buf            full .rad buffer
 * @param {object}   chunk          { offset, bytes } from header.chunks
 * @param {number}   payloadBase    byte offset to first RADC (from parseRadHeader)
 * @param {string[]} wantProperties list of property names to decompress (default: all)
 * @returns {{ meta, count, props: Map<string, Buffer> }}
 */
export function parseRadcChunk(buf, chunk, payloadBase, wantProperties = null) {
  const chunkStart = payloadBase + chunk.offset;
  
  // RADC: [magic 4][jsonLen 4][json][pad to 8][payloadBytes 8][payload]
  if (readMagic(buf, chunkStart) !== MAGIC_RADC) {
    throw new Error(`Expected RADC at offset ${chunkStart}, got "${readMagic(buf, chunkStart)}"`);
  }

  const cJsonLen   = readU32LE(buf, chunkStart + 4);
  const meta       = JSON.parse(buf.slice(chunkStart + 8, chunkStart + 8 + cJsonLen).toString('utf8'));
  const metaPadEnd = pad8(8 + cJsonLen);   // offset within chunk to payloadBytes field
  const propDataStart = chunkStart + metaPadEnd + 8;  // offset in buf to first property data

  const count = meta.count ?? meta.numSplats ?? 0;
  const props = new Map();

  for (const prop of (meta.properties ?? [])) {
    if (wantProperties && !wantProperties.includes(prop.property)) continue;
    const propStart = propDataStart + prop.offset;
    const propLen   = prop.bytes;
    const compressed = buf.slice(propStart, propStart + propLen);
    const raw = inflateRawSync(compressed);
    props.set(prop.property, raw);
  }

  return { meta, count, props };
}

/**
 * Build the LoD tree topology from all chunks.
 *
 * RAD topology is stored at the SPLAT level: child_start[0] is the global splat index
 * of the first child splat. To find the chunk containing that splat:
 *   chunkIndex = Math.floor(child_start[0] / chunkSize)
 *
 * child_count[0] = number of children at the CHUNK level (small integer, typically 0–8).
 * child_start[0] = splat index of first child splat → map to chunk index.
 *
 * @param {object[]} chunks      header.chunks array
 * @param {Buffer}   buf         full .rad buffer
 * @param {number}   payloadBase from parseRadHeader
 * @param {number}   chunkSize   header.chunkSize (splats per chunk, typically 65536)
 */
export function buildNodeTable(chunks, buf, payloadBase, chunkSize = 65536) {
  return chunks.map((chunk, ci) => {
    const { count, props } = parseRadcChunk(buf, chunk, payloadBase, ['child_count', 'child_start']);
    const ccBuf = props.get('child_count');
    const csBuf = props.get('child_start');
    if (!ccBuf || !csBuf) {
      throw new Error(`Chunk ${ci} missing child_count/child_start. File may not be an LoD RAD.`);
    }
    // TypedArray views require the byteOffset to be a multiple of the element
    // size. Buffers returned by zlib inflate are NOT guaranteed to be aligned,
    // so a direct view can throw "start offset must be a multiple of N". Read
    // via DataView (byte-addressable, no alignment constraint) instead.
    const ccView = new DataView(ccBuf.buffer, ccBuf.byteOffset, ccBuf.byteLength);
    const csView = new DataView(csBuf.buffer, csBuf.byteOffset, csBuf.byteLength);
    const childCount = new Uint16Array(count);
    const childStart = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      childCount[i] = ccView.getUint16(i * 2, true);
      childStart[i] = csView.getUint32(i * 4, true);
    }

    // Scan up to the first SCAN_LIMIT splats to find child-chunk indices.
    // BhattLod orders coarse splats first, so they reference all child chunks.
    // Scanning all splats on large files (50M+) exhausts memory; 1000 is plenty.
    const SCAN_LIMIT = Math.min(count, 1000);
    const childChunkSet = new Set();
    for (let i = 0; i < SCAN_LIMIT; i++) {
      if (childCount[i] > 0 && childStart[i] > 0) {
        const cc = Math.floor(childStart[i] / chunkSize);
        if (cc > ci && cc < chunks.length) childChunkSet.add(cc);
      }
    }
    const children = [...childChunkSet].sort((a, b) => a - b);

    // Keep legacy childStart/childCount for tilesetBuilder compatibility,
    // but also expose children[] for the full non-consecutive list.
    return {
      nodeIndex:  ci,
      children,                          // full list of child chunk indices
      childStart: children[0] ?? 0,
      childCount: children.length,
      bounds:     null,
      chunkIndex: ci,
      splatCount: count,
    };
  });
}
