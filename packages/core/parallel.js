/**
 * @3dtiled/core — parallelism helpers.
 *
 * `parallelMap` runs an async worker over items with bounded concurrency. Combined with the
 * async `buildSpzBuffer` (zlib.gzip on the libuv threadpool) this fans tile encoding+gzip+write
 * across cores with no worker_threads. For decode-heavy formats, `WorkerPool` runs a worker script.
 *
 * Tune `UV_THREADPOOL_SIZE` (env) to raise the libuv pool above its default 4 for more gzip lanes.
 */
import os from 'os';

export const defaultConcurrency = () => Math.max(1, (os.cpus()?.length || 4) - 1);

/**
 * Run `fn(item, index)` over `items` with at most `concurrency` in flight (order-preserving result).
 * @template T,R
 * @param {T[]} items
 * @param {(item:T,index:number)=>Promise<R>} fn
 * @param {{concurrency?:number, onProgress?:(done:number,total:number)=>void}} [opts]
 * @returns {Promise<R[]>}
 */
export async function parallelMap(items, fn, opts = {}) {
  const concurrency = Math.max(1, opts.concurrency || defaultConcurrency());
  const results = new Array(items.length);
  let next = 0, done = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
      done++;
      if (opts.onProgress) opts.onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/**
 * Minimal worker_threads pool for decode-heavy formats. `workerURL` is a module that listens for
 * messages `{id, task}` and posts `{id, result}` / `{id, error}`. Reusable across tasks.
 */
export class WorkerPool {
  constructor(workerURL, size = defaultConcurrency()) {
    this.workerURL = workerURL; this.size = Math.max(1, size);
    this.workers = []; this.idle = []; this.queue = []; this._seq = 0; this._pending = new Map();
  }
  async _spawn() {
    const { Worker } = await import('worker_threads');
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(this.workerURL);
      w.on('message', m => {
        const p = this._pending.get(m.id); if (!p) return; this._pending.delete(m.id);
        this.idle.push(w); this._drain();
        m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
      });
      this.workers.push(w); this.idle.push(w);
    }
  }
  _drain() {
    while (this.queue.length && this.idle.length) {
      const w = this.idle.pop(); const { id, task, transfer } = this.queue.shift();
      w.postMessage({ id, task }, transfer || []);
    }
  }
  /** run a task object on a free worker; `transfer` = ArrayBuffers to move (zero-copy). */
  async run(task, transfer) {
    if (!this.workers.length) await this._spawn();
    const id = this._seq++;
    return new Promise((resolve, reject) => { this._pending.set(id, { resolve, reject }); this.queue.push({ id, task, transfer }); this._drain(); });
  }
  async destroy() { await Promise.all(this.workers.map(w => w.terminate())); this.workers = []; this.idle = []; }
}
