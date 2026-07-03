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

**Tier 4 — blocked / low ROI:** **Autodesk ReCap `.rcp/.rcs`** — confirmed **no open reader OR writer** (PDAL/CloudCompare/PCL/Open3D none; FME writer-only); can't ingest remote `.rcp`; **and Autodesk can't consume 3D Tiles natively** (Cesium is *Bentley's* now → native import is in MicroStation/iTwin; Autodesk only has a Revit→3D Tiles *exporter*). Realistic bridge is a future **→ E57/LAS export** (formats ReCap ingests), not an `.rcp` writer. · **Bentley 3SM** (closed, no spec). · **Splatter (splatter.app)** — hosted Gaussian-splat viewer, **not a file format**: content is addressed by an opaque ID against a private backend, so there's nothing a converter could parse. Tracked as a rendering-technique reference, not a source format — see [`splatter-app.md`](/docs/references/splatter-app) for the full status writeup and observed API surface.

**Implemented adapters (plans: [streaming-adapter-plans.md](/docs/references/streaming-adapter-plans)):**
- ✅ **Bentley 3MX** — `GET /stream/tileset.json?format=threemx&url=<Scene.3mx | root.3mxb>`. Parses `3MXBO` node trees,
  serves lazy external-tileset fragments per `.3mxb`, decodes **OpenCTM (MG1/LZMA)** geometry via vendored
  js-openctm → glTF + JPEG baseColor. Verified live against the colorwlof/Unity-3mxb fixture (textured GLB
  tiles render; decoded bbox matches node bbMin/bbMax). Georef via SRS+SRSOrigin when present.
- ✅ **Bing Maps 3D** — `GET /bing/tileset.json?root=<quadkey>&g=<genid>&maxLevel=<L>[&decompress=1]`.
  `tf=3dv4` GLB (Draco + KTX2, ECEF in node matrix) served as-is; quadtree of quadkeys as lazy fragments,
  availability by HTTP probe, geographic `region` bounding volumes. Verified live (Berlin, keyless `g=15340`).
  The lazy fragments are their own route, `GET /bing/fragment/<face>-<level>-<x>-<y>.json?g=<genid>` —
  a partial explicit tileset continuing the tree from that boundary node; `tileset.json`'s deep tiles
  reference these by absolute URL, fetched only as the camera refines in. Example: `/bing/fragment/0-3-3-2.json?g=15530`.
- **Nexus** `.nxs/.nxz` — *moderate, postponed*: header parse + Corto decode exist in JS but are WebGL/Worker-coupled (port needed), Corto not on npm, DAG→tree mapping is the thorny bit.

### 2.5D terrain (separate track, future)
Deliberately out of scope so far, but worth showing: **DEM raster tiles → TIN → 3D Tiles/quantized-mesh.**
- **Cesium quantized-mesh** ([spec](https://github.com/CesiumGS/quantized-mesh)) — TIN, quadtree-in-TMS + `layer.json`; an output target as well as input.
- **Terrarium** (`(R*256+G+B/256)-32768`, token-free on AWS) and **Mapbox Terrain-RGB/DEM** (token-gated) — raster-DEM XYZ tiles.
- Bridge libs (Node-native): **[martini](https://github.com/mapbox/martini)** (RTIN), **[delatin](https://github.com/mapbox/delatin)** (Delaunay), **[pydelatin/pymartini](https://github.com/kylebarron/pydelatin)** (incl. `decode_ele` for Terrarium/Terrain-RGB) → feed **[quantized-mesh-encoder](https://github.com/kylebarron/quantized-mesh-encoder)** or a glTF terrain tileset.

> Verify-before-relying caveats from the crawl: itowns' current 3MX support is unconfirmed against master;
> Google 3D Tiles byte-range behavior is observed, not published; OSGB GE/bounding-volume metadata must be
> *synthesized* (the format only implies it via PagedLOD ranges).
