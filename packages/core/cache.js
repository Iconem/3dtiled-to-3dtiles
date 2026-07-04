/**
 * memoizeAsync — per-key cache for an async builder that also caches FAILURES.
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
 */
export function memoizeAsync(builder) {
  const cache = new Map();
  return async (key) => {
    if (cache.has(key)) {
      const cached = cache.get(key);
      if (cached instanceof Error) throw cached;
      return cached;
    }
    try {
      const result = await builder(key);
      cache.set(key, result);
      return result;
    } catch (e) {
      cache.set(key, e);
      throw e;
    }
  };
}
