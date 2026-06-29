/**
 * progress.js — tiny in-memory progress registry for long server-side ops (eager hierarchy drain for
 * cache=hierarchy, whole-dataset convert for cache=full). Keyed by the source URL so the viewer can poll
 * `/progress?key=<url>` and surface it in the timing log. Total may be 0/unknown (indeterminate) — the
 * `done` count still shows forward motion. Jobs self-expire so the map can't grow unbounded.
 */
const jobs = new Map();                       // key → { label, done, total, started, updated, finished }
const TTL_MS = 5 * 60 * 1000;

function sweep(now) { for (const [k, j] of jobs) if (now - j.updated > TTL_MS) jobs.delete(k); }

/** Begin (or restart) a job. `total` 0 = indeterminate. */
export function progressStart(key, label, total = 0, now = Date.now()) {
  if (!key) return;
  sweep(now);
  jobs.set(key, { label, done: 0, total, started: now, updated: now, finished: false });
}
/** Advance a job by `inc`; optionally update the (now-known) total. No-op if the job is unknown. */
export function progressTick(key, inc = 1, total = null, now = Date.now()) {
  const j = jobs.get(key); if (!j) return;
  j.done += inc; if (total != null) j.total = total; j.updated = now;
}
/** Mark a job finished. */
export function progressDone(key, now = Date.now()) {
  const j = jobs.get(key); if (j) { j.finished = true; j.updated = now; }
}
/** Snapshot for the viewer: { label, done, total, finished, elapsedMs } or null. */
export function progressGet(key, now = Date.now()) {
  const j = jobs.get(key); if (!j) return null;
  return { label: j.label, done: j.done, total: j.total, finished: j.finished, elapsedMs: now - j.started };
}
