/**
 * range-getter.js — coalesced HTTP range reads, the getter the `copc` library takes.
 *
 * The library's own `Getter.http` is one `cross-fetch` per range, with no keep-alive, socket cap, retry or status check. A
 * mosaic tileset request fans out into hundreds of hierarchy-page reads at once; S3 resets some of those connections and
 * the page is lost. Reads issued in the same tick are sorted by offset and merged when they are adjacent or separated by
 * less than `gap` bytes (COPC writers lay hierarchy pages out back-to-back, so a drain of 96 pages becomes a handful of
 * requests), capped at `maxBytes` per merged request. Each caller gets back exactly the bytes it asked for. The cap and the
 * retries come with every source read: see core/source-fetch.js.
 */
import { fetchSourceRange } from '../core/index.js';

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
      fetchSourceRange(url, g.begin, g.end - g.begin, fetchOpts).then(
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
