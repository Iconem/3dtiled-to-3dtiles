---
title: "Format comparison"
description: "🟢 = operational · 🟡 draft = scaffold built, partially/un-validated · 🟠 doc = spec referenced in"
---

🟢 = operational · 🟡 draft = scaffold built, partially/un-validated · 🟠 doc = spec referenced in
`docs-references/`, converter not built (lower-priority / niche). See `docs-references/` for full notes.

### Output — 3D Tiles

| Format | Status | Hierarchy / subdivision | Node (leaf) content | Refine | Intermediate nodes | Metadata location | HTTP range | Spec |
|--------|:------:|-------------------------|---------------------|:------:|--------------------|-------------------|:----------:|------|
| **3D Tiles** (output) | 🟢 out | explicit or implicit; box/region/sphere volumes | glTF/GLB w/ `KHR_gaussian_splatting`+`_spz_2` (splats) or POINTS/TRIANGLES | REPLACE/ADD | optional content | `tileset.json` (+ `.3tz`) | ✅ | [OGC](https://www.ogc.org/standard/3dtiles/) |

### Tiled point clouds → 3D Tiles

| Format | Status | Hierarchy / subdivision | Node (leaf) content | Refine | Intermediate nodes | Metadata location | HTTP range | Spec |
|--------|:------:|-------------------------|---------------------|:------:|--------------------|-------------------|:----------:|------|
| **COPC** (Cloud Optimized Pointcloud) | 🟢 | **octree** (EPT-style) | LAZ-compressed LAS points | ADD | octree nodes (accumulate) | COPC VLR + hierarchy pages | ✅ designed for range reads | [copc.io](https://copc.io) |
| **Potree** (v1 and v2) | 🟢 | **octree** (named `r`/`r0`..`r7`) | points: position int32×3·scale+offset + rgb (2.0 `octree.bin` / 1.x per-node `.bin`) | ADD | octree nodes (accumulate) | 2.0 `metadata.json`+`hierarchy.bin` (22 B/node) · 1.x `cloud.js`+`.hrc` | ✅ (2.0 single octree.bin; 1.x per-node files) | [Potree](https://github.com/potree/PotreeConverter) |

### Generic tiled formats → 3D Tiles

Formats that carry (or wrap) a general node/mesh hierarchy rather than a point- or splat-specific one.

| Format | Status | Hierarchy / subdivision | Node (leaf) content | Refine | Intermediate nodes | Metadata location | HTTP range | Spec |
|--------|:------:|-------------------------|---------------------|:------:|--------------------|-------------------|:----------:|------|
| **3D Tiles packages** `.3tz`/`.3dtiles` | 🟢 | passthrough — whatever the wrapped `tileset.json` declares (explicit or implicit) | the wrapped tileset's own tile content, unchanged | (wrapped tileset's own) | (wrapped tileset's own) | `.3tz`: ZIP + `@3dtilesIndex1@` binary index (path→offset) · `.3dtiles`: SQLite `key TEXT, content BLOB` | N/A — O(1) offset read / SQLite key lookup, not source-file byte-ranges | [3tz spec](https://github.com/erikdahlstrom/3tz-specification) · [.3dtiles proposal #727](https://github.com/CesiumGS/3d-tiles/issues/727) |
| **I3S** (Esri) | 🟡 draft | node tree (**always explicit** — no implicit/template scheme), OBB/MBS LoD (SLPK or REST) | nodes/geometry/textures; `DefaultGeometrySchema` = **PerAttributeArray** (pos `f32×3` · normal `f32×3` · uv0 `f32×2` · color `u8×4`, sequential) or Draco | REPLACE | node pages (`nodepages/*.json`) | `3dSceneLayer.json` + node pages | ✅ REST/range | [github](https://github.com/esri/i3s-spec) |
| **3MX** (Bentley/Acute3D) | 🟢 | master `Scene.3mx` JSON → `3MXBO` binary node tree | OpenCTM (MG1/LZMA) mesh + JPEG baseColor → transcoded to glTF | REPLACE | `3MXBO` node-tree levels | `Scene.3mx` + per-node `.3mxb` | ➖ per-file GET (lazy external-tileset fragments per `.3mxb`) | [Bentley docs](https://docs.bentley.com/LiveContent/web/ContextCapture%20Help-v18/en/GUID-569C1E44-D86A-4942-9ABE-36C33FB5A7EB.html) |
| **Bing Maps 3D** | 🟢 | quadtree of quadkeys (availability by HTTP probe) | `tf=3dv4` GLB — Draco geometry + KTX2 textures, ECEF baked into the node matrix | REPLACE | quadkey levels | manifest by quadkey/`genid` | ➖ per-file GET | (undocumented public tile service, reverse-engineered) |
| **Nexus** (CNR-ISTI) | 🟠 doc | multiresolution patch DAG / batched mesh | per-patch mesh (not splats) | — | — | header + patch index | ✅ | [github](https://github.com/cnr-isti-vclab/nexus) · [paper](https://vcg.isti.cnr.it/Publications/2016/PD16/FastDec_Ponchio.pdf) |

### Tiled Gaussian-splat sources → 3D Tiles

| Format | Status | Hierarchy / subdivision | Node (leaf) content | Refine | Intermediate nodes | Metadata location | HTTP range | Spec |
|--------|:------:|-------------------------|---------------------|:------:|--------------------|-------------------|:----------:|------|
| **SOG (streamed)** (PlayCanvas) | 🟢 | **binary** spatial tree (AABB split) | unbundled SOG chunk: WebP textures → `DataTable` (pos/quat-w-first/log-scale/SH-DC/logit-opacity) | REPLACE | empty grouping nodes | no geo metadata, `lod-meta.json` + per-chunk `meta.json` | ✅ per-file | [playcanvas](https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/streamed-sog/) |
| **LCC** (XGRIDS) | 🟢 | **grid of Units** (cellX×Y) × per-cell LODs | `Data.bin` fixed **32 B/splat**: pos `f32×3`, color `rgba8`, scale `u16×3`, rot `10-10-10-2` (+SH `Shcoef.bin` 64 B) | REPLACE | per-cell coarse LODs | georef'ed, `meta.lcc` JSON + `Index.bin` | ✅ `Index.bin` offsets into `Data.bin` | [developer.xgrids.com](https://developer.xgrids.com/#/document?titleId=en-1720509291851) |
| **RAD** (SparkJS) | 🟢 | LoD merge tree, variable fanout (Tiny-LoD base β≈1.75; Bhatt-LoD unspecified, our converter observes ~1.5 in practice) | RADC chunk: per-splat columns — `f16`/`oct88r8` **interleaved**, `ln_0r8`/`r8_delta` **planar**, `f32_lebytes` byte-transposed | REPLACE | downsampled **merged** splats | no geo metadata, root `RAD0` JSON + per-chunk `RADC` JSON | ✅ chunked `.radc` | [sparkjs.dev](https://sparkjs.dev/docs/lod-getting-started/) |
| **GeoSplats** (MapTiler) | 🟢 | **octree voxel grids** (`grid_1/8/64/512`) × 8 progressive LODs | per-octant **SOGS** (`means_l/u`, `quats`, `scales`, `sh0` WebP) or `octant_<n>.ply` | REPLACE (LOD subset) | coarser-LOD octants | georef'ed,`model.json` (georef) + per-sub-model `metadata.json` (`voxel_grids` + `entries` TOC) | ✅ per-file / range | [maptiler.com/geosplats](https://www.maptiler.com/geosplats/) |

### Format specifications (canonical sources + local mirrors)

Each source format's authoritative spec, with a distilled local copy under [`docs-references/`](docs-references/):

| Format | Canonical spec(s) | Local mirror |
|--------|-------------------|--------------|
| **COPC** | [copc.io](https://copc.io) · [spec repo](https://github.com/copcio/copcio.github.io) | [`copc-format.md`](docs-references/copc-format.md) |
| **Potree** | [PotreeConverter](https://github.com/potree/PotreeConverter) · [2.0 format (potree-converter)](https://github.com/potree/potree/blob/develop/docs/) · ref impl [potree23dtiles](https://github.com/yeyan00/potree23dtiles) | [`potree-format.md`](docs-references/potree-format.md) |
| **streamed-SOG** | [PlayCanvas streamed-SOG](https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/streamed-sog/) · [SOG](https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/sog/) · [splat-transform](https://github.com/playcanvas/splat-transform) | [`streamed-sog.md`](docs-references/streamed-sog.md) · [`sog.md`](docs-references/sog.md) |
| **LCC** (XGRIDS) | [developer.xgrids.com](https://developer.xgrids.com/#/document?titleId=en-1720509291851) · [LCC whitepaper](https://github.com/xgrids/LCCWhitepaper) · [LCC-Web-SDK](https://github.com/xgrids/LCC-Web-SDK) | [`lcc-format.md`](docs-references/lcc-format.md) |
| **RAD** (SparkJS) | **spec:** [LoD getting started](https://sparkjs.dev/docs/lod-getting-started/) · **blog:** [Spark 2.0 — spatially partitioned LoD](https://www.worldlabs.ai/blog/spark-2.0) · [ext-splats](https://sparkjs.dev/docs/ext-splats/) | [`rad-format-notes.md`](docs-references/rad-format-notes.md) · [`spark-2.0-blog-post.md`](docs-references/spark-2.0-blog-post.md) |
| **I3S** (Esri) | [esri/i3s-spec](https://github.com/esri/i3s-spec) (OGC Community Standard) | [`i3s-spec.md`](docs-references/i3s-spec.md) |
| **SPZ / glTF splat exts** | [SPZ](https://github.com/nianticlabs/spz) · [KHR_gaussian_splatting](https://github.com/CesiumGS/glTF/tree/proposal-KHR_gaussian_splatting) | [`spz-format.md`](docs-references/spz-format.md) · [`KHR_gaussian_splatting.md`](docs-references/KHR_gaussian_splatting.md) |
| **3D Tiles packages** | [`.3tz` spec](https://github.com/erikdahlstrom/3tz-specification) · [`.3dtiles` proposal (#727)](https://github.com/CesiumGS/3d-tiles/issues/727) | [`3tz-3dtiles-packages.md`](docs-references/3tz-3dtiles-packages.md) |
| **USD splats (ParticleField)** | [OpenUSD v26.03](https://aousd.org/blog/openusd-v26-03/) · [ParticleField3DGaussianSplat](https://openusd.org/release/user_guides/schemas/usdVol/ParticleField3DGaussianSplat.html) | [`usd-gaussian-splats.md`](docs-references/usd-gaussian-splats.md) |
| **glTF 2.1 (complex scenes)** | [Khronos blog](https://www.khronos.org/blog/introducing-gltf-2.1-with-complex-scenes) · [64-bit GLB / indices #2594](https://github.com/KhronosGroup/glTF/issues/2594) | [`gltf-2.1-complex-scenes.md`](docs-references/gltf-2.1-complex-scenes.md) |
| **GeoSplats** (MapTiler) | [maptiler.com/geosplats](https://www.maptiler.com/geosplats/) · SDK [@maptiler/geosplats](https://www.npmjs.com/package/@maptiler/geosplats) ([CDN .mjs](https://cdn.maptiler.com/maptiler-geosplats/v1.0.4/maptiler-geosplats.mjs)) · [docs.maptiler.com](https://docs.maptiler.com/) · [3D maps](https://www.maptiler.com/3d-maps/) | [`maptiler-geosplats.md`](docs-references/maptiler-geosplats.md) |


(Several spec sites block automated fetching — the `docs-references/` mirrors are hand-distilled from
the canonical sources above and kept in sync as the converters evolve.)
