/**
 * @3dtiled/core — the tile worker (worker_threads). A task is `{ module, fn, args }`: the worker imports `module`
 * once, calls its export `fn(args)` and posts the result back. Typed arrays in the result are handed over, not
 * copied. Formats keep their own task modules (tile-server/tile-tasks.js, a converter's tile-task.js), so this
 * file knows nothing about any of them. See WorkerPool / tilePool in parallel.js.
 */
import { parentPort } from 'worker_threads';

const modules = new Map();
/** ArrayBuffers of a result that can be moved: a bare typed array, or the typed arrays one level down in an object. */
function transferables(out) {
  const list = [];
  const take = (v) => { if (ArrayBuffer.isView(v) && v.byteOffset === 0 && v.byteLength === v.buffer.byteLength && !list.includes(v.buffer)) list.push(v.buffer); };
  if (ArrayBuffer.isView(out)) take(out);
  else if (out && typeof out === 'object') for (const v of Object.values(out)) take(v);
  return list;
}

parentPort.on('message', async ({ id, task }) => {
  try {
    let mod = modules.get(task.module);
    if (!mod) modules.set(task.module, mod = await import(task.module));
    let out = await mod[task.fn](task.args);
    // a Node Buffer may be a slice of the shared pool: copy it out rather than post (or move) the whole slab
    if (ArrayBuffer.isView(out) && (out.byteOffset !== 0 || out.byteLength !== out.buffer.byteLength)) out = new Uint8Array(out).slice();
    parentPort.postMessage({ id, result: out }, transferables(out));
  } catch (e) {
    parentPort.postMessage({ id, error: e?.stack || e?.message || String(e) });
  }
});
