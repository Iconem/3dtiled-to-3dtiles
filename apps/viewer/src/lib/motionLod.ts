/**
 * Coarser globe tiles while a scripted flight is in progress; the fine ones on arrival.
 *
 * A fly-to (double-click, a marker, a search hit) puts the camera somewhere new on every frame of its
 * tween. 3DTRjs's traversal then requests the tiles of each of these intermediate views at the full
 * error target: for the imagery globe that is the whole path from the current level to z18 or so,
 * with ancestors and siblings (`loadAncestors`), per frame. The downloads of views the camera has
 * already left are aborted (lib/staleLoads.ts) but the queue still spends its 25 slots per host on
 * them first, and the tiles of the destination get their turn only when the camera is already there.
 *
 * While `flight.active` (set by the viewer's camera tween for its duration) this plugin multiplies the
 * renderer's `errorTarget` by `boost`, so the frames of the flight only load coarse levels; the frame
 * after arrival requests the destination at the normal target. It does nothing for user input — a
 * drag, an orbit, a wheel step: those must not coarsen what is on screen (an earlier version boosted
 * from the camera's speed, which made the data and the terrain visibly flicker between levels while
 * panning). Register it on the globe renderers only: the data keeps its own LOD at all times.
 */
/** Set by scripted camera moves (fly-to tweens) for their duration. */
export const flight = { active: false };

let requestFrame: (() => void) | null = null;
/** The host's "draw another frame" (R3F's invalidate): the decay needs frames after the motion stops. */
export function setMotionLodInvalidate(fn: (() => void) | null) { requestFrame = fn; }

/** Every registered instance, for devtools and headless checks (`window.tiles3dtr.motionLod()`). */
export const motionLodPlugins = new Set<MotionLodPlugin>();

export class MotionLodPlugin {
  name = 'MOTION_LOD_PLUGIN';
  tiles: any = null;
  /** Error target multiplier while a scripted flight is in progress. */
  boost: number;
  private _base = NaN;
  private _applied = 1;
  private _onBefore = () => this._before();
  private _onAfter = () => this._after();

  constructor({ boost = 6 }: { boost?: number } = {}) {
    this.boost = boost;
  }

  init(tiles: any) {
    this.tiles = tiles;
    tiles.addEventListener('update-before', this._onBefore);
    tiles.addEventListener('update-after', this._onAfter);
    motionLodPlugins.add(this);
  }

  dispose() {
    motionLodPlugins.delete(this);
    this.tiles?.removeEventListener('update-before', this._onBefore);
    this.tiles?.removeEventListener('update-after', this._onAfter);
    if (this.tiles && !Number.isNaN(this._base)) this.tiles.errorTarget = this._base;
    this._base = NaN;
  }

  /** The multiplier applied on the last update (1 = at rest); for debugging and tests. */
  get applied() { return this._applied; }

  private _before() {
    const tiles = this.tiles;
    // the renderer's own value between updates is the base — ours was restored in update-after
    this._base = tiles.errorTarget;
    this._applied = flight.active ? this.boost : 1;
    if (this._applied > 1) {
      tiles.errorTarget = this._base * this._applied;
    } else if (this._wasBoosted) {
      // first update after arrival: the destination's tiles at the normal target, right now
      requestFrame?.();
    }
    this._wasBoosted = this._applied > 1;
  }
  private _wasBoosted = false;

  private _after() {
    if (!Number.isNaN(this._base)) this.tiles.errorTarget = this._base;
  }
}
