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
 * messages `{id, task}` and posts `{id, result}` / `{id, error}`. Reusable across tasks. A worker that dies
 * fails the task it held and is replaced, so one bad tile cannot shrink the pool or hang its caller.
 */
export class WorkerPool {
  constructor(workerURL, size = defaultConcurrency()) {
    this.workerURL = workerURL; this.size = Math.max(1, size);
    this.workers = []; this.idle = []; this.queue = []; this._seq = 0; this._pending = new Map();
    this._spawning = null; this._closed = false;
  }
  _add(Worker) {
    const w = new Worker(this.workerURL);
    w._task = null;
    w.on('message', m => {
      const p = this._pending.get(m.id); if (!p) return; this._pending.delete(m.id);
      w._task = null; w.unref(); this.idle.push(w); this._drain();
      m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
    });
    const lost = (why) => {
      const i = this.workers.indexOf(w); if (i < 0) return;
      this.workers.splice(i, 1); this.idle = this.idle.filter(x => x !== w);
      if (w._task != null) { const p = this._pending.get(w._task); this._pending.delete(w._task); p?.reject(new Error(`tile worker died: ${why}`)); }
      if (!this._closed) { this._add(Worker); this._drain(); }
    };
    w.on('error', e => lost(e?.message || String(e)));
    w.on('exit', code => lost(`exit ${code}`));
    // An idle worker must not keep a CLI alive, and one holding a task must: referenced while it works (_drain),
    // released when it answers. After the listeners, since attaching one references the worker again.
    w.unref();
    this.workers.push(w); this.idle.push(w);
  }
  async _spawn() {
    const { Worker } = await import('worker_threads');
    for (let i = 0; i < this.size; i++) this._add(Worker);
  }
  _drain() {
    while (this.queue.length && this.idle.length) {
      const w = this.idle.pop(); const { id, task, transfer } = this.queue.shift();
      w._task = id; w.ref();
      w.postMessage({ id, task }, transfer || []);
    }
  }
  /** run a task object on a free worker; `transfer` = ArrayBuffers to move (zero-copy). */
  async run(task, transfer) {
    if (!this.workers.length) await (this._spawning ??= this._spawn());
    const id = this._seq++;
    return new Promise((resolve, reject) => { this._pending.set(id, { resolve, reject }); this.queue.push({ id, task, transfer }); this._drain(); });
  }
  async destroy() { this._closed = true; const ws = this.workers; this.workers = []; this.idle = []; await Promise.all(ws.map(w => w.terminate())); }
}

let override;   // setTileWorkers: what a run asked for, over the environment
/**
 * Ask for tile workers from inside the process (an export's `workers`, the CLI's `--workers`), over `TILED_WORKERS`:
 * same values as the flag; null or undefined gives the environment its say back. Returns what was set before, to restore.
 */
export function setTileWorkers(v) { const was = override; override = v == null || v === '' ? undefined : v; return was; }

/**
 * How many tile workers the `TILED_WORKERS` flag asks for: unset, `0` or `off` is none (today's single-thread
 * path, the default), `auto` is one per core but one and at most 8 (more did not go faster when measured, and each
 * worker holds its own decoder and buffers), a number is that many.
 */
export function tileWorkerCount(v = override ?? process.env.TILED_WORKERS) {
  if (v == null || v === '' || /^(0|off|false|no)$/i.test(String(v))) return 0;
  if (/^(auto|on|true|yes)$/i.test(String(v))) return Math.min(8, defaultConcurrency());
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

let shared = null, sharedSize = 0;
/**
 * The process's pool of tile workers, or null when the flag is off. Each worker runs `task-worker.js`: a task
 * names a module and one of its exports, and the worker calls it with the task's arguments (see runTileTask).
 * @param {number} [size] override of the flag (a converter's `workers` option)
 */
export function tilePool(size = tileWorkerCount()) {
  if (!size) return null;
  if (!shared || sharedSize !== size) { shared?.destroy(); shared = new WorkerPool(new URL('./task-worker.js', import.meta.url), sharedSize = size); }
  return shared;
}

/**
 * Call `module`'s export `fn` with `args` on a tile worker. `module` is a file URL (`new URL('./x.js', import.meta.url).href`),
 * `args` must survive a structured clone (no functions), and `transfer` lists the ArrayBuffers to hand over.
 */
export const runTileTask = (pool, module, fn, args, transfer) => pool.run({ module: String(module), fn, args }, transfer);

/**
 * Whether a tile task failed for want of memory rather than for its data: the worker died (V8 ends a worker thread
 * that passes its heap limit), or an allocation failed inside it (typed arrays and the LAZ decoder's WASM heap live
 * outside that limit and throw instead). Such a tile is worth building again with nothing else running beside it.
 */
export const isMemoryFailure = (e) => /tile worker died|allocation failed|out of memory|cannot enlarge memory|invalid (typed )?array length/i.test(e?.message || '');

let lane = Promise.resolve();   // the caller's thread, one fallback at a time
/**
 * runTileTask, with a way out when the workers are short of memory: a tile that failed that way (isMemoryFailure) is
 * built by `fallback` on the caller's thread instead, and those run one after the other, never beside each other, so
 * the tile gets the memory a single-thread run would give it. Any other failure is the tile's own and is thrown.
 * @param {() => Promise<any>} fallback the single-thread build of the same tile
 */
export async function runTileTaskOr(pool, module, fn, args, transfer, fallback) {
  try { return await runTileTask(pool, module, fn, args, transfer); }
  catch (e) {
    if (!isMemoryFailure(e)) throw e;
    tileFallbacks.count++;
    if (tileFallbacks.count === 1 || tileFallbacks.count % 100 === 0)
      console.warn(`[tile workers] a tile ran out of memory on a worker (${String(e.message).split('\n')[0].slice(0, 120)}); built on the main thread instead, one at a time (${tileFallbacks.count} so far). Fewer workers would avoid it.`);
    const run = lane.then(fallback);
    lane = run.catch(() => {});
    return run;
  }
}
/** How many tiles fell back to the caller's thread since the process started (a health figure, and for tests). */
export const tileFallbacks = { count: 0 };

/** A copy of `bytes` that owns its ArrayBuffer, so it can be transferred without taking a cache's buffer with it. */
export const ownBytes = (bytes) => new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
