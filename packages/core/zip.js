/**
 * zip.js — a ZIP archive read member by member, over HTTP with range requests or from disk, without downloading or
 * extracting it. What a dataset "zipped per tile" needs (Hong Kong's Planning Department ships each 250 m tile of its
 * photo-realistic model as one `.zip` of a few hundred `.osgb` files, 80 to 800 MB): the central directory at the end
 * of the archive lists the members, each member is then one range read of its compressed bytes, inflated here.
 *
 *   const zip = await openZip('https://host/tile.zip');     // or a local path
 *   zip.names                                               // every member, in the archive's order ('dir/' entries too)
 *   await zip.read('dir/file.osgb')                         // → Buffer, or null for a name the archive lacks
 *
 * Reads: the last 64 KB (end of central directory record, zip64 locator and record when the archive is big), the central
 * directory, then per member its local header and data in one request (a little slack after the central directory's
 * sizes, since a local header may carry a longer extra field; a second read only when it is longer still). Stored and
 * deflated members; no encryption, no spanned archives. `writeZip` makes one (stored or deflated), for tests and tools.
 */
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { fetchSourceRange, requestSource } from './source-fetch.js';

const SIG_EOCD = 0x06054b50, SIG_EOCD64_LOC = 0x07064b50, SIG_EOCD64 = 0x06064b50, SIG_CENTRAL = 0x02014b50, SIG_LOCAL = 0x04034b50;
const isHttp = (u) => /^https?:\/\//i.test(u);

/** The byte source: `{ size, read(begin, length) }` over http (range requests) or a file. */
async function byteSource(src) {
  if (isHttp(src)) {
    // the size comes with the first (suffix) range read, so the tail of the archive costs one request
    return {
      size: null,
      read: (begin, length) => fetchSourceRange(src, begin, length),
      tail: async (length) => {
        const { status, headers, body } = await requestSource(src, { headers: { Range: `bytes=-${length}` } });
        const total = status === 206 ? Number(/\/(\d+)$/.exec(headers.get('content-range') || '')?.[1]) : body.length;
        if (!Number.isFinite(total)) throw new Error(`zip: ${src.slice(-80)}: no Content-Range on a suffix range read`);
        return { total, bytes: status === 206 ? body : body.subarray(Math.max(0, body.length - length)) };
      },
    };
  }
  const fh = await fs.open(src, 'r'), size = (await fh.stat()).size;
  const read = async (begin, length) => { const b = Buffer.alloc(Math.max(0, Math.min(length, size - begin))); await fh.read(b, 0, b.length, begin); return b; };
  return { size, read, tail: async (length) => ({ total: size, bytes: await read(Math.max(0, size - length), Math.min(length, size)) }), close: () => fh.close() };
}

/**
 * Open an archive: its member table from the central directory. `{ src, size, names, entries, read(name) }`.
 * @param {string} src an http(s) URL (a host that answers range requests) or a local path
 */
export async function openZip(src) {
  const bytes = await byteSource(src);
  const { total: size, bytes: tail } = await bytes.tail(65_558);                 // EOCD (22) + a comment of at most 65 535 + a zip64 locator
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  if (eocd < 0) throw new Error(`zip: ${src.slice(-80)} has no end-of-central-directory record: not a zip archive`);
  let count = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {   // zip64: the locator just before the EOCD names the zip64 record
    let loc = -1;
    for (let i = eocd - 20; i >= 0; i--) if (tail.readUInt32LE(i) === SIG_EOCD64_LOC) { loc = i; break; }
    if (loc < 0) throw new Error(`zip: ${src.slice(-80)}: zip64 sizes but no zip64 locator`);
    const at = Number(tail.readBigUInt64LE(loc + 8));
    const rec = at >= size - tail.length ? tail.subarray(at - (size - tail.length)) : await bytes.read(at, 56);
    if (rec.readUInt32LE(0) !== SIG_EOCD64) throw new Error(`zip: ${src.slice(-80)}: bad zip64 end-of-central-directory record`);
    count = Number(rec.readBigUInt64LE(32)); cdSize = Number(rec.readBigUInt64LE(40)); cdOffset = Number(rec.readBigUInt64LE(48));
  }
  const cdEnd = cdOffset + cdSize;
  const cd = cdEnd <= size && cdOffset >= size - tail.length ? tail.subarray(cdOffset - (size - tail.length), cdEnd - (size - tail.length)) : await bytes.read(cdOffset, cdSize);
  const entries = new Map();
  for (let p = 0, n = 0; n < count && p + 46 <= cd.length && cd.readUInt32LE(p) === SIG_CENTRAL; n++) {
    const method = cd.readUInt16LE(p + 10), nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
    let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24), offset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) {    // zip64 extra field: the 64-bit values, in the order of the fields that overflowed
      for (let q = p + 46 + nameLen, end = q + extraLen; q + 4 <= end;) {
        const id = cd.readUInt16LE(q), len = cd.readUInt16LE(q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(r)); r += 8; }
          if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(r)); r += 8; }
          if (offset === 0xffffffff) offset = Number(cd.readBigUInt64LE(r));
        }
        q += 4 + len;
      }
    }
    entries.set(name, { method, csize, usize, offset, nameLen, extraLen });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (entries.size !== count) throw new Error(`zip: ${src.slice(-80)}: ${entries.size} of ${count} central directory entries read`);

  const read = async (name) => {
    const e = entries.get(name);
    if (!e || name.endsWith('/')) return null;
    if (e.method !== 0 && e.method !== 8) throw new Error(`zip: ${name} uses compression method ${e.method}; only stored and deflate are read`);
    // the local header's name and extra may be longer than the central directory's (zip64, timestamps): a little slack
    let buf = await bytes.read(e.offset, 30 + e.nameLen + e.extraLen + 256 + e.csize);
    if (buf.length < 30 || buf.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`zip: ${name}: no local header at ${e.offset}`);
    const start = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
    if (buf.length < start + e.csize) buf = Buffer.concat([buf, await bytes.read(e.offset + buf.length, start + e.csize - buf.length)]);
    const data = buf.subarray(start, start + e.csize);
    const out = e.method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    if (out.length !== e.usize) throw new Error(`zip: ${name}: ${out.length} bytes inflated, ${e.usize} expected`);
    return out;
  };
  return { src, size, names: [...entries.keys()], entries, read, close: bytes.close || (() => {}) };
}

/**
 * An archive of `{ name: Buffer }`, deflated unless `{ store: true }`; what a test or a tool writes. Local headers carry the
 * sizes (no data descriptors), the central directory follows the members, no zip64 (members under 4 GB, fewer than 65 535).
 */
export function writeZip(files, { store = false } = {}) {
  const parts = [], central = [];
  let offset = 0;
  const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc32 = (b) => { let c = -1; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  for (const [name, bytes] of Object.entries(files)) {
    const data = Buffer.from(bytes), packed = store ? data : zlib.deflateRawSync(data), nm = Buffer.from(name, 'utf8'), method = store ? 0 : 8, crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nm.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(SIG_CENTRAL, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x800, 8); cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(packed.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nm.length, 28); cen.writeUInt32LE(offset, 42);
    parts.push(local, nm, packed); central.push(cen, nm);
    offset += local.length + nm.length + packed.length;
  }
  const cd = Buffer.concat(central), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0); eocd.writeUInt16LE(central.length / 2, 8); eocd.writeUInt16LE(central.length / 2, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}
