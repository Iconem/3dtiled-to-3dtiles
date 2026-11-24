/**
 * source-fetch.js — every read of a source dataset goes through here, whatever its format.
 *
 * One read that fails costs a tile at best and a whole branch of the hierarchy at worst, and the ways of losing one are not
 * format-specific. So what used to be per adapter, and missing from most of them, is one layer:
 *
 *   • A PER-HOST CAP on in-flight requests (`TILED_RANGE_MAX_PER_HOST`, default 32): a burst is paced, not refused. It
 *     halves when the host fails under load and climbs back as reads pass.
 *   • RETRY with backoff (3 attempts) on what may pass: a reset, a timeout, a 429, a 5xx.
 *   • A THROWN ERROR on anything else, never an error body taken for data. `err.status` is the host's answer, and
 *     `err.transient` says a retry might yet work: an adapter may treat a file the host lacks as optional, never one it
 *     could not read.
 *   • A HOST THAT IGNORES RANGE is refused, not downloaded: a range read answered with 200 and more than the bytes asked
 *     for (the whole file) throws `err.rangeIgnored`, with the body cancelled as soon as that is known. A file small enough
 *     to fit in the range asked is taken whole. The client gets an error, not a server busy downloading gigabytes.
 *   • A HOST WHOSE HEADERS `fetch` REFUSES is read with Node's own client in lenient mode. Some servers fold a long header
 *     over several lines (pdmap.pland.gov.hk's Content-Security-Policy, the Hong Kong 3D model host): obsolete line folding,
 *     which undici rejects as malformed HTTP. Once a host has failed that way, every read of it goes the lenient way.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const MAX_PER_HOST = Number(process.env.TILED_RANGE_MAX_PER_HOST) || 32;
const MIN_PER_HOST = 4;
const TRANSIENT = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN|socket hang up|fetch failed|other side closed|UND_ERR|network/i;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The cap adapts to the host, as TCP does: a failure that may be load (a 429, a 503, a reset, a timeout) halves it, down to
// MIN_PER_HOST, and a full window of reads that all passed raises it by one, back up to the configured cap. So a host that
// drops requests under a burst is given fewer, and one that recovers gets them back.
const hosts = new Map();                            // host → { cap, active, queue: resolve[], passed }
const hostOf = (host) => { let h = hosts.get(host); if (!h) hosts.set(host, h = { cap: MAX_PER_HOST, active: 0, queue: [], passed: 0 }); return h; };
function acquire(host) {
  const h = hostOf(host);
  const release = () => { h.active--; while (h.active < h.cap && h.queue.length) { h.active++; h.queue.shift()(); } };
  if (h.active < h.cap) { h.active++; return Promise.resolve(release); }
  return new Promise(resolve => h.queue.push(() => resolve(release)));
}
function noteOutcome(host, transientFailure) {
  const h = hostOf(host);
  if (transientFailure) {
    const cap = Math.max(MIN_PER_HOST, Math.floor(h.cap / 2));
    if (cap < h.cap) console.warn(`[source] ${host}: lowering to ${cap} requests at a time`);
    h.cap = cap; h.passed = 0;
  } else if (h.cap < MAX_PER_HOST && ++h.passed >= h.cap * 2) { h.cap++; h.passed = 0; }
}
/** The cap a host is at now (tests, logs). */
export const hostLimit = (host) => hostOf(host).cap;

const isTransient = (e) => e.transient === true || e.name === 'TimeoutError' || e.name === 'AbortError'
  || TRANSIENT.test(e.message || '') || TRANSIENT.test(e.cause?.message || '') || TRANSIENT.test(e.cause?.code || '');

/** A file that is not there (the host's answer for it) rather than a read that failed. */
export const isAbsent = (status) => status === 403 || status === 404 || status === 410;

/** The answer for a client when a request fails on this error: 404 for a file the source lacks, 502 for a host that did not answer. */
export const httpStatusOf = (e) => (!e.status && !e.transient ? 500 : isAbsent(e.status) ? 404 : 502);

/** The url for a message or a log: its query may hold a token. */
const shortUrl = (url) => url.split('?')[0].slice(-120);

/** For a Range header, the most bytes a 200 (the whole file) may hold and still be what was asked: the file is no longer
 *  than the range. `bytes=a-b` → b + 1, `bytes=-n` → n, `bytes=a-` → no limit. Null when there is no Range. */
function wholeFileLimit(range) {
  if (!range) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) return null;
  if (m[1] === '') return Number(m[2]);
  return m[2] === '' ? Infinity : Number(m[2]) + 1;
}

