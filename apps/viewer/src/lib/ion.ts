// Shared Cesium Ion access token — the user's own personal Ion account, used by BOTH renderers
// (CesiumViewer for World Terrain / Google Photorealistic 3D Tiles / Ion asset loading, and
// ThreeDTRjsViewer's QuantizedMeshPlugin+CesiumIonAuthPlugin terrain). A single source avoids the
// same literal token drifting out of sync across the two viewports.
export const CESIUM_ION_TOKEN =
  'REMOVED_CESIUM_ION_TOKEN';
