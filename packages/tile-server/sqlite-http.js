/**
 * sqlite-http.js — query a remote SQLite file (a .3dtiles package) by HTTP range requests, a few pages per lookup.
 *
 * The library is sqlite-wasm-http (official SQLite WASM + an HTTP VFS): SQLite runs on worker threads and asks a shared
 * HTTP thread for its pages, which keeps them in one LRU cache and doubles the size of a read when the previous page is
 * already there (a tile's overflow pages are contiguous, so a 1 MB blob is about ten requests, not 250). Nothing is
 * downloaded whole: that thread reads through core/source-fetch.js (sqlite-http-worker.js), so a host that ignores
 * Range is refused, as everywhere else.
 *
 *   TILED_SQLITE_CACHE_MB   page cache shared by every open file, default 64
 *   TILED_SQLITE_THREADS    SQLite threads (queries in parallel), default 2
 *   TILED_SQLITE_MAX_OPEN   remote files kept open, least recently used closed first, default 16
 *
 * Node has no Web Worker, which the library expects: @mmomtchev/web-worker (its author's) provides one, set as the
 * global only while the library creates its threads, so nothing else in the server sees a global `Worker`.
 */
import PolyWorker from '@mmomtchev/web-worker';
import { requestSource } from '../core/source-fetch.js';

const CACHE_MB = Number(process.env.TILED_SQLITE_CACHE_MB) || 64;
const THREADS = Number(process.env.TILED_SQLITE_THREADS) || 2;
const MAX_OPEN = Number(process.env.TILED_SQLITE_MAX_OPEN) || 16;
// The longest a page read may take before SQLite gives up on it (a read doubles up to the size of a tile)
const TIMEOUT_MS = 120_000;

const HTTP_THREAD = new URL('./sqlite-http-worker.js', import.meta.url);
class NodeWorker extends PolyWorker {
  constructor(url, opts) {
    super(/vfs-http-worker\.js$/.test(String(url)) ? HTTP_THREAD : url, { ...opts, type: 'module' });
  }
}
function withWorkerGlobal(fn) {
  const had = 'Worker' in globalThis, prev = globalThis.Worker;
  globalThis.Worker = NodeWorker;
  try { return fn(); } finally { if (had) globalThis.Worker = prev; else delete globalThis.Worker; }
}

let pool = null;                                   // Promise<{ backend, threads: [{ db, pending, tail, open: Map<url, dbId> }] }>
function getPool() {
  pool ??= (async () => {
    const { createHttpBackend, createSQLiteThread } = await import('sqlite-wasm-http');
    // maxPageSize 65536: SQLite's largest, so any file opens; cacheSize is in KB
    const backend = withWorkerGlobal(() => createHttpBackend({ maxPageSize: 65536, cacheSize: CACHE_MB * 1024, timeout: TIMEOUT_MS, backendType: 'shared' }));
    const dbs = await Promise.all(Array.from({ length: THREADS }, () => withWorkerGlobal(() => createSQLiteThread({ http: backend }))));
    return { backend, threads: dbs.map((db) => ({ db, pending: 0, tail: Promise.resolve(), open: new Map() })) };
  })().catch((e) => { pool = null; throw e; });
  return pool;
}

/** Runs `fn(thread)` after the work already queued on that thread: a thread runs one query at a time. */
function onThread(t, fn) {
  t.pending++;
  const run = t.tail.then(() => fn(t));
  t.tail = run.catch(() => {}).finally(() => { t.pending--; });
  return run;
}

/** SQLite reads a `file:` URI: `?` and `#` would start its own parameters, so they are escaped (SQLite decodes them). */
const sqliteUri = (url) => 'file:' + encodeURI(url).replace(/\?/g, '%3F').replace(/#/g, '%23');

const workerError = (url, ev) => {
  const msg = ev?.result?.message || ev?.message || String(ev);
  // An I/O error is a page read that failed (the host, not the file): a 502 for the client, as source-fetch says
  return Object.assign(new Error(`${url.split('?')[0]}: ${msg}`), /I\/O|IOERR|disk/i.test(msg) ? { status: 502, transient: true } : {});
};

const files = new Map();                           // url → Promise<{ pageSize, size }>, in least-recently-used order

/** The first bytes, read before SQLite is let in: the host's error (404, Range ignored) as it is, not an I/O error. */
async function probe(url) {
  const { status, headers, body } = await requestSource(url, { headers: { Range: 'bytes=0-99' }, timeoutMs: 30_000 });
  if (body.length < 100 || body.toString('latin1', 0, 16) !== 'SQLite format 3\0')
    throw Object.assign(new Error(`${url.split('?')[0]}: not an SQLite file`), { status: 415 });
  const p = body.readUInt16BE(16);
  const size = status === 206 ? Number(/\/(\d+)\s*$/.exec(headers.get('content-range') || '')?.[1]) : body.length;
  return { pageSize: p === 1 ? 65536 : p, size };
}

function closeOnThreads(url) {
  if (!pool) return;
  pool.then(({ threads }) => {
    for (const t of threads) {
      const dbId = t.open.get(url);
      if (!dbId) continue;
      t.open.delete(url);
      onThread(t, () => t.db({ type: 'close', dbId, args: {} })).catch(() => {});
    }
  }).catch(() => {});
}

function fileInfo(url) {
  let f = files.get(url);
  if (f) { files.delete(url); files.set(url, f); return f; }
  f = probe(url).then((info) => {
    console.log(`[sqlite-http] ${url.split('?')[0].slice(-120)}: ${info.size} bytes, ${info.pageSize}-byte pages, read by ranges`);
    return info;
  });
  f.catch(() => { if (files.get(url) === f) files.delete(url); });
  files.set(url, f);
  while (files.size > MAX_OPEN) {
    const oldest = files.keys().next().value;
    files.delete(oldest);
    closeOnThreads(oldest);
  }
  return f;
}

/**
 * Rows of `sql` with `bind` on the remote SQLite file at `url`, each an array of column values (a BLOB as Uint8Array).
 * The file is opened on first use on the least busy thread, and stays open (up to TILED_SQLITE_MAX_OPEN files).
 */
export async function queryRemoteSqlite(url, sql, bind = []) {
  await fileInfo(url);
  const { threads } = await getPool();
  const t = threads.reduce((a, b) => (b.pending < a.pending ? b : a));
  return onThread(t, async () => {
    let dbId = t.open.get(url);
    if (!dbId) {
      const ev = await t.db({ type: 'open', args: { filename: sqliteUri(url), vfs: 'http' } }).catch((e) => { throw workerError(url, e); });
      dbId = ev.dbId;
      t.open.set(url, dbId);
    }
    const rows = [];
    try {
      await t.db({ type: 'exec', dbId, args: { sql, bind, rowMode: 'array', callback: (m) => { if (m.row) rows.push(m.row); } } })
        .catch((e) => { throw workerError(url, e); });
    } finally {
      // closed meanwhile (least recently used, or the query was queued before it was): not left open
      if (!files.has(url) && t.open.get(url) === dbId) { t.open.delete(url); await t.db({ type: 'close', dbId, args: {} }).catch(() => {}); }
    }
    return rows;
  });
}

/** The page size and byte size of a remote SQLite file (from its header, read once). */
export const remoteSqliteInfo = (url) => fileInfo(url);

/** Stops the threads (tests; a server leaves with them). */
export async function closeRemoteSqlite() {
  if (!pool) return;
  const p = pool; pool = null; files.clear();
  const { backend, threads } = await p.catch(() => ({ threads: [] }));
  for (const t of threads) t.db.close();
  backend?.terminate();
}
