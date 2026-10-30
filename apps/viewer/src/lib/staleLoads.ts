/**
 * Abort the downloads and parses of tiles the camera has left behind.
 *
 * 3DTRjs cancels a tile that is no longer used only while it is still QUEUED
 * (`TilesRendererBase.removeUnusedPendingTiles`: "to avoid cancelling tiles that may already be
 * nearly downloaded"). Everything already in flight — up to `maxJobsPerOrigin` (25) requests per host,
 * then their main-thread parses — runs to completion. Fly from a country view to a site and the
 * queue first finishes the imagery, terrain and point tiles of every intermediate view, each parsed
 * on the main thread, before the tiles of the view you are looking at get their turn: the "loads all
 * tiles of the camera path" stall, which also starves the native Potree leaves sharing the queues.
 *
 * This plugin runs after every traversal and removes from the cache (which aborts the fetch and
 * discards the parse) any tile that has been downloading or parsing while unused for `graceFrames`
 * consecutive updates. The grace keeps a tile that leaves the frustum for a few frames during a fast
 * rotation from being thrown away and re-requested.
 *
 * Register it on every renderer that shares the queues (the mosaic, its native-leaf children, the
 * globe renderers).
 */
// 3d-tiles-renderer/src/core/renderer/constants.js
const LOADING = 2;
const PARSING = 3;

export class StaleLoadAbortPlugin {
  name = 'STALE_LOAD_ABORT_PLUGIN';
  tiles: any = null;
  graceFrames: number;
  private _unused = new Map<any, number>();
  private _onAfter = () => this._sweep();

  constructor({ graceFrames = 12 }: { graceFrames?: number } = {}) {
    this.graceFrames = graceFrames;
  }

  init(tiles: any) {
    this.tiles = tiles;
    tiles.addEventListener('update-after', this._onAfter);
  }

  dispose() {
    this.tiles?.removeEventListener('update-after', this._onAfter);
    this._unused.clear();
  }

  private _sweep() {
    const tiles = this.tiles;
    if (!tiles || this.graceFrames <= 0) return;
    const { lruCache, loadingTiles } = tiles;
    const unused = this._unused;
    const toRemove: any[] = [];
    for (const tile of loadingTiles as Set<any>) {
      const st = tile.internal.loadingState;
      if (st !== LOADING && st !== PARSING) continue;
      if (lruCache.isUsed(tile)) { unused.delete(tile); continue; }
      const n = (unused.get(tile) ?? 0) + 1;
      if (n >= this.graceFrames) { toRemove.push(tile); unused.delete(tile); }
      else unused.set(tile, n);
    }
    for (const t of toRemove) lruCache.remove(t);
    // forget tiles that finished loading meanwhile
    if (unused.size > 64) for (const t of [...unused.keys()]) if (!loadingTiles.has(t)) unused.delete(t);
  }
}
