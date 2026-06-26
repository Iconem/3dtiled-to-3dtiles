/**
 * package-live.js — serve .3tz (ZIP-packaged) and .3dtiles (SQLite-packaged) 3D Tiles packages.
 *
 * Mirrors the behaviour of `npx 3d-tiles-tools serve` (v0.5.3+), letting you open any local
 * .3tz / .3dtiles file through the tile-server without extracting it first.
 *
 * Endpoints:
 *   GET /package/tileset.json?url=<abs-path-or-local-url>  → reads tileset.json from the package
 *   GET /package/<key>?url=<same-url>                      → reads one tile/subtree/binary by key
 *
 * .3tz  format: a plain ZIP with a `@3dtilesIndex1@` entry that contains a binary random-access
 *               index (path → {offset,length} within the ZIP). We parse that entry, then use
 *               byte-range reads (fs.read) to pull individual tiles without reading the whole file.
 *               Spec: Maxar MAXAR_content_3tz extension + CesiumGS/3d-tiles-tools#86.
 *
 * .3dtiles format: SQLite database with a `media` table (key TEXT PRIMARY KEY, content BLOB).
 *               Requires `better-sqlite3` to be installed (`pnpm add better-sqlite3`).
 *               Without it the server still handles .3tz; .3dtiles returns 501 with instructions.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };

const MIME = {
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.b3dm': 'application/octet-stream',
  '.pnts': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.subtree': 'application/octet-stream', '.cmpt': 'application/octet-stream',
  '.ktx2': 'image/ktx2', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp',
};

// ── .3tz (ZIP + @3dtilesIndex1@ random-access index) ──────────────────────────────────────────

// The @3dtilesIndex1@ entry is a sequence of variable-length records:
//   [uint16-LE path-length][utf8 path][uint64-LE offset][uint32-LE length]
// "offset" is the byte offset of the LOCAL FILE HEADER for the entry in the ZIP file.
// After the local file header (30 + nameLen + extraLen bytes) comes the (possibly compressed)
// file data. For stored (method=0) entries we read `length` bytes; for deflated (method=8) we
// must decompress. The spec mandates STORED for tiles to allow random access, but we handle
// both for robustness.
//
// Reference: https://github.com/CesiumGS/3d-tiles-tools/blob/main/src/packages/Tz3tzPackage.ts

/** Read exactly `n` bytes from file descriptor `fd` at absolute offset `pos`. */
function readAt(fd, pos, n) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.allocUnsafe(n);
    fs.read(fd, buf, 0, n, pos, (err, bytesRead) => {
      if (err) return reject(err);
      if (bytesRead < n) return reject(new Error(`short read: wanted ${n}, got ${bytesRead} at ${pos}`));
      resolve(buf);
    });
  });
}

/** Locate the end-of-central-directory record (EOCD, signature 0x06054b50) near the end. */
async function findEocd(fd, fileSize) {
  const searchLen = Math.min(fileSize, 65535 + 22);
  const buf = await readAt(fd, fileSize - searchLen, searchLen);
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i+1] === 0x4b && buf[i+2] === 0x05 && buf[i+3] === 0x06) {
      return { cdOffset: buf.readUInt32LE(i + 16), cdSize: buf.readUInt32LE(i + 12), entryCount: buf.readUInt16LE(i + 8) };
    }
  }
  // ZIP64 EOCD locator check (simplified — look for 0x07064b50 just before EOCD placeholder)
  for (let i = buf.length - 56; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i+1] === 0x4b && buf[i+2] === 0x06 && buf[i+3] === 0x07) {
      // ZIP64 EOCD record is at the absolute offset stored in the locator.
      const eocd64Offset = Number(buf.readBigUInt64LE(i + 8));
      const eocd64 = await readAt(fd, eocd64Offset, 56);
      if (eocd64[0] !== 0x50 || eocd64[1] !== 0x4b || eocd64[2] !== 0x06 || eocd64[3] !== 0x06)
        break;
      return {
        cdOffset: Number(eocd64.readBigUInt64LE(48)),
        cdSize:   Number(eocd64.readBigUInt64LE(40)),
        entryCount: Number(eocd64.readBigUInt64LE(24)),
      };
    }
  }
  throw new Error('.3tz: EOCD not found — not a valid ZIP file');
}

