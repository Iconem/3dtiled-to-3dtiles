/**
 * source.js — uniform HTTP source for the live stream adapters.
 *
 * Replaces the per-adapter `fetchFull` / `rangeGet` / `fetchRange` helpers with one object that:
 *   • prefers HTTP range reads (206) and runs many in parallel,
 *   • probes range support once,
 *   • falls back to a single full download when the host ignores Range.
 *
 * "Parallel range whenever possible" is structural here, not re-implemented per format.
 */
import { parallelMap, defaultConcurrency } from './parallel.js';
import { requestSource, fetchSource, fetchSourceRange } from './source-fetch.js';

export class Source {
  constructor(url) { this.url = url; this._rangeSupported = null; }

  /** One contiguous [begin, begin+length) range read → Buffer. */
  range(begin, length) { return fetchSourceRange(this.url, begin, length); }

  /** Many ranges in parallel (bounded). `reqs` = [{begin,length}, …] → Buffer[] (input order). */
  async ranges(reqs, concurrency = Math.min(defaultConcurrency(), 16)) {
    const out = new Array(reqs.length);
    await parallelMap(reqs, async (req, i) => { out[i] = await this.range(req.begin, req.length); }, { concurrency });
    return out;
  }

  /** Whole resource → Buffer. */
  full() { return fetchSource(this.url); }

  /** Probe range support + size via one ranged GET of the first `probeLen` bytes.
   *  → { buf, rangeSupported, total }. total = file size (from Content-Range / Content-Length). */
  async probe(probeLen) {
    const { status, headers, body: buf } = await requestSource(this.url, { headers: { Range: `bytes=0-${probeLen - 1}` } });
    this._rangeSupported = status === 206;
    let total = null;
    const cr = headers.get('content-range');                 // "bytes start-end/total"
    if (cr) { const m = cr.match(/\/(\d+)\s*$/); if (m) total = Number(m[1]); }
    else if (headers.get('content-length')) total = Number(headers.get('content-length'));
    return { buf, rangeSupported: this._rangeSupported, total };
  }

  get rangeSupported() { return this._rangeSupported; }
}
