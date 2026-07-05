#!/bin/sh
# Regenerates dist/env-config.js from this CONTAINER's own environment at container START — the
# runtime-configurable counterpart to VITE_TILE_SERVER_URL (Dockerfile ARG, baked permanently into
# the compiled JS bundle at `docker build` time). Set TILE_SERVER_URL in your compose file's
# `environment:` block and it takes effect on the NEXT container start/restart, no rebuild needed.
set -e
cat > /app/dist/env-config.js <<EOF
window.__TILE_SERVER_URL__ = '${TILE_SERVER_URL:-}';
EOF
exec "$@"
