/**
 * sqlite-http.js — query a remote SQLite file (a .3dtiles package) by HTTP range requests, a few pages per lookup.
 *
 * The library is wa-sqlite (@journeyapps/wa-sqlite, MIT, its Asyncify build): SQLite compiled to WASM whose file reads
 * may be async JavaScript, so the HTTP VFS below runs on the server's own thread: no worker, no SharedArrayBuffer.
 * Every page SQLite asks for goes through core/source-fetch.js as a `bytes=a-b` range (retried, capped per host), and a
 * host that ignores Range is refused, never downloaded: the first 100 bytes are read before SQLite is let in (the
 * host's own error, 404 or Range ignored, as it is), and every page read after them is checked the same way.
 *
 * Pages are kept in one LRU cache shared by every open file. A read doubles in size when the page before it is already
 * there (a tile's overflow pages are contiguous, so a 1 MB blob is about ten requests, not 250), as sqlite-wasm-http
 * did, and a page another query is already reading is awaited, not read twice.
 *
 *   TILED_SQLITE_CACHE_MB      page cache shared by every open file, default 64
 *   TILED_SQLITE_CONNECTIONS   SQLite instances, so queries in parallel, default 2 (TILED_SQLITE_THREADS, its old name)
 *   TILED_SQLITE_MAX_OPEN      remote files kept open, least recently used closed first, default 16
 *
 * An Asyncify instance runs one call at a time: each connection queues its queries.
 */
import { readFileSync } from 'node:fs';
import SQLiteAsyncFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite-async.mjs';
import * as SQLite from '@journeyapps/wa-sqlite';
import { FacadeVFS } from '@journeyapps/wa-sqlite/src/FacadeVFS.js';
import * as VFS from '@journeyapps/wa-sqlite/src/VFS.js';
import { requestSource } from '../core/source-fetch.js';

const CACHE_BYTES = (Number(process.env.TILED_SQLITE_CACHE_MB) || 64) * 2 ** 20;
const CONNECTIONS = Number(process.env.TILED_SQLITE_CONNECTIONS || process.env.TILED_SQLITE_THREADS) || 2;
const MAX_OPEN = Number(process.env.TILED_SQLITE_MAX_OPEN) || 16;
// The longest single read: the doubling stops there (16 MB, past the largest tiles)
const MAX_READ_BYTES = 16 * 2 ** 20;

const shortUrl = (url) => url.split('?')[0];

// ── the page cache, shared by every connection and file ─────────────────────────────────────────

const pages = new Map();                           // `${url}|${page}` → { data: one page, run: pages read with it }, LRU order
let cachedBytes = 0;
const reading = new Map();                         // `${url}|${page}` → Promise of the read bringing that page

function cacheGet(key) {
  const e = pages.get(key);
  if (e) { pages.delete(key); pages.set(key, e); }
  return e;
}
function cachePut(key, e) {
  const old = pages.get(key);
  if (old) { pages.delete(key); cachedBytes -= old.data.length; }
  pages.set(key, e);
  cachedBytes += e.data.length;
  while (cachedBytes > CACHE_BYTES && pages.size > 1) {
    const [k, v] = pages.entries().next().value;
    pages.delete(k);
    cachedBytes -= v.data.length;
  }
}

/** Reads pages from `page` on: one page, or twice as many as the read that brought the page before it. → that page. */
async function readRun(url, { pageSize: ps, size }, page) {
  const prev = page > 0 && pages.get(`${url}|${page - 1}`);
  let n = Math.min(prev ? prev.run * 2 : 1, Math.max(1, Math.floor(MAX_READ_BYTES / ps)), Math.ceil(size / ps) - page);
  for (let i = 1; i < n; i++) if (pages.has(`${url}|${page + i}`) || reading.has(`${url}|${page + i}`)) { n = i; break; }
  const begin = page * ps, end = Math.min(size, begin + n * ps) - 1;
  const read = (async () => {
    const { status, body } = await requestSource(url, { headers: { Range: `bytes=${begin}-${end}` }, timeoutMs: 60_000 + Math.ceil((end - begin + 1) / 1000) });
    // a 200 here is a file no longer than the range (requestSource refuses a longer one)
    const data = status === 200 ? body.subarray(begin, end + 1) : body;
    if (data.length !== end - begin + 1)
      throw Object.assign(new Error(`read ${shortUrl(url)} [bytes=${begin}-${end}] → ${data.length} bytes`), { status: 502, transient: true });
    for (let i = 0; i < n; i++) cachePut(`${url}|${page + i}`, { data: data.slice(i * ps, (i + 1) * ps), run: n });
    return data.subarray(0, ps);
  })();
  for (let i = 0; i < n; i++) reading.set(`${url}|${page + i}`, read);
  try { return await read; } finally {
    for (let i = 0; i < n; i++) if (reading.get(`${url}|${page + i}`) === read) reading.delete(`${url}|${page + i}`);
  }
}

