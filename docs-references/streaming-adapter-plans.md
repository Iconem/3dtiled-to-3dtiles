# Streaming-adapter implementation plans & format assessments

Plans for candidate `/stream` adapters, plus honest feasibility verdicts. Research-backed (links inline).
Nothing here is implemented yet — these are the blueprints we agreed to write before building.

---

## 1. Bentley 3MX → 3D Tiles  (`/stream?format=3mx`)  — **TOP mesh candidate**

### Format (verified against Bentley docs + osgPlugins-3mx / Unity-3mx readers)
- **Master `.3mx`** (JSON entry point): `layers[0]` = `{ type:"meshPyramid", SRS (e.g. "EPSG:32631"), SRSOrigin:[x,y,z] (local origin in SRS units), root:"Data/Tile_0/Tile_0.3mxb" }`. All node coords are **relative to `SRSOrigin`** (float-friendly).
- **`.3mxb` binary**: `"3MXBO"` (5 bytes) · `uint32 LE headerSize` · JSON header · concatenated payload buffers.
  - header `resources[]`: `{ id, type:"geometryBuffer"|"textureBuffer", format:"ctm"|"jpg"|"xyz", size }`
  - header `nodes[]`: `{ id, bbMin, bbMax, maxScreenDiameter, children:[<child .3mxb relative paths>], resources:[ids] }`
  - geometry = **OpenCTM** (MG1 in practice); texture = **JPEG** (passthrough). A single `.3mxb` packs several sibling nodes + all their buffers.
