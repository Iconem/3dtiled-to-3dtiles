/**
 * range-getter.js — coalesced HTTP range reads: the getter the `copc` library takes, and the read every other range
 * adapter (Potree 2.0, LCC, LCC2, Nexus) goes through.
 *
 * The library's own `Getter.http` is one `cross-fetch` per range, with no keep-alive, socket cap, retry or status check. A
 * mosaic tileset request fans out into hundreds of hierarchy-page reads at once; S3 resets some of those connections and
 * the page is lost. Reads issued in the same tick are sorted by offset and merged when they are adjacent or separated by
 * less than `gap` bytes (COPC writers lay hierarchy pages out back-to-back, so a drain of 96 pages becomes a handful of
 * requests), capped at `maxBytes` per merged request. Each caller gets back exactly the bytes it asked for. The cap and the
 * retries come with every source read: see core/source-fetch.js.
 *
 * `sharedRangeGetter(url)` is one getter per source URL, kept in a small LRU, so that reads of the same file from
 * DIFFERENT tile requests share a queue: a viewer asks for sibling tiles in a burst of HTTP requests, and the formats
 * that lay a level's nodes out back-to-back (Potree's octree.bin, Nexus nodes and textures, LCC's data.bin, the planes
 * of a bundled SOG) then read one range for the burst instead of one per tile. The window those requests fall into is
 * one tick (`setImmediate`) by default; `TILED_RANGE_COALESCE_MS=<ms>` (or `windowMs`) holds the first read of a window
 * back by that long so that requests a few milliseconds apart coalesce too, at the cost of that latency on every read.
 * The default stays at 0 (COPC's behaviour since 2026-10-29): the measurements are in the changelog of 2026-11-11.
 *
 * `rangeStats` counts, for `RANGE_DEBUG` and the tests: reads asked for, requests sent, bytes asked for and bytes read.
 */
import { fetchSourceRange } from '../core/index.js';

const WINDOW_MS = Math.max(0, Number(process.env.TILED_RANGE_COALESCE_MS) || 0);
const SHARED_MAX = 256;                                 // URLs whose getter is kept (an idle getter is an empty queue)

/** Running totals over every getter: `reads` asked, `requests` sent, `bytesAsked` by the callers, `bytesFetched` from the host. */
export const rangeStats = { reads: 0, requests: 0, bytesAsked: 0, bytesFetched: 0 };
export function resetRangeStats() { for (const k of Object.keys(rangeStats)) rangeStats[k] = 0; }

/**
 * A `(begin, end) → Uint8Array` getter for one URL (the shape the `copc` library takes), coalescing
 * the reads issued within one window. `gap` is the largest hole worth reading through to merge two
 * ranges (default 64 KB, less than one round-trip's worth of bytes); `maxBytes` caps a merged request;
 * `windowMs` is the batching window (default `TILED_RANGE_COALESCE_MS`, 0 = the current tick).
 */
export function rangeGetter(url, { gap = 65536, maxBytes = 8 * 1024 * 1024, windowMs = WINDOW_MS, ...fetchOpts } = {}) {
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
    let asked = 0, fetched = 0;
    for (const r of reqs) asked += r.end - r.begin;
    for (const g of groups) fetched += g.end - g.begin;
    rangeStats.reads += reqs.length; rangeStats.requests += groups.length; rangeStats.bytesAsked += asked; rangeStats.bytesFetched += fetched;
    if (process.env.RANGE_DEBUG && reqs.length) console.log(`[range] ${url.split('?')[0].slice(-60)}: ${reqs.length} reads → ${groups.length} requests, ${(asked / 1024).toFixed(1)} KB asked, ${(fetched / 1024).toFixed(1)} KB fetched`);
    for (const g of groups) {
      fetchSourceRange(url, g.begin, g.end - g.begin, fetchOpts).then(
        buf => { for (const it of g.items) it.resolve(buf.subarray(it.begin - g.begin, it.end - g.begin)); },
        err => { if (process.env.RANGE_DEBUG) console.log(`[range] group ${g.begin}-${g.end} rejected: ${g.items.length} reads`); for (const it of g.items) it.reject(err); });
    }
  };
  const getter = (begin, end) => new Promise((resolve, reject) => {
    if (begin < 0 || end < begin) return reject(new Error(`Invalid range ${begin}-${end}`));
    queue.push({ begin, end, resolve, reject });
    if (!scheduled) { scheduled = true; if (windowMs > 0) setTimeout(flush, windowMs); else setImmediate(flush); }
  });
  getter.url = url;
  return getter;
}

// url (and options) → the getter every reader of that URL shares. A getter holds nothing between flushes, so the LRU
// only bounds the map; an evicted getter finishes the reads it has and is forgotten.
const shared = new Map();
/** The getter for `url` shared by every caller with the same `gap` / `maxBytes` / `windowMs` (see the file header). */
export function sharedRangeGetter(url, { gap, maxBytes, windowMs } = {}) {
  const key = `${gap ?? ''}|${maxBytes ?? ''}|${windowMs ?? ''}|${url}`;
  let g = shared.get(key);
  if (g) { shared.delete(key); shared.set(key, g); return g; }
  g = rangeGetter(url, { ...(gap != null && { gap }), ...(maxBytes != null && { maxBytes }), ...(windowMs != null && { windowMs }) });
  shared.set(key, g);
  if (shared.size > SHARED_MAX) shared.delete(shared.keys().next().value);
  return g;
}

/**
 * `[begin, begin + length)` of `url` through its shared getter → Buffer of exactly those bytes, a view into the merged
 * read: a caller that keeps the bytes (a cache) copies them, or it pins the whole merged buffer. Same errors as
 * core's fetchSourceRange (`status`, `transient`), the same for every read of a merged request.
 */
export function readRange(url, begin, length, opts) {
  if (begin < 0 || length < 0) return Promise.reject(new Error(`Invalid range ${begin}+${length}`));
  if (length === 0) return Promise.resolve(Buffer.alloc(0));
  return sharedRangeGetter(url, opts)(begin, begin + length);
}
