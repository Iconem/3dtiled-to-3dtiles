# Multi-stage build for the three runnable pieces of this repo:
#   - tile-server: the live <format> -> OGC 3D Tiles middleware (packages/tile-server)
#   - viewer:      apps/viewer ("3D Tiled", React + vite build) — also serves the legacy standalone
#                  vanilla-viewer.html at /vanilla-viewer, built into the same dist/
#   - docs:        apps/docs (Fumadocs/Next) — kept as its OWN service; its search API needs a live
#                  Node server, not just static files, so it can't fold into the viewer's static
#                  dist/ the way vanilla-viewer.html does. If you put a reverse proxy in front of all
#                  three, route /docs + its asset/API routes (see docker-compose.yml's comment) at
#                  this service and everything else at viewer — matching what apps/viewer's own
#                  vite dev-server proxy already does for local dev.
#
# Build + run all three:
#   docker compose up --build
# Build just one image:
#   docker build --target tile-server -t 3dtiles-tile-server .
#   docker build --target viewer      -t 3dtiles-viewer .
#   docker build --target docs        -t 3dtiles-docs .

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

# ---- deps: install the whole workspace once, shared by all three build paths below ----
# Copies packages/, apps/viewer/, AND apps/docs/ in full (not package.json-only layer-caching) —
# NOT just for cache-simplicity like packages/ (small JS packages, not worth the COPY-glob
# gymnastics pnpm workspace:* resolution would otherwise need), but because apps/docs' own
# `"postinstall": "fumadocs-mdx"` script runs automatically as part of THIS install step and needs
# its real source.config.ts + content/ already present — package.json alone isn't enough, and a
# failing postinstall here fails `pnpm install` for every target, not just docs.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages packages
COPY apps/viewer apps/viewer
COPY apps/docs apps/docs
RUN pnpm install --frozen-lockfile

# ---- viewer: vite build → static dist/, served by a tiny static file server ----
FROM deps AS viewer-build
RUN pnpm --filter 3d-tiled build

FROM node:22-slim AS viewer
RUN npm install -g serve@14
WORKDIR /app
COPY --from=viewer-build /app/apps/viewer/dist ./dist
EXPOSE 3000
# `serve`'s SPA fallback would break the adapters' "real 404 for a missing optional file" probing
# (see vite.config.ts's own comment on this) — -s only rewrites a bare `/` request, not every path.
# `dist/serve.json` (vite's publicDir → apps/viewer/public/serve.json) supplies the /vanilla-viewer
# extension-less rewrite that vite's OWN dev-only middleware handles in `pnpm dev`.
CMD ["serve", "-l", "3000", "dist"]

# ---- docs: next build → next start, its own service (see the Traefik-routing note up top) ----
FROM deps AS docs-build
RUN pnpm --filter docs build

FROM base AS docs
ENV NODE_ENV=production
# hoisted node-linker (.npmrc) puts `next`'s real binary in the ROOT node_modules/.bin, not
# apps/docs/node_modules/.bin (that dir doesn't even exist — this runtime stage never copies
# pnpm-workspace.yaml/pnpm-lock.yaml, so `pnpm run start` here can't resolve the workspace root to
# find it either). Skip pnpm entirely and put the real bin dir on PATH so `next` resolves directly.
ENV PATH="/app/node_modules/.bin:${PATH}"
COPY --from=docs-build /app/apps/docs ./apps/docs
COPY --from=docs-build /app/node_modules ./node_modules
WORKDIR /app/apps/docs
EXPOSE 3002
CMD ["next", "start", "-p", "3002"]

# ---- tile-server: the Node middleware, no build step needed (plain ESM) ----
# `packages/` (source + its per-package node_modules symlinks) is already correct from `deps` — don't
# re-COPY it from a plain `COPY . .`: pnpm's strict linking means each package resolves deps through
# its OWN node_modules, not just a hoisted root one, so re-copying from the build context would wipe
# those symlinks and break resolution (e.g. @gltf-transform/core inside packages/tile-server missing).
FROM deps AS tile-server
ENV TILE_PORT=3001
EXPOSE 3001
# TLS_REJECT_UNAUTHORIZED=1 opts back into strict cert verification (server.js relaxes it by
# default — this is a read-only dev proxy for public tilesets, see server.js's own comment).
CMD ["node", "packages/tile-server/server.js"]