/** The body of an answer, or null as soon as it passes `limit` bytes (declared, then received): then cancelled. */
async function bodyUpTo(r, limit) {
  const declared = Number(r.headers.get('content-length'));
  if (declared > limit) { await r.body?.cancel().catch(() => {}); return null; }
  if (!r.body || limit === Infinity) { const b = Buffer.from(await r.arrayBuffer()); return b.length > limit ? null : b; }
  const reader = r.body.getReader(), parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  return Buffer.concat(parts, total);
}

// ── the lenient client ───────────────────────────────────────────────────────────────────────────────────────────
const lenientHosts = new Set();
/** True when fetch gave up on the answer's framing rather than on the network: the host's HTTP is odd, not down. */
const isMalformedHttp = (e) => /HPE_|HTTPParserError|does not match the HTTP\/1\.1 protocol|invalid header/i
  .test(`${e.cause?.code || ''} ${e.cause?.message || ''} ${e.cause?.name || ''} ${e.message || ''}`);
/** True when the host's answers are read with the lenient client (tests, logs). */
export const isLenientHost = (host) => lenientHosts.has(host);

/** One GET through node:http(s) with `insecureHTTPParser`, redirects followed, → the same shape as fetch's answer. */
function lenientFetch(url, { headers, signal } = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'GET', headers, signal, insecureHTTPParser: true }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) {
        res.resume();
        return lenientFetch(new URL(res.headers.location, url).href, { headers, signal }, hops + 1).then(resolve, reject);
      }
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) for (const x of [].concat(v ?? [])) h.append(k, x);
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => { const body = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: h, arrayBuffer: async () => body }); });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── files on this machine ──────────────────────────────────────────────────────
// A live stream reads its source by byte ranges, and a file on disk gives those as an HTTP host does: the same
// adapters stream a local dataset with nothing converted or copied first. A local source is a `file:` URL, so the
// adapters' URL arithmetic (a sibling file, a child folder) works on it unchanged.
//
// Off unless the server runs for the person at this machine: TILED_ALLOW_EXPORT=1 (the desktop app sets it) or
// TILED_LOCAL_SOURCES=1. A public server must not read its own disk for whoever asks; TILED_LOCAL_SOURCES=0 turns it
// off in any case.
export const localSourcesAllowed = () => process.env.TILED_LOCAL_SOURCES !== '0'
  && (process.env.TILED_LOCAL_SOURCES === '1' || process.env.TILED_ALLOW_EXPORT === '1');

const ENTRY_FILES = ['cloud.js', 'metadata.json', 'lod-meta.json'];
/**
 * A source as the range-reading adapters want it: an absolute path on this machine (`C:\\…`, `/…`) becomes a `file:`
 * URL, a folder the URL of the entry file it holds (Potree, a streamed SOG). `byRanges(fileName)` says whether the
 * format is one of those: the adapters that open local paths themselves (OSGB, Nexus, archives) keep the path. A URL
 * is returned as is.
 */
export async function localSourceUrl(src, byRanges = () => true) {
  if (!src || /^[a-z][a-z0-9+.-]*:\/\//i.test(src) || !path.isAbsolute(src)) return src;
  let file = src;
  if (await fs.stat(src).then((f) => f.isDirectory(), () => false)) {
    for (const name of ENTRY_FILES) if (await fs.stat(path.join(src, name)).then((f) => f.isFile(), () => false)) { file = path.join(src, name); break; }
  }
  return byRanges(path.basename(file)) ? pathToFileURL(file).href : src;
}

/** One read of a `file:` URL, whole or the `Range` asked for → the same shape as an HTTP answer. */
async function readLocalSource(url, headers) {
  if (!localSourcesAllowed()) throw Object.assign(new Error('this server does not read files on its own disk: give it an http(s) URL'), { status: 403 });
  const file = fileURLToPath(new URL(url));
  const range = /^bytes=(\d+)-(\d*)$/.exec(headers?.Range ?? headers?.range ?? '');
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    if (!range) return { status: 200, headers: new Headers({ 'content-length': String(size) }), body: await handle.readFile() };
    const begin = Number(range[1]), end = Math.min(range[2] === '' ? size - 1 : Number(range[2]), size - 1);
    if (begin > end) throw Object.assign(new Error(`read ${path.basename(file)} [${headers.Range}] → beyond its ${size} bytes`), { status: 416 });
    const body = Buffer.allocUnsafe(end - begin + 1);
    let got = 0;
    while (got < body.length) { const { bytesRead } = await handle.read(body, got, body.length - got, begin + got); if (!bytesRead) break; got += bytesRead; }
    return { status: 206, headers: new Headers({ 'content-length': String(got), 'content-range': `bytes ${begin}-${begin + got - 1}/${size}` }), body: got < body.length ? body.subarray(0, got) : body };
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.code === 'EISDIR') throw Object.assign(new Error(`read ${path.basename(file)} → no such file`), { status: 404 });
    throw e;
  } finally { await handle?.close(); }
}

