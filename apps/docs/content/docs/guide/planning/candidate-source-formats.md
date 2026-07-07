---
title: "Candidate source formats"
description: "A crawl of the GIS / CAD-AEC / VFX / cultural-heritage communities for tiled / streamable formats we"
---

A crawl of the GIS / CAD-AEC / VFX / cultural-heritage communities for **tiled / streamable** formats we
don't yet ingest. Ranked by value × feasibility for a *live → 3D Tiles* adapter. (Already supported:
COPC, Potree 1.x/2.0, EPT, I3S/SLPK, streamed-SOG, LCC, RAD, 3D Tiles packages, Bentley 3MX, Bing Maps 3D.)

**Candidates — open enough + cleanly tiled + remotely consumable:**
| Format | Origin / community | Content | Hierarchy | Remote/range | Reader | Note |
|---|---|---|---|---|---|---|
| **SPZ v5** (upcoming) | Niantic Spatial | Gaussian splats, spatial chunking + LOD (planned) | not yet specified | unspecified | none yet | to be implemented once the spec ships — see below |
| **Splatter** (splatter.app) | Jakub Červený · hosted Gaussian-splat viewer/host | opaque `splatId`-addressed splats (PLY + server-side LOD augmentation) | private backend; not a published tiled format | ➖ opaque backend, no public wire format | none (private `splatter-three` client) | reprioritized higher per explicit product request — see full status writeup below |
| **2.5D Terrain** (DEM → TIN, and Terrarium/Terrain-RGB-encoded XYZ tiles) | Cesium quantized-mesh / Terrarium / Mapbox Terrain-RGB | raster-DEM → TIN mesh | quadtree-in-TMS (`layer.json`) or raster XYZ | ✅ per-tile | martini/delatin (JS bridges) | separate track, future — see below |
| **OSGB** `.osgb` | OpenSceneGraph + Acute3D/Smart3D · GIS oblique (huge in China) | textured mesh | `metadata.xml` + PagedLOD child files | ➖ file paging (no byte-range) | `flywave/go-osg`, OSG C++, WASM; offline [fanvanzh/3dtiles](https://github.com/fanvanzh/3dtiles) (reads **OSGB, SHP, FBX, and OBJ** — OBJ via single-file `gltf` mode; full simplify/Draco tileset pipeline is still only `osgb`/`shape`) | main work = georef (CGCS2000) + synth GE/bbox. **Open sample data**: few openly downloadable full tilesets (vendor demo projects + [natowi/photogrammetry_datasets](https://github.com/natowi/photogrammetry_datasets) index; small fixtures in converters) — ContextCapture/ion **3D Tiles** samples are easier to get than raw OSGB. |
| **Nexus** `.nxs/.nxz` | CNR-ISTI (3DHOP) · heritage/academic | mesh (+pts) | error-tagged **DAG of patches** | ✅ **HTTP Range by design** | `nexus3d`/`nexus.js` + Corto (MIT) | best heritage fit; DAG→tileset maps cleanly — see the full assessment below |
| **SuperMap S3M** `.s3mb+.scp` | SuperMap · China GIS (open spec T/CAGIS) | mesh (+WebP/KTX2) | LOD pyramid under `.scp` | ✅ HTTP per LOD/tile | [s3m-spec](https://github.com/SuperMap/s3m-spec) + **official S3M↔3D Tiles tool** | low risk; converter already exists, but **adoption outside China is low** (SuperMap-internal; OGC 3D Tiles dominates internationally) — deprioritize. Samples referenced in [SuperMap/s3m-spec](https://github.com/SuperMap/s3m-spec) but no direct URLs. |

**Watch:**

- **Upcoming Niantic SPZ-v5** — with HLOD + stream support
- **DJI Terra / DJI Reality** — DJI's photogrammetry/splat reconstruction software; ships a web viewer
at `3dviewer.dji.com` (the specific link checked was **stale/unreachable**, so this couldn't be
confirmed directly). Plausibly a *tiled HLOD* splat format given DJI Reality targets large drone-scale
captures (the same scale problem GeoSplats/RAD/LCC solve with HLOD), but unverified — flagged here as
a format worth investigating once a live viewer link is found, not a confirmed adapter target.

**Discarded:**
- **Autodesk ReCap `.rcp/.rcs`** — confirmed **no open reader OR writer** (not in PDAL/CloudCompare/PCL/Open3D; FME has a *writer only*, via Autodesk's closed SDK, no reader — so a remote `.rcp` can't even be ingested, since it needs local relative paths to `.rcs`). **Autodesk can't natively consume OGC 3D Tiles either**: Cesium is **Bentley's** since 2024 — native 3D Tiles import lives in **MicroStation/iTwin**, not Autodesk; Autodesk's only Cesium link is a **Revit→3D Tiles *exporter***, not an importer (AutoCAD/Civil3D/Navisworks/InfraWorks have no 3D Tiles import). Realistic bridge is a future **"→ E57/LAS/LAZ" export** tool (formats ReCap *does* ingest: E57, LAS/LAZ, PTS, PTX, XYZ, PLY) → ReCap Pro → `.rcp` → AutoCAD — not an `.rcp` writer. ([ReCap supported formats](https://help.autodesk.com/view/RECAP/ENU/?guid=supported_file_formats) · [Cesium Revit add-in (exporter)](https://cesium.com/blog/2024/12/03/cesium-design-tiler-and-revit-add-in/) · [no open RCS/RCP reader](https://www.cadinterop.com/en/formats/cloud-point/rcs-rcp.html))

### SPZ v5 (upcoming), the fuller roadmap writeup

**SPZ v4/v5 roadmap** (primary source: [Niantic Spatial's own v4 announcement](https://www.nianticspatial.com/blog/spz4),
published 2026-05-05 — supersedes the earlier secondhand radiancefields.com summary this section used
to cite). **v4, shipped:** six parallel ZSTD streams (one per attribute: positions/colors/scales/
rotations/alphas/SH) replacing the old single GZip stream — "**compresses about 3-5x faster**" (an
8.5 GB/34M-point PLY benchmark: 3 min 26 s on v3 vs. 1 min 8 s on v4) and "**loads roughly 1.5-2x
faster**", while still landing "**10x smaller than uncompressed PLYs**". Also: the old **10-million-point
cap is gone**; SH support goes to **degree 4** (from degree 3) with configurable quantization (3-8 bits,
5 recommended); a new "NGSP"-magic extensible header carries vendor extensions (e.g. an Adobe
camera-control extension); and **old (pre-v4) readers fail gracefully** on the new magic bytes rather
than misparsing — v4 itself reads every older SPZ file. Adoption stat cited: "**800,000 SPZ files in
the last two months**."

**v5, roadmap only — no design specifics or date given:** the post names, verbatim, "**streaming and
progressive loading**" and "**spatial chunking and LOD**" as "directions on our radar", alongside
further SH-quantization refinement and more vendor extensions. No bit layout, chunk scheme, LOD tier
count, or streaming protocol is specified — it's a roadmap bullet list, not a spec draft. That's the
same tiled/HLOD problem this repo's own streaming adapters (GeoSplats, RAD, LCC, streamed-SOG) already
solve today, just heading toward a single-vendor-defined *file* format instead of a 3D-Tiles-hierarchy
one — worth a re-check once v5 actually publishes something concrete to read against, not before. To be
implemented once the spec ships.

### Splatter, the fuller status writeup

Splatter (splatter.app, Jakub Červený) — a hosted Gaussian-splat viewer/host by Jakub Červený, tested
against a 103M-splat scene. Re-checked 2026-07-06 (WebSearch pass: splatter.app's own site, the
Radiance Fields announcement post, Červený's public `splatter-app/three-demo`): still **not a file
format** in the sense every other entry here is — content is addressed by an opaque `splatId` against
a private backend, the LOD-hierarchy augmentation step (their site says it takes a "standard PLY" and
"automatically augments it with an LOD hierarchy, no retraining needed") happens server-side and isn't
published, and `splatter-three` (the actual streaming/rendering client library) is licensed to
Business/Enterprise customers rather than open-sourced — so the opaque-backend caveat holds, confirmed
not stale.

**Reprioritized higher anyway, per explicit product request (2026-07-06)** — despite the caveat, it's
worth tracking nearer the top of this list rather than buried at the bottom, and worth periodically
re-checking for a published wire format or an open-sourced client, since the underlying idea (PLY → LOD
hierarchy → progressive streaming) is exactly the shape of format this repo already targets (see
[`splatter-app.md`](/docs/references/3dgs-splats/splatter-app) for the full status writeup, observed public API
surface from the `three-demo` source, and how its progressive-loading model compares to this repo's own
SOG/GeoSplats octree LOD).

### 2.5D terrain, the fuller writeup (separate track, future)

Deliberately out of scope so far, but worth showing: **DEM raster tiles → TIN → 3D Tiles/quantized-mesh.**
- **Cesium quantized-mesh** ([spec](https://github.com/CesiumGS/quantized-mesh)) — TIN, quadtree-in-TMS + `layer.json`; an output target as well as input.
- **Terrarium** (`(R*256+G+B/256)-32768`, token-free on AWS) and **Mapbox Terrain-RGB/DEM** (token-gated) — raster-DEM XYZ tiles.
- Bridge libs (Node-native): **[martini](https://github.com/mapbox/martini)** (RTIN), **[delatin](https://github.com/mapbox/delatin)** (Delaunay), **[pydelatin/pymartini](https://github.com/kylebarron/pydelatin)** (incl. `decode_ele` for Terrarium/Terrain-RGB) → feed **[quantized-mesh-encoder](https://github.com/kylebarron/quantized-mesh-encoder)** or a glTF terrain tileset.

> Verify-before-relying caveats from the crawl: itowns' current 3MX support is unconfirmed against master;
> Google 3D Tiles byte-range behavior is observed, not published; OSGB GE/bounding-volume metadata must be
> *synthesized* (the format only implies it via PagedLOD ranges).

### Nexus, the fuller assessment (MODERATE, postponed)

Honest verdict: **not a quick spike.** Why it's *not hard*: the binary layout is small and **already
parsed in JS** (`cnr-isti-vclab/nexus` `html/js/nexus.js`: `importHeader`/`handleIndex` read the DAG,
and it already does HTTP **Range** requests), and **Corto** decode exists in JS
(`cnr-isti-vclab/corto`, MIT). Why it's *not trivial*: that JS is welded to WebGL + Web Workers + a
runtime camera-driven traversal — you'd **port and re-architect**, not import; **Corto is not on npm**
(the `corto` npm package is an unrelated 2014 HTTP client — must vendor from the repo, and the WASM
build needs Node glue); and **Nexus is a DAG while 3D Tiles is a strict tree** (shared nodes →
duplicate or spanning-tree cut, the one genuinely thorny design choice). Also it's **mesh** content,
off this repo's splat path.

Node struct: `uint32 offset(×256)` + `uint16 nvert` + `uint16 nface` + `float error` + `Cone3s(8)` +
`Sphere3f(16)` + `float tight_radius` + `uint32 first_patch` (44 B). Patch struct: 12 B
(`node, triangle_offset, texture`). Map: `geometricError←node.error`,
`boundingVolume.sphere←node.sphere`, `refine:"REPLACE"`.

**Estimate: days-to-low-weeks.** Recommend postpone until a mesh-tiling track is prioritized.
([dag.h](https://github.com/cnr-isti-vclab/nexus/blob/master/src/common/dag.h) ·
[nexus.js](https://github.com/cnr-isti-vclab/nexus/blob/master/html/js/nexus.js) ·
[corto](https://github.com/cnr-isti-vclab/corto))

**Implemented adapters:** Bentley 3MX and Bing Maps 3D are both fully implemented and live — see the
dedicated [Bentley 3MX and Bing Maps 3D](/docs/guide/planning/streaming-architecture-design-log) sections in the
design log for the full implementation detail (format investigation, byte layouts, and the plans that
preceded the build). Still not implemented: **Nexus** — see the assessment above.