async function getPage(url, info, page) {
  const key = `${url}|${page}`;
  for (;;) {
    const hit = cacheGet(key);
    if (hit) return hit.data;
    const pending = reading.get(key);
    if (!pending) return readRun(url, info, page);
    await pending;                                 // another query's read: its pages, or its error
  }
}

// ── the files: their header, read once ─────────────────────────────────────────────────────────

const files = new Map();                           // url → Promise<{ pageSize, size }>, in least-recently-used order

/** The first bytes, read before SQLite is let in: the host's error (404, Range ignored) as it is, not an I/O error. */
async function probe(url) {
  const { status, headers, body } = await requestSource(url, { headers: { Range: 'bytes=0-99' }, timeoutMs: 30_000 });
  if (body.length < 100 || body.toString('latin1', 0, 16) !== 'SQLite format 3\0')
    throw Object.assign(new Error(`${shortUrl(url)}: not an SQLite file`), { status: 415 });
  const p = body.readUInt16BE(16);
  const size = status === 206 ? Number(/\/(\d+)\s*$/.exec(headers.get('content-range') || '')?.[1]) : body.length;
  if (!(size > 0)) throw Object.assign(new Error(`${shortUrl(url)}: the host gives no file size`), { status: 502 });
  return { pageSize: p === 1 ? 65536 : p, size };
}

function fileInfo(url) {
  let f = files.get(url);
  if (f) { files.delete(url); files.set(url, f); return f; }
  f = probe(url).then((info) => {
    console.log(`[sqlite-http] ${shortUrl(url).slice(-120)}: ${info.size} bytes, ${info.pageSize}-byte pages, read by ranges`);
    return info;
  });
  f.catch(() => { if (files.get(url) === f) files.delete(url); });
  files.set(url, f);
  while (files.size > MAX_OPEN) {
    const oldest = files.keys().next().value;
    files.delete(oldest);
    closeOnConnections(oldest);
  }
  return f;
}

// ── the VFS: SQLite's file reads, as page reads ────────────────────────────────────────────────

class HttpVFS extends FacadeVFS {
  mxPathname = 16384;                              // the file name is the URL: a presigned one runs to a few KB (default 64)
  handles = new Map();                             // SQLite's file id → { url, info }
  lastError = null;                                // the source's error behind the last I/O error SQLite reports

  async jOpen(name, fileId, flags, pOutFlags) {
    if (!name || !(flags & VFS.SQLITE_OPEN_MAIN_DB)) return VFS.SQLITE_CANTOPEN;
    try { this.handles.set(fileId, { url: name, info: await (files.get(name) ?? fileInfo(name)) }); }
    catch (e) { this.lastError = e; return VFS.SQLITE_CANTOPEN; }
    pOutFlags.setInt32(0, VFS.SQLITE_OPEN_READONLY, true);
    return VFS.SQLITE_OK;
  }
  jClose(fileId) { this.handles.delete(fileId); return VFS.SQLITE_OK; }
  async jRead(fileId, pData, iOffset) {
    const h = this.handles.get(fileId);
    if (!h) return VFS.SQLITE_IOERR_READ;
    const { pageSize: ps, size } = h.info;
    try {
      const want = Math.max(0, Math.min(pData.length, size - iOffset));
      let done = 0;
      while (done < want) {
        const off = iOffset + done, page = Math.floor(off / ps);
        const data = await getPage(h.url, h.info, page);
        const n = Math.min(data.length - (off - page * ps), want - done);
        if (n <= 0) break;
        pData.set(data.subarray(off - page * ps, off - page * ps + n), done);
        done += n;
      }
      if (done < pData.length) { pData.fill(0, done); return VFS.SQLITE_IOERR_SHORT_READ; }
      return VFS.SQLITE_OK;
    } catch (e) { this.lastError = e; return VFS.SQLITE_IOERR_READ; }
  }
  jWrite() { return VFS.SQLITE_READONLY; }
  jTruncate() { return VFS.SQLITE_READONLY; }
  jSync() { return VFS.SQLITE_OK; }
  jFileSize(fileId, pSize64) { pSize64.setBigInt64(0, BigInt(this.handles.get(fileId)?.info.size ?? 0), true); return VFS.SQLITE_OK; }
  jLock() { return VFS.SQLITE_OK; }
  jUnlock() { return VFS.SQLITE_OK; }
  jCheckReservedLock(fileId, pResOut) { pResOut.setInt32(0, 0, true); return VFS.SQLITE_OK; }
  jSectorSize(fileId) { return this.handles.get(fileId)?.info.pageSize ?? 4096; }
  jDeviceCharacteristics() { return VFS.SQLITE_IOCAP_IMMUTABLE; }
  jAccess(name, flags, pResOut) { pResOut.setInt32(0, 0, true); return VFS.SQLITE_OK; }   // no journal, no WAL
  jDelete() { return VFS.SQLITE_IOERR_DELETE; }
}

