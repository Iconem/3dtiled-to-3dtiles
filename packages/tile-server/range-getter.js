/**
 * range-getter.js — HTTP range reads for the streaming adapters, done the way S3 and friends expect.
 *
 * The `copc` library's own `Getter.http` is one `cross-fetch` (node-fetch → `https.globalAgent`, no
 * keep-alive, no socket cap, no retry, no status check) per range. A mosaic tileset request fans out
 * into hundreds of hierarchy-page reads at once; S3 resets some of those connections ("socket hang
 * up" FetchErrors in the prod logs) and node-fetch hands the error straight up, so the page is lost.
 * This getter fixes that at the source:
 *
 *   • COALESCING — range reads issued in the same tick are sorted by offset and merged when they
 *     are adjacent or separated by less than `gap` bytes (COPC writers lay hierarchy pages out
 *     back-to-back, so a drain of 96 pages becomes a handful of requests), capped at `maxBytes`
 *     per merged request. Each caller gets back exactly the bytes it asked for.
 *   • A PER-HOST CAP on in-flight requests (`TILED_RANGE_MAX_PER_HOST`, default 32), so a burst is
 *     paced instead of opening hundreds of sockets. Node's global `fetch` (undici) keeps the
 *     connections alive and reuses them.
 *   • RETRY with backoff (3 attempts) on transient failures — connection reset / hang up / timeout
 *     and HTTP 429/5xx — and a thrown error on any other non-2xx status, instead of parsing a
 *     403 body as hierarchy or point data.
 */

const MAX_PER_HOST = Number(process.env.TILED_RANGE_MAX_PER_HOST) || 32;
const TRANSIENT = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN|socket hang up|fetch failed|other side closed|UND_ERR|network/i;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── per-host in-flight cap ───────────────────────────────────────────────────────────────────────
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

/** One range read `[begin, end)` with the per-host cap, status check and retries. */
export async function fetchRange(url, begin, end, { attempts = 3, timeoutMs = 60_000 } = {}) {
  if (begin < 0 || end < begin) throw new Error(`Invalid range ${begin}-${end}`);
  if (end === begin) return new Uint8Array(0);
  const host = new URL(url).host;
  for (let attempt = 1; ; attempt++) {
    const release = await acquire(host);
    let err;
    try {
      const r = await fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` }, signal: AbortSignal.timeout(timeoutMs) });
      if (r.status === 206 || r.status === 200) {
        const buf = new Uint8Array(await r.arrayBuffer());
        // a server that ignores Range answers 200 with the whole file: cut our slice out of it
        return r.status === 200 && buf.length > end - begin ? buf.subarray(begin, end) : buf;
      }
      await r.arrayBuffer().catch(() => {});       // drain so the connection can be reused
      err = new Error(`range read ${url.split('?')[0].slice(-120)} [${begin}-${end - 1}] → HTTP ${r.status}`);
      err.status = r.status;
      err.transient = r.status === 429 || r.status >= 500;
    } catch (e) { err = e; }
    finally { release(); }
    if (!isTransient(err) || attempt >= attempts) throw err;
    console.warn(`[range] ${url.split('?')[0].slice(-80)} [${begin}-${end - 1}] attempt ${attempt} failed: ${err.message}${err.cause ? ` (${err.cause.message || err.cause.code})` : ''} — retrying`);
    await sleep(300 * 2 ** (attempt - 1) + Math.random() * 200);
  }
}

/**
 * A `(begin, end) → Uint8Array` getter for one URL (the shape the `copc` library takes), coalescing
 * the reads issued within one tick. `gap` is the largest hole worth reading through to merge two
 * ranges (default 64 KB, less than one round-trip's worth of bytes); `maxBytes` caps a merged request.
 */
export function rangeGetter(url, { gap = 65536, maxBytes = 8 * 1024 * 1024, ...fetchOpts } = {}) {
  let queue = [], scheduled = false;
  const flush = () => {
    scheduled = false;
    const reqs = queue; queue = [];
    reqs.sort((a, b) => a.begin - b.begin);
    const groups = [];
    for (const r of reqs) {
      const g = groups[groups.length - 1];
      if (g && r.begin - g.end <= gap && Math.max(g.end, r.end) - g.begin <= maxBytes) { g.end = Math.max(g.end, r.end); g.items.push(r); }
      else groups.push({ begin: r.begin, end: r.end, items: [r] });
    }
    for (const g of groups) {
      fetchRange(url, g.begin, g.end, fetchOpts).then(
        buf => { for (const it of g.items) it.resolve(buf.subarray(it.begin - g.begin, it.end - g.begin)); },
        err => { if (process.env.RANGE_DEBUG) console.log(`[range] group ${g.begin}-${g.end} rejected: ${g.items.length} reads`); for (const it of g.items) it.reject(err); });
    }
  };
  const getter = (begin, end) => new Promise((resolve, reject) => {
    if (begin < 0 || end < begin) return reject(new Error(`Invalid range ${begin}-${end}`));
    queue.push({ begin, end, resolve, reject });
    if (!scheduled) { scheduled = true; setImmediate(flush); }
  });
  getter.url = url;
  return getter;
}