- **Remote-friendly**: `children`/`resources` are **relative-path HTTP GETs** → a middleware pointed at a remote `Scene.3mx` walks `children` on demand. ([3MX](https://docs.bentley.com/LiveContent/web/ContextCapture%20Help-v18/en/GUID-CED0ABE6-2EE3-458D-9810-D87EC3C521BD.html) · [3MXB](https://docs.bentley.com/LiveContent/web/ContextCapture%20Help-v18/en/GUID-2A3C8541-EF29-4F17-8999-D3398C8E7192.html) · [osgPlugins-3mx ReaderWriter3MX.cpp](https://github.com/ProjSEED/osgPlugins-3mx/blob/master/ReaderWriter3MX.cpp))

### Plan — new `packages/tile-server/threemx-live.js`, modeled on **i3s-live.js**
(named-node DAG → lazy **external-tileset fragments keyed by file path**, NOT octree coords; non-octree, no `subtree`). Register `threemx`/`3mx` in `stream-live.js` `ADAPTERS` + `detectFormatByName`.
1. **`threemxTileset`**: GET `.3mx` → read `layers[0]`; build root `transform` = **ENU→ECEF from `SRSOrigin`** (reuse the repo's proj→ECEF helper from `lcc`/`copc`); emit a root tile whose content is an external ref to the root `.3mxb` (`/stream/tile/<enc relPath>?...&format=3mx`).
2. **Per-`.3mxb` fragment** (the workhorse): GET + verify `3MXBO` + parse header. Each `node` → a tile: `boundingVolume.box` from `bbMin/bbMax`, `geometricError = diag(bbMin,bbMax)/maxScreenDiameter × tunable` (monotonic-decreasing; `refine:"REPLACE"`), content = a glb built from the node's CTM geometry + JPEG texture; `children[]` → external-tileset refs to child `.3mxb`. One `.3mxb` → one tileset.json fragment + N glb contents.
3. **CTM→glTF**: vendor **jcmellado/js-openctm** + **js-lzma** (both Node-safe, no DOM; MIT/zlib); decode `ctm`→`{vertices,indices,normals,uvMaps}`, embed JPEG as `image/jpeg` baseColor (no re-encode). Reuse the repo's glb writer.
4. Honor `hierarchy`/`prefetch` (lazy fragments by default; eager pre-walk N levels).

### Hard parts
`maxScreenDiameter`→`geometricError` multiplier needs tuning in Cesium (must stay monotonic) · `SRSOrigin` vs `offset` differs across ContextCapture versions; projected-grid vs true-ENU convergence at scene edges · OpenCTM MG1 vs MG2 quantization in Node (test early) · multi-node-per-`.3mxb` resource attribution · **no current JS reference reader** (itowns dropped its 3MX provider) → port the C++ `ReaderWriter3MX.cpp` parse logic.

---

## 2. Bing Maps 3D → 3D Tiles  (`/stream?format=bing`)  — licensing handled by user

### Format (verified by downloading + parsing a real tile)
- **Endpoint**: `https://{host}/tiles/mtx{QUADKEY}?g={GENID}&tf={FMT}&n=z&key={KEY}&form=web3d`
  - host `t.ssl.ak.tiles.virtualearth.net` · path = `mtx`+base-4 **quadkey** (**quadkey length = LOD**) · `g=` = generation/dataset id (e.g. `15340`; **drifts**, undocumented) · `tf=3dv4`→**GLB**, `tf=3dv3`→MTX.
- **`tf=3dv4` GLB** (the target): standard binary glTF, **`KHR_draco_mesh_compression`** geometry + **`KHR_texture_basisu`** (KTX2) textures, **ECEF placement baked into the glTF node `matrix`** (translation = tile origin in EPSG:4978; drops into Cesium correctly with no extra transform). Vertices = plain FLOAT VEC3 local meters.
- **MTX `tf=3dv3`**: zstd (`28 B5 2F FD`) → b3dm-like TIN; **post-inflate layout never publicly reverse-engineered → avoid**; always request `tf=3dv4`.
- Sniff first bytes: `67 6C 54 46` (`"glTF"`)=GLB · `28 B5 2F FD`=MTX(zstd).
- ([Bing Tile System / quadkey](https://learn.microsoft.com/en-us/bingmaps/articles/bing-maps-tile-system) · [s1dny/bing-maps-tile-downloader](https://github.com/s1dny/bing-maps-tile-downloader) — `src/download.rs` endpoint+quadkey, `src/decompress.rs` KTX2 · [3D Tiles ImplicitTiling](https://github.com/CesiumGS/3d-tiles/blob/main/specification/ImplicitTiling/README.adoc)) · sample tile saved at `C:\Dev\tile.glb`.

### Plan — new `packages/tile-server/bing-live.js`
1. **Config (no manifest exists)**: accept `g` (genid), `key`, AOI bbox, min/max zoom. Optionally validate `g` by probing a known-good quadkey at startup. Root = longest common quadkey prefix of AOI corners.
2. **Synthesize an implicit QUADTREE tileset**: `implicitTiling{ subdivisionScheme:"QUADTREE", subtreeLevels:N, availableLevels:maxZoom+1, subtrees:{uri:"subtrees/{level}/{x}/{y}.subtree"} }`, `content:{uri:"content/{level}/{x}/{y}.glb"}`. `(L,x,y)`↔quadkey: child digits `xbit + 2·ybit` per level.
3. **`.subtree` availability on demand**: walk the subtree's quadkeys, **HTTP-probe** Bing (404/empty=absent), set `tileAvailability`/`contentAvailability`/`childSubtreeAvailability` bitstreams in Morton order; 24-byte `"subt"` header + JSON + binary chunks; cache aggressively.
4. **Content**: `(L,x,y)`→quadkey→URL→fetch GLB; sniff `"glTF"`; **serve as-is** (node matrix georefs it; leave tile `transform` identity). Optionally gltf-transform-decode Draco/KTX2 for non-Cesium viewers (ties into the planned `gltf` decompress tool).

### Hard parts
**Child-availability discovery** is the central unknown — no manifest; only proven method is recursive HTTP probing (`s1dny` does it flat at one zoom). *Investigate whether the GLB embeds its child quadkeys* (accessors/extras) to replace blind probing — sample tile saved for inspection. · `g=` **genid drift** (no discovery API; will rot) · confirm node-matrix-ECEF convention across zooms/regions (cross-check with a `region` bbox from quadkey corners) · Draco **is** present (confirmed empirically) → pipeline must decode for non-Cesium.

---

## 3. Nexus (.nxs/.nxz) → 3D Tiles — **assessment: MODERATE, postponed**

Honest verdict: **not a quick spike.** Why it's *not hard*: the binary layout is small and **already parsed in JS** (`cnr-isti-vclab/nexus` `html/js/nexus.js`: `importHeader`/`handleIndex` read the DAG, and it already does HTTP **Range** requests), and **Corto** decode exists in JS (`cnr-isti-vclab/corto`, MIT). Why it's *not trivial*: that JS is welded to WebGL + Web Workers + a runtime camera-driven traversal — you'd **port and re-architect**, not import; **Corto is not on npm** (the `corto` npm package is an unrelated 2014 HTTP client — must vendor from the repo, and the WASM build needs Node glue); and **Nexus is a DAG while 3D Tiles is a strict tree** (shared nodes → duplicate or spanning-tree cut, the one genuinely thorny design choice). Also it's **mesh** content, off this repo's splat path. Node struct: `uint32 offset(×256)` + `uint16 nvert` + `uint16 nface` + `float error` + `Cone3s(8)` + `Sphere3f(16)` + `float tight_radius` + `uint32 first_patch` (44 B); Patch = 12 B (`node, triangle_offset, texture`). Map: `geometricError←node.error`, `boundingVolume.sphere←node.sphere`, `refine:"REPLACE"`. **Estimate: days-to-low-weeks.** Recommend postpone until a mesh-tiling track is prioritized. ([dag.h](https://github.com/cnr-isti-vclab/nexus/blob/master/src/common/dag.h) · [nexus.js](https://github.com/cnr-isti-vclab/nexus/blob/master/html/js/nexus.js) · [corto](https://github.com/cnr-isti-vclab/corto))

---

## 4. Autodesk ReCap `.rcp/.rcs` — **blocked, and not bypassable via 3D Tiles** (corrects an earlier hope)

- **No open/reverse-engineered reader OR writer.** Not in PDAL/CloudCompare/PCL/Open3D; FME has a *writer only* (via Autodesk's closed SDK), no reader. Can't ingest a remote `.rcp` (needs local relative paths to `.rcs`). So **we can't write `.rcp`** to feed AutoCAD (no open writer), and can't read it as a source.
- **Autodesk can't natively consume OGC 3D Tiles either.** (Cesium is **Bentley's** since 2024 — the native 3D Tiles import lives in **MicroStation/iTwin**, not Autodesk. Autodesk's only Cesium link is a **Revit→3D Tiles *exporter***, not an importer; AutoCAD/Civil3D/Navisworks/InfraWorks have no 3D Tiles import.)
- **Realistic Autodesk bridge** = a future **"→ E57 / LAS / LAZ" export** (formats ReCap *does* ingest: E57, LAS/LAZ, PTS, PTX, XYZ, PLY) → ReCap Pro → `.rcp` → AutoCAD. That export tool (not an `.rcp` writer) is the only viable path. ([ReCap supported formats](https://help.autodesk.com/view/RECAP/ENU/?guid=supported_file_formats) · [Cesium Revit add-in (exporter)](https://cesium.com/blog/2024/12/03/cesium-design-tiler-and-revit-add-in/) · [no open RCS/RCP reader](https://www.cadinterop.com/en/formats/cloud-point/rcs-rcp.html))

---

## Corrected facts (from this round's verification)
- **fanvanzh/3dtiles** reads **OSGB, SHP, FBX, and OBJ** (OBJ via single-file `gltf` mode) — *not* "only OSGB+SHP". Full tileset pipeline (simplify/Draco) is still only `osgb`/`shape`. ([README_EN](https://github.com/fanvanzh/3dtiles/blob/master/README_EN.md))
- **SuperMap S3M**: open spec + official S3M↔3D Tiles converter, but **adoption outside China is low** (SuperMap-internal; OGC 3D Tiles dominates internationally) — deprioritize.
- **Open sample data**: OSGB — few openly downloadable full tilesets (vendor demo projects + [natowi/photogrammetry_datasets](https://github.com/natowi/photogrammetry_datasets) index; small fixtures in converters). S3M — samples referenced in [SuperMap/s3m-spec](https://github.com/SuperMap/s3m-spec) but no direct URLs. For test meshes, ContextCapture/ion **3D Tiles** samples are easier to get than raw OSGB/S3M.
