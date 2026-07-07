# 3dtiled-to-3dtiles

## Ambition

This started as a set of Node.js SDK/CLI, standalone-packaged, **converters**: take a *tiled / LoD source format* — HLOD Hierarchical Level of Detail, tiled point clouds, meshes, or 3D Gaussian splats (COPC, Potree, I3S, stream-SOG, LCC, RAD, 3MX, GeoSplats, …) — and
turn it into OGC **3D Tiles 1.1** (splats via `KHR_gaussian_splatting` +
`KHR_gaussian_splatting_compression_spz_2` GLB tiles). The unifying idea behind every converter is
the same: translate each of the tree-hierarchy and tile-geometry as-is, since each source format is already *some spatial tree of pre-tiled, LoD'd content* — so the
converter just maps that tree onto a 3D Tiles HLOD tree, implicit (octree/quadtree) or explicit (arbitrary), and re-encodes node content into one shared
output (standard mesh primitives, TRIANGLES, POINTS, or `spzGlb.js` for splats). The decode differs per format; the output is uniform.

It has since grown into an **on-the-fly streaming middleware** (`packages/tile-server`, the offline
converters' live counterpart): point it at a `<format>` source URL and it serves a 3D Tiles tileset
*live*, so any 3D-Tiles-compatible client — browser/JS viewers, CesiumJS or its native plugins
(Unreal, Unity, Nvidia Omniverse, Open-3d-Engine), GIS software (QGIS, ESRI etc), anything that speaks the OGC standard — can consume any of these tiled
formats **without a pre-conversion step**, with tile-hierarchy/content **caching** and **prefetching**
tunable per use case (`cache=none|hierarchy|all`). `viewer.html` (CesiumJS + 3DTilesRendererJS) is the
reference client, and doubles as a **bbox + geometric-error-aware crop/extract** tool (`/extract/*`) for
pulling a sub-region, with user-controlled Geometric Error target precision, of any of these formats back out as LAS/COPC/GLB/SPZ/SOG/PLY.

**Where this is going next.** Two items that used to be listed here as "concrete and addressable" are
now done: **containerizing the server** (`Dockerfile` + `docker-compose.yml` + a GHCR-publishing GitHub
Actions workflow — `docker compose up --build` runs the whole stack) and a first pass at the
**Fumadocs** documentation site (`apps/docs`) — most of this README's detail now lives there; see
[Documentation](#documentation) below.

Further out: a browser/server tiled-splat transcoding UI in the spirit of SuperSplat's splat-transform
tooling; a **georeferencing/geolocator** step for splats that don't ship one, along the lines of
WilliamLiu's `3dtiles-inspector` or MapTiler GeoSplats'; and an **aggregator** unifying the
export/interchange formats of other splat platforms, behind the same 3D Tiles pipeline. A
longer-running goal underneath all of this: be the **fastest** point-cloud — and eventually splat —
tiler, by reusing the octree-computation principles behind Potree 2.0's converter.

## Documentation

**This README is a pitch + quickstart.** The detailed, up-to-date documentation — architecture,
per-converter usage, endpoint reference, format specs, TODOs, and findings — lives in a
[Fumadocs](https://fumadocs.dev/) site under `apps/docs`. Run it locally:

```sh
pnpm --filter docs dev   # http://localhost:3002
```

(There is no publicly deployed instance yet — run it locally, or read the source `.md` files directly
on GitHub under [`apps/docs/content/docs/guide/`](apps/docs/content/docs/guide/) and
[`apps/docs/content/docs/references/`](apps/docs/content/docs/references/).)

Guide pages (mirrors this README's original section breakdown, one page each):

- [Introduction](apps/docs/content/docs/guide/introduction.md) · [Ambition](apps/docs/content/docs/guide/ambition.md) · [Format comparison](apps/docs/content/docs/guide/format-comparison.md)
- [Related tilers / prior art](apps/docs/content/docs/guide/related-tilers-prior-art-reference-implementations.md) · [Monorepo & usage](apps/docs/content/docs/guide/monorepo-usage.md) · [TODO / Future work](apps/docs/content/docs/guide/planning/todo-future-work.md)
- [Architecture: the materialization continuum](apps/docs/content/docs/guide/architecture-the-materialization-continuum-cache-none-hierar.md) · [Converters](apps/docs/content/docs/guide/converters.md) · [Sample Data](apps/docs/content/docs/guide/planning/sample-data.md)
- [Dependencies](apps/docs/content/docs/guide/planning/dependencies.md) · [Performance & parallelism](apps/docs/content/docs/guide/performance-parallelism.md) · [Candidate source formats](apps/docs/content/docs/guide/planning/candidate-source-formats-roadmap-not-yet-supported.md)
- [Documentation (findings, format notes)](apps/docs/content/docs/guide/documentation.md) · [3D Gaussian Splatting extension lineage](apps/docs/content/docs/guide/3d-gaussian-splatting-extension-lineage.md)
- [Vision: towards a TiTiler for 3D](apps/docs/content/docs/guide/vision-towards-a-titiler-for-3d-now-live-for-every-supported.md) · [Known blockers](apps/docs/content/docs/guide/known-blockers-how-to-overcome-them.md)
- [Missing features & unsupported code-paths](apps/docs/content/docs/guide/missing-features-unsupported-code-paths.md) · [Appendix: per-format schema diagrams](apps/docs/content/docs/guide/planning/appendix-per-format-schema-diagrams.md)

Format-spec deep-dives (canonical sources + hand-distilled local notes), readable directly on GitHub
under [`docs-references/`](docs-references/) — e.g.
[`copc-format.md`](docs-references/copc-format.md), [`potree-format.md`](docs-references/potree-format.md),
[`rad-format-notes.md`](docs-references/rad-format-notes.md), [`lcc-format.md`](docs-references/lcc-format.md),
[`i3s-spec.md`](docs-references/i3s-spec.md), [`streamed-sog.md`](docs-references/streamed-sog.md),
[`sog.md`](docs-references/sog.md), [`spz-format.md`](docs-references/spz-format.md),
[`maptiler-geosplats.md`](docs-references/maptiler-geosplats.md), and 16 more (see the directory listing).

## Quickstart

npm/pnpm workspaces monorepo. Two ports cover day-to-day use:

```sh
pnpm install    # installs the whole workspace
pnpm dev        # http://localhost:3000  (3D Tiled — the React viewer app, + /vanilla-viewer + /docs folded in)
                # http://localhost:3001  (tile-server — the streaming/convert middleware)
```

`pnpm dev` runs the viewer's Vite dev server alongside the tile-server and the Fumadocs site's Next dev
server (port 3002, proxied under `/docs` from the viewer — see [Documentation](#documentation) above to
reach it directly). pnpm uses `pnpm-workspace.yaml` + `.npmrc` (`node-linker=hoisted`); npm's `workspaces`
field works too.

**Layout at a glance:**

```
apps/
  viewer/    3D Tiled          — React 19 + Vite viewer app (CesiumJS + 3DTilesRendererJS), port 3000
  docs/      Fumadocs site     — the canonical docs (see above), port 3002
packages/
  core/      3dtiles-convert-core   — shared: SPZ-v2 GLB + POINTS GLB encoders, parallelMap, format detection
  convert/   3dtiles-convert        — meta-converter; `3dtiled` CLI + JS/TS API, auto-detects format
  tile-server/                      — live streaming/convert/extract HTTP middleware, port 3001
  rad-to-3dtiles/  sog-to-3dtiles/  lcc-to-3dtiles/  copc-to-3dtiles/  potree-to-3dtiles/  i3s-to-3dtiles/
                                    — the per-format offline converters (each its own package + deps)
docs-references/   hand-distilled format-spec notes (mirrored into apps/docs/content/docs/references/)
sample-data/       small input/output fixtures used by the converters and viewer presets
```

Each per-format converter is independent (install just the one you need); the meta-converter
(`packages/convert`) auto-detects input format and dispatches to the right one:

```sh
npm run convert -- <input> <outDir> [--format rad|sog|lcc|copc|potree|i3s]
# or directly:
node packages/convert/cli.js sample-data/input/RAD/coit.rad sample-data/output/rad/coit-3dtiles-from-rad
```

See [Converters](apps/docs/content/docs/guide/converters.md) and
[Monorepo & usage](apps/docs/content/docs/guide/monorepo-usage.md) for the full per-converter CLI/API
reference, and [Vision: towards a TiTiler for 3D](apps/docs/content/docs/guide/vision-towards-a-titiler-for-3d-now-live-for-every-supported.md)
for the live `/stream`, `/convert`, and `/extract` HTTP endpoints served by `packages/tile-server`.

## Format comparison

🟢 = operational · 🟡 draft = scaffold built, partially/un-validated · 🟠 doc = spec referenced in
`docs-references/`, converter not built (lower-priority / niche). See
[the full format-comparison page](apps/docs/content/docs/guide/format-comparison.md) for canonical spec
links and local-mirror notes per format.

### Output — 3D Tiles

| Format | Status | Hierarchy / subdivision | Node (leaf) content | Refine | HTTP range |
|--------|:------:|-------------------------|---------------------|:------:|:----------:|
| **3D Tiles** (output) | 🟢 out | explicit or implicit; box/region/sphere volumes | glTF/GLB w/ `KHR_gaussian_splatting`+`_spz_2` (splats) or POINTS/TRIANGLES | REPLACE/ADD | ✅ |

### Tiled point clouds → 3D Tiles

| Format | Status | Hierarchy / subdivision | Node (leaf) content | Refine | HTTP range |
|--------|:------:|-------------------------|---------------------|:------:|:----------:|
| **COPC** (Cloud Optimized Pointcloud) | 🟢 | **octree** (EPT-style) | LAZ-compressed LAS points | ADD | ✅ designed for range reads |
| **Potree** (v1 and v2) | 🟢 | **octree** (named `r`/`r0`..`r7`) | points: position int32×3·scale+offset + rgb | ADD | ✅ |

### Generic tiled formats → 3D Tiles

| Format | Status | Hierarchy / subdivision | Node (leaf) content | Refine | HTTP range |
|--------|:------:|-------------------------|---------------------|:------:|:----------:|
| **3D Tiles packages** `.3tz`/`.3dtiles` | 🟢 | passthrough — whatever the wrapped `tileset.json` declares | the wrapped tileset's own tile content, unchanged | (wrapped tileset's own) | N/A — O(1) offset/key lookup |
| **I3S** (Esri) | 🟡 draft | node tree (always explicit), OBB/MBS LoD (SLPK or REST) | nodes/geometry/textures; PerAttributeArray or Draco | REPLACE | ✅ REST/range |
| **3MX** (Bentley/Acute3D) | 🟢 | master `Scene.3mx` JSON → `3MXBO` binary node tree | OpenCTM mesh + JPEG baseColor → transcoded to glTF | REPLACE | ➖ per-file GET |
| **Bing Maps 3D** | 🟢 | quadtree of quadkeys (availability by HTTP probe) | `tf=3dv4` GLB — Draco + KTX2, ECEF in node matrix | REPLACE | ➖ per-file GET |
| **Nexus** (CNR-ISTI) | 🟠 doc | multiresolution patch DAG / batched mesh | per-patch mesh (not splats) | — | ✅ |

### Tiled Gaussian-splat sources → 3D Tiles

| Format | Status | Hierarchy / subdivision | Node (leaf) content | Refine | HTTP range |
|--------|:------:|-------------------------|---------------------|:------:|:----------:|
| **SOG (streamed)** (PlayCanvas) | 🟢 | **binary** spatial tree (AABB split) | unbundled SOG chunk: WebP textures → DataTable | REPLACE | ✅ per-file |
| **LCC** (XGRIDS) | 🟢 | **grid of Units** (cellX×Y) × per-cell LODs | `Data.bin` fixed 32 B/splat (+SH `Shcoef.bin`) | REPLACE | ✅ offsets into `Data.bin` |
| **RAD** (SparkJS) | 🟢 | LoD merge tree, variable fanout | RADC chunk: per-splat columns, mixed encodings | REPLACE | ✅ chunked `.radc` |
| **GeoSplats** (MapTiler) | 🟢 | **octree voxel grids** × 8 progressive LODs | per-octant **SOGS** or `octant_<n>.ply` | REPLACE (LOD subset) | ✅ per-file / range |

## Converters

Six offline converters (`packages/<fmt>-to-3dtiles`) turn a tiled source format into 3D Tiles on disk:
`copc-to-3dtiles`, `rad-to-3dtiles`, `sog-to-3dtiles`, `lcc-to-3dtiles`, `i3s-to-3dtiles` (🟡 draft),
`potree-to-3dtiles`. Each has its own CLI, npm deps, and design notes (implicit-octree mapping for COPC,
LoD merge-tree decode for RAD, WebP/DataTable decode for SOG, etc). The repo also ships two viewers:
`vanilla-viewer.html` (offline, zero-React reference viewer) and **3D Tiled** (`apps/viewer`, the React
port — shadcn/ui, R3F, CesiumJS + 3DTilesRendererJS side by side).

See the [Converters guide](apps/docs/content/docs/guide/converters.md) for per-format CLI usage, output
layout, design notes, and known scope gaps (e.g. I3S's Draco/attribute limitations).

## Monorepo & usage

npm/pnpm-workspaces monorepo: each input format is an independent converter package, a shared **core**
holds common machinery (SPZ-v2/POINTS GLB encoders, parallelism, format detection), and a
**meta-converter** (`packages/convert`) auto-detects input and dispatches. `packages/tile-server` is the
live streaming/convert/extract counterpart — see [Vision: towards a TiTiler for
3D](apps/docs/content/docs/guide/vision-towards-a-titiler-for-3d-now-live-for-every-supported.md) for its
endpoints.

See the [Monorepo & usage guide](apps/docs/content/docs/guide/monorepo-usage.md) for the meta-converter
API, `/stream` lazy-loading semantics, per-format native chunking units, and individual-converter usage.

## TODO / Future work

A running, dated log of what's shipped recently, what's still open, and a survey of other
capture/scanner ecosystems checked for tiled formats worth adding (none found so far worth an adapter).
Includes the SPZ v4/v5 roadmap notes (Niantic Spatial's compression format used for splat tiles here).

See the [TODO / Future work guide](apps/docs/content/docs/guide/planning/todo-future-work.md) for the full,
dated list.

## Architecture: the materialization continuum (`cache = none · hierarchy · full`)

The conceptual core of `packages/tile-server`: every live format adapter sits somewhere on one axis —
how much of the source dataset the middleware *materializes* before serving a tile, from `cache=none`
(pure pass-through decode per request) through `cache=hierarchy` (index cached, geometry streamed) to
`cache=all`/`/convert` (fully preprocessed and cached, same code path as the offline converters). Covers
why push-based offline converters stay separate from the pull-based live path, the endpoint rework
history, and per-converter parallelism notes.

See the [Architecture guide](apps/docs/content/docs/guide/architecture-the-materialization-continuum-cache-none-hierar.md)
for the full model, the harmonization plan, and current vs. future endpoint shape.

## Sample Data

Small, `sample-data/`-friendly fixtures and curl commands for RAD (Gaussian splat LoD), Streamed SOG
(PlayCanvas), and COPC (LiDAR) — real public/open datasets (Coit Tower, Autzen Stadium, IGN LiDAR HD,
PlayCanvas example scenes, etc), used by the converters' own README examples and the viewer's preset bar.

See the [Sample Data guide](apps/docs/content/docs/guide/planning/sample-data.md) for the full curl commands and
source links.

## Dependencies

A short table of the handful of non-obvious shared npm dependencies (`copc`, `@gltf-transform/core`,
`proj4`, `@sparkjsdev/spark`) and which converters use them.

See the [Dependencies guide](apps/docs/content/docs/guide/planning/dependencies.md) for the full table.

## Performance & parallelism

All five operational converters (rad, sog, lcc, copc, potree) fan tiles out via bounded-concurrency
`parallelMap` + async gzip (i3s, still a draft, remains serial); the outstanding piece is a real
`worker_threads` pool for multicore *decode* rather than just event-loop concurrency.

See the [Performance & parallelism guide](apps/docs/content/docs/guide/performance-parallelism.md) for
the current, accurate per-converter picture (supersedes older performance notes elsewhere).

## Candidate source formats — roadmap (not yet supported)

A ranked crawl (Candidates vs. Discarded, by openness × feasibility × remote-consumability) of
GIS/CAD-AEC/VFX/heritage tiled formats not yet ingested — SPZ v5, Splatter, 2.5D terrain, OSGB, Nexus,
SuperMap S3M — and blocked cases like Autodesk ReCap. Includes a separate 2.5D terrain track
(DEM raster → TIN → 3D Tiles/quantized-mesh).

See the [Candidate source formats guide](apps/docs/content/docs/guide/planning/candidate-source-formats-roadmap-not-yet-supported.md)
for the full tier breakdown and implemented-adapter notes (3MX, Bing Maps 3D, Nexus).

## 3D Gaussian Splatting extension lineage

How the glTF extensions for 3D Gaussian splatting evolved through 2025–2026 — from a single
experimental `KHR_spz_gaussian_splats_compression` to the current split of `KHR_gaussian_splatting`
(renderer-agnostic base) + `KHR_gaussian_splatting_compression_spz_2` (SPZ-blob child extension).
Understanding this lineage is what pinned down a real SPZ-version rendering bug (see Known blockers).

See the [3D Gaussian Splatting extension lineage guide](apps/docs/content/docs/guide/3d-gaussian-splatting-extension-lineage.md)
for the full timeline.

## Vision: towards a TiTiler for 3D — now live for every supported 3D-tiled format

The live HTTP API surface of `packages/tile-server`: `/convert` (any-format → 3D Tiles, cached),
`/3dtiles-self-contained` (serve `.3tz`/`.3dtiles` packages in-place), 3D-Tiles-to-3D-Tiles transcodes,
and the assessed-but-blocked `potree-to-copc` (needs a JS LAZ encoder).

See the [Vision guide](apps/docs/content/docs/guide/vision-towards-a-titiler-for-3d-now-live-for-every-supported.md)
for full endpoint semantics, request/response shapes, and implementation notes.

## Known blockers & how to overcome them

Two resolved war-stories kept for reference: (1) RAD splats rendering wrong after conversion — fixed by
emitting SPZ **v2**, not v3; (2) COPC point clouds appearing "upside down" in 3DTilesRendererJS's *Env*
controls (correct in *Globe* mode) — a renderer coordinate-convention mismatch, not a converter bug.

See the [Known blockers guide](apps/docs/content/docs/guide/known-blockers-how-to-overcome-them.md) for
the full root-cause writeups.

## Missing features & unsupported code-paths

A consolidated, honest list of what's not handled and where it would go: SH beyond DC, I3S's
Draco/texture/attribute gaps, parallelism/architecture notes, the two `packages/tile-server` modes,
true range-streaming status per format, and the live `/geosplats`, `/extract`, `/proxy`, and API
playground/OpenAPI endpoints.

See the [Missing features guide](apps/docs/content/docs/guide/missing-features-unsupported-code-paths.md)
for the full, itemized list.

## Appendix: per-format schema diagrams

Mermaid diagrams of each source format's LoD/hierarchy tree (RAD, Streamed SOG, LCC, COPC).

See the [Appendix guide](apps/docs/content/docs/guide/planning/appendix-per-format-schema-diagrams.md) for the
full diagrams.
