---
title: "3dtiled Supported Formats"
description: "Set of Node.js SDK/CLI, standalone-packaged, converters: and middleware on-the-fly HLOD conversion (hierarchy/tile content)"
---

## Introduction: The intent (online, range-streamed)

This started as a set of Node.js SDK/CLI, standalone-packaged, **converters**: take a *tiled / LoD source format* — HLOD Hierarchical Level of Detail, tiled point clouds, meshes, or 3D Gaussian splats (COPC, Potree, I3S, stream-SOG, LCC, RAD, 3MX, GeoSplats, …) — and
turn it into OGC **3D Tiles 1.1** (standard mesh primitives, `TRIANGLES`, `POINTS`, splats via `KHR_gaussian_splatting` +
`KHR_gaussian_splatting_compression_spz_2` GLB tiles). The unifying idea behind every converter is
the same: translate each of the tree-hierarchy and tile-geometry as-is, since each source format is already *some spatial tree of pre-tiled, LoD'd content* — so the
converter just maps that tree onto a 3D Tiles HLOD tree, implicit (octree/quadtree) or explicit (arbitrary), and re-encodes node content into one shared
output. The decode differs per format; the output is uniform.

It has since grown into an **on-the-fly streaming middleware** (`packages/tile-server`, the offline
converters' live counterpart): point it at a `<format>` source URL and it serves a 3D Tiles tileset
*live*, so any 3D-Tiles-compatible client — browser/JS viewers, CesiumJS or its native plugins
(Unreal, Unity, Nvidia Omniverse, Open-3d-Engine), GIS software (QGIS, ESRI etc), anything that speaks the OGC standard — can consume any of these tiled
formats **without a pre-conversion step**, with tile-hierarchy/content **caching** and **prefetching**
tunable per use case (`cache=none|hierarchy|all`). A viewer (vite-served React app) based on CesiumJS and 3DTilesRendererJS is the
reference client, and doubles as a **bbox + geometric-error-aware crop/extract** tool (`/extract/*`) for
pulling a sub-region, with user-controlled Geometric Error target precision, of any of these formats back out as LAS/COPC/GLB/SPZ/SOG/PLY.

### Towards a TiTiler for 3D

A **TiTiler equivalent for 3D formats**: middleware that reads cloud-native, internally tiled 3D
formats and streams OGC 3D Tiles 1.1 **on demand** — transcribing the source octree/hierarchy into a
3D Tiles tree and converting raw node geometry to glTF/GLB, served over HTTP Range so nothing is
re-encoded or re-sorted. Like TiTiler for COG: zero re-tiling, zero copy.

> The intent: fully online, fetching only the required portions of the underlying format hierarchy
> to build the 3D Tiles JSON hierarchy, then — when GLB tiles are requested — fetching via range
> requests the corresponding {copc, stream-sog, lcc, potree, etc} contiguous memory block just to
> build the requested tile.

The end state is the same model generalised to every internally-tiled format
(streamed-SOG chunk runs, LCC unit LOD runs, Potree octree-node byte ranges, …): a per-format
"range adapter" mapping a requested 3D-Tiles key → the source byte range to fetch and transcode.

## Supported Input Format 

The **Spec** column below gives every canonical source plus a link to the distilled local mirror (hand-written
since several spec sites block automated fetching — kept in sync as the converters evolve).

### Output — 3D Tiles

| Format  | Hierarchy / subdivision | Node (leaf) content | Refine | Intermediate nodes | Metadata location | HTTP range | Spec |
|--------|-------------------------|---------------------|:------:|--------------------|-------------------|:----------:|------|
| **3D Tiles** (output) | explicit or implicit; box/region/sphere volumes | glTF/GLB w/ `KHR_gaussian_splatting`+`_spz_2` (splats) or POINTS/TRIANGLES | REPLACE/ADD | optional content | `tileset.json` (+ `.3tz`) | ✅ | [OGC](https://www.ogc.org/standard/3dtiles/) |

### Tiled point clouds → 3D Tiles

| Format  | Hierarchy / subdivision | Node (leaf) content | Refine | Intermediate nodes | Metadata location | HTTP range | Spec |
|--------|-------------------------|---------------------|:------:|--------------------|-------------------|:----------:|------|
| **COPC** (Cloud Optimized Pointcloud) | **octree** (EPT-style) | LAZ-compressed LAS points | ADD | octree nodes (accumulate) | COPC VLR + hierarchy pages | ✅ designed for range reads | [copc.io](https://copc.io) · [spec repo](https://github.com/copcio/copcio.github.io) · local: [`copc-format.md`](/docs/references/pointclouds/copc-format) |
| **Potree** (v1 and v2) | **octree** (named `r`/`r0`..`r7`) | points: position int32×3·scale+offset + rgb (2.0 `octree.bin` / 1.x per-node `.bin`) | ADD | octree nodes (accumulate) | 2.0 `metadata.json`+`hierarchy.bin` (22 B/node) · 1.x `cloud.js`+`.hrc` | ✅ (2.0 single octree.bin; 1.x per-node files) | [PotreeConverter](https://github.com/potree/PotreeConverter) · [2.0 format](https://github.com/potree/potree/blob/develop/docs/) · ref impl [potree23dtiles](https://github.com/yeyan00/potree23dtiles) · local: [`potree-format.md`](/docs/references/pointclouds/potree-format) |

### Generic tiled formats → 3D Tiles

Formats that carry (or wrap) a general node/mesh hierarchy rather than a point- or splat-specific one.

| Format  | Hierarchy / subdivision | Node (leaf) content | Refine | Intermediate nodes | Metadata location | HTTP range | Spec |
|--------|-------------------------|---------------------|:------:|--------------------|-------------------|:----------:|------|
| **3D Tiles packages** `.3tz`/`.3dtiles` | passthrough — whatever the wrapped `tileset.json` declares (explicit or implicit) | the wrapped tileset's own tile content, unchanged | (wrapped tileset's own) | (wrapped tileset's own) | `.3tz`: ZIP + `@3dtilesIndex1@` binary index (path→offset) · `.3dtiles`: SQLite `key TEXT, content BLOB` | N/A — O(1) offset read / SQLite key lookup, not source-file byte-ranges | [3tz spec](https://github.com/erikdahlstrom/3tz-specification) · [.3dtiles proposal #727](https://github.com/CesiumGS/3d-tiles/issues/727) · local: [`3tz-3dtiles-packages.md`](/docs/references/3dtiles-gltf/3tz-3dtiles-packages) |
| **I3S** (Esri) | node tree (**always explicit** — no implicit/template scheme), OBB/MBS LoD (SLPK or REST) | nodes/geometry/textures; `DefaultGeometrySchema` = **PerAttributeArray** (pos `f32×3` · normal `f32×3` · uv0 `f32×2` · color `u8×4`, sequential) or Draco | REPLACE | node pages (`nodepages/*.json`) | `3dSceneLayer.json` + node pages | ✅ REST/range | [esri/i3s-spec](https://github.com/esri/i3s-spec) (OGC Community Standard) · local: [`i3s-spec.md`](/docs/references/mesh-generic/i3s-spec) |
| **3MX** (Bentley/Acute3D) | master `Scene.3mx` JSON → `3MXBO` binary node tree | OpenCTM (MG1/LZMA) mesh + JPEG baseColor → transcoded to glTF | REPLACE | `3MXBO` node-tree levels | `Scene.3mx` + per-node `.3mxb` | ➖ per-file GET (lazy external-tileset fragments per `.3mxb`) | [Bentley docs](https://docs.bentley.com/LiveContent/web/ContextCapture%20Help-v18/en/GUID-569C1E44-D86A-4942-9ABE-36C33FB5A7EB.html) |

### Bing Maps

| Format | Hierarchy / subdivision | Node (leaf) content | Refine | Intermediate nodes | Metadata location | HTTP range | Spec |
|--------|-------------------------|---------------------|:------:|--------------------|-------------------|:----------:|------|
| **Bing Maps 3D** | quadtree of quadkeys (availability by HTTP probe) | `tf=3dv4` GLB — Draco geometry + KTX2 textures, ECEF baked into the node matrix | REPLACE | quadkey levels | manifest by quadkey/`genid` | ➖ per-file GET | (undocumented public tile service, reverse-engineered) |

### Tiled Gaussian-splat sources → 3D Tiles

| Format  | Hierarchy / subdivision | Node (leaf) content | Refine | Intermediate nodes | Metadata location | HTTP range | Spec |
|--------|-------------------------|---------------------|:------:|--------------------|-------------------|:----------:|------|
| **SOG (streamed)** (PlayCanvas) | **binary** spatial tree (AABB split) | unbundled SOG chunk: WebP textures → `DataTable` (pos/quat-w-first/log-scale/SH-DC/logit-opacity) | REPLACE | empty grouping nodes | no geo metadata, `lod-meta.json` + per-chunk `meta.json` | ✅ per-file | [streamed-SOG](https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/streamed-sog/) · [SOG](https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/sog/) · [splat-transform](https://github.com/playcanvas/splat-transform) · local: [`streamed-sog.md`](/docs/references/3dgs-splats/streamed-sog) · [`sog.md`](/docs/references/3dgs-splats/sog) |
| **LCC** (XGRIDS) | **grid of Units** (cellX×Y) × per-cell LODs | `Data.bin` fixed **32 B/splat**: pos `f32×3`, color `rgba8`, scale `u16×3`, rot `10-10-10-2` (+SH `Shcoef.bin` 64 B) | REPLACE | per-cell coarse LODs | georef'ed, `meta.lcc` JSON + `Index.bin` | ✅ `Index.bin` offsets into `Data.bin` | [developer.xgrids.com](https://developer.xgrids.com/#/document?titleId=en-1720509291851) · [LCC whitepaper](https://github.com/xgrids/LCCWhitepaper) · [LCC-Web-SDK](https://github.com/xgrids/LCC-Web-SDK) · local: [`lcc-format.md`](/docs/references/3dgs-splats/lcc-format) |
| **RAD** (SparkJS) | LoD merge tree, variable fanout (Tiny-LoD base β≈1.75; Bhatt-LoD unspecified, our converter observes ~1.5 in practice) | RADC chunk: per-splat columns — `f16`/`oct88r8` **interleaved**, `ln_0r8`/`r8_delta` **planar**, `f32_lebytes` byte-transposed | REPLACE | downsampled **merged** splats | no geo metadata, root `RAD0` JSON + per-chunk `RADC` JSON | ✅ chunked `.radc` | **spec:** [LoD getting started](https://sparkjs.dev/docs/lod-getting-started/) · **blog:** [Spark 2.0](https://www.worldlabs.ai/blog/spark-2.0) · [ext-splats](https://sparkjs.dev/docs/ext-splats/) · local: [`rad-format-notes.md`](/docs/references/3dgs-splats/rad-format-notes) |
| **GeoSplats** (MapTiler) | **octree voxel grids** (`grid_1/8/64/512`) × 8 progressive LODs | per-octant **SOGS** (`means_l/u`, `quats`, `scales`, `sh0` WebP) or `octant_<n>.ply` | REPLACE (LOD subset) | coarser-LOD octants | georef'ed,`model.json` (georef) + per-sub-model `metadata.json` (`voxel_grids` + `entries` TOC) | ✅ per-file / range | [maptiler.com/geosplats](https://www.maptiler.com/geosplats/) · SDK [@maptiler/geosplats](https://www.npmjs.com/package/@maptiler/geosplats) ([CDN .mjs](https://cdn.maptiler.com/maptiler-geosplats/v1.0.4/maptiler-geosplats.mjs)) · local: [`maptiler-geosplats.md`](/docs/references/3dgs-splats/maptiler-geosplats) |

## 3D Tiles → 3D Tiles transcodes

The input is *already* 3D Tiles — these are tileset-level transforms (the live/streaming-flavored
counterparts to [`3d-tiles-tools`](https://github.com/CesiumGS/3d-tiles-tools)).
Served live by the **`/3dtiles-tools`** endpoint (`packages/tile-server/3dtiles-tools-live.js`):
tileset JSON is rewritten once and cached; each tile is converted on demand (like `/stream`).

**`tool=implicit-to-explicit`** — read a tileset with `implicitTiling` (OCTREE/QUADTREE) + `.subtree`
files, walk the availability bitstreams, and emit an **explicit** nested tree (derived boxes via the
same `octreeSubCube`/`cubeToBox` core helpers as the octree converters). Per-tile `.b3dm`/`.pnts`
content is converted to glb on the fly; `.glb` is proxied as-is. Works on local dirs and remote URLs.

**`tool=upgrade`** — legacy → 3D Tiles 1.1 with per-tile content conversion (`packages/3dtiles-tools/upgrade.js`):
- **JSON-level:** `asset.version` → `1.1`, legacy `content.url` → `uri` (older 1.0/0.0 tilesets).
- **`b3dm` → `glb`:** a b3dm is a header + feature/batch tables + an embedded GLB — extracted by slicing
  to the GLB (zero-copy where possible).
- **`pnts` → `glb`:** parsed and re-encoded to a glTF `POINTS` GLB (native fast builder; POSITION /
  POSITION_QUANTIZED, RGBA/RGB/RGB565/CONSTANT_RGBA, RTC_CENTER → node translation).
- **glTF 1.0 → 2.0:** if the embedded GLB is **version 1** (legacy `pg2b3dm`/older exporters), it is
  upgraded to glTF 2.0 via **`gltf-pipeline`** (`processGlb`) so Three.js/3DTRjs can load it (CesiumJS
  reads glTF 1.0 natively, Three.js does not).
- **`CESIUM_RTC` baking:** because we serve a plain GLB (bypassing each renderer's native b3dm/RTC
  handling), the b3dm's `CESIUM_RTC.center` (an ECEF offset) is folded into a wrapper **node
  translation** and the extension stripped. The center is **pre-rotated by the inverse glTF up-axis**
  (RX−90°: `(x,y,z)→(x,z,−y)`) so the renderer's Y-up→Z-up RX+90° restores the true ECEF position —
  otherwise the ~6378 km-magnitude center is itself rotated 90° and the geometry lands thousands of km
  away (correct bounding boxes, empty tiles). The small relative mesh vertices still get RX+90°, as in
  native b3dm.

`i3dm`/`cmpt` content and full PBR material rebuilds are deferred to `3d-tiles-tools`
(`upgrade --targetVersion 1.1`).

**`viewer.html`'s "⚙ Tools" mode groups a third operation, `packages`,** alongside these two for UX —
but it isn't a `/3dtiles-tools?tool=…` value at all: it routes to the *separate*
**`/3dtiles-self-contained`** endpoint (a `.3tz`/`.3dtiles` package → a standard streamed 3D Tiles
tileset — see
["`/3dtiles-self-contained` — serve `.3tz` / `.3dtiles` packages in-place"](/docs/guide/architecture-the-materialization-continuum-cache-none-hierar#3dtiles-self-contained--serve-3tz--3dtiles-packages-in-place)
in the architecture doc), not a tileset-level transcode. The grouping is "pick an operation to demo,"
not an architectural claim that `packages` lives under `/3dtiles-tools`.

**Doable but low value (noted, not planned):**
- **Point-budget / downsample proxy** — serve fewer/decimated tiles to weak clients. Marginal: a
  capable renderer (CesiumJS / 3DTilesRendererJS) already loads only what its SSE budget needs.
- **Mesh → points** — emit only vertices of a mesh tileset. Niche (loses the surface; render-time can
  approximate), listed for completeness.

For full offline pipelines (merge, `mergeJson`, `upgrade`, `b3dmToGlb`/`pnts`/`i3dm`/`cmpt` → glTF),
use **[`3d-tiles-tools`](https://github.com/CesiumGS/3d-tiles-tools)** — the canonical CesiumGS toolbox.
