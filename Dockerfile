# Multi-stage build for the two runnable pieces of this repo:
#   - tile-server: the live <format> -> OGC 3D Tiles middleware (packages/tile-server)
#   - viewer:      the static CesiumJS + 3DTilesRendererJS reference client (viewer.html, vite build)
#
# Build + run both:
#   docker compose up --build
# Build just one image:
#   docker build --target tile-server -t 3dtiles-tile-server .
#   docker build --target viewer      -t 3dtiles-viewer .

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

# ---- deps: install the whole workspace once, shared by both build paths below ----
# (Copies the whole packages/ tree up front rather than package.json-only layer-caching: these are
# small JS packages, not a node_modules-heavy monorepo, so the cache-hit savings aren't worth the
# COPY-glob gymnastics pnpm workspace:* resolution would otherwise need.)
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages packages
RUN pnpm install --frozen-lockfile

# ---- viewer: vite build → static dist/, served by a tiny static file server ----
# NOTE: copy root files individually, NOT `COPY . .` — that would re-copy packages/ over the `deps`
# stage's node_modules, clobbering the per-workspace-package node_modules symlinks pnpm just created
# (pnpm's strict linking means each package resolves deps through its OWN node_modules, not just a
# hoisted root one — re-copying packages/ from the plain build context wipes those symlinks and
# breaks resolution, e.g. @gltf-transform/core inside packages/tile-server going missing).
FROM deps AS viewer-build
COPY index.html viewer.html vite.config.mjs ./
RUN pnpm run build

FROM node:22-slim AS viewer
RUN npm install -g serve@14
WORKDIR /app
COPY --from=viewer-build /app/dist ./dist
EXPOSE 3000
# `serve`'s SPA fallback would break the adapters' "real 404 for a missing optional file" probing
# (see vite.config.js's own comment on this) — -s only rewrites a bare `/` request, not every path.
CMD ["serve", "-l", "3000", "dist"]

# ---- tile-server: the Node middleware, no build step needed (plain ESM) ----
# `packages/` (source + its per-package node_modules symlinks) is already correct from `deps` — do
# NOT re-COPY it here, see the viewer-build note above for why that would break dependency resolution.
FROM deps AS tile-server
ENV TILE_PORT=3001
EXPOSE 3001
# TLS_REJECT_UNAUTHORIZED=1 opts back into strict cert verification (server.js relaxes it by
# default — this is a read-only dev proxy for public tilesets, see server.js's own comment).
CMD ["node", "packages/tile-server/server.js"]
