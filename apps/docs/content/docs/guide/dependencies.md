---
title: "Dependencies"
description: "Major dependencies per workspace package, grouped by the middleware server + offline converters (Packages), the viewer, and the docs site."
---

Dependencies are grouped into three areas: **Packages** (the middleware server + every offline
converter — `packages/*`), **Viewer** (`apps/viewer` and the legacy `viewer.html`), and a short mention
of `apps/docs`'s own tooling. Versions aren't tracked here — see each package's own `package.json`/
lockfile for what's currently resolved.

## Packages

The middleware server (`packages/tile-server`) and every offline `<fmt>-to-3dtiles` converter, plus
the shared `core` and meta-converter, as one workspace group.

### `packages/core` (`3dtiles-convert-core`)

| Package | Used by |
|---------|---------|
| `@gltf-transform/core` | glTF read/write, shared by every converter |
| `@gltf-transform/extensions` | glTF extension (de)registration |
| `@gltf-transform/functions` | glTF-Transform pipeline ops (`/gltf` decompress) |
| `three` | Basis/KTX2 transcoding support |
| `draco3dgltf` | Draco geometry decode/encode registration |
| `ktx-parse` | KTX2 container parsing |
| `ktx2-encoder` | in-process KTX2 (ETC1S/UASTC) WASM encoder |
| `@jsquash/webp` | WebP decode (SOG textures) |
| `pngjs` | pure-JS PNG encode (KTX2→PNG decompress path) |
| `jpeg-js` | pure-JS JPEG decode/encode |

### `packages/convert` (meta CLI/SDK)

| Package | Used by |
|---------|---------|
| `fflate` | zip read (remote directory-format mirroring) |
| `sql.js` | `.3dtiles` package output |
| workspace: `copc-to-3dtiles`, `potree-to-3dtiles`, `rad-to-3dtiles`, `sog-to-3dtiles`, `lcc-to-3dtiles`, `i3s-to-3dtiles`, `3dtiles-convert-core` | per-format converters |

### `packages/tile-server`

| Package | Used by |
|---------|---------|
| `copc` | `/stream?format=copc` range adapter |
| `proj4` | live georeferencing (COPC/Potree/I3S) |
| `@loaders.gl/i3s` | `/stream?format=i3s` |
| `@loaders.gl/zip` | `.3tz` / SLPK zip random access |
| `@playcanvas/splat-transform` | `/stream?format=sog`, `/extract` splat merge |
| workspace: `3dtiles-convert-core`, `3dtiles-tools`, `i3s-to-3dtiles`, `implicit-to-explicit` | shared decode/encode + tileset transforms |

### `packages/copc-to-3dtiles`

| Package | Used by |
|---------|---------|
| `copc` | COPC/LAZ read (via `laz-perf` WASM) |
| `@gltf-transform/core` | GLB tile output |
| `proj4` | WKT CRS → ECEF root transform |

### `packages/potree-to-3dtiles`

| Package | Used by |
|---------|---------|
| `@gltf-transform/core` | GLB tile output |
| `copc` | tiled-LAZ node decode (`laz-perf`) |

### `packages/rad-to-3dtiles`

| Package | Used by |
|---------|---------|
| `@sparkjsdev/spark` | RAD format reference (`build-lod` output) |
| `@gltf-transform/core` | GLB tile output |

### `packages/sog-to-3dtiles`

| Package | Used by |
|---------|---------|
| `@playcanvas/splat-transform` | `readSog` WebP-chunk decode → `DataTable` |

### `packages/lcc-to-3dtiles`

No third-party runtime dependencies — pure-JS `DataView` decode of `meta.lcc`/`Index.bin`/`Data.bin`.

### `packages/i3s-to-3dtiles`

| Package | Used by |
|---------|---------|
| `@loaders.gl/core` | SLPK/zip + fetch plumbing |
| `@loaders.gl/i3s` | I3S schema types/helpers |
| `@loaders.gl/polyfills` | Node polyfills for loaders.gl |
| `@loaders.gl/tiles` | tile-tree traversal helpers |

### `packages/threemx-to-3dtiles`

No third-party runtime dependencies — vendors its own OpenCTM (`js-openctm`) decode logic in-tree.

### `packages/3dtiles-tools`

