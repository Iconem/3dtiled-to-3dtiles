// A Google Cloud / Maps Platform API key (Map Tiles API enabled), used by ThreeDTRjsViewer's
// GoogleCloudAuthPlugin for direct access to Google Photorealistic 3D Tiles — the library's own
// first-party auth path for this (as opposed to CesiumIonAuthPlugin + Ion asset 2275207, which
// brokers the SAME tiles through a Cesium ion account and needs no separate Google credential).
// Ships client-side, same exposure model as the Cesium ion token in lib/ion.ts — make sure this key
// is restricted in Google Cloud Console (HTTP referrer + API restrictions to Map Tiles /
// Photorealistic 3D Tiles only) since it's visible in this public repo's history.
export const GOOGLE_MAPS_API_KEY = 'REMOVED_GOOGLE_API_KEY';