/**
 * One GET with the cap, the status check and the retries → { status, headers, body: Buffer }. `ok(status)` says which answers
 * are data, default 2xx. `timeoutMs` covers the whole read, default none: a full download may rightly take long, and undici
 * already gives up on a socket that stays silent.
 */
export async function requestSource(url, { headers, signal, attempts = 3, timeoutMs = null, ok = (s) => s >= 200 && s < 300 } = {}) {
  if (/^file:/i.test(url)) { signal?.throwIfAborted(); return readLocalSource(url, headers); }
  const host = new URL(url).host;
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    const release = await acquire(host);
    let err;
    try {
      const signals = [signal, timeoutMs && AbortSignal.timeout(timeoutMs)].filter(Boolean);
      const opts = { headers, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] };
      let r;
      if (lenientHosts.has(host)) r = await lenientFetch(url, opts);
      else {
        try { r = await fetch(url, opts); }
        catch (e) {
          if (!isMalformedHttp(e)) throw e;
          console.warn(`[source] ${host} answers with HTTP that fetch refuses (${e.cause?.message || e.message}): reading it with the lenient client from now on`);
          lenientHosts.add(host);
          r = await lenientFetch(url, opts);
        }
      }
      const range = headers?.Range ?? headers?.range;
      if (r.status === 200 && range) {
        const body = await bodyUpTo(r, wholeFileLimit(range) ?? Infinity);
        if (body === null) {
          noteOutcome(host, false);
          const size = Number(r.headers.get('content-length'));
          throw Object.assign(new Error(`read ${shortUrl(url)} [${range}] → the host ignores Range and answers with the whole file${size > 0 ? ` (${size} bytes)` : ''}: refused rather than downloaded`),
            { status: 200, rangeIgnored: true, transient: false, headers: r.headers });
        }
        noteOutcome(host, false);
        return { status: r.status, headers: r.headers, body };
      }
      if (ok(r.status)) { noteOutcome(host, false); return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) }; }
      await r.arrayBuffer().catch(() => {});        // drain so the connection can be reused
      err = Object.assign(new Error(`read ${shortUrl(url)}${headers?.Range ? ` [${headers.Range}]` : ''} → HTTP ${r.status}`), { status: r.status, transient: r.status === 429 || r.status >= 500 });
    } catch (e) { err = e; }
    finally { release(); }
    if (signal?.aborted || err.rangeIgnored) throw err;
    err.transient = isTransient(err);
    if (!isAbsent(err.status)) noteOutcome(host, err.transient);
    if (!err.transient || attempt >= attempts) throw err;
    console.warn(`[source] ${shortUrl(url)} attempt ${attempt} failed: ${err.message}${err.cause ? ` (${err.cause.message || err.cause.code})` : ''}, retrying`);
    await sleep(300 * 2 ** (attempt - 1) + Math.random() * 200);
  }
}

/** A whole file → Buffer. */
export const fetchSource = async (url, opts) => (await requestSource(url, opts)).body;

/** A whole JSON file. Decoded as `Response.json()` does, which drops a BOM. */
export const fetchSourceJson = async (url, opts) => JSON.parse(new TextDecoder().decode(await fetchSource(url, opts)));

/** `[begin, begin + length)` → Buffer of exactly those bytes. A whole file in answer is taken only when it is no longer
 *  than `begin + length` (requestSource refuses a longer one). */
export async function fetchSourceRange(url, begin, length, opts = {}) {
  if (begin < 0 || length < 0) throw new Error(`Invalid range ${begin}+${length}`);
  if (length === 0) return Buffer.alloc(0);
  const { status, body } = await requestSource(url, { timeoutMs: 60_000 + Math.ceil(length / 1000), ...opts, headers: { ...opts.headers, Range: `bytes=${begin}-${begin + length - 1}` } });
  return status === 200 && body.length > length ? body.subarray(begin, begin + length) : body;
}