| Package | Used by |
|---------|---------|
| `gltf-pipeline` | glTF 1.0→2.0 upgrade (legacy b3dm content) |
| `3d-tiles-tools` | real CesiumGS package, wired as `tool=upgrade-real` on `/3dtiles-tools` |
| workspace: `3dtiles-convert-core`, `implicit-to-explicit` | tileset-level transforms |

### `packages/implicit-to-explicit`

Workspace-only dependency: `3dtiles-convert-core` (shared octree/geo helpers).

## Viewer

`apps/viewer` (the standalone React app, "3D Tiled") and the legacy `viewer.html`/`vanilla-viewer.html`.

### `apps/viewer` (3D Tiled — React app)

| Package | Used by |
|---------|---------|
| `react` / `react-dom` | app framework |
| `@react-three/fiber` | R3F renderer for the 3DTRJS viewport |
| `@react-three/drei` | R3F helpers (`<TransformControls>` crop gizmo, etc.) |
| `3d-tiles-renderer` | 3D Tiles rendering (official `/r3f` export) |
| `3d-tiles-rendererjs-3dgs-plugin` | Gaussian-splat plugin for 3DTRJS |
| `@sparkjsdev/spark` | splat rendering backend |
| `cesium` | CesiumJS viewport |
| `three` | shared 3D engine (deduped with 3DTRJS/Spark) |
| `three-mesh-bvh` | BVH acceleration for 3DTRJS |
| `zustand` | app state (crop bbox, camera readouts, status log) |
| `nuqs` | shareable URL-param state (format/mode/cache/preset/…) |
| `@radix-ui/react-*` (checkbox, collapsible, dialog, label, scroll-area, select, separator, slider, slot, toggle, toggle-group) | shadcn/ui primitives |
| `class-variance-authority` | shadcn/ui variant styling |
| `clsx` | conditional class names |
| `tailwind-merge` | Tailwind class merging (shadcn/ui) |
| `lucide-react` | icon set |
| `tailwindcss` / `@tailwindcss/postcss` | styling |
| `vite` | dev server / build |
| `@vitejs/plugin-react` | React Fast Refresh for Vite |
| `vite-plugin-cesium` | Cesium static asset copying |
| `typescript` | type checking |

### Legacy `vanilla-viewer.html` (root)

The repo-root `viewer.html` (the original standalone page, distinct from `apps/viewer`'s own bundled
copy) shares the same runtime dependencies listed above — Cesium, three, `3d-tiles-renderer`, the 3DGS
plugin, SparkJS, `vite-plugin-cesium` — as genuine npm packages bundled by Vite (`vite-plugin-cesium`
copies Cesium's static assets; `three` is deduped via `resolve.dedupe`), **not** CDN-loaded. See
[Viewer](/docs/guide/viewer) for how it's served.

Dev-tooling-only root deps (`vite`, `concurrently`, `sql.js` for `.3dtiles` package reading) don't
carry their own table — `concurrently` runs `pnpm dev`'s viewer+docs+tile-server processes in
parallel, `vite` is shared build tooling, `sql.js` is used both by the legacy viewer's package reading
and by `packages/convert` (see above).

## Docs site

- **[Fumadocs](https://fumadocs.dev)** (`fumadocs-core`/`fumadocs-ui`/`fumadocs-mdx`) powers this
  documentation site — see its own [docs](https://fumadocs.dev/docs) and
  [repo](https://github.com/fuma-nama/fumadocs) for its dependency tree, not itemized here.
- **[Scalar](https://scalar.com)** powers the API reference/playground in two places: a **standalone**
  webapp at the tile-server's own `/playground` route (`packages/tile-server/homepage-live.js`, loaded
  from Scalar's CDN script) and an **embedded** page in this Fumadocs site
  (`/docs/api-reference`, via `@scalar/api-reference-react`). See Scalar's own
  [docs](https://guides.scalar.com) and [repo](https://github.com/scalar/scalar).

---

**Optional / conditionally-used:**
- `better-sqlite3` — only needed for local `.3dtiles` package *writing*/serving via native SQLite; the
  read path uses `sql.js` (pure WASM) instead, so it's optional (`pnpm add -w better-sqlite3`, needs a
  C++ build toolchain).
