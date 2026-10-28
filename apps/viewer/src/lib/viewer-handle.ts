import type { AssetType } from './formats';
import type { DatasetMarker } from './aggregate';
import type { DatasetStyle } from './datasetStyle';
import type { BasemapId } from './basemaps';
import type { TerrainMode } from './terrainModes';

/**
 * Renderer-agnostic contract both CesiumViewer and ThreeDTRjsViewer implement via
 * useImperativeHandle — TopBar/Sidebar call these without knowing which renderer is mounted.
 * See C:\Users\jonathan\.claude\plans\cuddly-jingling-rabbit.md.
 */
export interface ViewerHandle {
  // skipAutoFrame: the caller is about to issue its OWN flyToCity() right after this — set true so
  // the renderer's normal "auto-frame camera on the newly-loaded tileset's bounds" behavior doesn't
  // race against it. Both renderers fire their auto-frame asynchronously once the tileset.json fetch
  // resolves, which can land AFTER (and override) an immediately-issued flyToCity — the actual bug
  // behind "Berlin/Washington pills don't zoom to their own location" (all Bing city pills load the
  // SAME global tileset URL, so the auto-frame target is the whole-world bounding sphere, not the city).
  load(url: string, type: AssetType, opts?: { sseOverride?: number | null; skipAutoFrame?: boolean }): void;
  setBasemap(id: BasemapId): void;
  setTerrainMode(mode: TerrainMode): void;
  /** Draw the globe (terrain/ellipsoid) at all; the loaded tileset is untouched. 3DTRjs reads the store. */
  setGlobeVisible?(visible: boolean): void;
  setMaxSSE(v: number | null): void;
  toggleAssetVisible(show: boolean): void;
  setOrtho(on: boolean): void;
  /** 'cells': outlines of the tileset's own declared tiles; 'tiles': the renderer's full debug view. */
  setDebugMode(mode: 'off' | 'cells' | 'tiles'): void;
  /** Re-apply the store's point-cloud shading (size, adaptive sizing, EDL) to the loaded tileset. */
  applyPointShading(): void;
  applyShading(shadeless: boolean, brightness: number): void;
  setFov(deg: number): void;
  flyToLocalFrame(lon: number, lat: number, alt: number, range: number): void;
  applyLocalFrame(lon: number, lat: number, alt: number, range: number): void;
  applyZOffset(v: number): void;
  loadIonAsset(assetId: number, token: string, isSplat: boolean): void;
  toggleCollision(enabled: boolean): void;
  useCurrentView(): { lon: number; lat: number; alt: number; range: number } | null;
  setCropToView(): [number, number, number, number, number, number] | null; // w,s,minH,e,n,maxH
  getExtractMatrix(): number[] | null;
  flyToCity(lon: number, lat: number, height: number): void;
  autoZoomToTileset(): void;
  // Aggregate mosaics (optional — both renderers implement them; callers fall back when absent).
  /** Show one "there is data here" marker per dataset, or clear them with null. */
  setDatasetMarkers?(list: DatasetMarker[] | null): void;
  /**
   * Hide and/or tint datasets of the loaded mosaic in place (by their tile metadata id) — the picker's
   * show/hide and colour modes, without reloading the tileset. null restores everything.
   */
  setDatasetStyle?(style: DatasetStyle | null): void;
  /** Frame a dataset from its bounding sphere (degrees, metres). */
  flyToSphere?(lon: number, lat: number, height: number, radius: number): void;
  /**
   * Ids of the datasets whose bounds are inside the view frustum AND span at least `minFraction` of
   * the viewport height — i.e. the ones that are, or are about to be, actually rendering.
   */
  datasetsInView?(list: DatasetMarker[], minFraction: number): string[];
  /**
   * Move the loaded tileset vertically onto the active terrain: sample the dataset's own surface and
   * the terrain on a grid around its centre and apply the difference as the Z offset. Resolves to a
   * status line.
   */
  snapToGround?(): Promise<string>;
  // 3DTRJS-only — no-ops on CesiumViewer.
  setControlMode?(mode: 'globe' | 'orbit' | 'env'): void;
  setPointSize?(px: number): void;
  showCropGizmo?(): boolean;
  hideCropGizmo?(): void;
  showTilesetGizmo?(): void;
  hideTilesetGizmo?(): void;
}
