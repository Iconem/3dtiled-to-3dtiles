---
title: "Candidate source formats — roadmap (not yet supported)"
description: "A crawl of the GIS / CAD-AEC / VFX / cultural-heritage communities for tiled / streamable formats we"
---

A crawl of the GIS / CAD-AEC / VFX / cultural-heritage communities for **tiled / streamable** formats we
don't yet ingest. Ranked by value × feasibility for a *live → 3D Tiles* adapter. (Already supported:
COPC, Potree 1.x/2.0, EPT, I3S/SLPK, streamed-SOG, LCC, RAD, 3D Tiles packages, Bentley 3MX, Bing Maps 3D.)

**Tier 1 — open enough + cleanly tiled + remotely consumable:**
| Format | Origin / community | Content | Hierarchy | Remote/range | Reader | Note |
|---|---|---|---|---|---|---|
| **Nexus** `.nxs/.nxz` | CNR-ISTI (3DHOP) · heritage/academic | mesh (+pts) | error-tagged **DAG of patches** | ✅ **HTTP Range by design** | `nexus3d`/`nexus.js` + Corto (MIT) | best heritage fit; DAG→tileset maps cleanly |
| **OSGB** `.osgb` | OpenSceneGraph + Acute3D/Smart3D · GIS oblique (huge in China) | textured mesh | `metadata.xml` + PagedLOD child files | ➖ file paging (no byte-range) | `flywave/go-osg`, OSG C++, WASM; offline [fanvanzh/3dtiles](https://github.com/fanvanzh/3dtiles) (reads OSGB/SHP/FBX/OBJ) | main work = georef (CGCS2000) + synth GE/bbox |
| **SuperMap S3M** `.s3mb+.scp` | SuperMap · China GIS (open spec T/CAGIS) | mesh (+WebP/KTX2) | LOD pyramid under `.scp` | ✅ HTTP per LOD/tile | [s3m-spec](https://github.com/SuperMap/s3m-spec) + **official S3M↔3D Tiles tool** | low risk; converter already exists |

**Tier 2 — feasible, caveated:**
- **Cesium quantized-mesh `.terrain`** + **Terrarium** / **Mapbox Terrain-RGB** raster-DEM tiles → TIN via
  **martini**/**delatin** (JS) — the whole **2.5D terrain** track (see below).
- **OpenUSD / USDZ** — strong VFX/heritage *source* (not spatially tiled); **TinyUSDZ** gives a Node/WASM
  reader. Walk the stage → emit tileset; not a streaming passthrough. (Nanite = no open format → dead end.)
- **Skyline o3DML v2** — only the new variant (3D Tiles internals in a SQLite container); skip classic 3DML/MPT.

**Tier 3 — integrate, don't build:** **Bentley iModel/iTwin** (use the [Mesh Export API](https://developer.bentley.com/apis/mesh-export/overview/) → already 3D Tiles) · **Cesium ion** & **Google Photorealistic 3D Tiles** (already 3D Tiles — consume/target; Google ToS forbids re-serving/caching).

**Tier 4 — blocked / low ROI:** **Autodesk ReCap `.rcp/.rcs`** — confirmed **no open reader OR writer** (PDAL/CloudCompare/PCL/Open3D none; FME writer-only); can't ingest remote `.rcp`; **and Autodesk can't consume 3D Tiles natively** (Cesium is *Bentley's* now → native import is in MicroStation/iTwin; Autodesk only has a Revit→3D Tiles *exporter*). Realistic bridge is a future **→ E57/LAS export** (formats ReCap ingests), not an `.rcp` writer. · **Bentley 3SM** (closed, no spec).

**Reprioritized higher — Splatter (splatter.app):** hosted Gaussian-splat viewer/host by Jakub Červený.
Re-checked 2026-07-06 (WebSearch pass: splatter.app's own site, the Radiance Fields announcement post,
Červený's public `splatter-app/three-demo`): still **not a file format** in the sense every other entry
here is — content is addressed by an opaque `splatId` against a private backend, the LOD-hierarchy
augmentation step (their site says it takes a "standard PLY" and "automatically augments it with an LOD
hierarchy, no retraining needed") happens server-side and isn't published, and `splatter-three` (the
actual streaming/rendering client library) is licensed to Business/Enterprise customers rather than
open-sourced — so the opaque-backend caveat from the previous entry still holds, confirmed not stale.
**Reprioritized higher anyway, per explicit product request (2026-07-06)** — despite the caveat, it's
worth tracking nearer the top of this list rather than buried in Tier 4, and worth periodically
re-checking for a published wire format or an open-sourced client, since the underlying idea (PLY → LOD
hierarchy → progressive streaming) is exactly the shape of format this repo already targets (see
[`splatter-app.md`](/docs/references/splatter-app) for the full status writeup, observed public API
surface from the `three-demo` source, and how its progressive-loading model compares to this repo's own
SOG/GeoSplats octree LOD).

**Implemented adapters (plans: [streaming-adapter-plans.md](/docs/references/streaming-adapter-plans)):**
Bentley 3MX and Bing Maps 3D are both fully implemented and live — see the dedicated
[Bentley 3MX and Bing Maps 3D](/docs/guide/streaming-architecture-design-log) sections in the design
log for the full implementation detail. Still not implemented:
- **Nexus** `.nxs/.nxz` — *moderate, postponed*: header parse + Corto decode exist in JS but are WebGL/Worker-coupled (port needed), Corto not on npm, DAG→tree mapping is the thorny bit.

### 2.5D terrain (separate track, future)
Deliberately out of scope so far, but worth showing: **DEM raster tiles → TIN → 3D Tiles/quantized-mesh.**
- **Cesium quantized-mesh** ([spec](https://github.com/CesiumGS/quantized-mesh)) — TIN, quadtree-in-TMS + `layer.json`; an output target as well as input.
- **Terrarium** (`(R*256+G+B/256)-32768`, token-free on AWS) and **Mapbox Terrain-RGB/DEM** (token-gated) — raster-DEM XYZ tiles.
- Bridge libs (Node-native): **[martini](https://github.com/mapbox/martini)** (RTIN), **[delatin](https://github.com/mapbox/delatin)** (Delaunay), **[pydelatin/pymartini](https://github.com/kylebarron/pydelatin)** (incl. `decode_ele` for Terrarium/Terrain-RGB) → feed **[quantized-mesh-encoder](https://github.com/kylebarron/quantized-mesh-encoder)** or a glTF terrain tileset.

> Verify-before-relying caveats from the crawl: itowns' current 3MX support is unconfirmed against master;
> Google 3D Tiles byte-range behavior is observed, not published; OSGB GE/bounding-volume metadata must be
> *synthesized* (the format only implies it via PagedLOD ranges).

### New project direction (proposed, not a format): "fastest" point-cloud → COPC/3D Tiles tiler

Not a source format to ingest — a **proposed new project direction**: could this repo's own converters
(or a new sibling tool) become the fastest tiler for raw point clouds into COPC or 3D Tiles output,
taking inspiration from Potree's own tiling approach. This is a **market/feasibility research note**
(WebSearch pass, 2026-07-06) — it summarizes public technical writing and one repo's own README claims,
**not** first-hand user feedback gathered from this project's users. Treat the "community sentiment"
items below as what's publicly written, not a survey.

**How Potree's own converter achieves its speed (technical read, not sentiment):**
- **PotreeConverter 2.0's approach is documented in a peer-reviewed paper**: Schütz, Ohrhallinger & Wimmer,
  ["Fast Out-of-Core Octree Generation for Massive Point Clouds"](https://www.cg.tuwien.ac.at/research/publications/2020/SCHUETZ-2020-MPC/)
  (Computer Graphics Forum, 2020). Core technique: a **hierarchical counting sort** to split the point
  cloud into small out-of-core chunks first (cheap, single-pass, parallelizable), then build per-chunk
  LOD via exchangeable subsampling strategies (a fast approximate blue-noise sampler, or a plain uniform
  random sampler) bottom-up. Reported throughput: **up to ~9M points/sec** (uniform sampling) or **~6M
  points/sec** (blue-noise), including out-of-core disk I/O — benchmarked at generating an LOD structure
  for **18 billion points in 1h17m**. This is a **published, citable technical result**, not community
  hearsay.
- **Independently, PotreeConverter's own GitHub README claims 2.0 is 10-50x faster than 1.7 on SSDs**,
  attributing most of the gain to emitting **~3 output files total instead of thousands-to-millions** —
  fewer files means filesystem operations (copy/upload/delete) that used to take hours/days drop to
  seconds/minutes. That's the tool authors' own claim, not independently reproduced here.
- Net technical read: the speed story is less about a novel geometric algorithm and more about (a) an
  out-of-core chunking pass designed for parallelism from the start, and (b) minimizing filesystem
  overhead by consolidating output into few large files rather than many small ones — both principles
  this repo's own streaming/tiled formats (COPC, streamed-SOG, LCC) already lean on for the *output*
  side; the gap would be on the *tiling/build* side for raw, untiled point-cloud input.

**How COPC-focused tools compare (untwine/entwine/PDAL):**
- **untwine** (Hobu Inc., the PDAL maintainers) is the tool actually recommended for building COPC at
  scale: per its own project material, for point clouds **exceeding 500 million points, untwine runs
  2-5x faster than `pdal translate`**, crediting a **parallelized, single-pass chunking algorithm** that
  builds the clustered octree index directly, with **under 5% storage overhead** versus the source LAZ.
  It works **bottom-up** rather than entwine's (its predecessor's) top-down approach.
  ([hobuinc/untwine](https://github.com/hobuinc/untwine))
  Sources: [CAD Interop's COPC writeup](https://www.cadinterop.com/en/formats/cloud-point/copc.html),
  [untwine GitHub](https://github.com/hobuinc/untwine).
- **entwine** (`connormanning/entwine`) is the older, more general EPT/point-cloud organizer that
  untwine's own docs position themselves as a faster, COPC-specific successor to for the large-scale case.
- No independent third-party head-to-head *benchmark* (untwine vs. PotreeConverter 2.0 vs. a hypothetical
  new tool) turned up in this pass — the untwine-vs-`pdal-translate` and PotreeConverter-2.0-vs-1.7
  numbers above are each tool's **own** reported comparison, not a neutral bake-off. Worth flagging before
  treating either as a hard target to beat.

**Public community commentary found (actual sentiment, not just tool-vendor claims):**
- [`visgl/loaders.gl` issue #2911](https://github.com/visgl/loaders.gl/issues/2911) tracks COPC tiled-loader
  support as background/ongoing work — reflects COPC still being treated as an emerging, not-yet-universally
  -supported format in the wider JS geospatial-viewer ecosystem, consistent with this repo's own choice to
  build a live COPC adapter rather than assume off-the-shelf tooling covers it.
  Related loader-quality discussion (`visgl/deck.gl` discussion #7454 on point-cloud layer performance,
  and a Cesium Community forum thread on FPS drops rendering sparse point-cloud 3D Tiles) point at
  **tileset-traversal and per-tile-fragment-count** as recurring real-world pain points **on the render
  side**, not the build/tiling side — i.e. even a fast tiler can produce tilesets that render poorly if
  node/point density per tile isn't tuned for the target GPU fragment budget. Worth folding into any
  "fastest tiler" design goal: fast *and* well-tiled are separate axes.
- [MIERUNE/point-tiler](https://github.com/MIERUNE/point-tiler) (Rust, Rayon-based parallelism, targets
  3D Tiles 1.1 directly from LAS/LAZ/CSV) is a recent (found via this search pass) independent example of
  someone else already pursuing a similar "fast point-cloud → 3D Tiles" goal — worth a direct look/comparison
  before scoping this repo's own effort, since it may already cover some of the same ground.

**Feasibility read for this repo specifically:** the repo's own `ambition.md` already names "be the
fastest point-cloud — and eventually splat — tiler, by reusing the octree-computation principles behind
Potree 2.0's converter" as a longer-running goal. This research pass supports that direction being
technically groundable (Potree 2.0's own published paper gives concrete algorithmic principles to reuse:
out-of-core parallel chunking + few-large-files output; untwine shows the same principles hold specifically
for COPC-shaped output) but flags two things worth resolving before committing: (1) no neutral benchmark
exists yet comparing this repo's own converters' build speed against PotreeConverter 2.0 or untwine — that
would be the natural first step to even know the starting gap; (2) `MIERUNE/point-tiler` looks like
already-published prior art aimed at the same COPC/3D-Tiles-from-raw-point-cloud niche and should be
evaluated before assuming this would be a novel effort.
