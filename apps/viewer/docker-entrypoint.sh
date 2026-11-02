#!/bin/sh
# Regenerates dist/env-config.js from this CONTAINER's own environment at container START — the
# runtime-configurable counterpart to VITE_TILE_SERVER_URL/VITE_DOCS_URL (Dockerfile ARGs, baked
# permanently into the compiled JS bundle at `docker build` time). Set TILE_SERVER_URL/DOCS_URL in
# your compose file's `environment:` block and they take effect on the NEXT container start/restart,
# no rebuild needed. Without this, formats.ts's fallback (same host, :3002/docs) is wrong in prod,
# where docs lives on its own subdomain (e.g. 3dtiled-docs.prod.*), not <this host>:3002.
set -e
cat > /app/dist/env-config.js <<EOF
window.__TILE_SERVER_URL__ = '${TILE_SERVER_URL:-}';
window.__DOCS_URL__ = '${DOCS_URL:-}';
window.__GOOGLE_MAPS_API_KEY__ = '${GOOGLE_MAPS_API_KEY:-}';
window.__CESIUM_ION_TOKEN__ = '${CESIUM_ION_TOKEN:-}';
EOF
exec "$@"
