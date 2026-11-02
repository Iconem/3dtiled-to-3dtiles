// Runtime-overridable config for this static SPA build. The Docker image's entrypoint script
// (docker-entrypoint.sh) regenerates this exact file from the container's OWN environment at
// CONTAINER START — unlike VITE_TILE_SERVER_URL/VITE_DOCS_URL (apps/viewer/src/lib/formats.ts), which
// get permanently baked into the compiled JS bundle at `docker build` time and can never change again
// without rebuilding+republishing the image. Empty here means "no runtime override" — formats.ts
// falls back to VITE_TILE_SERVER_URL/VITE_DOCS_URL, then a same-origin-port guess, in that order.
window.__TILE_SERVER_URL__ = '';
window.__DOCS_URL__ = '';
window.__GOOGLE_MAPS_API_KEY__ = '';
window.__CESIUM_ION_TOKEN__ = '';
