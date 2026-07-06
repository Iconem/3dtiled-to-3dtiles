---
title: "Converters"
description: "All viewer deps (Cesium, three, 3d-tiles-renderer, @sparkjsdev/spark, the 3DGS plugin) are npm"
---

### Running this repo day-to-day: two ports

```sh
pnpm install    # installs the whole workspace
pnpm dev        # http://localhost:3000  (3D Tiled — the React app, + /vanilla-viewer + /docs folded in)
                # http://localhost:3001  (tile-server middleware — the only other port you need)
```

`pnpm dev` runs `apps/viewer`'s own Vite dev server (`dev:viewer`) alongside the tile-server
(`serve:tiles`) and the Fumadocs site's own Next dev server (`dev:docs`, port 3002 — that process still
runs, it's just no longer something you navigate to directly: `apps/viewer`'s Vite config proxies
`/docs` and its asset/API routes through to it). `apps/viewer`'s own build also folds in the legacy
standalone `vanilla-viewer.html` (below) as a second page at `/vanilla-viewer`, so it ships in the same
`dist/` and needs no separate server either. See [3D Tiled](#3d-tiled-standalone-react-viewer-appsviewer-shadcnui-r3f-one-push-wip-first-pass)
below for the app itself.

### `vanilla-viewer.html` — offline, self-contained via Vite, no React/build tooling needed

The **original**, pre-React reference viewer — kept as a from-scratch fallback that needs nothing but
Vite (no Node backend beyond the tile-server, no component framework). All its deps (Cesium, three,
3d-tiles-renderer, @sparkjsdev/spark, the 3DGS plugin) are **npm dependencies bundled by Vite — no CDN,
works fully offline**. Served at `/vanilla-viewer` by `apps/viewer`'s own dev server/build (above) — the
repo-root copy of the same file (`viewer.html`) also still runs completely standalone via a separate,
untouched legacy path if you want zero dependency on `apps/viewer` even existing:

```sh
pnpm run dev:legacy    # vite dev server → http://localhost:3000/ (redirects to viewer.html; serves sample-data/)
# pnpm run build:legacy  # static offline bundle in dist/
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

### 3D Tiled — standalone React viewer (`apps/viewer`), shadcn/ui, R3F, one push, WIP first pass

A ground-up port of `viewer.html` into a real React app, named **3D Tiled** — the repo-root `viewer.html`
stays as-is, unaffected; this app carries its own copy (`vanilla-viewer.html`, served at `/vanilla-viewer`)
instead of depending on the legacy path. `pnpm --filter 3d-tiled dev` → `http://localhost:3000` — this
IS `pnpm dev` now (added to `.claude/launch.json` as `"viewer"`, `dev:viewer` root script; see "Running
this repo day-to-day" above). Stack: Vite + React 19 + TypeScript +
Tailwind v4, shadcn/ui (hand-vendored `src/components/ui/*`, default dark theme, not a port of
viewer.html's own hand-tuned palette), **nuqs** for the shareable URL-param slice (format/mode/cache/
prefetch/transform/tiling/renderer/preset — the address bar is a bookmarkable link to a given view;
the fully-resolved tileset URL itself deliberately stays out of it, see `state/urlState.ts`'s comment
for why), **Zustand** for everything else (crop bbox, camera-derived readouts, status/timing log).

- **CesiumJS side** (`components/Viewport/CesiumViewer.tsx`): plain imperative `Cesium.Viewer` in a
  `useEffect`, functionally identical to viewer.html's `initCesium()`. Resium was tried first per the
  original plan; dropped in favor of this — see the file's own comment.
- **3DTRJS side** (`components/Viewport/ThreeDTRjsViewer.tsx`): uses `3d-tiles-renderer`'s **official
  `/r3f` export** (`<TilesRenderer>`, `<TilesPlugin>`, `<GlobeControls>`, `<EnvironmentControls>`,
  `<CameraTransition>`) instead of hand-rolled three.js — a real capability of the upstream package,
  not previously used anywhere in this repo. `GaussianSplatPlugin` registers only for splat assets.
  drei's `<TransformControls>` on a box mesh is the crop-box gizmo (first pass: translate mode,
  approximate — see the file's `CropGizmo` comment). No imagery overlay on the background globe yet
  (a plain wireframe sphere placeholder) and no auto-fly-to-loaded-content — both documented gaps.
- Both renderers stay mounted (CSS-hidden, not unmounted) when you switch the RENDERER pill — matches
  viewer.html's `#cesium-container`/`#three-container` behavior — and the last-loaded tileset URL
  replays into whichever one you switch to (`App.tsx`'s `url.renderer` effect).

**Real bugs found and fixed while building this** (all upstream/tooling issues, not React-port
artifacts — kept here since they'd bite anyone doing the equivalent Vite+Cesium+pnpm-monorepo setup):
- `vite-plugin-cesium`'s default `cesiumBuildRootPath` is the **relative** path
  `node_modules/cesium/Build`, resolved against the dev server's cwd. Works for the root app (cesium
  is right there) but not a nested `apps/*` package under pnpm's hoisting (cesium lives in the
  **monorepo root**'s `node_modules`, not `apps/viewer/node_modules`) — every Cesium static asset
  (`Widgets/widgets.css`, the skybox JPGs, `approximateTerrainHeights.json`, …) 404'd. Worse: Vite's
  default SPA fallback served `index.html` (200, `text/html`) instead of a real 404, and Cesium's
  WebGL texture pipeline tried to decode that HTML as an image — crashing the **entire render loop**
  with an opaque `InvalidStateError: the source image could not be decoded`, not a per-asset failure.
  Fixed by pointing the plugin at cesium's actual resolved location (`vite.config.ts`) and adding
  `appType: 'mpa'` (same fix the root app's `vite.config.mjs` already documents for a related
  tile-server gotcha) so a real 404 surfaces instead of being masked.
- The raw `mt1.google.com` "Google Hybrid" tile hotlink used as the default basemap sometimes answers
  with an HTML error page instead of image bytes, hitting the exact same Cesium crash independently —
  default basemap changed to OSM (a properly public tile service); Google stays selectable.
- TopBar's mount effect only auto-loaded a preset when the URL had **none** selected — meaning a
  reloaded/shared link (which always has `?preset=…` from the previous session) silently never
  fired the actual tileset load, since the resolved URL is deliberately not persisted (see above).

**Not yet done** (first-pass, tracked as follow-up, not attempted to fully match viewer.html feature-
for-feature in one pass): 3DTRJS auto-fly-to-content on load, 3DTRJS basemap imagery overlay, Ion
asset loading on the 3DTRJS side, Cesium `shadeless`/brightness shading ported but not yet re-verified
against baked-lighting photogrammetry content, crop-gizmo precision (approximate ENU conversion, no
face-handle resize yet — translate only).

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
normals stay in the source frame, and Draco/attributes are gated out. **JPEG/PNG base-color
textures ARE embedded** (2026-07-02) when the layer offers a raster format; DDS/KTX2/Basis-only
textures have no decoder here and are gated the same way Draco is (geometry still renders,
untextured). **LEPCC-compressed PointCloud positions now decode** too (2026-07-06,
`i3sParse.js`'s `decodeDefaultGeometry` — shared with the live `i3s-live.js` adapter, which is what's
actually been run against real LEPCC data; this offline CLI hasn't separately been exercised on a
LEPCC dataset yet, so treat it as wired-but-unverified through this specific code path).

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
| Uncompressed `DefaultGeometrySchema` (PerAttributeArray) | Per-feature attributes (dropped); non-WGS84 vertical CRS |
| **LEPCC**-compressed point-cloud positions (decoded — shared w/ live adapter) | RGB/Intensity LEPCC blob types (position-only decoder) |
| OBB → 3D Tiles `box`; node tree → REPLACE tileset | |
| **JPEG/PNG base-color textures** (embedded, per-node) | DDS/KTX2/Basis-encoded textures (no decoder — gated, geometry-only) |

**Investigation notes** (answering "is it complex? meshes/points/instances/mix? implicit?"):
I3S **does** cover meshes (`IntegratedMesh`, `3DObject`), point clouds (`PointCloud`), and
symbol/model **instances** (`Point` layers); a **Building Scene Layer** is the "mix" — a composite of
sublayers. Tiling is **always explicit** (a node tree addressed via paged indices); I3S has **no
implicit/template scheme** like 3D Tiles subtrees, so the user's "explicit tiling only" constraint is
automatic. The node-tree → tileset mapping is **direct** (OBB↔box, children↔children, REPLACE). The
genuinely hard remaining part — and why this stays a draft — is **Draco** geometry compression (no
decoder; LEPCC point-cloud positions and raster **textures** are now both handled, see above),
**per-feature attributes** (→ `EXT_mesh_features`/metadata), and the **CRS/ECEF vertex placement**
nuances. A mesh-or-points-only,
uncompressed, explicit-tree converter (this draft) is **moderate**; full-fidelity I3S is **high** effort
and overlaps mature tools (loaders.gl, Cesium ion).

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
- Integrated mesh (**works, fully textured**) — SLPK: [item `95a427c7a6ec4789b03c1a177366b54c`](https://3dcities.maps.arcgis.com/home/item.html?id=95a427c7a6ec4789b03c1a177366b54c) (`Rancho_Mesh_v18.slpk`, 285 MB) · service: [item `01eff699c8404a27a65e0877201136b4`](https://3dcities.maps.arcgis.com/home/item.html?id=01eff699c8404a27a65e0877201136b4) → `https://tiles.arcgis.com/tiles/z2tnIkrLQ2BRzr6P/arcgis/rest/services/Rancho_Mesh_v18/SceneServer`. The SLPK link is ArcGIS Online's own download endpoint (`.../content/items/<id>/data`) — no `.slpk` anywhere in the URL (only in a `Content-Disposition` header), which the adapter didn't originally detect as an archive at all; both this and the texture support (see the scope table above) were fixed 2026-07-02, verified byte-identical (same JPEG at the same buffer offset) against both the SLPK and the SceneServer URL for the same underlying dataset.
- Point cloud (**LEPCC-compressed — now decoded, both work**) — SLPK: [item `496552d059644b4892c51ad06bdba8e2`](https://www.arcgis.com/home/item.html?id=496552d059644b4892c51ad06bdba8e2) (`Moro_Bay_LiDAR.slpk`, 578 MB, 2,624 tiles) · service: [item `908d6b986f314d51b1ff50b3bc321dfd`](https://www.arcgis.com/home/item.html?id=908d6b986f314d51b1ff50b3bc321dfd) → `https://tiles.arcgis.com/tiles/z2tnIkrLQ2BRzr6P/arcgis/rest/services/Moro_Bay_LiDAR/SceneServer` (13,775 tiles). Position decodes correctly (checksum + extent-verified); RGB doesn't render yet — it's a separate LEPCC blob type not yet ported, and this specific dataset's `RGB` attribute resource 404s server-side anyway despite being advertised in its schema. A second point-cloud sample (item `fc3f4a4919394808830cd11df4631a54`, `BARNEGAT_BAY_LiDAR_UTM`) is also LEPCC — every real ArcGIS point-cloud SceneServer sample found so far uses it, since it's Esri's own default point-cloud codec.
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

---

## Offline tilers — building tiled hierarchies (point clouds, splats, meshes)

Reference catalogue of **offline** tilers that produce the tiled inputs this project converts to (or
serves as) OGC 3D Tiles. The converters above consume the *outputs* of these tools (COPC, Potree,
streamed-SOG, RAD, I3S); this section records how those inputs are produced.

### Point-cloud tilers

#### Potree (PotreeConverter)

Intensity must be `0–65535` and named `Intensity` in the LAS (e.g. CloudCompare LAS 1.2 v2 export).

```bash
# Standard: projection as UTM string
PotreeConverter.exe pointcloud.las -o cloud_Potree -p index --projection "+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs "
# Set spacing
PotreeConverter.exe scan.las -p index -o out --scale 0.0001 --overwrite
# Include normals (from ascii or ply)
PotreeConverter.exe ptc.xyz -f xyzrgbXYZ -a RGB NORMAL -o out -p index --overwrite
PotreeConverter.exe ptc.ply -a RGB NORMAL -o out -p index
# Include Intensity in output attributes
PotreeConverter.exe cloud.las --output-attributes RGB INTENSITY --intensity-range 0 65536 --material INTENSITY --overwrite -p cloud -o out
```

Tip: store any per-point scalar field (e.g. a CloudCompare C2C distance) in the LAS `Intensity` field
(2-byte int, 65536 values) to display it in Potree's intensity mode. Rename the scalar field to
`Intensity` before LAS export. (Older CloudCompare LAS 1.4 export had a [min/max-xyz=0 header bug](https://github.com/CloudCompare/CloudCompare/issues/1845) — use CC 2.13+.)

#### Building OGC/Cesium 3D Tiles from point clouds

- **[py3dtiles](https://py3dtiles.org/v7.0.0/cli.html#convert)** ([repo](https://gitlab.com/py3dtiles/py3dtiles/)) — `py3dtiles convert cloud.las --out /tmp/dst`; supports tileset `merge`; [docker images](https://hub.docker.com/r/py3dtiles/py3dtiles); mesh tiling planned ([v7 notes](https://oslandia.com/en/2024/03/25/py3dtiles-v7-0-0-est-de-sortie-des-fonctionnalites-et-une-communaute-qui-se-developpe/)).
- **[gocesiumtiler](https://github.com/mfbonfigli/gocesiumtiler)** — fast Go LAS → 3D Tiles (1.0/1.1).
  ```bash
  gocesiumtiler-win-x64.exe file -out ./out-1.1 -version 1.1 pointcloud.1.4.las
  gocesiumtiler-win-x64.exe file -version 1.1 -o Exports/$m -e EPSG:32648 --resolution 1 --subsample 1 $m.las
  ```
- **[potree23dtiles](https://github.com/yeyan00/potree23dtiles)** — Potree → 3D Tiles.
- **[ept-tools](https://github.com/connormanning/ept-tools)** — LAS → EPT → 3D Tiles.
- **[Gaia3D/mago-3d-tiler](https://github.com/Gaia3D/mago-3d-tiler)** — point clouds + meshes → 3D Tiles.
- Terrain: **[Gaia3D/mago-3d-terrainer](https://github.com/Gaia3D/mago-3d-terrainer)** or [cesium-terrain-builder-docker](https://github.com/tum-gis/cesium-terrain-builder-docker) (quantized-mesh from GeoTIFF).
- Older (reference only): [entium](https://github.com/commaai/entium), [cesium.entwine.io](https://github.com/connormanning/cesium.entwine.io), [mattshax/cesium_pnt_generator](https://github.com/mattshax/cesium_pnt_generator), [tum-gis/cesium-point-cloud-generator](https://github.com/tum-gis/cesium-point-cloud-generator).

#### Building COPC via PDAL

[COPC](https://copc.io/) (Cloud-Optimized Point Cloud) replaces EPT; produced/consumed by
[PDAL](https://pdal.io/), [pdal-wrench](https://github.com/PDAL/wrench), [untwine](https://github.com/hobuinc/untwine).
This repo streams COPC directly (`/stream?format=copc`).

```json
[ "input.las", { "type": "writers.copc", "filename": "output.copc.laz" } ]
```

#### Pipelines / dashboards

- **[geosolutions-it/digital-twin-toolbox](https://github.com/geosolutions-it/digital-twin-toolbox)** — self-hosted point-cloud / shapefile 3D-tiling pipeline dashboard aggregating several tools.

### Gaussian-splat tilers (→ LoD trees of splats)

| Tool | Output | Notes |
|------|--------|-------|
| **PlayCanvas [splat-transform](https://github.com/playcanvas/splat-transform)** (SuperSplat) | **streamed-SOG** (`lod-meta.json` + per-chunk WebP) | Binary spatial tree (AABB split), per-leaf LOD runs. Consumed by `sog-to-3dtiles` / `/stream?format=sog`. |
| **World Labs [SparkJS](https://sparkjs.dev/docs/lod-getting-started/) `build-lod`** (BhattLod) | **`.RAD`** LoD merge tree | Variable fanout (~1.5–1.75), downsampled merged representative splats per node. Consumed by `rad-to-3dtiles` / `/stream?format=rad`. Blog: [Spark 2.0 — spatially partitioned LoD](https://www.worldlabs.ai/blog/spark-2.0). |
| **[William Liu — 3DGS-PLY-3DTiles-Converter](https://github.com/WilliamLiu-1997/3DTilesRendererJS-3DGS-Plugin)** | 3D Tiles of glb splats | PLY → 3D Tiles directly (the geometric-error model our RAD tileset builder mirrors). |

> **LCC** (XGRIDS Lixel CyberColor) is intentionally **not** listed here: there is no open-source
> *tiler* that produces `.lcc` — the format is generated by XGRIDS' proprietary Lixel software/devices.
> Only the [whitepaper spec](https://github.com/xgrids/LCCWhitepaper) and a reader
> ([LCC-Web-SDK](https://github.com/xgrids/LCC-Web-SDK)) are public. This repo *reads* `.lcc`
> (`lcc-to-3dtiles` / `/stream?format=lcc`); see [`lcc-format.md`](/docs/references/lcc-format).

### Why is PotreeConverter 2.0 so fast?

PotreeConverter 2.0 ([repo](https://github.com/potree/PotreeConverter)) is largely **I/O- and
counting-bound, not GPU-bound** — it runs on the CPU. Its speed comes from a **3-pass,
counting-sort-style** build that avoids per-point tree descent:

1. **Counting pass** — stream all points once, compute a fine regular grid (Morton/octant index from
   quantized coordinates), and **histogram** how many points fall in each cell. A flat-array increment
   per point — cache-friendly, trivially parallel over chunks.
2. **Allocate** — from the counts, decide the octree node layout up front (which cells become nodes,
   their byte offsets in the output) so there is no dynamic tree growth during the heavy pass.
3. **Distribution pass** — stream the points again and **scatter** each into its node's pre-allocated
   slot by its precomputed Morton index. Nodes over a target point budget **spill** the excess down to
   children; coarse levels keep a Poisson-disk / subsample so every level is renderable.

The wins vs. insert-one-point-at-a-time octrees: two **linear streaming passes** with sequential disk
reads (no random tree-walk per point); **Morton-code bucketing** turns spatial placement into integer
math; **batch parallelism** over fixed chunks with a final merge; the layout is known before writing,
so output is one large sequential write. It's a **radix/counting sort on Morton codes**, not a
comparison tree build — hence near-linear scaling that saturates disk bandwidth.

#### Could a GPU make it faster? (and the RAM→VRAM question)

For the *binning/sort* math, yes — GPUs do Morton-code radix sorts extremely well (this is exactly
what GPU point/particle sorters and GPU BVH builders do). But for a **whole-dataset out-of-core tiler**
(billions of points that don't fit in RAM, let alone VRAM), the bottleneck is **not** the arithmetic —
it's **moving bytes**: disk → RAM → (PCIe) → VRAM → back. So:

- **PCIe transfer dominates.** A 10 B-point cloud at ~16 B/point ≈ 160 GB. You can't hold it in VRAM
  (24–80 GB), so you'd stream chunks host→device, sort/bin on GPU, read back, and merge — the PCIe
  round-trips (tens of GB/s) plus disk (a few GB/s NVMe) set the wall-clock. The GPU sort finishes long
  before the next chunk arrives → you're **transfer-bound**, and the GPU mostly idles.
- **Where GPU genuinely helps:** when the working set *does* fit in VRAM (≤ a few hundred M points), or
  for the **per-chunk** sort/bin/decimate kernels inside an otherwise CPU-orchestrated out-of-core
  pipeline (overlap copy with compute via double-buffering + CUDA streams). Then the GPU radix sort +
  Poisson-disk subsample per chunk can beat the CPU by a wide margin.
- **Net:** for 10 B points, a GPU won't give a 10× end-to-end win because RAM↔VRAM + disk dominate; it
  can still help the per-chunk hot loops if you keep data resident and hide transfers. The biggest
  lever remains **fast sequential I/O + counting sort + chunk parallelism** — exactly Potree 2.0's design.

#### Is COPC building the same as Potree 2.0? (corrected — they are NOT equally fast)

I over-simplified earlier. The right framing: the **output container** differs (COPC = one indexed LAZ
with an EPT-style octree + hierarchy page; Potree = a directory of node files), but more importantly the
**implementations differ enormously in speed**, and "PDAL builds COPC" hides which engine does it:

- **PotreeConverter 2.0** is a *purpose-built, heavily-parallel* out-of-core tiler (the counting-sort /
  Morton-histogram + pre-allocate + scatter-with-spill described above). It's about the fastest thing
  there is for LAS/LAZ → octree, and saturates disk bandwidth.
- **PDAL `writers.copc`** is part of PDAL's general **pipeline** engine. It is *not* the same optimized
  out-of-core counting-sort builder — it's a more general, less parallel writer, and in practice users
  report it is **much slower** than PotreeConverter 2.0 (matching your experience). PDAL's strength is
  generality (filters, reprojection, formats), not raw octree-build throughput.
- **untwine** (hobuinc) is the **fast, dedicated COPC builder** — a two-phase "bin points into temp
  files per cell, then assemble" out-of-core approach, multi-threaded, designed to bound memory on huge
  clouds. If you want fast COPC, reach for `untwine` (PDAL can shell out to it), not `writers.copc`.
- **entwine** (connormanning) builds EPT (not COPC) with a similar out-of-core spatial-binning design;
  mature and reasonably fast, but EPT is a directory of many files rather than one COPC LAZ.

So: the *algorithm family* (spatial bin → chunked write) is shared, but **only some implementations are
counting-sort-fast**. PotreeConverter 2.0 and untwine are in that tier; `pdal writers.copc` is not.

> ⚠️ The notes below on `py3dtiles` / `gocesiumtiler` / `mago-3d-tiler` are **best-effort from
> general knowledge, not benchmarked here** — treat as hypotheses to verify:
> - **py3dtiles** (Python) — convenient, supports tileset merge & docker; Python + multiprocessing
>   makes it generally **slower** than the C++/Go tilers on very large clouds (GIL/serialization
>   overhead), though fine for moderate sizes.
> - **gocesiumtiler** (Go) — concurrent (goroutines), typically **fast** and a good middle ground;
>   compiled, parallel, simple LAS→3D Tiles. Often the pragmatic fast choice for 3D Tiles output.
> - **mago-3d-tiler** (Java) — broad input support (point clouds + meshes); JVM, multi-threaded;
>   performance is decent but I have **no measured comparison** vs PotreeConverter 2.0.
>
> Bottom line you can rely on: for raw octree-build speed, **PotreeConverter 2.0** (Potree output) and
> **untwine** (COPC output) are the proven-fast tier; `pdal writers.copc` is the slow one you hit.

#### Toward an out-of-core LAS/LAZ → 3D Tiles / COPC / Potree tiler (note)

A future fast tiler in this repo would reuse exactly this methodology: (1) stream LAS/LAZ once to
histogram a Morton grid; (2) pre-allocate the octree layout + per-node byte offsets; (3) stream again,
scatter to per-node temp buffers, spill over-quota points to children, Poisson-subsample coarse levels;
(4) emit COPC (one indexed LAZ), Potree (node files), or 3D Tiles (pnts/glb) from the same in-memory
node table. Bound memory with per-cell temp files (untwine-style) for clouds larger than RAM; optionally
offload the per-chunk sort/decimate to the GPU when the chunk fits in VRAM.
