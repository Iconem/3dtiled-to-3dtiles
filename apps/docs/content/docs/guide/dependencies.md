---
title: "Dependencies"
description: "Major dependencies per workspace package, with currently-installed versions (from node_modules, not just the package.json semver range)."
---

Versions below are the **currently installed** versions (read from each package's own
`node_modules/<pkg>/package.json`), not just the semver range declared in each workspace's
`package.json` — ranges can drift from what's actually resolved in the lockfile.

### Root (`package.json`)

| Package | Version | Used by |
|---------|---------|---------|
| `cesium` | 1.142.0 | root dev script / legacy `viewer.html` |
| `three` | 0.180.0 | root / shared across viewer + splat rendering |
| `3d-tiles-renderer` | 0.4.28 | legacy `viewer.html` 3DTRJS mode |
| `3d-tiles-rendererjs-3dgs-plugin` | 0.1.13 | legacy `viewer.html` splat streaming |
| `@sparkjsdev/spark` | 2.1.0 | legacy `viewer.html` splat rendering |
| `sql.js` | 1.14.1 | `.3dtiles` (SQLite) package reading |
| `vite` | 6.4.3 | dev/build tooling |
| `vite-plugin-cesium` | 1.2.23 | Cesium asset copying for Vite |
| `concurrently` | 9.2.3 | `pnpm dev` (viewer + docs + tile-server in parallel) |

### `apps/viewer` (3D Tiled — React app)

| Package | Version | Used by |
|---------|---------|---------|
| `react` / `react-dom` | 19.2.7 | app framework |
| `@react-three/fiber` | 9.6.1 | R3F renderer for the 3DTRJS viewport |
| `@react-three/drei` | 10.7.7 | R3F helpers (`<TransformControls>` crop gizmo, etc.) |
| `3d-tiles-renderer` | 0.4.28 | 3D Tiles rendering (official `/r3f` export) |
| `3d-tiles-rendererjs-3dgs-plugin` | 0.1.13 | Gaussian-splat plugin for 3DTRJS |
| `@sparkjsdev/spark` | 2.1.0 | splat rendering backend |
| `cesium` | 1.142.0 | CesiumJS viewport |
| `three` | 0.180.0 | shared 3D engine (deduped with 3DTRJS/Spark) |
| `three-mesh-bvh` | 0.8.3 | BVH acceleration for 3DTRJS |
| `zustand` | 5.0.14 | app state (crop bbox, camera readouts, status log) |
| `nuqs` | 2.9.0 | shareable URL-param state (format/mode/cache/preset/…) |
| `@radix-ui/react-*` (checkbox, collapsible, dialog, label, scroll-area, select, separator, slider, slot, toggle, toggle-group) | 1.x–2.x (e.g. `react-checkbox` 1.3.6, `react-select` 2.3.2) | shadcn/ui primitives |
| `class-variance-authority` | 0.7.1 | shadcn/ui variant styling |
| `clsx` | 2.1.1 | conditional class names |
| `tailwind-merge` | 3.5.0 | Tailwind class merging (shadcn/ui) |
| `lucide-react` | 1.23.0 | icon set |
| `tailwindcss` / `@tailwindcss/postcss` | 4.3.2 | styling |
| `vite` | 6.4.3 | dev server / build |
| `@vitejs/plugin-react` | 5.2.0 | React Fast Refresh for Vite |
| `vite-plugin-cesium` | 1.2.23 | Cesium static asset copying |
| `typescript` | 6.0.3 | type checking |

### `apps/docs` (Fumadocs site)

| Package | Version | Used by |
|---------|---------|---------|
| `next` | 16.2.9 | app framework |
| `react` / `react-dom` | 19.2.7 | app framework |
| `fumadocs-core` | 16.10.7 | docs page-tree / source loader |
| `fumadocs-ui` | 16.10.7 | docs layout/theme components |
| `fumadocs-mdx` | 15.0.13 | MDX content collection |
| `@scalar/api-reference-react` | 0.9.53 | embedded API Reference page (`/docs/api-reference`) |
| `mermaid` | 11.16.0 | diagram rendering (schema-diagram appendix) |
| `lucide-react` | 1.23.0 | icon set |
| `cnfast` | 0.0.8 | class-name helper |
| `tailwindcss` / `@tailwindcss/postcss` | 4.3.2 | styling |
| `typescript` | 6.0.3 | type checking |
| `eslint` / `eslint-config-next` | 9.39.4 / 16.2.9 | linting |

### `packages/core` (`3dtiles-convert-core`)

