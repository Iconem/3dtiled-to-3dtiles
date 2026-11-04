/**
 * memoizeAsync — per-key cache for an async builder that also caches FAILURES (for a while).
 *
 * Every `*-live.js` adapter builds a per-URL "ctx" (parsed header/tree/etc.) once and reuses it for
 * every subsequent request against the same source — reasonable, since the source itself is treated
 * as immutable for the life of the process. But a plain `Map` that only calls `.set()` on the SUCCESS
 * path leaves a broken source with nothing cached: every retry (a client polling a failed tileset
 * load, several tabs/users hitting the same bad file) re-runs the WHOLE expensive builder from
 * scratch, only to fail at the same spot again. For adapters that eager-scan a whole multi-GB file
 * (RAD is the extreme case — a parallel range-fetch+decode pass per chunk), that repeated-work
 * pattern is enough to exhaust CPU/memory under retries. Caching the rejection too makes a broken
 * source fail fast on every subsequent call instead.
 *
 * Two refinements, both learnt from production:
 *   • The PROMISE is cached, not the settled value, so concurrent first calls for one key (a mosaic
 *     fanning out 16 `/stream` requests that all land on the same source) share ONE build instead of
 *     each running the builder.
 *   • `failureTtlMs` bounds how long a rejection is served, by default a minute: one "socket hang up"
 *     during the root read must not mark a perfectly good dataset broken until the process restarts.
 */
export function memoizeAsync(builder, { failureTtlMs = 60_000 } = {}) {
  const cache = new Map();                      // key → { promise } | { error, at }
  return (key) => {
    const hit = cache.get(key);
    if (hit) {
      if (!('error' in hit)) return hit.promise;
      if (Date.now() - hit.at < failureTtlMs) return Promise.reject(hit.error);
      cache.delete(key);                        // expired failure: try again
    }
    const promise = Promise.resolve().then(() => builder(key));
    cache.set(key, { promise });
    promise.then(() => {}, (error) => { cache.set(key, { error, at: Date.now() }); });
    return promise;
  };
}
