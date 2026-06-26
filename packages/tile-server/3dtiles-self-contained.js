/**
 * 3dtiles-self-contained.js — serve .3tz (ZIP) and .3dtiles (SQLite) single-file packages.
 *
 * Endpoint: GET /3dtiles-self-contained/<key>?url=<path-or-URL>
 *
 *   <key>  = the tile path within the package, e.g. "tileset.json", "tiles/0/0/0.glb"
 *   ?url=  = local path, file:// URL, or http(s):// URL to the .3tz / .3dtiles file
 *
 * Examples:
 *   GET /3dtiles-self-contained/tileset.json?url=/abs/path/to/scene.3tz
 *   GET /3dtiles-self-contained/tileset.json?url=https://example.com/scene.3dtiles
 *   GET /3dtiles-self-contained/tiles/0/0/0.glb?url=/abs/path/to/scene.3tz
 *
 * Mirrors `npx 3d-tiles-tools serve` but in-process, CORS-open, and works for both local and
 * remote-hosted packages. tileset.json responses have all relative content URIs rewritten to
 * route back through this endpoint so follow-up tile requests resolve correctly.
 *
 * .3tz  format: ZIP with `@3dtilesIndex1@` binary random-access index. Pure-JS ZIP parsing +
 *               fflate for DEFLATE entries — no native deps, browser-compatible in principle.
 *               Spec: Maxar MAXAR_content_3tz + CesiumGS/3d-tiles-tools#86.
 *
 * .3dtiles format: SQLite `media` table (key TEXT, content BLOB). Uses sql.js (pure WASM —
 *               works for both local files and remote URLs via fetch + arrayBuffer load).
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
  '.ktx2': 'image/ktx2', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp',
};

// ── .3tz (ZIP + @3dtilesIndex1@ random-access index) ──────────────────────────────────────────
//
// The @3dtilesIndex1@ entry is a flat list of variable-length records:
//   [uint16-LE path-length][utf8 path][uint64-LE local-header-offset][uint32-LE data-length]
// "local-header-offset" is the byte offset of the ZIP local file header in the .3tz file.
// After the local header (30 + nameLen + extraLen bytes) comes the stored/deflated tile data.
// The spec recommends STORED (method=0) entries for tiles to allow true random access.
//
// Reference: CesiumGS/3d-tiles-tools src/packages/Tz3tzPackage.ts

function readAt(fd, pos, n) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.allocUnsafe(n);
    fs.read(fd, buf, 0, n, pos, (err, bytesRead) => {
      if (err) return reject(err);
      if (bytesRead < n) return reject(new Error(`short read: wanted ${n}, got ${bytesRead} at offset ${pos}`));
      resolve(buf);
    });
  });
}

async function findEocd(fd, fileSize) {
  const searchLen = Math.min(fileSize, 65535 + 22);
  const buf = await readAt(fd, fileSize - searchLen, searchLen);
  // Standard EOCD
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i]===0x50 && buf[i+1]===0x4b && buf[i+2]===0x05 && buf[i+3]===0x06) {
      const cdOffset = buf.readUInt32LE(i + 16);
      if (cdOffset !== 0xFFFFFFFF) return { cdOffset, cdSize: buf.readUInt32LE(i + 12) };
      break; // ZIP64
    }
  }
  // ZIP64 EOCD locator
  for (let i = buf.length - 56; i >= 0; i--) {
    if (buf[i]===0x50 && buf[i+1]===0x4b && buf[i+2]===0x06 && buf[i+3]===0x07) {
      const eocd64Off = Number(buf.readBigUInt64LE(i + 8));
      const r = await readAt(fd, eocd64Off, 56);
      if (r[0]===0x50 && r[1]===0x4b && r[2]===0x06 && r[3]===0x06) {
        return { cdOffset: Number(r.readBigUInt64LE(48)), cdSize: Number(r.readBigUInt64LE(40)) };
      }
    }
  }
  throw new Error('.3tz: no EOCD found — not a valid ZIP');
}

async function buildZipDir(fd, fileSize) {
  const { cdOffset, cdSize } = await findEocd(fd, fileSize);
  const cd = await readAt(fd, cdOffset, cdSize);
  const dir = new Map();
  let pos = 0;
  while (pos + 46 <= cd.length && cd[pos]===0x50 && cd[pos+1]===0x4b && cd[pos+2]===0x01 && cd[pos+3]===0x02) {
    const method = cd.readUInt16LE(pos + 10), compSz = cd.readUInt32LE(pos + 20), uncompSz = cd.readUInt32LE(pos + 24);
    const nLen = cd.readUInt16LE(pos + 28), eLen = cd.readUInt16LE(pos + 30), cLen = cd.readUInt16LE(pos + 32);
    let lOff = cd.readUInt32LE(pos + 42);
    const name = cd.toString('utf8', pos + 46, pos + 46 + nLen);
    if (lOff === 0xFFFFFFFF) {
      let ep = pos + 46 + nLen;
      while (ep + 4 <= pos + 46 + nLen + eLen) {
        const hid = cd.readUInt16LE(ep), hsz = cd.readUInt16LE(ep + 2);
        if (hid === 0x0001) {
          let skip = 0;
          if (uncompSz === 0xFFFFFFFF) skip += 8;
          if (compSz   === 0xFFFFFFFF) skip += 8;
          lOff = Number(cd.readBigUInt64LE(ep + 4 + skip));
          break;
        }
        ep += 4 + hsz;
      }
    }
    dir.set(name, { localOffset: lOff, method, compSize: compSz });
    pos += 46 + nLen + eLen + cLen;
  }
  return dir;
}

function parseIndex(buf) {
  const idx = new Map();
  let pos = 0;
  while (pos + 2 <= buf.length) {
    const pathLen = buf.readUInt16LE(pos); pos += 2;
    if (pos + pathLen + 12 > buf.length) break;
    const p = buf.toString('utf8', pos, pos + pathLen); pos += pathLen;
    const off = Number(buf.readBigUInt64LE(pos)); pos += 8;
    const len = buf.readUInt32LE(pos); pos += 4;
    idx.set(p, { offset: off, length: len });
  }
  return idx;
}

async function readZipEntry(fd, localOffset, compSize) {
  const hdr = await readAt(fd, localOffset, 30);
  if (hdr[0]!==0x50||hdr[1]!==0x4b||hdr[2]!==0x03||hdr[3]!==0x04)
    throw new Error(`not a local file header at ${localOffset}`);
  const method = hdr.readUInt16LE(8), nLen = hdr.readUInt16LE(26), eLen = hdr.readUInt16LE(28);
  const raw = await readAt(fd, localOffset + 30 + nLen + eLen, compSize);
  if (method === 0) return raw;
  if (method === 8) {
    const { inflateRaw } = await import('fflate');
    return new Promise((res, rej) => inflateRaw(raw, (e, o) => e ? rej(e) : res(Buffer.from(o))));
  }
  throw new Error(`Unsupported ZIP compression method ${method}`);
}

const _3tzCache = new Map();
async function get3tzCtx(filePath) {
  const abs = path.resolve(filePath);
  if (_3tzCache.has(abs)) return _3tzCache.get(abs);
  const { size } = await fsp.stat(abs);
  const fd = await new Promise((res, rej) => fs.open(abs, 'r', (e, f) => e ? rej(e) : res(f)));
  const dir = await buildZipDir(fd, size);
  const idxEntry = dir.get('@3dtilesIndex1@') || dir.get('/@3dtilesIndex1@');
  if (!idxEntry) throw new Error(`${abs}: no @3dtilesIndex1@ entry — not a .3tz package`);
  const idxRaw = await readZipEntry(fd, idxEntry.localOffset, idxEntry.compSize);
  const idx = parseIndex(idxRaw);
  const ctx = { fd, dir, idx };
  _3tzCache.set(abs, ctx);
  console.log(`[3dtiles-self-contained] .3tz ${path.basename(abs)}: ${idx.size} indexed entries`);
  return ctx;
}

async function read3tz(filePath, key) {
  const ctx = await get3tzCtx(filePath);
  const norm = key.replace(/^\//, '');
  const entry = ctx.idx.get(norm) || ctx.idx.get('/' + norm);
  if (entry) {
    const hdr = await readAt(ctx.fd, entry.offset, 30);
    const nLen = hdr.readUInt16LE(26), eLen = hdr.readUInt16LE(28), method = hdr.readUInt16LE(8);
    const raw = await readAt(ctx.fd, entry.offset + 30 + nLen + eLen, entry.length);
    if (method === 0) return raw;
    if (method === 8) {
      const { inflateRaw } = await import('fflate');
      return new Promise((res, rej) => inflateRaw(raw, (e, o) => e ? rej(e) : res(Buffer.from(o))));
    }
    throw new Error(`Unsupported compression method ${method} for key "${key}"`);
  }
  const dirEntry = ctx.dir.get(norm) || ctx.dir.get('/' + norm);
  if (!dirEntry) return null;
  return readZipEntry(ctx.fd, dirEntry.localOffset, dirEntry.compSize);
}

// ── .3dtiles (SQLite via sql.js — pure WASM, works local + remote) ────────────────────────────

let _sqljs = null;
async function getSqlJs() {
  if (_sqljs) return _sqljs;
  const { default: initSqlJs } = await import('sql.js');
  _sqljs = await initSqlJs();
  return _sqljs;
}

// Cache db per resolved URL / path (key = urlParam string).
const _sqlCache = new Map();
async function getSqliteDb(urlParam) {
  if (_sqlCache.has(urlParam)) return _sqlCache.get(urlParam);
  const SQL = await getSqlJs();
  let buf;
  if (/^https?:\/\//i.test(urlParam)) {
    const r = await fetch(urlParam);
    if (!r.ok) throw new Error(`fetch ${urlParam} → ${r.status}`);
    buf = new Uint8Array(await r.arrayBuffer());
  } else {
    const abs = urlParam.startsWith('file://') ? fileURLToPath(urlParam) : path.resolve(urlParam);
    buf = new Uint8Array(await fsp.readFile(abs));
  }
  const db = new SQL.Database(buf);
  _sqlCache.set(urlParam, db);
  console.log(`[3dtiles-self-contained] .3dtiles loaded: ${urlParam}`);
  return db;
}

async function read3dtiles(urlParam, key) {
  const db = await getSqliteDb(urlParam);
  const rows = db.exec('SELECT content FROM media WHERE key = ?', [key]);
  if (!rows.length || !rows[0].values.length) return null;
  return Buffer.from(rows[0].values[0][0]);
}

// ── URI rewriter ───────────────────────────────────────────────────────────────────────────────

function rewriteSelfContainedUris(node, encUrl) {
  if (Array.isArray(node)) { for (const v of node) rewriteSelfContainedUris(v, encUrl); return; }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'uri' && typeof v === 'string' && !/^([a-z]+:)?\/\//i.test(v) && !v.startsWith('/'))
      node[k] = `/3dtiles-self-contained/${v}?url=${encUrl}`;
    else rewriteSelfContainedUris(v, encUrl);
  }
}

// ── HTTP handler ───────────────────────────────────────────────────────────────────────────────

/** Try to handle a /3dtiles-self-contained/* request. Returns true iff it owned the response. */
export async function handleSelfContained(req, res, u) {
  const PREFIX = '/3dtiles-self-contained/';
  if (!u.pathname.startsWith(PREFIX)) return false;

  const urlParam = u.searchParams.get('url');
  if (!urlParam) {
    res.writeHead(400, CORS);
    res.end('missing ?url=<path/to/file.3tz|.3dtiles|https://...>');
    return true;
  }

  const key = decodeURIComponent(u.pathname.slice(PREFIX.length));
  if (!key) {
    res.writeHead(400, CORS);
    res.end('specify a tile key, e.g. /3dtiles-self-contained/tileset.json?url=<path>');
    return true;
  }

  // Resolve the file extension from the package URL (before any query string).
  const pkgPath = urlParam.split('?')[0];
  const ext = path.extname(pkgPath).toLowerCase();

  let buf;
  if (ext === '.3tz') {
    // For remote .3tz we would need to download the whole file first (no HTTP range for 3tz index).
    // For now, only local paths for .3tz; remote .3dtiles is fully supported via sql.js fetch.
    if (/^https?:\/\//i.test(urlParam)) {
      res.writeHead(501, CORS);
      res.end('.3tz remote URLs require downloading the full file — use a local path or the /convert endpoint instead.');
      return true;
    }
    const localPath = urlParam.startsWith('file://') ? fileURLToPath(urlParam) : urlParam;
    buf = await read3tz(localPath, key);
  } else if (ext === '.3dtiles') {
    buf = await read3dtiles(urlParam, key);
  } else {
    res.writeHead(400, CORS);
    res.end(`unsupported package extension "${ext}" — expected .3tz or .3dtiles`);
    return true;
  }

  if (!buf) {
    res.writeHead(404, CORS);
    res.end(`key "${key}" not found in package`);
    return true;
  }

  // tileset.json / sub-tileset .json: rewrite relative content URIs.
  const keyExt = path.extname(key).toLowerCase();
  if (keyExt === '.json') {
    try {
      const ts = JSON.parse(buf.toString('utf8'));
      const enc = encodeURIComponent(urlParam);
      rewriteSelfContainedUris(ts, enc);
      const out = Buffer.from(JSON.stringify(ts));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(out.length), ...CORS });
      res.end(out);
      return true;
    } catch { /* not parseable JSON — fall through to raw serve */ }
  }

  const mime = MIME[keyExt] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': String(buf.length), ...CORS });
  res.end(buf);
  return true;
}