// ── the connections: SQLite instances, one query at a time each ────────────────────────────────

let pool = null;                                   // Promise<[{ sqlite3, vfs, pending, tail, open: Map<url, db> }]>
function getPool() {
  pool ??= (async () => {
    const wasmBinary = readFileSync(new URL(import.meta.resolve('@journeyapps/wa-sqlite/dist/wa-sqlite-async.wasm')));
    return Promise.all(Array.from({ length: CONNECTIONS }, async () => {
      const module = await SQLiteAsyncFactory({ wasmBinary });
      const sqlite3 = SQLite.Factory(module);
      const vfs = new HttpVFS('http', module);
      sqlite3.vfs_register(vfs, false);
      return { sqlite3, vfs, pending: 0, tail: Promise.resolve(), open: new Map() };
    }));
  })().catch((e) => { pool = null; throw e; });
  return pool;
}

/** Runs `fn(c)` after the work already queued on that connection. */
function onConnection(c, fn) {
  c.pending++;
  const run = c.tail.then(() => fn(c));
  c.tail = run.catch(() => {}).finally(() => { c.pending--; });
  return run;
}

function closeOnConnections(url) {
  if (!pool) return;
  pool.then((conns) => {
    for (const c of conns) {
      if (!c.open.has(url)) continue;
      onConnection(c, async () => {
        const db = c.open.get(url);
        if (db == null) return;
        c.open.delete(url);
        await c.sqlite3.close(db).catch(() => {});
      }).catch(() => {});
    }
  }).catch(() => {});
}

/** SQLite's error as the client should see it: the host's own (a failed page read: 502, as source-fetch says). */
function queryError(url, e, sourceError) {
  if (sourceError) return Object.assign(sourceError, sourceError.status ? {} : { status: 502, transient: true });
  return new Error(`${shortUrl(url)}: ${e?.message || e}`);
}

/**
 * Rows of `sql` with `bind` on the remote SQLite file at `url`, each an array of column values (a BLOB as Uint8Array).
 * The file is opened on first use on the least busy connection, and stays open (up to TILED_SQLITE_MAX_OPEN files).
 */
export async function queryRemoteSqlite(url, sql, bind = []) {
  await fileInfo(url);
  const conns = await getPool();
  const c = conns.reduce((a, b) => (b.pending < a.pending ? b : a));
  return onConnection(c, async () => {
    const { sqlite3, vfs } = c;
    vfs.lastError = null;
    const rows = [];
    try {
      let db = c.open.get(url);
      if (db == null) {
        db = await sqlite3.open_v2(url, SQLite.SQLITE_OPEN_READONLY, 'http');
        c.open.set(url, db);
      }
      for await (const stmt of sqlite3.statements(db, sql)) {
        if (bind.length) sqlite3.bind_collection(stmt, bind);
        while (await sqlite3.step(stmt) === SQLite.SQLITE_ROW)
          rows.push(sqlite3.row(stmt).map((v) => (v instanceof Uint8Array ? v.slice() : v)));   // a BLOB is a view of WASM memory
      }
    } catch (e) {
      throw queryError(url, e, vfs.lastError);
    } finally {
      // closed meanwhile (least recently used, or the query was queued before it was): not left open
      const db = c.open.get(url);
      if (!files.has(url) && db != null) { c.open.delete(url); await sqlite3.close(db).catch(() => {}); }
    }
    return rows;
  });
}

/** The page size and byte size of a remote SQLite file (from its header, read once). */
export const remoteSqliteInfo = (url) => fileInfo(url);

/** Closes every file and empties the cache (tests). */
export async function closeRemoteSqlite() {
  if (!pool) return;
  const p = pool; pool = null; files.clear();
  const conns = await p.catch(() => []);
  for (const c of conns) {
    await onConnection(c, async () => {
      for (const db of c.open.values()) await c.sqlite3.close(db).catch(() => {});
      c.open.clear();
    }).catch(() => {});
  }
  pages.clear(); cachedBytes = 0;
}
