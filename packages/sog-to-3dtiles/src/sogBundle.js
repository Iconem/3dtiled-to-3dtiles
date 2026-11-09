/**
 * sogBundle.js (sog-to-3dtiles) — a **bundled SOG** (one `.sog` file: a ZIP of meta.json and its WebP planes) → the
 * files a tile needs, by name, reading as little of the bundle as it can.
 *
 * The tiles written here carry no spherical harmonics beyond the base colour, and the `shN_*` planes are a quarter to
 * a third of a bundle (2.27 of 6.24 MB in the coarsest chunk of the XGRIDS Tunis LCC2 sample). So the reader takes the
 * ZIP's central directory from the end of the file, then only the byte spans of the entries it keeps, and hands back a
 * meta.json that no longer names the planes it left behind. Over HTTP that is two requests in the usual case: the tail,
 * then one span, since the kept planes sit next to each other at the start of the bundle.
 *
 * Plain ZIP only (STORED or DEFLATE entries, no ZIP64, no encryption): what SOG writers produce.
 */
import zlib from 'node:zlib';

const EOCD = 0x06054b50, CDIR = 0x02014b50, LOCAL = 0x04034b50;

/** The planes a splat tile of this repo does not use: higher-order spherical harmonics. */
export const withoutShN = (name) => !/^shN/i.test(name.split('/').pop());

/** Where the central directory of a ZIP is, from the file's last bytes `tail` (the file is `total` bytes long) → { count, dirOffset, dirSize, inTail }. */
export function zipDirectory(tail, total) {
  let e = tail.length - 22;
  while (e >= 0 && tail.readUInt32LE(e) !== EOCD) e--;
  if (e < 0) throw new Error('bundled SOG: no ZIP end-of-central-directory record in the last bytes of the file');
  const count = tail.readUInt16LE(e + 10), dirSize = tail.readUInt32LE(e + 12), dirOffset = tail.readUInt32LE(e + 16);
  if (count === 0xffff || dirOffset === 0xffffffff) throw new Error('bundled SOG: ZIP64 archives are not supported');
  return { count, dirOffset, dirSize, inTail: dirOffset >= total - tail.length };
}

/** The central directory's bytes → [{ name, method, size, offset }] (`size`: compressed; `offset`: of the local header). */
export function zipEntries(dir, count) {
  const entries = [];
  for (let p = 0, i = 0; i < count; i++) {
    if (p + 46 > dir.length || dir.readUInt32LE(p) !== CDIR) throw new Error('bundled SOG: corrupt ZIP central directory');
    const nameLen = dir.readUInt16LE(p + 28), extraLen = dir.readUInt16LE(p + 30), commentLen = dir.readUInt16LE(p + 32);
    entries.push({ name: dir.toString('utf8', p + 46, p + 46 + nameLen), method: dir.readUInt16LE(p + 10), size: dir.readUInt32LE(p + 20), offset: dir.readUInt32LE(p + 42) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** One entry's data out of `buf`, which holds the file from byte `base` on and starts at or before the entry's local header. */
function entryData(buf, base, entry) {
  const p = entry.offset - base;
  if (buf.readUInt32LE(p) !== LOCAL) throw new Error(`bundled SOG: no local file header for "${entry.name}"`);
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const raw = buf.subarray(start, start + entry.size);
  if (raw.length !== entry.size) throw new Error(`bundled SOG: "${entry.name}" is cut short`);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`bundled SOG: "${entry.name}" uses ZIP compression method ${entry.method}`);
}

/**
 * The kept files of a bundled SOG, by name, as Uint8Arrays, with meta.json rewritten to match what was kept.
 * @param {Buffer} tail   the last bytes of the bundle (all of it, for a local file or a host that ignores Range)
 * @param {number} total  the bundle's size in bytes
 * @param {(begin:number, length:number) => Promise<Buffer>} [range]  reads more of the bundle; not called when `tail` is the whole file
 * @param {(name:string) => boolean} [keep]  the entries to read, default all but the `shN_*` planes
 */
export async function bundledSogFiles(tail, total, range, keep = withoutShN) {
  const tailBase = total - tail.length;
  const { count, dirOffset, dirSize, inTail } = zipDirectory(tail, total);
  const dir = inTail ? tail.subarray(dirOffset - tailBase, dirOffset - tailBase + dirSize) : await range(dirOffset, dirSize);
  const entries = zipEntries(dir, count).sort((a, b) => a.offset - b.offset);
  // An entry ends where the next one starts (or the directory does): its header, data and optional data descriptor.
  entries.forEach((en, i) => { en.end = entries[i + 1]?.offset ?? dirOffset; });
  const wanted = entries.filter((en) => !en.name.endsWith('/') && keep(en.name));

  // Spans to read: wanted entries the tail does not already hold, neighbours merged into one read.
  const spans = [];
  for (const en of wanted) {
    if (en.offset >= tailBase) continue;
    const last = spans[spans.length - 1];
    if (last && last.end === en.offset) last.end = en.end; else spans.push({ begin: en.offset, end: en.end });
  }
  await Promise.all(spans.map(async (s) => { s.buf = await range(s.begin, Math.min(s.end, total) - s.begin); }));

  const files = {};
  for (const en of wanted) {
    const span = spans.find((s) => en.offset >= s.begin && en.offset < s.end);
    files[en.name] = new Uint8Array(span ? entryData(span.buf, span.begin, en) : entryData(tail, tailBase, en));
  }
  if (!files['meta.json']) throw new Error('bundled SOG: no meta.json in the archive');
  files['meta.json'] = pruneMeta(files['meta.json'], files);
  return files;
}

/** meta.json without the sections whose files were not kept (readSog then decodes no column for them). */
function pruneMeta(bytes, files) {
  const meta = JSON.parse(new TextDecoder().decode(bytes));
  let changed = false;
  for (const [key, section] of Object.entries(meta)) {
    if (Array.isArray(section?.files) && section.files.some((f) => !files[f])) { delete meta[key]; changed = true; }
  }
  return changed ? new TextEncoder().encode(JSON.stringify(meta)) : bytes;
}
