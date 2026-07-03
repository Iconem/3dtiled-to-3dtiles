---
title: "Converters"
description: "All viewer deps (Cesium, three, 3d-tiles-renderer, @sparkjsdev/spark, the 3DGS plugin) are npm"
---

### Viewer (`viewer.html`) — offline, self-contained via Vite

All viewer deps (Cesium, three, 3d-tiles-renderer, @sparkjsdev/spark, the 3DGS plugin) are **npm
dependencies bundled by Vite — no CDN, works fully offline**:

```sh
pnpm install         # (or npm install) — installs cesium/three/3d-tiles-renderer/spark/vite
pnpm run dev         # vite dev server → http://localhost:3000/ (redirects to viewer.html; serves sample-data/)
# pnpm run build     # static offline bundle in dist/
```

pnpm uses `pnpm-workspace.yaml` + `.npmrc` (`node-linker=hoisted`, so the meta-converter's
`import('rad-to-3dtiles')` resolves like npm's flat layout); npm uses the `workspaces` field. Either works.

`vite-plugin-cesium` copies Cesium's Workers/Assets/Widgets and sets `CESIUM_BASE_URL`; `three` is
de-duplicated (`resolve.dedupe`) so SparkJS + the 3DGS plugin share one instance (replacing the old
esm.sh `?external=three` trick). Verified: **0 CDN requests** — Cesium, the 3DTRJS globe, and Gaussian
splat streaming all load from `node_modules`. The dev server serves `sample-data/output/**` too, so the
built-in presets (which point at `http://localhost:3000/sample-data/...`) resolve against the same origin.

Additional online viewers:
- **COPC**: [viewer.copc.io](https://viewer.copc.io), [lidar-viewer.gishub.org](https://lidar-viewer.gishub.org)
- **3D Tiles**: CesiumJS sandbox, [3D-Tiles-RendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS)

`viewer.html` includes a **3DTilesRendererJS mode** (toggle the `3DTRJS` button) backed by Three.js.
For Gaussian splat streaming, it uses [3D-Tiles-RendererJS-3DGS-Plugin](https://github.com/WilliamLiu-1997/3D-Tiles-RendererJS-3DGS-Plugin)
which streams `.rad`/SPZ content via `@sparkjsdev/spark`:

```sh
npm install 3d-tiles-rendererjs-3dgs-plugin three 3d-tiles-renderer @sparkjsdev/spark
```

```js
import { TilesRenderer } from '3d-tiles-renderer';
import { GaussianSplatPlugin } from '3d-tiles-rendererjs-3dgs-plugin';

const tiles = new TilesRenderer('http://localhost:3000/tileset.json');
tiles.registerPlugin(new GaussianSplatPlugin({
  renderer, scene,
  minRaycastOpacity: 0.1,
  sparkRendererOptions: { focalAdjustment: 2 },
}));
scene.add(tiles.group);
```

> The viewer bundles this plugin (and SparkJS) as local npm deps via Vite — shared `three@0.180`
> through `resolve.dedupe`, no CDN. `npm run dev` serves it offline.

`viewer.html` consolidates all controls into a right **sidebar** (Renderer · Basemap · Tileset &
LoD · Navigation · Local frame · Ion · Snippet), including a **Max SSE (px)** input that drives
CesiumJS `maximumScreenSpaceError` and 3DTRJS `errorTarget`, and a **🪲 Debug tiles** toggle that
draws bounding volumes coloured by octree depth in both renderers. The preset bar includes the
**◈ GSplat 1/2** reference splat tilesets from the
[3DTilesRendererJS-3DGS-Plugin](https://github.com/WilliamLiu-1997/3DTilesRendererJS-3DGS-Plugin)
demo data (PLY→3D Tiles). For deeper tileset inspection (tree, bounds, per-tile stats) alongside
this viewer, see [3DTiles-Inspector](https://github.com/WilliamLiu-1997/3DTiles-Inspector).

---

### copc-to-3dtiles

Converts COPC `.copc.laz` LiDAR files to 3D Tiles 1.1 with implicit octree tiling.

```sh
cd packages/copc-to-3dtiles
npm install
node src/index.js input.copc.laz ./out-copc
```

**Output:**
```
out-copc/
  tileset.json
  tiles/<level>/<x>/<y>/<z>.glb       POINTS, tile-local coords
  subtrees/<level>/<x>/<y>/<z>.subtree binary subtree files
```

**Design:**
- Implicit octree (`subdivisionScheme: "OCTREE"`) — COPC hierarchy maps directly, no re-tiling
- Subtree binary format (3D Tiles 1.1 §7.3): 24-byte header, Morton Z-order bitstreams, bufferView indices
- Refine: `ADD` — each level independently contributes points
- CRS handling: see note below

**On CRS and proj4:**
COPC files may carry a WKT CRS in their VLRs. Currently `georef.js` uses proj4 to convert the
dataset origin to WGS84 lon/lat, then builds an ENU→ECEF (EPSG:4978) root transform — which is
what most 3D Tiles viewers (CesiumJS) expect.

However, **3D Tiles 1.1 does not mandate ECEF**. The spec allows any CRS expressed via a
`transform` matrix and optional metadata. If the COPC's native CRS is known and the viewer
supports it, proj4 could be skipped entirely by passing the raw COPC transform hierarchy
root-to-leaf verbatim. Viewers like opengeos' lidar-viewer likely position COPC files correctly
by reading their internal spatial metadata directly rather than relying on the 3D Tiles CRS.
This is worth exploring to simplify the pipeline and eliminate the proj4 dependency for
native-CRS outputs.

---

### rad-to-3dtiles

Converts SparkJS `.RAD` Gaussian Splat LoD files to 3D Tiles 1.1 with `KHR_gaussian_splatting` GLB tiles.

```sh
cd packages/rad-to-3dtiles
npm install
# Always inspect first:
node scripts/dump-rad-header.js coit.rad
# Convert (defaults: --scale=1, --ge-scale=1, --ge-layer=1):
node src/index.js coit.rad ./out-rad
# Noise filtering (OPT-IN, default OFF — SparkJS renders the RAD with no filtering, so we don't either):
#   --opacity-filter=0.05   drop faint splats (final opacity < N)
#   --max-scale-mult=30     drop giant "floating noise" splats (maxScale > per-chunk median×N)
node src/index.js coit.rad ./out-rad --opacity-filter=0.05 --max-scale-mult=30  # only for data with known noise
# Tune splat size and LoD (rarely needed — raw values match the reference):
node src/index.js coit.rad ./out-rad --scale=2         # σ×2 (larger splats)
node src/index.js coit.rad ./out-rad --ge-scale=2      # GE×2 (refine at greater distance)
node src/index.js coit.rad ./out-rad --ge-layer=2      # widen depth range
```

**Output:**
```
out-rad/
  tileset.json              explicit tiling, one tile per RAD chunk
  tiles/node_<index>.glb    KHR_gaussian_splatting GLB (POINTS)
```

> **Note:** `rad-to-3dtiles` and `copc-to-3dtiles` used to list a package-name-typo'd
> `@cesium/3d-tiles-tools` (no such npm package — 404; the real one is plain
> [`3d-tiles-tools`](https://github.com/CesiumGS/3d-tiles-tools)) as an optional dependency that was
> never wired to any CLI flag and never actually installable — removed 2026-07-02 (it was silently
> breaking `pnpm install --frozen-lockfile`, since pnpm can't reconcile an unresolvable optional dep
> against the lockfile). For `.3tz`/`.3dtiles` today, convert to a plain tileset dir then use the
> in-repo packer (`scripts/pack-3dtiles.mjs`) or `npx 3d-tiles-tools convert`, both documented under
> `/3dtiles-self-contained` below.

**Live `/stream` (no pre-conversion)** — `packages/tile-server/rad-live.js`, served at
`GET /stream/tileset.json?url=<.rad>&format=rad`:

- **tileset.json** — fetch the `.rad` once (cached in memory), build the node table, and decode
  **only the `center` column** per chunk for bounds — no SPZ encode, no gzip. Reuses the shared
  `buildTileset`. This is the cheap pass that makes the first paint fast.
- **tile/`<i>`.glb** — full-decode + SPZ-v2 encode that **one** chunk on demand (~200 ms / 65k-splat
  chunk), via the shared `encodeChunkGlb`.

This defers the expensive per-tile decode+encode+gzip (which `/convert` runs for the *whole* dataset
up front) to on-demand, so tiles stream as the camera requests them. Only **monolithic** `.rad` files
stream (a streaming-manifest `.rad` has no embedded chunk data); `/convert` produces identical tiles.

---

### sog-to-3dtiles

Converts a PlayCanvas **[Streamed SOG](/docs/references/streamed-sog)** dataset (`lod-meta.json`
+ per-chunk unbundled [SOG](/docs/references/sog) dirs) to 3D Tiles 1.1 with the same
`KHR_gaussian_splatting` + `_compression_spz_2` GLB tiles as the RAD path.

> **Arrival.Space `.lod` uses this same streamed-SOG format.** An Arrival entity's `lodParameter.glbUrl`
> points at a `…_LOD/lod-meta.json` whose tree + per-chunk `version:2` webp splats (`means_l/u`, `quats`,
> `scales`, `sh0`, `shN_*`, generated by `splat-transform`) are byte-shape-identical to PlayCanvas
> streamed-SOG — so the **SOG adapter/converter reads Arrival `.lod` directly**; no Arrival-specific code.
> Verified live against `ugc.arrival.space`. (Arrival's per-entity `rotation`/`scale`/`position` from its
> own API are a separate placement layer, not part of the `.lod` payload.)
>
> **Not georeferenced** (checked 2026-07-02): `lod-meta.json` and every per-chunk `meta.json` carry only
> local tree bounds — no lon/lat/EPSG anywhere in the `.lod` payload itself, so `sog-live.js`'s root
> transform is a fixed local upright-correction (`RX(−90°)`), same as any other non-georeferenced SOG
> source. Real-world placement for an Arrival scene would need to fetch its **entity API** separately
> (the `rotation`/`scale`/`position` mentioned above) and compose that into the root transform —
> untried, Arrival-specific, not implemented here.

```sh
cd packages/sog-to-3dtiles
npm install                                  # pulls @playcanvas/splat-transform
node src/index.js path/to/scene/ ./out-sog   # dir containing lod-meta.json, or the json itself
```

**How it works:** the streamed-SOG binary spatial tree maps almost 1:1 onto a 3D Tiles HLOD
tree — interior nodes become empty grouping tiles, and each leaf becomes a `REPLACE` chain of
tiles from coarsest LOD level down to level 0 (finest). Bounds are emitted in the Z-up tileset
frame (`RX+90°`), matching the RAD path.

**The per-chunk pipeline (intermediate format):**
1. [`@playcanvas/splat-transform`](https://github.com/playcanvas/splat-transform)'s `readSog`
   decodes each SOG chunk's WebP textures (CPU `webp.wasm` — **no GPU**) into a **`DataTable`** —
   that's the intermediate per-chunk format. Columns: `x,y,z`, `rot_0..3` (quaternion, **w-first**),
   `scale_0..2` (**log**), `f_dc_0..2` (SH DC), `opacity` (**logit**).
2. For each leaf's `lods[level]` run, we slice `[offset, offset+count)` of that DataTable, convert
   conventions (`exp` scale, `sigmoid` opacity, `0.5 + SH_C0·f_dc` → color, quaternion reorder
   w-first → xyzw), and re-encode to an **SPZ-v2 GLB** with our own encoder (the same one
   `rad-to-3dtiles` uses).

That this path renders cleanly is itself proof the **SPZ-v2/GLB encoder and tree builder are
correct** — so when the RAD path looked wrong, the bug had to be in the *RAD decode*, not the
shared encoder. (It was: see [RAD column layouts](#rad-column-byte-layouts-the-spiky-render-bug).)

**Output:**
```
out-sog/
  tileset.json           HLOD tree mirroring the SOG spatial tree
  tiles/node_<n>.glb      one per LOD run; tiles/env.glb if the scene has an environment
```

> **Status:** validated end-to-end on PlayCanvas's `example_skatepark_02` & `example_roman_parish_02`
> (see Sample Data below). Decoded tiles contain real splats — varied positions, valid scales,
> unit quaternions, proper opacity — confirming the WebP CPU decode + decode conventions
> (quaternion `rot_0=w`, log scales, logit opacity, SH0→color). geometricError halves cleanly
> root→leaf (e.g. skatepark `17.8 → 8.9 → … → 0.0`). Bundled `.sog` environments are skipped
> (best-effort) since the spec's chunks are unbundled.

---

### lcc-to-3dtiles

Converts an XGRIDS **[LCC](/docs/references/lcc-format)** dataset (`meta.lcc` + `Index.bin` +
`Data.bin` [+ `Shcoef.bin`]) to 3D Tiles with the same `KHR_gaussian_splatting` + `_spz_2` GLB tiles.

```sh
cd packages/lcc-to-3dtiles
node src/index.js path/to/lcc-dir ./out-lcc     # dir containing meta.lcc (name can vary)
```

**How it works:** LCC organises splats as a **grid of Units** (one per partition cell, x/y packed in
the index) × `totalLevel` LODs (LOD0 = finest). Each Unit → a `REPLACE` chain of tiles
coarsest→finest under a single root. `Data.bin` is **uncompressed, fixed 32 B/splat** (the meta
`"encoding": "COMPRESS"` refers to field quantization, not stream compression — verified
`LODSize / PointsCount == 32`). The 32-byte layout is taken **directly from the official
[xgrids/LCC-Web-SDK](https://github.com/xgrids/LCC-Web-SDK) vertex shader** (the non-`LCC_COMPRESSED`
`decodeCov` path), not guessed: `0–11 pos f32×3 · 12–15 color rgba8 (a = opacity) ·
16–21 scale uint16×3 · 22–25 rot uint32 (10-10-10-2 smallest-three) · 26–27 semantic · 28–31 pad`.
**Scale = linear `mix(scale.min, scale.max, u/65535)`** (the SDK's `compressedScaleMin/Max` uniforms =
meta `attributes.scale.min/max`); rotation decode = the SDK's `QUAT_TAB`.

> ⚠️ **LCC partitions in X/Y only (a 2-D grid, not an octree).** `Index.bin` packs each Unit's cell as
> `x(low16)/y(high16)` with `cellLengthX/Y`; there is **no Z partition** — each Unit spans the full
> scene height, refined by LOD detail rather than by vertical tiling. For a **tall scan** (e.g. an
> XGRIDS L2 sweep of a tower) the live/stream tile boxes therefore use the cell's X/Y extent + the full
> scene Z, so vertical frustum culling is coarse (everything in a column shares one Z span). Not a bug —
> it's how LCC organizes data; tighter per-Unit Z would require decoding the splats.

**Validated:** `Guan_Temple` → 154 tiles, **11,424,293 splats (= `meta.totalSplats` exactly)**,
0 bad quaternions, scale p50 ≈ 3 cm (sane for a 325 m-diagonal temple). **SH (`Shcoef.bin`, Quality
files) not yet emitted** (DC only, like the other converters). LCC is XGRIDS' format — attribution
required per its White Paper (see the doc).

> **License note:** the LCC White Paper requires displaying "Data Organization Format originated
> from XGRIDS" and publishing derivatives under terms no less open. This converter reads the format;
> downstream products must carry that attribution.

---

### i3s-to-3dtiles  🟡 **DRAFT — mesh validated on real data**

Converts the **supported subset** of Esri **[I3S](/docs/references/i3s-spec)** (Indexed 3D Scene
Layer) → 3D Tiles 1.1. Validated on `Buildings_NewYork_v18.slpk` → **5882 glTF TRIANGLES tiles** that
place correctly in NYC: I3S geographic-layer vertices are `(Δlon°, Δlat°, Δheight_m)` relative to the
node OBB centre, converted per-vertex to ECEF (stored relative to the centre for float32 precision,
tile `transform` translates back). Still a draft: **projected/vertical CRS** placement is not handled,
normals stay in the source frame, and Draco/LEPCC/textures/attributes are gated out.

```sh
unzip your-layer.slpk -d your-layer/        # an SLPK is a plain zip
cd packages/i3s-to-3dtiles
node src/index.js ../your-layer ./out-i3s
```

**Scope (deliberately gated — warns/skips everything else):**

| Supported ✓ | Not supported ✗ (detected → warn/skip/exit) |
|---|---|
| Explicit `nodepages/*.json` trees | Legacy per-node `3dNodeIndexDocument` index (pre-1.7) |
| `IntegratedMesh` / `3DObject` → glTF **TRIANGLES** | **Draco**-compressed geometry (no decoder) |
| `PointCloud` → glTF **POINTS** | `Point` (symbol/instance) & `Building` (composite) layers |
| Uncompressed `DefaultGeometrySchema` (PerAttributeArray) | Textures / PBR materials (dropped — geometry only) |
| OBB → 3D Tiles `box`; node tree → REPLACE tileset | Per-feature attributes (dropped); non-WGS84 vertical CRS |

**Investigation notes** (answering "is it complex? meshes/points/instances/mix? implicit?"):
I3S **does** cover meshes (`IntegratedMesh`, `3DObject`), point clouds (`PointCloud`), and
symbol/model **instances** (`Point` layers); a **Building Scene Layer** is the "mix" — a composite of
sublayers. Tiling is **always explicit** (a node tree addressed via paged indices); I3S has **no
implicit/template scheme** like 3D Tiles subtrees, so the user's "explicit tiling only" constraint is
automatic. The node-tree → tileset mapping is **direct** (OBB↔box, children↔children, REPLACE). The
genuinely hard parts — and why this stays a draft — are **Draco** geometry, **textures/materials**,
**per-feature attributes** (→ `EXT_mesh_features`/metadata), and the **CRS/ECEF vertex placement**
nuances. A mesh-or-points-only, uncompressed, explicit-tree converter (this draft) is **moderate**;
full-fidelity I3S is **high** effort and overlaps mature tools (loaders.gl, Cesium ion).

> **ESRI also publishes Gaussian splats as 3D Tiles directly**, not through I3S: ArcGIS's
> **3D Tiles Server** hosts `KHR_gaussian_splatting`/SPZ GLB tilesets alongside its regular
> `IntegratedMesh` output (see the `esri-mantes`/`esri-portcoast` pills in `viewer.html`, and ESRI's
> [3D Tiles samples experience](https://experience.arcgis.com/experience/e2e1e497d13b41cab368c894fd9b3df7))
> — so "does ESRI do splats" is really two separate answers: **I3S itself** has no splat layer type
> (mesh/points/instances only, per above); ArcGIS's **3D Tiles Server** product does, as plain OGC
> 3D Tiles, sitting entirely outside I3S's own format.

**I3S open-data samples** (beyond `Buildings_NewYork_v18.slpk`, mesh-only) — SLPK + hosted-service
pairs for both integrated mesh and point-cloud layers, from Esri's own [`i3s-spec` sample data
readme](https://github.com/Esri/i3s-spec/blob/master/docs/2.1/pcsl_ReadMe.md), the [ArcGIS JS SDK
3D-object sample gallery](https://developers.arcgis.com/javascript/latest/sample-code/?tagged=3dobject),
and the [ArcGIS 3D Tiles samples experience](https://experience.arcgis.com/experience/e2e1e497d13b41cab368c894fd9b3df7)
(ArcGIS portal items — open each `item.html` link and use its "Download" button for the SLPK, or the
REST service URL directly for streaming). All four verified live against `/stream?format=i3s`:
- Integrated mesh (**works**) — SLPK: [item `95a427c7a6ec4789b03c1a177366b54c`](https://3dcities.maps.arcgis.com/home/item.html?id=95a427c7a6ec4789b03c1a177366b54c) (`Rancho_Mesh_v18.slpk`, 285 MB) · service: [item `01eff699c8404a27a65e0877201136b4`](https://3dcities.maps.arcgis.com/home/item.html?id=01eff699c8404a27a65e0877201136b4) → `https://tiles.arcgis.com/tiles/z2tnIkrLQ2BRzr6P/arcgis/rest/services/Rancho_Mesh_v18/SceneServer`
- Point cloud (**LEPCC-compressed — unsupported**, same gap as the Autzen sample) — SLPK: [item `496552d059644b4892c51ad06bdba8e2`](https://www.arcgis.com/home/item.html?id=496552d059644b4892c51ad06bdba8e2) (`Moro_Bay_LiDAR.slpk`, 578 MB) · service: [item `908d6b986f314d51b1ff50b3bc321dfd`](https://www.arcgis.com/home/item.html?id=908d6b986f314d51b1ff50b3bc321dfd) → `https://tiles.arcgis.com/tiles/z2tnIkrLQ2BRzr6P/arcgis/rest/services/Moro_Bay_LiDAR/SceneServer`. A second point-cloud sample (item `fc3f4a4919394808830cd11df4631a54`, `BARNEGAT_BAY_LiDAR_UTM`) is also LEPCC — every real ArcGIS point-cloud SceneServer sample found so far uses it, since it's Esri's own default point-cloud codec.
- **Live ArcGIS SceneServer REST support added** (2026-07-02) to test the "service" URLs above directly
  (previously the adapter only read a static `3dSceneLayer.json`/SLPK tree, not the REST API's
  `?f=json`-based resource paths) — see `arcgisSceneServerReader()` in `i3s-live.js`.
- Also referenced: portal item `fc3f4a4919394808830cd11df4631a54` (point cloud) and `001bb7ee3ce44ae5a8a15bef72f4404a` (integrated mesh) — not yet run against `i3s-to-3dtiles`/`/stream?format=i3s`, listed here as further samples to pull in.

> **Reference — bidirectional I3S ⇄ 3D Tiles converter:** loaders.gl's
> **[`@loaders.gl/tile-converter`](https://github.com/visgl/loaders.gl/tree/master/modules/tile-converter)**
> ([docs](https://loaders.gl/docs/modules/tile-converter/cli-reference/tile-converter)) converts
> **3D Tiles → I3S and I3S → 3D Tiles** (Draco, textures, attributes, gzip), and is the mature
> baseline this draft is measured against. Use it for full-fidelity I3S; `i3s-to-3dtiles` here stays a
> minimal, dependency-light subset (uncompressed, explicit tree, mesh/points only).

> **Reference — 3D Tiles ⇄ 3D Tiles tooling:** CesiumGS's
> **[`3d-tiles-tools`](https://github.com/CesiumGS/3d-tiles-tools)** is the canonical toolbox for
> tileset-level operations, several of which overlap our "3D Tiles → 3D Tiles" plans:
> - **`upgrade`** — legacy → 3D Tiles 1.0/1.1 (`asset.version`, `url`→`uri`, `refine` upper-case, glTF
>   1.0→2.0, and with `--targetVersion 1.1` converts PNTS/B3DM/I3DM/CMPT content to glTF; drops
>   `3DTILES_content_gltf`).
> - **`merge` / `mergeJson`** — combine tilesets as external tilesets (mergeJson writes only the
>   referencing JSON, using relative paths to the inputs).
> - **`b3dmToGlb` / `i3dmToGlb` / `cmptToGlb` / `convertB3dmToGlb` / `convertPntsToGlb` /
>   `convertI3dmToGlb` / `splitCmpt`** — extract or convert legacy tile content to glTF.
>
> Our [`3D Tiles → 3D Tiles`](#3d-tiles--3d-tiles-transcodes) transcodes are the live/streaming-flavored
> counterparts (implicit→explicit, legacy upgrade); use `3d-tiles-tools` for full offline pipelines.

---

### potree-to-3dtiles

Converts a **Potree** octree point cloud → 3D Tiles (glTF **POINTS** tiles). Auto-detects
**2.0** (`metadata.json` + `hierarchy.bin` + `octree.bin`) and **1.x** (`cloud.js` + `.hrc` +
per-node `.bin`).

```sh
cd packages/potree-to-3dtiles && npm install
node src/index.js path/to/potree-dir ./out-potree
```

**How it works:** the Potree octree (`r`, `r0`..`r7`, …) maps 1:1 to a 3D Tiles tree with
**`refine: ADD`** (children add denser detail in sub-octants, like COPC); `geometricError` = point
spacing per depth (`rootSpacing / 2^depth`). 2.0 decode is authoritative (`hierarchy.bin` 22 B/node:
`type u8, childMask u8, numPoints u32, byteOffset u64, byteSize u64`; positions `int32×3·scale+offset`;
DEFAULT + BROTLI via Node's `zlib`). Points are emitted relative to the dataset centre (float32-safe).

**Validated on real datasets** (2026-06-22):

| Sample | Potree | Result |
|--------|--------|--------|
| iTowns `lion` | 2.0 (**BROTLI**) | ✅ 1624 tiles / **3,954,696 pts = `metadata.points` exactly** (Morton-decoded position+rgb) |
| `lion_takanawa` | 1.x **v1.7** (`.hrc` + chunked `data/r/…`) | ✅ 167 tiles / 272,768 pts (per-node origin) |
| `vol_total` | 1.x **v1.4** (inline `hierarchy`, flat `data/<name>.bin`) | ✅ 42 tiles |
| `lion_takanawa_laz` | 1.x **v1.4 + LAZ** (`pointAttributes:"LAZ"`, flat `data/<name>.laz`) | ✅ 200 tiles — **tiled LAZ** octree (one .laz per node, laz-perf) |

> **Status:** 🟢 **operational for Potree 2.0 (DEFAULT + BROTLI) and 1.x (v1.7 `.hrc` + v1.4 inline),
> with `.bin` and tiled-`.laz` nodes.** 2.0 BROTLI positions/rgb are Morton-decoded; 1.x points are
> quantised per-node-origin; LAZ nodes are decoded with laz-perf (via `copc`). Output is **not
> geo-referenced** (local origin; add a root transform downstream). Samples in
> `sample-data/input/POTREE/`. Reference: [yeyan00/potree23dtiles](https://github.com/yeyan00/potree23dtiles) + Potree `DecoderWorker_brotli.js`.

**Implicit vs explicit tiling — available on all four surfaces:**

| Surface | Default | Option |
|---------|---------|--------|
| Dedicated CLI (`node src/index.js … --tiling=explicit`) | implicit | `--tiling=explicit` |
| Meta CLI (`node packages/convert/cli.js … --tiling=explicit`) | implicit | `--tiling=explicit` |
| `/convert` middleware | implicit | `&tiling=explicit` |
| `/stream` middleware | implicit | `&tiling=explicit` |

Both COPC and Potree are octree hierarchies, so **implicit** is the natural default (smaller
tileset JSON, subtrees served on demand). Pass `explicit` only when the client doesn't support
3D Tiles 1.1 implicit tiling (e.g. legacy CesiumJS < 1.96 or simple tile fetchers).
