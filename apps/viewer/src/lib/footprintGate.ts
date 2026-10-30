/**
 * Do not load a mosaic dataset until it is big enough on screen to be worth a request.
 *
 * In a /aggregate mosaic the cells are empty tiles and every dataset hangs under them as an
 * external tileset (or, with native leaves, as the content tile itself). The 3D Tiles traversal
 * refines through empty tiles unconditionally, so at country scale every dataset root in the frustum
 * — 113 for `flai`, 692 for the full Iconem set — had its tileset.json fetched and its root content
 * (one or two MB of points each) downloaded and parsed, to paint a handful of pixels under a marker
 * that already says "data here". That is the "seeing the whole of France becomes slow" cost, and it
 * applies to native Potree leaves (the child renderer mounts and loads the octree root) exactly as to
 * /stream leaves.
 *
 * This plugin uses 3DTRjs's `calculateTileViewError` hook (the one LoadRegionPlugin masks with) to
 * declare a dataset ROOT out of view while its bounding sphere spans fewer than `minPixels` on
 * screen. Only the tile that carries the dataset id (the mosaic leaf) is gated: once a dataset is
 * large enough, everything below it loads and refines exactly as before. The marker (hidden at 10 %
 * of the viewport, `ThreeDatasetMarkers`) stands for the dataset until then.
 *
 * The same mask hides a dataset the picker has switched off (`isHidden`): its root leaves the used
 * set, so its tiles stop loading and fall out of the cache instead of merely being drawn invisible.
 */
import * as THREE from 'three';

const _sphere = new THREE.Sphere();

export class FootprintGatePlugin {
  name = 'FOOTPRINT_GATE_PLUGIN';
  tiles: any = null;
  /** Bounding-sphere height on screen, in pixels, below which a dataset root is not loaded. 0 = off. */
  minPixels: number;
  /** A tile's own dataset id (mosaic leaves carry one in their tile metadata). */
  idOf: (tile: any) => string | undefined;
  /** A dataset the user has hidden: masked whatever its size. */
  isHidden?: (id: string) => boolean;

  constructor({ minPixels = 24, idOf, isHidden }: { minPixels?: number; idOf: (tile: any) => string | undefined; isHidden?: (id: string) => boolean }) {
    this.minPixels = minPixels;
    this.idOf = idOf;
    this.isHidden = isHidden;
  }

  init(tiles: any) { this.tiles = tiles; }

  /** Returns true (and masks the tile) only for a dataset root that is hidden or too small on screen. */
  calculateTileViewError(tile: any, target: any): boolean {
    const id = this.idOf(tile);
    if (id === undefined) return false;
    if (this.isHidden?.(id)) { target.inView = false; target.error = 0; target.distance = Infinity; return true; }
    if (this.minPixels <= 0) return false;
    const bv = tile.engineData?.boundingVolume;
    if (!bv?.getSphere) return false;
    bv.getSphere(_sphere);
    let maxPx = 0;
    for (const info of this.tiles.cameraInfo as any[]) {
      if (info.isOrthographic) return false;
      // same frame as the core's own error maths: camera position in the tiles group's space
      const d = _sphere.center.distanceTo(info.position);
      if (d <= _sphere.radius) return false;                 // the camera is inside: never gate
      maxPx = Math.max(maxPx, (2 * _sphere.radius) / (d * info.sseDenominator));
    }
    if (maxPx >= this.minPixels) return false;
    target.inView = false;
    target.error = 0;
    target.distance = Infinity;
    return true;
  }
}
