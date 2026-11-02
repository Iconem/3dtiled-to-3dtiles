// A Google Cloud / Maps Platform API key (Map Tiles API enabled), used by ThreeDTRjsViewer's
// GoogleCloudAuthPlugin for direct access to Google Photorealistic 3D Tiles — the library's own
// first-party auth path for this (as opposed to CesiumIonAuthPlugin + Ion asset 2275207, which
// brokers the SAME tiles through a Cesium ion account and needs no separate Google credential).
// Never committed: VITE_GOOGLE_MAPS_API_KEY in apps/viewer/.env.local, or GOOGLE_MAPS_API_KEY at container
// start (public/env-config.js). It still ships client-side once set, so restrict it in Google Cloud
// Console (HTTP referrer + API restrictions to Map Tiles / Photorealistic 3D Tiles only).
export const GOOGLE_MAPS_API_KEY: string =
  (typeof window !== 'undefined' && (window as any).__GOOGLE_MAPS_API_KEY__) ||
  import.meta.env.VITE_GOOGLE_MAPS_API_KEY ||
  '';
