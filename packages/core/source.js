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

export class Source {
  constructor(url) { this.url = url; this._rangeSupported = null; }

  /** One contiguous [begin, begin+length) range read → Buffer. */
  async range(begin, length) {
    const r = await fetch(this.url, { headers: { Range: `bytes=${begin}-${begin + length - 1}` } });
    if (r.status !== 206 && r.status !== 200) throw new Error(`range ${this.url} → ${r.status} (server must support HTTP 206)`);
    if (this._rangeSupported === null) this._rangeSupported = r.status === 206;
    return Buffer.from(await r.arrayBuffer());
  }

  /** Many ranges in parallel (bounded). `reqs` = [{begin,length}, …] → Buffer[] (input order). */
  async ranges(reqs, concurrency = Math.min(defaultConcurrency(), 16)) {
    const out = new Array(reqs.length);
    await parallelMap(reqs, async (req, i) => { out[i] = await this.range(req.begin, req.length); }, { concurrency });
    return out;
  }

  /** Whole resource → Buffer. */
  async full() {
    const r = await fetch(this.url);
    if (!r.ok) throw new Error(`fetch ${this.url} → ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  /** Probe range support + size via one ranged GET of the first `probeLen` bytes.
   *  → { buf, rangeSupported, total }. total = file size (from Content-Range / Content-Length). */
  async probe(probeLen) {
    const r = await fetch(this.url, { headers: { Range: `bytes=0-${probeLen - 1}` } });
    if (r.status !== 206 && r.status !== 200) throw new Error(`probe ${this.url} → ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    this._rangeSupported = r.status === 206;
    let total = null;
    const cr = r.headers.get('content-range');               // "bytes start-end/total"
    if (cr) { const m = cr.match(/\/(\d+)\s*$/); if (m) total = Number(m[1]); }
    else if (r.headers.get('content-length')) total = Number(r.headers.get('content-length'));
    return { buf, rangeSupported: this._rangeSupported, total };
  }

  get rangeSupported() { return this._rangeSupported; }
}