| Package | Version | Used by |
|---------|---------|---------|
| `@gltf-transform/core` | 4.4.0 | glTF read/write, shared by every converter |
| `@gltf-transform/extensions` | 4.4.0 | glTF extension (de)registration |
| `@gltf-transform/functions` | 4.4.0 | glTF-Transform pipeline ops (`/gltf` decompress) |
| `three` | 0.180.0 | Basis/KTX2 transcoding support |
| `draco3dgltf` | 1.5.7 | Draco geometry decode/encode registration |
| `ktx-parse` | 1.1.0 | KTX2 container parsing |
| `ktx2-encoder` | 0.5.3 | in-process KTX2 (ETC1S/UASTC) WASM encoder |
| `@jsquash/webp` | 1.5.0 | WebP decode (SOG textures) |
| `pngjs` | 7.0.0 | pure-JS PNG encode (KTX2→PNG decompress path) |
| `jpeg-js` | 0.4.4 | pure-JS JPEG decode/encode |

### `packages/copc-to-3dtiles`

| Package | Version | Used by |
|---------|---------|---------|
| `copc` | 0.0.8 | COPC/LAZ read (via `laz-perf` WASM) |
| `@gltf-transform/core` | 4.4.0 | GLB tile output |
| `proj4` | 2.20.9 | WKT CRS → ECEF root transform |

### `packages/potree-to-3dtiles`

| Package | Version | Used by |
|---------|---------|---------|
| `@gltf-transform/core` | 4.4.0 | GLB tile output |
| `copc` | 0.0.8 | tiled-LAZ node decode (`laz-perf`) |

### `packages/rad-to-3dtiles`

| Package | Version | Used by |
|---------|---------|---------|
| `@sparkjsdev/spark` | 2.1.0 | RAD format reference (`build-lod` output) |
| `@gltf-transform/core` | 4.4.0 | GLB tile output |

### `packages/sog-to-3dtiles`

| Package | Version | Used by |
|---------|---------|---------|
| `@playcanvas/splat-transform` | 2.6.0 | `readSog` WebP-chunk decode → `DataTable` |

### `packages/lcc-to-3dtiles`

No third-party runtime dependencies — pure-JS `DataView` decode of `meta.lcc`/`Index.bin`/`Data.bin`.

### `packages/i3s-to-3dtiles`

| Package | Version | Used by |
|---------|---------|---------|
| `@loaders.gl/core` | 4.4.3 | SLPK/zip + fetch plumbing |
| `@loaders.gl/i3s` | 4.4.3 | I3S schema types/helpers |
| `@loaders.gl/polyfills` | 4.4.3 | Node polyfills for loaders.gl |
| `@loaders.gl/tiles` | 4.4.3 | tile-tree traversal helpers |

### `packages/convert` (meta CLI/SDK)

| Package | Version | Used by |
|---------|---------|---------|
| `fflate` | 0.8.3 | zip read (remote directory-format mirroring) |
| `sql.js` | 1.14.1 | `.3dtiles` package output |
| workspace: `copc-to-3dtiles`, `potree-to-3dtiles`, `rad-to-3dtiles`, `sog-to-3dtiles`, `lcc-to-3dtiles`, `i3s-to-3dtiles`, `3dtiles-convert-core` | — | per-format converters |

### `packages/3dtiles-tools`

| Package | Version | Used by |
|---------|---------|---------|
| `gltf-pipeline` | 4.3.1 | glTF 1.0→2.0 upgrade (legacy b3dm content) |
| workspace: `3dtiles-convert-core`, `implicit-to-explicit` | — | tileset-level transforms |

### `packages/tile-server`

| Package | Version | Used by |
|---------|---------|---------|
| `copc` | 0.0.8 | `/stream?format=copc` range adapter |
| `proj4` | 2.20.9 | live georeferencing (COPC/Potree/I3S) |
| `@loaders.gl/i3s` | 4.4.3 | `/stream?format=i3s` |
| `@loaders.gl/zip` | 4.4.3 | `.3tz` / SLPK zip random access |
| `@playcanvas/splat-transform` | 2.6.0 | `/stream?format=sog`, `/extract` splat merge |
| workspace: `3dtiles-convert-core`, `3dtiles-tools`, `i3s-to-3dtiles`, `implicit-to-explicit` | — | shared decode/encode + tileset transforms |

### `packages/implicit-to-explicit`

Workspace-only dependency: `3dtiles-convert-core` (shared octree/geo helpers).

### `packages/threemx-to-3dtiles`

No third-party runtime dependencies — vendors its own OpenCTM (`js-openctm`) decode logic in-tree.

---

**Optional / conditionally-used:**
- `better-sqlite3` — only needed for local `.3dtiles` package *writing*/serving via native SQLite; the
  read path uses `sql.js` (pure WASM) instead, so it's optional (`pnpm add -w better-sqlite3`, needs a
  C++ build toolchain).
