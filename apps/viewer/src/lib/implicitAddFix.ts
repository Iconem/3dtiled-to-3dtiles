/**
 * Works around a 3d-tiles-renderer (0.5.2, and master as of 70847eb) traversal bug that hides
 * ADD-refined implicit tilesets whenever they are far enough to be "good enough".
 *
 * `markUsedTiles` skips a child of an ADD tile when "the parent already meets the error target in the
 * child's region" (an optimisation borrowed from Cesium) — without checking that the parent has
 * anything to render. An implicit subtree root only has unrenderable content (the .subtree);
 * SUBTREELoader moves its real content into a CONTENT CHILD with the same geometric error, under
 * which the rest of the subtree hangs. Once that child's error drops below the target it is skipped
 * — with its whole subtree — and nothing draws: every /stream COPC/Potree point cloud vanished at a
 * normal viewing distance (Geghard from 1.2 km: 2.3 px < target 4) and only appeared up close.
 *
 * The fix raises the content child's view error to just above the target through the plugin
 * error hook, so it is never skipped. Its own children keep their normal checks, which ARE valid
 * there, since the content child does render. Nothing else changes: geometric errors are untouched,
 * so deeper subtrees (whose errors derive from the implicit root's) are unaffected.
 */
export class ImplicitAddRefineFixPlugin {
  name = 'IMPLICIT_ADD_REFINE_FIX_PLUGIN';
  tiles: any = null;

  init(tiles: any) {
    this.tiles = tiles;
  }

  calculateTileViewError(tile: any, target: any) {
    const parent = tile.parent;
    const a = tile.implicitTilingData, b = parent?.implicitTilingData;
    if (
      !parent || parent.refine !== 'ADD' || !parent.internal?.hasUnrenderableContent || !a || !b
      || a.level !== b.level || a.x !== b.x || a.y !== b.y || a.z !== b.z
    ) return false;
    target.inView = true;
    target.error = this.tiles.errorTarget + 1e-3;
    target.distance = Infinity;
    return true;
  }
}
