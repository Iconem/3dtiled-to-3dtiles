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
 *   • A range read returns the bytes asked for, even from a host that ignores Range and answers with the whole file.
 *   • A HOST WHOSE HEADERS `fetch` REFUSES is read with Node's own client in lenient mode. Some servers fold a long header
 *     over several lines (pdmap.pland.gov.hk's Content-Security-Policy, the Hong Kong 3D model host): obsolete line folding,
 *     which undici rejects as malformed HTTP. Once a host has failed that way, every read of it goes the lenient way.
 */
import http from 'node:http';
import https from 'node:https';
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

/**
 * One GET with the cap, the status check and the retries → { status, headers, body: Buffer }. `ok(status)` says which answers
 * are data, default 2xx. `timeoutMs` covers the whole read, default none: a full download may rightly take long, and undici
 * already gives up on a socket that stays silent.
 */
export async function requestSource(url, { headers, signal, attempts = 3, timeoutMs = null, ok = (s) => s >= 200 && s < 300 } = {}) {
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
      if (ok(r.status)) { noteOutcome(host, false); return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) }; }
      await r.arrayBuffer().catch(() => {});        // drain so the connection can be reused
      err = Object.assign(new Error(`read ${shortUrl(url)}${headers?.Range ? ` [${headers.Range}]` : ''} → HTTP ${r.status}`), { status: r.status, transient: r.status === 429 || r.status >= 500 });
    } catch (e) { err = e; }
    finally { release(); }
    if (signal?.aborted) throw err;
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

/** `[begin, begin + length)` → Buffer of exactly those bytes. */
export async function fetchSourceRange(url, begin, length, opts = {}) {
  if (begin < 0 || length < 0) throw new Error(`Invalid range ${begin}+${length}`);
  if (length === 0) return Buffer.alloc(0);
  const { status, body } = await requestSource(url, { timeoutMs: 60_000 + Math.ceil(length / 1000), ...opts, headers: { ...opts.headers, Range: `bytes=${begin}-${begin + length - 1}` } });
  return status === 200 && body.length > length ? body.subarray(begin, begin + length) : body;
}
