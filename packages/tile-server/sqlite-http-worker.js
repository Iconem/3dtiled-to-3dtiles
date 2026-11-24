/**
 * sqlite-http-worker.js — the HTTP thread of sqlite-wasm-http, its reads going through core/source-fetch.js.
 *
 * sqlite-wasm-http reads pages with plain `fetch` and takes whatever comes back as page data: an error body, or a whole
 * file from a host that ignores Range, would be read as the database. So this thread gives it a `fetch` that is
 * requestSource (sqlite-http.js loads this module in place of the library's vfs-http-worker.js, then imports that):
 *
 *   • a page read is a `bytes=a-b` range, retried, capped per host, and refused when the host answers with the whole
 *     file (unless the file is no longer than the range): never a download of the database;
 *   • the HEAD it sends for the file size is a one-byte range instead, which also passes hosts that refuse HEAD
 *     (presigned URLs) and refuses a host that ignores Range before the first page.
 *
 * A read that fails throws, which the library answers to SQLite as an I/O error: the query fails, nothing is cached.
 *
 * requestSource itself calls the global `fetch`: inside it (an async context, so through every await) the global is
 * Node's own again.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { requestSource } from '../core/source-fetch.js';

const RANGE = /^bytes=(\d+)-(\d+)$/;
const nativeFetch = globalThis.fetch;
const insideSource = new AsyncLocalStorage();

globalThis.fetch = (url, init) => (insideSource.getStore() ? nativeFetch(url, init) : insideSource.run(true, () => readForSqlite(url, init)));

async function readForSqlite(url, init = {}) {
  const headers = { ...init.headers };
  if (String(init.method || 'GET').toUpperCase() === 'HEAD') {
    const r = await requestSource(url, { headers: { ...headers, Range: 'bytes=0-0' }, timeoutMs: 30_000 });
    const size = r.status === 206 ? Number(/\/(\d+)\s*$/.exec(r.headers.get('content-range') || '')?.[1]) : r.body.length;
    if (!(size > 0)) throw new Error(`${String(url).split('?')[0]}: the host gives no file size`);
    return new Response(null, { status: 200, headers: { 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
  }
  const m = RANGE.exec(headers.Range ?? headers.range ?? '');
  if (!m) throw new Error('sqlite-http: a read without a byte range');
  const begin = Number(m[1]), end = Number(m[2]);
  const { status, body } = await requestSource(url, { headers, timeoutMs: 60_000 + Math.ceil((end - begin + 1) / 1000) });
  return new Response(status === 200 ? body.subarray(begin, end + 1) : body, { status: 206 });
}

await import(new URL('./vfs-http-worker.js', import.meta.resolve('sqlite-wasm-http')).href);
