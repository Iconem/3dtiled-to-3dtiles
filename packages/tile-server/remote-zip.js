/**
 * remote-zip.js — generic ZIP-over-HTTP-range access, for formats packaged as a .zip whose members
 * we want to read WITHOUT downloading the whole archive (e.g. an LCC file set bundled as one .zip).
 *
 * Reuses @loaders.gl/zip's ZipFileSystem — a from-scratch, format-agnostic ZIP reader (central
 * directory + local file header parsing, STORED/DEFLATE decompression) that is NOT SLPK-specific;
 * i3s-live.js already proves the same package's ReadableFile-over-HTTP-range pattern for SLPK. Here
 * we feed it a ReadableFile backed by this repo's own Source (packages/core/source.js) instead of
 * loaders.gl's own HTTP file class, for consistency with every other range-reading adapter here.
 *
 * getFile(name)      → whole decompressed member (fine for small members: meta.lcc, index.bin).
 * rawEntryRange(name, offset, size) → a [offset,size) slice of a STORED (uncompressed-in-zip) member's
 *   raw bytes, via ONE range read that skips straight to `localFileHeaderDataOffset + offset` — no
 *   decompression, no reading anything outside the requested slice. Throws if the member is DEFLATE
 *   (not byte-seekable) — caller decides the fallback (e.g. decompress once and cache).
 */
import zlib from 'node:zlib';
import { ZipFileSystem } from '@loaders.gl/zip';
import { Source } from '../core/index.js';

// Adapts this repo's Source (plain HTTP range GETs) to loaders.gl's ReadableFile interface.
class SourceReadableFile {
  constructor(source, size) { this.source = source; this.size = size; this.bigsize = BigInt(size); this.url = source.url; this.handle = source; }
  async close() {}
  async stat() { return { size: this.size, bigsize: this.bigsize, isDirectory: false }; }
  async read(start = 0, length) {
    const s = Number(start);
    const len = length != null ? Number(length) : this.size - s;
    const buf = await this.source.range(s, len);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
}

// Local file header: sig(4) ver(2) flags(2) method(2) modtime(4) crc(4) compSz(4) uncompSz(4) nameLen(2) extraLen(2)
// then [name][extra][data]. We only need `method` + where [data] starts — same layout package-live.js
// documents for its own from-scratch (local-file, non-HTTP) .3tz reader.
async function readLocalHeader(source, localOffsetIn) {
  const localOffset = Number(localOffsetIn);
  const hdr = await source.range(localOffset, 30);
  if (hdr[0] !== 0x50 || hdr[1] !== 0x4b || hdr[2] !== 0x03 || hdr[3] !== 0x04)
    throw new Error(`remote-zip: not a local file header at offset ${localOffset}`);
  const method = hdr.readUInt16LE(8);
  const nameLen = hdr.readUInt16LE(26);
  const extraLen = hdr.readUInt16LE(28);
  return { method, dataOffset: localOffset + 30 + nameLen + extraLen };
}

export async function remoteZipFileSystem(url) {
  const source = new Source(url);
  const { total } = await source.probe(4);
  if (!Number.isFinite(total)) throw new Error(`remote-zip: ${url} did not report a size (need Content-Length/-Range)`);
  const file = new SourceReadableFile(source, total);
  const zfs = new ZipFileSystem(file);
  const names = await zfs.readdir();

  const entryCache = new Map();               // name → local-header info (method, dataOffset)
  async function entryInfo(name) {
    if (entryCache.has(name)) return entryCache.get(name);
    const cd = await zfs.stat(name);
    const info = { ...(await readLocalHeader(source, cd.localHeaderOffset)), compressedSize: Number(cd.compressedSize), uncompressedSize: cd.size };
    entryCache.set(name, info);
    return info;
  }

  return {
    names,
    /** Whole decompressed member → Buffer. Fine for small members (meta.lcc, index.bin). */
    async getFile(name) {
      const r = await zfs.fetch(name);
      return Buffer.from(await r.arrayBuffer());
    },
    /** Compression method (0=STORED, 8=DEFLATE) + sizes for `name`, without fetching its data. */
    async stat(name) { return entryInfo(name); },
    /** [offset,size) slice of a STORED member's raw bytes — ONE range read, no decompression. */
    async rawEntryRange(name, offset, size) {
      const info = await entryInfo(name);
      if (info.method !== 0) throw new Error(`remote-zip: "${name}" is compressed (method ${info.method}) — not byte-range-seekable`);
      return source.range(info.dataOffset + offset, size);
    },
    /**
     * Whole member, fully decompressed, as ONE Buffer — for a large DEFLATE member where per-tile
     * range reads into the compressed stream aren't possible (deflate isn't byte-seekable). Fetches
     * the entry's whole compressed span in one range read, then inflates it once; caller is expected
     * to cache the result (see lcc-live.js's getCtx) so this only runs once per cold source.
     */
    async getFullDecompressed(name) {
      const info = await entryInfo(name);
      const compressed = await source.range(info.dataOffset, info.compressedSize);
      if (info.method === 0) return compressed;
      if (info.method === 8) return zlib.inflateRawSync(compressed);
      throw new Error(`remote-zip: "${name}" uses unsupported compression method ${info.method}`);
    },
  };
}
