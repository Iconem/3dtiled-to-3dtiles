import type { AssetType } from './formats';
import type { DatasetMarker } from './aggregate';

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
  setBasemap(id: string): void;
  setTerrainMode(mode: 'wgs84' | 'cesium' | 'google'): void;
  setMaxSSE(v: number | null): void;
  toggleAssetVisible(show: boolean): void;
  setOrtho(on: boolean): void;
  toggleDebug(on: boolean): void;
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
  // Aggregate mosaics (optional — CesiumViewer implements both; callers fall back when absent).
  /** Show one "there is data here" marker per dataset, or clear them with null. */
  setDatasetMarkers?(list: DatasetMarker[] | null): void;
  /** Frame a dataset from its bounding sphere (degrees, metres). */
  flyToSphere?(lon: number, lat: number, height: number, radius: number): void;
  // 3DTRJS-only — no-ops on CesiumViewer.
  setControlMode?(mode: 'globe' | 'orbit' | 'env'): void;
  setPointSize?(px: number): void;
  showCropGizmo?(): boolean;
  hideCropGizmo?(): void;
  showTilesetGizmo?(): void;
  hideTilesetGizmo?(): void;
}