/** Scan the central directory and return a map of filename → localHeaderOffset. */
async function buildZipDirectory(fd, fileSize) {
  const { cdOffset, cdSize } = await findEocd(fd, fileSize);
  const cd = await readAt(fd, cdOffset, cdSize);
  const dir = new Map(); // filename → local header offset
  let pos = 0;
  while (pos + 46 <= cd.length) {
    if (cd[pos] !== 0x50 || cd[pos+1] !== 0x4b || cd[pos+2] !== 0x01 || cd[pos+3] !== 0x02) break;
    const method      = cd.readUInt16LE(pos + 10);
    const compSize    = cd.readUInt32LE(pos + 20);
    const uncompSize  = cd.readUInt32LE(pos + 24);
    const nameLen     = cd.readUInt16LE(pos + 28);
    const extraLen    = cd.readUInt16LE(pos + 30);
    const commentLen  = cd.readUInt16LE(pos + 32);
    let   localOffset = cd.readUInt32LE(pos + 42);
    const name        = cd.toString('utf8', pos + 46, pos + 46 + nameLen);
    // ZIP64 extra field: if localOffset is 0xFFFFFFFF, read from the extra field.
    if (localOffset === 0xFFFFFFFF) {
      let ep = pos + 46 + nameLen;
      while (ep + 4 <= pos + 46 + nameLen + extraLen) {
        const hid = cd.readUInt16LE(ep), hsz = cd.readUInt16LE(ep + 2);
        if (hid === 0x0001) { localOffset = Number(cd.readBigUInt64LE(ep + 4 + (uncompSize === 0xFFFFFFFF ? 8 : 0) + (compSize === 0xFFFFFFFF ? 8 : 0))); break; }
        ep += 4 + hsz;
      }
    }
    dir.set(name, { localOffset, method, compSize, uncompSize });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return dir;
}

/** Parse the @3dtilesIndex1@ binary blob → Map<path, {offset,length}>. */
function parseIndex(buf) {
  const idx = new Map();
  let pos = 0;
  while (pos + 2 <= buf.length) {
    const pathLen = buf.readUInt16LE(pos); pos += 2;
    if (pos + pathLen + 12 > buf.length) break;
    const p   = buf.toString('utf8', pos, pos + pathLen); pos += pathLen;
    const off = Number(buf.readBigUInt64LE(pos)); pos += 8;
    const len = buf.readUInt32LE(pos); pos += 4;
    idx.set(p, { offset: off, length: len });
  }
  return idx;
}

/** Read one entry's raw (possibly compressed) data from the ZIP via its local header offset. */
async function readZipEntry(fd, localOffset, compSize) {
  // Local file header: sig(4) ver(2) flags(2) method(2) modtime(4) crc(4) compSz(4) uncompSz(4) nameLen(2) extraLen(2)
  const hdr = await readAt(fd, localOffset, 30);
  if (hdr[0] !== 0x50 || hdr[1] !== 0x4b || hdr[2] !== 0x03 || hdr[3] !== 0x04)
    throw new Error(`not a local file header at offset ${localOffset}`);
  const method   = hdr.readUInt16LE(8);
  const nameLen  = hdr.readUInt16LE(26);
  const extraLen = hdr.readUInt16LE(28);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const rawData   = await readAt(fd, dataStart, compSize);
  if (method === 0) return rawData;   // STORED
  if (method === 8) {                 // DEFLATE (raw, no zlib header)
    const { inflateRaw } = await import('fflate');
    return new Promise((resolve, reject) =>
      inflateRaw(rawData, (err, out) => err ? reject(err) : resolve(Buffer.from(out))));
  }
  throw new Error(`Unsupported ZIP compression method ${method} in .3tz entry`);
}

/** Cached per-file context: fd + the @3dtilesIndex1@ path index. */
const _3tzCache = new Map();
async function get3tzCtx(filePath) {
  const abs = path.resolve(filePath);
  if (_3tzCache.has(abs)) return _3tzCache.get(abs);
  const stat = await fsp.stat(abs);
  const fd   = await new Promise((res, rej) => fs.open(abs, 'r', (e, f) => e ? rej(e) : res(f)));
  const dir  = await buildZipDirectory(fd, stat.size);
  // Find @3dtilesIndex1@ in the central directory (it may or may not have a leading slash).
  const idxEntry = dir.get('@3dtilesIndex1@') || dir.get('/@3dtilesIndex1@');
  if (!idxEntry) throw new Error(`${abs}: no @3dtilesIndex1@ entry — not a .3tz package`);
  const idxRaw = await readZipEntry(fd, idxEntry.localOffset, idxEntry.compSize);
  const idx = parseIndex(idxRaw);
  const ctx = { fd, dir, idx };
  _3tzCache.set(abs, ctx);
  console.log(`[package] .3tz ${path.basename(abs)}: ${idx.size} indexed entries`);
  return ctx;
}

/** Read one file from a .3tz package by its path key (e.g. "tileset.json", "tiles/0/0/0.glb"). */
async function read3tz(filePath, key) {
  const ctx = await get3tzCtx(filePath);
  // Try the index first (random-access, O(1)).
  const entry = ctx.idx.get(key) || ctx.idx.get(key.replace(/^\//, ''));
  if (entry) {
    // The index gives the offset of the LOCAL FILE HEADER; we need to skip it.
    const hdr = await readAt(ctx.fd, entry.offset, 30);
    const nameLen  = hdr.readUInt16LE(26);
    const extraLen = hdr.readUInt16LE(28);
    const method   = hdr.readUInt16LE(8);
    const dataStart = entry.offset + 30 + nameLen + extraLen;
    const raw = await readAt(ctx.fd, dataStart, entry.length);
    if (method === 0) return raw;
    if (method === 8) {
      const { inflateRaw } = await import('fflate');
      return new Promise((res, rej) => inflateRaw(raw, (e, o) => e ? rej(e) : res(Buffer.from(o))));
    }
    throw new Error(`Unsupported compression method ${method} for key "${key}"`);
  }
  // Fall back to central-directory lookup (for entries not in the 3tz index — shouldn't happen).
  const dirEntry = ctx.dir.get(key) || ctx.dir.get('/' + key);
  if (!dirEntry) return null;
  return readZipEntry(ctx.fd, dirEntry.localOffset, dirEntry.compSize);
}

// ── .3dtiles (SQLite media table) ─────────────────────────────────────────────────────────────

let _sqlite = null;
async function getSqlite() {
  if (_sqlite) return _sqlite;
  try {
    _sqlite = (await import('better-sqlite3')).default;
    return _sqlite;
  } catch {
    throw new Error(
      '.3dtiles files require better-sqlite3 — run: pnpm add -w better-sqlite3\n' +
      '(It is a native addon; you need a C++ build environment.)'
    );
  }
}

const _sqliteCache = new Map();
async function getSqliteDb(filePath) {
  const abs = path.resolve(filePath);
  if (_sqliteCache.has(abs)) return _sqliteCache.get(abs);
  const BetterSqlite = await getSqlite();
  const db = new BetterSqlite(abs, { readonly: true, fileMustExist: true });
  _sqliteCache.set(abs, db);
  console.log(`[package] .3dtiles ${path.basename(abs)}: SQLite opened`);
  return db;
}

async function read3dtiles(filePath, key) {
  const db = await getSqliteDb(filePath);
  const row = db.prepare('SELECT content FROM media WHERE key = ?').get(key);
  return row ? Buffer.from(row.content) : null;
}

// ── HTTP handler ───────────────────────────────────────────────────────────────────────────────

/** Rewrite all relative content/subtree URIs in a tileset JSON tree to route through /package/. */
function rewritePackageUris(node, prefix, encUrl) {
  if (Array.isArray(node)) { for (const v of node) rewritePackageUris(v, prefix, encUrl); return; }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'uri' && typeof v === 'string' && !/^([a-z]+:)?\/\//i.test(v) && !v.startsWith('/'))
      node[k] = `${prefix}${v}?url=${encUrl}`;
    else rewritePackageUris(v, prefix, encUrl);
  }
}

function resolveLocalPath(urlParam) {
  // Accept local file paths or file:// URLs.
  if (urlParam.startsWith('file://')) return fileURLToPath(urlParam);
  // Reject remote URLs — this middleware is for local package files only.
  if (/^https?:\/\//i.test(urlParam)) return null;
  return urlParam;
}

/** Try to handle a /package/* request. Returns true iff it owned the response. */
export async function handlePackage(req, res, u) {
  if (!u.pathname.startsWith('/package/')) return false;
  const urlParam = u.searchParams.get('url');
  if (!urlParam) { res.writeHead(400, CORS); res.end('missing ?url=<path/to/file.3tz or .3dtiles>'); return true; }
  const filePath = resolveLocalPath(urlParam);
  if (!filePath) { res.writeHead(400, CORS); res.end('?url must be a local path or file:// URL — use /convert for remote sources'); return true; }

  // The key is everything after /package/ (minus ?url=…).
  // /package/tileset.json?url=… → key = "tileset.json"
  // /package/tiles/0/0/0.glb?url=… → key = "tiles/0/0/0.glb"
  const key = decodeURIComponent(u.pathname.slice('/package/'.length));
  if (!key) { res.writeHead(400, CORS); res.end('specify a file key, e.g. /package/tileset.json?url=<path>'); return true; }

  const ext = path.extname(filePath).toLowerCase();
  let buf;
  try {
    if (ext === '.3tz') buf = await read3tz(filePath, key);
    else if (ext === '.3dtiles') buf = await read3dtiles(filePath, key);
    else { res.writeHead(400, CORS); res.end(`unsupported package format "${ext}" — expected .3tz or .3dtiles`); return true; }
  } catch (e) {
    if (e.message.includes('better-sqlite3')) { res.writeHead(501, CORS); res.end(e.message); return true; }
    throw e;
  }

  if (!buf) { res.writeHead(404, CORS); res.end(`key "${key}" not found in package`); return true; }

  // For tileset.json and sub-tilesets: rewrite relative content URIs so follow-up tile requests
  // route back through /package/<key>?url=<same-url> instead of resolving against the viewer origin.
  const extKey = path.extname(key).toLowerCase();
  if (extKey === '.json') {
    try {
      const ts = JSON.parse(buf.toString('utf8'));
      const enc = encodeURIComponent(urlParam);
      rewritePackageUris(ts, `/package/`, enc);
      const out = Buffer.from(JSON.stringify(ts));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(out.length), ...CORS });
      res.end(out);
      return true;
    } catch { /* not JSON — fall through to raw serve */ }
  }

  const mime = MIME[extKey] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': String(buf.length), ...CORS });
  res.end(buf);
  return true;
}

