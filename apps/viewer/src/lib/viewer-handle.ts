import type { AssetType } from './formats';

/**
 * Renderer-agnostic contract both CesiumViewer and ThreeDTRjsViewer implement via
 * useImperativeHandle — TopBar/Sidebar call these without knowing which renderer is mounted.
 * See C:\Users\jonathan\.claude\plans\cuddly-jingling-rabbit.md.
 */
export interface ViewerHandle {
  load(url: string, type: AssetType, opts?: { sseOverride?: number | null }): void;
  setBasemap(id: string): void;
  toggleTerrain(on: boolean): void;
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
  flyToOrigin(): void;
  // 3DTRJS-only — no-ops on CesiumViewer.
  setControlMode?(mode: 'globe' | 'orbit' | 'env'): void;
  setPointSize?(px: number): void;
  showCropGizmo?(): boolean;
  hideCropGizmo?(): void;
}
