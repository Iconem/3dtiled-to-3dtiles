---
title: "Ambition"
description: "This started as a set of Node.js SDK/CLI, standalone-packaged, converters: take a tiled / LoD source format — HLOD Hierarchical Level of Det"
---

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
**Fumadocs** documentation site (`apps/docs`, `pnpm --filter docs dev`) — `README.md`'s sections and
every [`docs-references/`](docs-references/) file are chunked into it and verified building/rendering;
the guide and reference sections are now cross-linked (e.g. `format-comparison.md` links every format to
its reference-page mirror) and the migration is complete — the docs site, not this README, is the
canonical source going forward. Both are tracked in [TODO / Future work](#todo--future-work) below.

Further out: a browser/server tiled-splat transcoding UI in the spirit of SuperSplat's splat-transform
tooling; a **georeferencing/geolocator** step for splats that don't ship one, along the lines of
WilliamLiu's `3dtiles-inspector` or MapTiler GeoSplats'; and an **aggregator** unifying the
export/interchange formats of other splat platforms, behind the same 3D Tiles pipeline. A
longer-running goal underneath all of this: be the **fastest** point-cloud — and eventually splat —
tiler, by reusing the octree-computation principles behind Potree 2.0's converter (see the Potree
sections throughout this doc, e.g. [`potree-to-3dtiles`](#potree-to-3dtiles) and
[`/stream`](#copc-and-potree-via-stream-true-range-streaming)).
