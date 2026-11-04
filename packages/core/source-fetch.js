/**
 * source-fetch.js — every read of a source dataset goes through here, whatever its format.
 *
 * One read that fails costs a tile at best and a whole branch of the hierarchy at worst, and the ways of losing one are not
 * format-specific. So what used to be per adapter, and missing from most of them, is one layer:
 *
 *   • A PER-HOST CAP on in-flight requests (`TILED_RANGE_MAX_PER_HOST`, default 32): a burst is paced, not refused.
 *   • RETRY with backoff (3 attempts) on what may pass: a reset, a timeout, a 429, a 5xx.
 *   • A THROWN ERROR on anything else, never an error body taken for data. `err.status` is the host's answer, and
 *     `err.transient` says a retry might yet work: an adapter may treat a file the host lacks as optional, never one it
 *     could not read.
 *   • A range read returns the bytes asked for, even from a host that ignores Range and answers with the whole file.
 */
const MAX_PER_HOST = Number(process.env.TILED_RANGE_MAX_PER_HOST) || 32;
const TRANSIENT = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN|socket hang up|fetch failed|other side closed|UND_ERR|network/i;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const hosts = new Map();                            // host → { active, queue: resolve[] }
function acquire(host) {
  let h = hosts.get(host);
  if (!h) hosts.set(host, h = { active: 0, queue: [] });
  const release = () => { const next = h.queue.shift(); if (next) next(); else h.active--; };
  if (h.active < MAX_PER_HOST) { h.active++; return Promise.resolve(release); }
  return new Promise(resolve => h.queue.push(() => resolve(release)));
}

const isTransient = (e) => e.transient === true || e.name === 'TimeoutError' || e.name === 'AbortError'
  || TRANSIENT.test(e.message || '') || TRANSIENT.test(e.cause?.message || '') || TRANSIENT.test(e.cause?.code || '');

/** A file that is not there (the host's answer for it) rather than a read that failed. */
export const isAbsent = (status) => status === 403 || status === 404 || status === 410;

/** The answer for a client when a request fails on this error: 404 for a file the source lacks, 502 for a host that did not answer. */
export const httpStatusOf = (e) => (!e.status && !e.transient ? 500 : isAbsent(e.status) ? 404 : 502);

/** The url for a message or a log: its query may hold a token. */
const shortUrl = (url) => url.split('?')[0].slice(-120);

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
      const r = await fetch(url, { headers, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] });
      if (ok(r.status)) return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) };
      await r.arrayBuffer().catch(() => {});        // drain so the connection can be reused
      err = Object.assign(new Error(`read ${shortUrl(url)}${headers?.Range ? ` [${headers.Range}]` : ''} → HTTP ${r.status}`), { status: r.status, transient: r.status === 429 || r.status >= 500 });
    } catch (e) { err = e; }
    finally { release(); }
    if (signal?.aborted) throw err;
    err.transient = isTransient(err);
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
