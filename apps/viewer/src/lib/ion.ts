// Shared Cesium Ion access token, used by BOTH renderers (CesiumViewer for World Terrain / Google
// Photorealistic 3D Tiles / Ion asset loading, and ThreeDTRjsViewer's QuantizedMeshPlugin+CesiumIonAuthPlugin
// terrain). Never committed: VITE_CESIUM_ION_TOKEN in apps/viewer/.env.local, or CESIUM_ION_TOKEN at
// container start (public/env-config.js). It still ships client-side once set.
export const CESIUM_ION_TOKEN: string =
  (typeof window !== 'undefined' && (window as any).__CESIUM_ION_TOKEN__) ||
  import.meta.env.VITE_CESIUM_ION_TOKEN ||
  '';
