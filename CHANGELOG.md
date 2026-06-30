# Changelog

All notable changes to **3dtiled-to-3dtiles** are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added — 2026-06-30 (`stream-cache` cont.: splat per-splat clip + PDAL via pixi + PivotControls)
- **`/dump/splat` per-splat clip** finished and **default ON** (`&clip=0` to disable): drops individual
  splats whose centroid falls outside the box. The earlier version under-clipped because it ignored the
  splat GLB's **node matrix**; SPZ positions are node-local, so they're now placed in ECEF via the same
  chain meshes use — `M = worldM · YUP_ZUP · nodeM` (nodeM = Rx180 spz→glTF axis fix + per-tile
  translation). Verified: SPZ centroids land inside their tile box only with this matrix (82.8% vs 0%);
  a georeferenced E2E run keeps 100% under a wide bbox, a central 60.9% under a tight one. New
  `X-Dump-Splats-Raw` / `X-Dump-Clipped` headers + a viewer "clip splats outside box" checkbox.
- **PDAL for `/dump/copc` via pixi** (not conda): `pixi global install pdal` (2.10.2) → `~/.pixi/bin/pdal`.
  The server resolves it as `$PDAL_BIN` → pixi-global shim → `pdal` on PATH. pixi is the right installer —
  PDAL is a conda-forge native binary, not a pip package (uv is Python-only, so it can't supply it).
- **3DTilesRendererJS bbox PivotControls gizmo** (`⬚ 3D box gizmo` in Crop & Dump, 3DTRJS mode): a
  vanilla-three port of the drei/threepipe PivotControls idea, purpose-built for the crop box — a
  translucent box with **3 ENU translate arrows** (move the whole box) + **6 face handles** (drag a face
  to resize that geographic bound; the requested face-gizmo bonus). Placed via the globe ellipsoid's
  `getEastNorthUpFrame` under `ecefRoot`, so it aligns with the tiles; bounds are re-derived exactly from
  each dragged handle's position (`getPositionToCartographic`). Shares the same DOM bbox the Cesium box
  and the dumper read. Verified in-browser: correct ECEF placement (centre at Earth radius), 12 handles,
  drag of the east face +100 m → +0.001352° lon (matches `100/(111320·cosφ)`), only that bound changes.

### Added — 2026-06-30 (`stream-cache` cont.: dumper out-of-core outputs + splat merge)
- **Disk-free out-of-core LAS** (`/dump/las?...&stream=1`): 2-pass (count+bbox, then stream 8k-record
  chunks with backpressure) — O(1) RAM, no temp file. Byte-identical to the disk path (verified 498 868 pts).
- **`/dump/copc`**: reuse the LAS temp file, `pdal translate … crop.copc.laz`, stream it; graceful 501 if no PDAL.
- **`/dump/tileset`**: no-decode filtered tileset (in-bbox tiles + transforms, original GLB URIs).
- **`/dump/zip`**: out-of-core streamed STORE-mode ZIP (one tile in RAM at a time) → tileset.json + tiles —
  the answer to "is the crop zipped?" + mesh-out-of-core single download. Works for mesh/splat/points.
- **`/dump/splat`**: merge in-bbox **splat** tiles → one supersplat-ingestable **SPZ/SOG** via
  `@playcanvas/splat-transform` (embeds the Niantic SPZ decoder). Extract each tile's SPZ blob straight
  from the GLB (gltf-transform can't read the required spz extension), `readSpz`→`combine`→`writeSpz`.
  Verified: LCC Guan_Temple → 41 tiles → 6 414 134 splats → 102 MB valid SPZ.
- Viewer Crop & Dump: LAS / COPC / GLB / Tileset / Splat(SPZ) / ZIP buttons + "disk-free stream" toggle.
- *Remaining*: single-file mesh merge out-of-core (streaming GLB needs 2-pass byte layout); zip64 for >4 GB.

### Added — 2026-06-30 (`stream-cache` cont.: dumper out-of-core + implicit + crop UI handles)
- **Generic 3D Tiles bbox dumper** matured: ingests any tileset (our /stream outputs, /bing, /threemx,
  external) and branches points→LAS / mesh→merged-GLB.
  - **Out-of-core LAS**: streams points to a temp file via the O(1)-RAM `LasWriter` (header back-patched
    on close) then pipes it to the response — constant RAM regardless of cloud size. (Mesh merge is still
    in-memory; huge-mesh out-of-core → USD streaming is future.)
  - **Implicit-subtree traversal**: walks OCTREE/QUADTREE `.subtree` availability (morton index, cell-box
    subdivision, template substitution) — so COPC/Potree/implicit tilesets dump directly. Verified on the
    implicit georeferenced vol_total: full 498 868 pts / 42 tiles / 18 MB valid LAS; half-bbox → 230 356.
  - **Viewer Crop & Dump UI**: "Set box to view (80%)", a translucent box on the globe, editable W/E/S/N
    + minH/maxH, max-GE, ⬇ LAS / ⬇ GLB. **Cesium drag handles** (yellow W/E/S/N face points dragged on the
    ellipsoid resize the box live).
  - **`/dump/copc`**: shells out to `pdal translate crop.las crop.copc.laz` (reuses the out-of-core LAS
    temp file), streams the COPC; graceful 501 when PDAL isn't on PATH.
  - **`/dump/tileset`**: no-decode crop — emits a filtered 3D Tiles tileset referencing only the in-bbox
    tiles (each leaf keeps its world transform + the original tile GLB URI). The clean **splat** crop
    (gltf-transform can't even read the SPZ-compressed splat GLBs — required extension fails validation),
    and works for points/mesh too. Verified: georeferenced LCC splat → 41 in-bbox tiles.
  - *Remaining*: single-file splat merge (raw container-level GLB concat preserving the SPZ extension, since
    gltf-transform refuses it), mesh out-of-core (USD streaming), NASA-3DTRJS/R3F TransformControls box
    (drei-style PivotControls, cf. repalash/threepipe), and LAS streaming-to-client without disk (two-pass).

### Added — 2026-06-29 (`stream-cache` cont.: bbox crop engine + shadeless rendering)
- **bbox crop / subsample extract — engine (point clouds → LAS)**. New `/dump/las?url=<potree>&bbox=
  minx,miny,minz,maxx,maxy,maxz[&maxLevel=N]` traverses the octree (ADD: accumulate every point inside the
  bbox from all nodes down to `maxLevel`), filters to the bbox, and streams an uncompressed LAS
  (`core/las-writer.js`; offset = points' min so int32 quantization stays in range). Verified on Potree
  lion: full = 272 768 pts / 167 nodes (valid LASF), a half-X bbox = 94 417 pts clipped exactly at the cut.
  First increment of the BLOSM-style crop feature. *Next*: COPC source, 3D-Tiles-mesh→merged glb/USD,
  lazy traversal for huge remote clouds (non-lazy full-hierarchy load is slow on big datasets), and the
  in-viewer draw-bbox UI (→ `pdal writers.copc`/`untwine` for LAZ/COPC).
- **Viewer shadeless (unlit) + brightness** — Bing/3MX bake lighting into textures, so a Cesium
  `CustomShader` (LightingModel.UNLIT + brightness multiply, default 1.6, on by default) renders them
  bright/clear instead of dark. Toggles in the Tileset & LoD panel.

### Added — 2026-06-29 (`stream-cache` cont.: server-side per-cache progress)
- **Server-side progress** for long ops — `core/progress.js` registry + `GET /progress?key=<srcUrl>`
  (JSON `{label, done, total, finished, elapsedMs}`). Hooked the Potree eager-drain (`cache=hierarchy`):
  ticks per `.hrc` chunk loaded. The viewer polls it (1.5s) during `cache=hierarchy`/`cache=all` loads and
  surfaces it in the timing-log modal (`server … drain: N`). Verified: drain reports 252→844→1776 chunks.
  (COPC/Potree-2.0 drains + convert follow the same pattern — easy to extend.)

### Fixed — 2026-06-29 (`stream-cache` cont.: Bing geometry renders)
- **Bing 3D now renders at the right location** (verified: photogrammetry mesh of Rome, 900+ tiles). Two
  bugs: (1) the viewer's auto-placement treated Bing's **world-spanning `region`** as local data (its
  bounding-sphere centre sits at the earth's centre) and applied a San-Francisco local frame `modelMatrix`
  → shifted everything off-globe. Now `isLocalCoords` also requires a **compact bounding radius** (`< 1e6`),
  so global/continental georeferenced tilesets are left at identity. (2) A wrong `gltfUpAxis:"Z"` I'd added
  — Bing GLBs are standard **Y-up** with ECEF in the node matrix, so Cesium's default Y-up→Z-up already
  places them correctly; setting Z put geometry in the Indian Ocean. Reverted.

### Added — 2026-06-29 (`stream-cache` cont.: in-process KTX2 texture encode)
- **In-process KTX2 encode** (`KHR_texture_basisu`) — `compressGlb({ktx, uastc})` and `/stream?transform=ktx`
  (ETC1S) / `ktx-uastc` (UASTC), via the **`ktx2-encoder` WASM basis encoder** + our pngjs/jpeg-js source
  decoder (the in-Node `imageDecoder` it needs). **No native `toktx`** — closes the encode gap. Verified
  end-to-end on a real textured 3MX tile (encoded.ktx=1, round-trips through the decoder). Pinned
  `@gltf-transform/*` to `^4.4.0`. (WebP texture encode still needs a WASM webp encoder.)

### Added / Changed / Fixed — 2026-06-29 (`stream-cache` cont.: Bing td1 rewrite)
- **Bing rewritten to the `td1` implicit manifest** — the old `mtx<quadkey>` HTTP-probe quadtree couldn't
  discover Bing's deep-only tiles (intermediate LODs are 0-byte, so probing from a shallow root pruned the
  whole tree → "only one request, world shows nothing"). Now: fetch `td1`, strip the `MICROSOFT_*`
  `extensionsRequired`, rewrite the `mtx`/`st` templates to proxy through `/bing/{tile,subtree}/{face}-{level}-{x}-{y}`
  with a standard `{y}`, and flip `y→reverseY` (= 2^level−1−y) when fetching from Bing. Subtree availability
  is standard `subt` morton(x,y) → passed through untouched. **Verified end-to-end**: manifest rewrites
  (MS exts stripped, templates routed), subtrees proxy with real availability, and a known-good tile
  (`/bing/tile/1-14-1141-4206.glb` → reverseY 12177) returns the real 203 KB glTF. **No API key needed.**
  Viewer: one "Bing 3D — world (td1)" pill (navigate/zoom to any city) replacing the root-quadkey pills.
- **Bing webmercator fix — convert implicit→explicit lazy fragments with correct regions.** Passing Bing's
  implicit tiling through made Cesium subdivide each face's latitude *linearly* (it can't do
  `MICROSOFT_webmercator_subdivision`), so deep regions were wrong and tiles were culled ("zoom to Rome
  shows nothing"). Now `/bing` walks Bing's `st` subtree availability itself and emits **explicit** tiles
  whose `region` is computed with proper web-mercator math (4 faces = quadrants; lon linear; lat =
  atan(sinh(mercator-y))), as lazy `/bing/fragment` tilesets (a few levels each, external-ref deeper).
  **Verified**: root = 4 faces; a level-12 fragment near Rome yields 85 content tiles, one at
  **12.566°E / 41.900°N** (Rome), fetching a real 203 KB glTF.

### Added / Changed / Fixed — 2026-06-29 (`stream-cache` cont.: 3MX georef/orientation, Z-offset, diagnostics)
- **Fix 3MX orientation** — node GLBs stored SRS Z-up `(E,N,U)` verbatim, so Cesium's glTF Y-up→Z-up
  rotation tipped meshes 90° (vertical instead of horizontal). Now swizzled `(E,N,U)→(E,U,−N)` like the
  point paths, matching the ENU root transform + bounding box.
- **Fix 3MX georef for compound CRS** — `core/geo.js` `georefFromCrs` now unwraps `COMPD_CS[...]` WKT
  (horizontal PROJCS/GEOGCS + vertical) that proj4 can't parse. Verified: Tende village (dept06, EPSG:2154
  Lambert-93 + NGF-IGN69) now georeferences to 7.59°E / 43.9°N instead of sitting at the local origin.
- **Viewer vertical Z-offset** — a "Z offset (m)" control nudges an already-georeferenced tileset along
  **geodetic up** (local vertical, not ECEF Z) via `tileset.modelMatrix`, composing with the dataset's
  own georef (for wrong-altitude datasets like Geghard). Verified it applies without replacing the georef.
- **README**: noted Arrival.Space `.lod` uses the streamed-SOG format (SOG adapter reads it directly).
- **Diagnostics (no viewer fix this pass)**: the Potree implicit "stops refining" report — verified
  **server-side is correct** (BFS reaches subtree level 9 / tile level 11, 161 subtrees, 0 errors; deep
  tiles load; implicit and explicit produce identical geometric errors). Any remaining under-refinement is
  Cesium-side and needs live repro; workaround = the viewer's tiling→explicit toggle.

### Added / Changed — 2026-06-29 (`stream-cache` cont.: pills, Arrival=SOG, timing modal, dev port)
- **Arrival.Space `.lod` = SOG** (confirmed by fetching the live fixture): identical `lod-meta.json` tree
  and per-chunk `version:2` webp splats (`means_l/u`, `quats`, `scales`, `sh0`, `shN_*`). The SOG adapter
  reads it directly — **no Arrival converter needed**. Added an Arrival jaffa3 pill (verified streaming).
- **Viewer pills**: Geghard (iconem Potree, remote), Marseille `root.json` (3D Tiles, CORS-ok), Tende
  village 3MX (dept06 — a real georeferenced 3MX; the earlier "white" was the SRS-less fixture), Arrival.
  Pills can now be absolute remote URLs (`isRemoteUrl`/`srcUrl`); offline mode hides assets with no output.
- **Timing log merged into the `#status` modal** (was a separate bottom-left panel overlapping the status
  overlay) — `#status` = `#status-line` + `#timing-log`.
- **Dev port fix**: the preview harness injects `PORT=3000` into `pnpm run dev`, collapsing the tile-server
  onto vite's port. `server.js` now resolves `--port > TILE_PORT > PORT > 3001`; `serve:tiles` passes
  `--port 3001`. `pnpm run dev` → vite 3000 + tiles 3001 under the harness.
- **Findings (answers, see Future work for the resulting tasks)**: (a) the Float32 world-coord precision
  bug was **Potree-only** — COPC subtracts origin in float64 before the f32 cast, and LCC/SOG/RAD store
  local model coords + georef via the root transform. (b) **Bing**: the `mtx<quadkey>` probe model is wrong
  — Bing serves a standard **implicit-tiling** 3D Tiles root at **`td1`** (QUADTREE, `subtreeLevels:7`,
  `availableLevels:21`, tile template `mtx{face}-{level}-{x}-{reverseY}`, subtree template `st{face}-…`);
  the probe only catches sparse deep `mtx` tiles (0-byte at low LOD) → "subsample"/"world shows nothing".
  (c) **No in-process KTX2 encode** (no `basis_encoder`/`toktx`; `three` ships only the transcoder) and no
  webp encoder (would pull `sharp`) — both need a new WASM dep. (d) **Nira** has no proprietary tiled format
  (adopting 3D Tiles `.3tz`/`b3dm`). (e) tastier `.3tz`/`.3dtiles` are already under the 📦 Packages pill.

### Added / Changed — 2026-06-29 (`stream-cache` cont.: encode/transform, texture format, LAS writer)
- **Per-tile encode + `&transform=` on `/stream`** — closes the implicit-octree gap the `/gltf` proxy
  can't reach (it URL-rewrites explicit tilesets; `/stream` builds each GLB itself). `transform=meshopt`
  (EXT_meshopt — works on **POINTS**, where Draco no-ops; verified Potree tile 203 KB → 65 KB, ~32%),
  `transform=draco` (mesh tiles), `transform=decompress` (decode draco/meshopt/KTX2, `+&tex=jpg|png`).
  New `core/gltf-compress.js` `compressGlb({meshopt|draco})`; verified end-to-end through the live server
  + round-trip decode. Viewer: **transform** dropdown next to cache/prefetch (before formats).
- **Configurable KTX2 decode output** — `core/gltf-decompress.js` + `/gltf?tex=jpg|png`. Default **jpg**
  (pure-JS `jpeg-js`, no native/sharp): measured ~30% smaller and ~2.6× faster than the prior `pngjs` path.
- **Out-of-core LAS writer** (`core/las-writer.js`) — hand-written LAS 1.4 / PDRF7 (no maintained JS/WASM
  LAS *writer* exists). Streaming `LasWriter` (O(1) RAM — header back-patch for count/bbox, so a 500 GB
  cloud needs ~constant memory) + in-memory `writeLasBuffer` for the browser. Hand off to
  `laszip`/`pdal writers.copc`/`untwine` for LAZ/COPC. Self-tested (LASF/PDRF7/count/bbox round-trip).
- **Bing**: default genid `15340 → 15530`; any root quadkey works (full-world); viewer World/Rome pills.
- **Viewer**: raw-url field re-resolves on toggle **and** on pill click; KTX→decode demo pill (Bing via
  `/gltf`). **Docs**: `/stream?transform=` + `/gltf?tex=` in the endpoints table; cache disk/RAM/none
  persistence note; blosm#498 + CesiumGS public-data refs.
- **Viewer permanent timing log** (bottom-left) — persistent per-load milestones with elapsed times
  (context: cache mode + prefetch + transform + format + renderer; then tileset resolved / first tile /
  streaming N / tiles ready N / failure). The **timing-log half** of the requested progress reporting.
- **Offline georef baked** — the prebuilt LCC + Potree converters now write `root.transform` from the
  data's own CRS, sharing the live adapters' math (new `core/geo.js` `cgcs2000Lon0`/`lccGeoref`; Potree
  via `georefFromCrs`). Regenerated **Guan_Temple** (EPSG:4547) + **vol_total** (Swiss somerc) — verified
  offline placement == live `/stream` adapter. Clouds with no CRS (Guanlan EPSG:0) correctly stay local.
- **Still deferred** (unverifiable here / greenfield): **server-side per-cache progress** (eager-drain /
  convert need a progress endpoint — the other half of progress reporting); Arrival.Space `.lod` adapter;
  Potree live zoom-stop above a level (needs live-viewer repro); 3MX visual debug (public fixture has no
  SRS); KTX2 *texture* encode (needs native `toktx`).

### Added / Changed / Fixed — 2026-06-29 (`stream-cache` branch: lazy hierarchy, cache continuum, new adapters)
- **Lazy hierarchy on demand** for every multi-page format (geometry was already per-tile): Potree 1.x
  (`.hrc` chunks → lazy implicit), Potree 2.0 (hierarchy chunks), COPC (hierarchy pages), RAD (4-level
  explicit fragments), I3S (node-page fragments). Huge clouds: Potree 1.7 302 M ~80 s → ~0.2 s; RAD 50 M
  9.6 s → 0.015 s. Lazy paths verified to reach the same node set as eager (Potree 2.0 byte-identical
  1624 nodes; RAD 765/765; I3S 5882/5882).
- **Single `cache` axis** (replaced `mode × hierarchy`): `cache=none` (live, lazy) · `cache=hierarchy`
  (whole tree in RAM, tiles per-request) · `cache=full` (whole dataset → disk, `/convert`). No "prebuilt"
  middleware mode. Unified **`/tiles`** endpoint 307-routes by `cache`; `/stream` & `/convert` are aliases.
  **`prefetch=N`** (0/N/-1) background-warms lazy hierarchy. **Bounded-parallel** lazy fragment builds
  (`parallelMap`, cap `min(cpus−1,16)`).
- **New `core/` shared services**: `geo.js` (ENU/ECEF georef, was 4× dup), `source.js` (`Source`:
  range/parallel-ranges/full/probe), `http.js` (CORS + send helpers), `octree.js` (`buildImplicitTileset`),
  `gltf-decompress.js`.
- **New adapters/tools**: **`/gltf`** generic per-tile glTF-Transform pipeline (`ops=decompress|draco|meshopt|ktx`,
  decode today — gltf-transform + draco3dgltf + Basis WASM from `three` + `pngjs`, **no sharp**, no native
  `ktx`); **`/bing`** Bing Maps 3D (`tf=3dv4` GLB) → quadtree (verified live keyless, Berlin); **`/threemx`**
  Bentley 3MX → lazy fragments + **OpenCTM MG1** decode (vendored js-openctm, `packages/threemx-to-3dtiles/`).
- **`centroids`** (`&centroids=1`) for SOG/LCC/RAD — POINTS preview of splat centres.
- **Fix — Potree live float32 precision striping**: decoders now build positions in **Float64Array**
  (world); origin subtraction casts the small local result to float32 (verified: iconem 1.x tile positions
  local ±351 m, not UTM ~5e5). 1.x & 2.0, implicit & explicit.
- **Viewer**: 3 modes (Live streaming · Prebuilt offline · Tools); `cache` pill + `prefetch` input placed
  right after the mode, before formats; **Bing 3D** + **3MX** pills; tastier `.3tz`/`.3dtiles` moved to
  Packages; public CesiumGS samples on the 3D Tiles pill; **raw-url** checkbox (re-resolves on toggle,
  auto-off in offline). centroids toggle for splats.
- **Docs**: README materialization continuum, multi-page-vs-monolithic-index, tools & endpoints, candidate-
  formats roadmap, future work; `docs-references/streaming-architecture-design-log.md`,
  `streaming-adapter-plans.md`; full `CONVERSATION.md`.
- **Deferred** (noted in README/CHANGELOG): glTF-Transform encode ops; `&transform=` in `/stream` (implicit
  per-tile transform); offline-georef regen (LCC Guan, Potree vol_total) + Potree implicit offline output;
  3MX visual debug (needs a georeferenced 3MX — public fixture has no SRS); live progress reporting;
  browser-native bbox crop → LAS → `pdal`/`untwine` COPC; fastest JS point-cloud tiler.

### Fixed — 2026-06-26 (server stability, pills, intensity, Potree 1.x convert, SOG rotation)
- **Server crash fix** (`ERR_HTTP_HEADERS_SENT`): catch blocks no longer write a 500 after streaming
  has started (`if (!res.headersSent)` guard). `laz-perf` WASM `abort()` handlers overridden so they
  log instead of re-throwing. Non-LAS `/copc` requests (e.g. wrong URL) fail fast with a clear error
  (LASF magic check) instead of hanging and killing the process.
- **Potree 1.x stream fix**: `cloud.js` (pure JSON) was being transformed by Vite's JS module pipeline
  (HMR footer appended), corrupting `JSON.parse`. Added a Vite plugin (`raw-sample-data-js`) that
  serves any `sample-data/**/*.js` request as raw bytes, bypassing module transformation. Tolerant
  brace-balanced parser in `potree1.js` as defence-in-depth.
- **Potree 1.x convert via middleware**: `/convert` can now fully mirror a remote Potree 1.x dataset
  (walks `cloud.js` → `.hrc` hierarchy → all per-node `.bin`/`.laz` files) before converting. Both
  inline (v1.4) and chunked-dir (v1.7) layouts handled. First request is slow (downloads the tree);
  subsequent requests hit the cache instantly.
- **Implicit/explicit tiling on `/stream`**: both COPC and Potree stream adapters now default to
  **implicit** (`implicitTiling` + on-the-fly subtrees) and support `&tiling=explicit`. Dedicated-package
  CLI shims gained `--tiling` flag. All four surfaces (dedicated CLI, meta CLI, `/convert`, `/stream`)
  are uniform.
- **Viewer stale-tileset bug**: clicking a new pill before the previous tileset finished loading left
  a ghost tileset in the scene. Fixed with a `_loadGen` counter; stale async completions remove their
  tileset immediately.
- **URL bar on its own line**: `#url-bar` uses `flex-basis: 100%` so it always wraps below the pill rows.
- **Intensity greyscale fallback**: when a point-cloud tile has no RGB channels, COPC and Potree 1.x
  decoders now emit intensity as greyscale (`Intensity/65535` → rgb). Covers `/stream` tiles. Potree
  1.x `.bin` nodes also detect the `INTENSITY` attribute.
- **SOG root transform (Cesium)**: `sog-live.js` now includes `root.transform = RX(+90°)` so that
  streamed-SOG scenes (PlayCanvas Y-up) appear upright when the user applies a local ENU frame in
  CesiumJS. Bounding volumes already used `boundToZUpBox`; content rotation now matches.
- **LCC georef**: `lcc-live.js` converts `meta.lcc` `epsg` + `offset` → ECEF `root.transform` via
  proj4 (CGCS2000 Gauss-Krüger EPSG 4513–4554). Handles CM-based vs zone-prefixed easting.

### Added — 2026-06-26 (3TZ/.3dtiles package server, I3S converter draft, docs)
- **`/package` endpoint (tile-server)**: serves `.3tz` (ZIP with `@3dtilesIndex1@` random-access
  index) and `.3dtiles` (SQLite `media` table) packages as if they were unpacked tileset directories.
  `GET /package/tileset.json?url=<local-path.3tz>` → parses the index and rewrites all tile URIs so
  follow-up requests route back through `/package/<key>?url=<same-url>`. Mirrors `npx 3d-tiles-tools
  serve` but in-process, with CORS and no CLI dependencies. `.3dtiles` requires `better-sqlite3`
  (optional; 501 + install hint if absent). No extraction needed — random-access reads via file
  descriptor + the ZIP index.
- **`i3s-to-3dtiles` draft package**: reads Esri I3S SLPK (extracted or REST-mirror directory) and
  converts to OGC 3D Tiles 1.1 explicit tree. Supported: IntegratedMesh / 3DObject / PointCloud
  layers with uncompressed DefaultGeometrySchema. ENU-frame shared root transform. Already wired
  into `3dtiles-convert` meta-converter REGISTRY and `/convert` middleware. Unsupported by this
  draft: Draco compression, LEPCC point clouds, textures, per-feature attributes.

### Added — 2026-06-26 (pill bar restructure, FORMAT selector, docs)
- **Pill bar restructure**: mode selector (⚡ Stream / 💾 Offline / 🛠 Convert) × FORMAT selector
  (COPC / Potree / SOG / RAD / LCC / I3S / 3D Tiles) × tiling toggle (⬡ implicit / ⬢ explicit,
  shown only for COPC/Potree). Asset pills show only the selected format's assets. Switching mode
  or tiling reloads the active asset. RAD/I3S disable in Stream mode (no stream adapter).
- **README**: implicit/explicit documentation (all surfaces, defaults, octree key convention);
  3D Tiles → 3D Tiles transcoding section (implicit→explicit, legacy upgrade, tools reference);
  LCC X/Y-only quadtree warning for tall scans; consolidated format-specification links.

### Added — 2026-06-23d (implicit/explicit tiling option; LCC live streaming; core/tiling)
- **Implicit ⇄ explicit tiling, both converters.** New `--tiling=implicit|explicit` (CLI) /
  `opts.tiling` (API) / `&tiling=` (`/convert`). **COPC** gained an **explicit** nested-tree mode (was
  implicit-only); **Potree** gained an **implicit** subtree mode (was explicit-only). Defaults unchanged
  (COPC implicit, Potree explicit). Potree implicit derives each node's `(level,x,y,z)` from its box vs
  the root box and **validates** that the implicit-derived box equals the explicit box before writing
  (0 mismatches on lion_p2; 116 subtrees, 6 levels).
- **Factored shared tiling into `3dtiles-convert-core/tiling`**: `keyToCoords`/`coordsToKey`,
  `octreeChildKeys`, `octreeSubCube`, `cubeToBox`, `buildExplicitTree`, `buildSubtreeBuffer` (moved from
  copc, BigInt Morton decode — fixes the >level-10 wrap), `subtreeRootKeys`. COPC's `subtreeBuilder.js`
  is now a thin re-export. Used by both copc + potree converters.
- **LCC live streaming** (`/lcc` + `/stream`): `meta.lcc` grid (`cellLengthX/Y` + `boundingBox`) +
  `index.bin` (cell packed x16/y16, per-LOD `{points,offset,size}`) → tileset built **without decoding**;
  each tile range-reads its `[offset,size)` slice of `data.bin` → SPZ-v2 GLB. Verified (Guan_Temple: 41
  units, 154 runs).

### Added — 2026-06-23c (true on-the-fly streaming: SOG + Potree 1.x; unified /stream)
- **Unified `/stream` dispatcher** — one front-door that detects the format and delegates to its range
  adapter; 501 (→ use `/convert`) for formats without one. Each streamed format is now a uniform
  `*-live.js` module (COPC extracted out of `server.js`).
- **streamed-SOG live streaming** (`/sog` + `/stream`): tileset built from `lod-meta.json` (bounds +
  leaf runs persisted, **no decode**); each tile fetches just that chunk's WebP set, decodes once
  (LRU-cached), extracts the `[offset,count)` run → SPZ-v2 GLB. Verified (skatepark).
- **Potree 1.x live streaming**: `potree1.js` refactored to read through an **injectable reader** (fs
  offline, fetch live) so the same authoritative reader serves both. `/potree` + `/stream` now handle
  1.x (`.hrc`/inline, `.bin` + per-node `.laz`) and 2.0. Verified live (lion_takanawa `.bin` 167 nodes,
  lion_takanawa_laz 200 nodes, potree.org 2.0 1624 nodes).
- **Potree 2.0 true range-streaming** (`/potree`): metadata.json + hierarchy.bin → tree; one HTTP-206
  range read of octree.bin per tile → POINTS GLB. `potree2.js` factored into pure
  `preparePotree2Schema`/`parsePotree2Hierarchy`/`decodePotree2Node` (shared offline + live).
- **Streaming roadmap documented**: a format streams only if it persists per-tile bounds — COPC, Potree
  2.0/1.x, SOG, LCC do; **RAD doesn't and isn't spatially tiled** → `/convert` only
  (`docs-references/rad-format-notes.md`, distilled from the SparkJS-team GitHub replies). Added the
  loaders.gl `@loaders.gl/tile-converter` reference (bidirectional I3S⇄3D Tiles).

### Added — 2026-06-23b (generic `/convert` live middleware; `--centroids-only`)
- **`/convert` — live any-format → 3D Tiles** (preprocess+cache): converts the whole dataset once on
  first request (cached on disk by `sha1(format|src)`), then serves static; rewrites the root tileset's
  relative URIs to absolute `/convert/<key>/…`. Works for every meta-converter format. `<SRC>` may be a
  **remote URL or local path**; remote directory formats are mirrored with the sibling files each
  converter needs.
- **Remote URLs across CLI + JS API + middleware** via shared `packages/convert/fetch-source.js`
  (`3dtiled https://…/metadata.json out/`, `convert('https://…', out)`); name-based detection
  (`detectFormatByName`) for remote inputs.
- **`--centroids-only` / `?centroids=1`**: splat formats (RAD/SOG/LCC) emit a plain glTF **POINTS**
  tileset of splat centroids (POSITION+COLOR_0, no `KHR_gaussian_splatting`) so point-cloud-only
  renderers can display tiled-splat scenes. Shared `core.buildSplatTileGlb` + a `swizzle` option on
  `buildPointsGlb`. Offline pills (RAD/LCC/SOG centroids) + live `&centroids=1`.

### Fixed — 2026-06-23a (dev ergonomics; viewer placement of local point clouds)
- **`pnpm run dev` now starts the viewer (:3000) AND tile-server (:3001) together** via `concurrently`
  (`dev:web` + `serve:tiles`; `serve:live` alias added).
- **Vite no longer crawls** — `server.watch.ignored: ['**/sample-data/**']` (sample-data moved into the
  repo is ~119k files / 29 GB; watching it stalled startup & HMR). Still served on demand.
- **Local point clouds now auto-place & zoom in CesiumJS** (centroid / non-georef Potree tilesets
  previously loaded but never framed — only splats auto-placed). Now any local-origin tileset is placed
  at the local frame and flown to.
- **pnpm workspace fix**: `3dtiles-convert` now declares the `<fmt>-to-3dtiles` packages as
  `workspace:*` deps (it `import()`s them by bare name; npm auto-links all workspaces, pnpm doesn't).

### Added — 2026-06-22g (live COPC→3D Tiles middleware; I3S geometricError; Potree CRS)
- **`tile-server` — live COPC → 3D Tiles middleware** (`packages/tile-server`, the "TiTiler for 3D"):
  `GET /copc/tileset.json?url=<COPC>` builds a 3D Tiles tree from the COPC hierarchy (HTTP-range), and
  `GET /copc/tile/<D-X-Y-Z>.glb?url=<COPC>` range-reads one octree node and returns a POINTS GLB on the fly
  (`core.buildPointsGlb`). One ENU→ECEF root transform from the COPC WKT CRS (proj4). `npm run serve:tiles`
  (:3001, CORS open). Verified: CesiumJS renders Autzen geo-referenced over Oregon, streamed live — the
  viewer only sees 3D Tiles. Added viewer pill **🛰 COPC→3DT (live middleware)**.
- **I3S geometricError** now = half the tile's bounding-box diagonal (shrinks with depth: 33 km root → 0
  leaves), so the renderer refines by camera distance instead of loading every tile always.
- **Potree CRS recovery**: readers surface `cloud.js.projection` (1.x) / `metadata` CRS (2.0) as `crs`
  for downstream geo-referencing.
- **`potree-to-copc` assessed, deferred**: read side ready (octree + points + CRS), but COPC needs LAZ and
  there's no pure-JS LAZ encoder (`laz-perf` WASM is decode-only). Path documented (Rust `copc-rs`/`laz-rs`
  → WASM, or PDAL `writers.copc` / copc-lib).

### Fixed — 2026-06-22f (I3S ENU frame — upright on the globe)
- **I3S buildings now sit flat & upright on the globe** (were tilted ~40° / looked like a plane
  perpendicular to the ground, with weirdly-rotated boxes). Root cause: geometry stored in **ECEF axes**,
  which are tilted vs the local horizon at NYC. Fix: a single **local ENU frame** — geometry in
  East/North/Up **metres**, with the root `transform` = ENU→ECEF (`[East,North,Up,origin]`). glTF POSITION
  is pre-swizzled to `(E,U,−N)` so the renderer's Y-up→Z-up RX(+90°) yields tileset `(E,N,U)`; boxes are
  AABBs in that ENU frame. Verified: root box ENU half-extents = 23.5 km × 23.1 km × **0.3 km** (a flat
  city slab, not a vertical plane); buildings follow the Manhattan street grid (Central Park visible),
  ground-aligned boxes. This is the "custom local CRS via tile transform" approach (vs converting every
  vertex to absolute ECEF).

### Fixed — 2026-06-22e (Potree 1.x scatter, I3S boxes/orientation)
- **Potree 1.x no longer scatters into duplicate clusters.** Two coupled bugs: (1) `POSITION_CARTESIAN` is
  **node-relative** — `raw·scale + THIS NODE's box.min` (the spec's "boundingBox.min" is the node's subdivided
  box; the global cloud min piles every node at the corner); (2) the octant→sub-box convention was wrong —
  Potree's `createChildAABB` is **bit0→Z, bit1→Y, bit2→X**, not bit0→X (an X/Z swap that put deep nodes in the
  wrong octant). Fixed both (potree1.js + potree2.js childBox). Verified: child→root NN 0.03 m, 60/60 nodes'
  geometry inside their box, lion_takanawa renders as one coherent statue with geometry filling the debug boxes.
  Added `docs-references/potree-format.md` (1.x `.hrc`/`.bin` + 2.0 binary octree, with the decode rules + source links).
- **I3S bounding boxes now contain the geometry (no weird rotation).** The I3S OBB quaternion is in a local
  frame that doesn't match our per-vertex-geodetic placement, so OBB-derived boxes were rotated wrong and
  didn't enclose the mesh. Now each tile's box is the **axis-aligned AABB of its actual decoded geometry**,
  unioned with children (parent ⊇ children). Verified: 40/40 sampled content tiles contain their geometry;
  NYC buildings render tangent to the globe over Manhattan and refine on zoom.

### Fixed — 2026-06-22d (I3S transform compounding)
- **I3S tiles no longer scatter / vanish on zoom.** The converter set a per-tile `transform` translating
  to each node's ECEF centre (~6.4M m), but 3D Tiles **composes transforms down the tree**, so child
  translations compounded (root + child + grandchild ≈ N×6.4M) and flung deep tiles off the planet.
  Fix: one shared ECEF origin (root OBB centre) — all tile geometry **and** bounding boxes are stored
  relative to it, and only the **root** carries a `transform`. Verified on NYC: buildings concentrate
  over Manhattan and refine on zoom (627 tiles vs the old 36 + scatter). (Potree 1.x re-verified correct
  via debug-box overlay — boxes wrap the point cloud; earlier "wrong" look was pre-fix / sparse ADD LoD.)

### Added — 2026-06-22c (in-process meta dispatch, offline Vite viewer)
- **Meta-converter now dispatches IN-PROCESS** — every converter exports a uniform
  `convert(input, outDir, opts)` plus a `fileURLToPath`-guarded CLI shim. The registry `import()`s the
  module (verified: **0 child processes spawned**); it falls back to `spawn` only when `opts.extraArgs`
  (format-specific CLI flags) are passed. rad's argv-consts became a settable `OPTS` object + `parseArgvOpts`.
- **Viewer is now offline / self-contained via Vite** — added `cesium`, `three`, `3d-tiles-renderer`,
  `@sparkjsdev/spark`, `3d-tiles-rendererjs-3dgs-plugin` as deps + `vite` / `vite-plugin-cesium`.
  Removed the importmap + CDN `<script>`s; Cesium is imported as ESM and exposed as the `window.Cesium`
  global the non-module scripts use (init deferred via a `cesium-ready` event). `npm run dev` →
  `http://localhost:3000/viewer.html`. **Verified 0 CDN requests** (Cesium, 3DTRJS globe, and Gaussian-splat
  streaming all from node_modules); `three` de-duplicated via `resolve.dedupe`. The dev server also serves
  `sample-data/` so the presets resolve same-origin. **pnpm supported**: `pnpm-workspace.yaml` +
  `.npmrc` (`node-linker=hoisted`, so `import('rad-to-3dtiles')` resolves), `convert`'s core dep uses the
  `workspace:*` protocol, and a root `index.html` redirects `/` → `/viewer.html`. `pnpm install && pnpm run dev` verified.

### Fixed / Added — 2026-06-22b (decode bug fixes, RAD spatial GE, packages/ migration)
- **RAD geometricError is now SPATIAL by default** — `geBasis: 'spatial'` = `2 × bboxDiagonal/∛(splatCount)`
  (mean representative-splat spacing). Elevator root GE 1.22 → **4.15** (≈ William's 4.66), fixing the
  under-refinement that showed as coarse/"missing" tiles at distance. Legacy basis via `--ge-basis=featuresize`.
- **Potree 2.0 BROTLI decode FIXED** — was rendering as a flat line. The decompressed buffer is
  **attribute-planar** (not interleaved) and position/rgb are **Morton-encoded** (16 B / 8 B per point);
  ported Potree's `dealign24b` + planar plane offsets. lion_p2 now decodes to a correct 3D lion with colour.
- **Potree 1.x parent/child offset FIXED** — points are quantised relative to **each node's bbox min**,
  not the root's (root min shifted deep nodes → misaligned clusters). Verified points now nest in their node box.
- **Potree 1.4 inline-hierarchy + tiled LAZ implemented** (was fast-fail). Reads the inline `hierarchy`
  array + flat `data/<name>.{bin,laz}`; LAZ nodes decoded with laz-perf (via `copc`). `lion_takanawa_laz`
  → 200 tiled-LAZ tiles, `vol_total` → 42. (This is the *tiled* LAZ path; plain untiled LAS/LAZ stays in copc.)
- **I3S mesh placement FIXED** — geographic-layer vertices are `(Δlon°, Δlat°, Δheight_m)` relative to the
  OBB centre; converted per-vertex to ECEF (stored centre-relative for float32 precision). NYC buildings now
  land at ≈ −74°, 40.7°. `detectFormat` also now recognises extracted SLPK dirs (`3dSceneLayer.json.gz`/`nodepages/`).
- **All six converters moved under `packages/<fmt>-to-3dtiles/`** (workspace members); core imports repointed
  (`../../core`), meta-converter registry paths updated. Meta dispatch retested on all formats. (In-process
  `convert()` export remains the next step; dispatch is still child-process.)
- **Viewer/inspector**: added Potree LAZ pill + `inspect:lion-laz`; regenerated all changed outputs (rad GE,
  potree decode, i3s placement) incl. the `output-meta-converter/` set.
- **README**: format table notes tiled-LAZ; `.3tz`/upgrades now point to CesiumGS **3d-tiles-tools**;
  added **loaders.gl I3S test-data** to open-data samples; Missing-features section trimmed to what's still open.

### Added / Changed — 2026-06-22 (parallelism rollout, I3S + Potree on real data, LAS/LAZ, output reorg)
- **Parallelism rolled out to all five operational converters.** `rad`, `sog`, `copc`, `potree` joined
  `lcc` on the shared `core` async-gzip + `parallelMap` tier (bounded concurrency = cores−1). Verified
  equivalent output: **rad byte-identical**, **copc byte-identical** (autzen 23.0→16.9 s), **potree
  byte-identical** (lion 6.2→5.0 s), **sog content-identical** (same 2054 tiles / 10,995,501 splats;
  tiles renumbered in task-order, deterministic across runs). `sog/spzGlb.js` deleted (now imports core).
- **I3S converter validated on real SLPKs.** `Buildings_NewYork_v18` (3DObject mesh, v1.8) →
  **5882 glTF TRIANGLES tiles**. Fixed the load-bearing encoding detector (was gating the whole layer as
  Draco when buffer 0 is uncompressed). `SMALL_AUTZEN_LAS_All` (PointCloud, **LEPCC**) → fast-fail (no
  decoder). CRS/ENU placement remains the known caveat. Status 🟡 draft → mesh works.
- **Potree validated on real datasets** (iTowns `lion` 2.0 BROTLI = 3,954,696 pts exact; `lion_takanawa`
  1.7 = 167 tiles). **Potree 1.4 inline-hierarchy** and **1.x LAZ** now **fast-fail** with stale-format
  messages (exit 1, no output) instead of writing an invalid `root:null` tileset.
- **Plain (non-COPC) LAS/LAZ** support added to `copc-to-3dtiles` (`plainLas.js`): detect via missing COPC
  VLR → flat tiling (≤2 M pts/tile, no native LoD), LAZ via `laz-perf`. Single-tile LAS tested; multi-tile
  + non-COPC LAZ end-to-end UNTESTED (no sample).
- **Meta-converter retested on every format** via the `3dtiled` CLI → `sample-data/output-meta-converter/`
  (auto-detect + dispatch): rad 11 · sog 2054 · lcc 154 · copc 278 · potree 1624 · **i3s 5882** tiles.
  Fixed `detectFormat` to recognize **extracted SLPK dirs** (`3dSceneLayer.json.gz` / `nodepages/`).
  **Note:** the meta-CLI requires `npm install` first (workspace symlink) — without it the bare
  `3dtiles-convert-core` import fails with `ERR_MODULE_NOT_FOUND`.
- **Output dirs reorganized** `sample-data/output-<fmt>/` → **`sample-data/output/<fmt>/`**; viewer presets
  (15), inspector scripts, and README paths repointed. **Viewer pills added**: Potree ×2, I3S (NYC), and a
  **meta-converter group** (🔀 ×6) pointing at `output-meta-converter/`; matching `inspect:*` scripts.
- **README**: format-comparison table **split** into Output / point-cloud&mesh / Gaussian-splat; added a
  **Parallelism (per-converter)** table and a **Missing features & unsupported code-paths** section.
- **Naming**: kept the `<fmt>-to-3dtiles` convention and the **`3dtiled`** CLI name; purged `@3dtiled/*`
  from docs/source (shared packages are unscoped `3dtiles-convert-core` / `3dtiles-convert`).

### Added — monorepo, shared core, meta-converter, parallelism (see ARCHITECTURE.md)
- **npm workspaces** root (`packages/*`). **`3dtiles-convert-core`** holds the shared machinery: the
  canonical SPZ-v2 + GLB splat encoder (now **async gzip** for parallelism), POINTS GLB writer,
  `parallelMap` (bounded concurrency) + `WorkerPool` (worker_threads), and `detectFormat`.
- **`3dtiles-convert`** — the **meta-converter**: `convert(input, outDir, opts)` JS API + `3dtiled`
  CLI that auto-detects the format and dispatches. Detection covers rad/sog/lcc/copc/potree/i3s.
  Dispatches to the standalone converters today (non-breaking); migrates to in-process `convert()`
  as each converter moves into `packages/`.
- **Parallelism** wired into `lcc-to-3dtiles` as the first adopter: two-phase (build tree + collect
  tasks → `parallelMap` decode/encode/gzip/write); uses `3dtiles-convert-core`. Validated identical output
  (11,424,293 splats), ~20% faster on Guan_Temple (more on gzip-heavy formats like SOG).
- **README**: format-comparison table + a **Runtime (Node / browser-capable)** table per converter
  (decoders mostly portable / WASM; Node-only gates are I/O + gzip/brotli + workers).

### Added — converters
- **sog-to-3dtiles** — PlayCanvas Streamed SOG → 3D Tiles. Walks the binary spatial tree
  (interior = grouping, leaf = REPLACE LOD chain); decodes each chunk via
  `@playcanvas/splat-transform`'s `readSog` (CPU `webp.wasm`, no GPU) into a `DataTable`,
  re-encodes to SPZ-v2 GLB. Validated on `example_skatepark_02` (2,054 tiles) and
  `example_roman_parish_02` (37,725 tiles). Memory-bounded (decode chunk → write → release).
  `scripts/fetch-sog.mjs` downloads a full streamed-SOG dataset.
- **lcc-to-3dtiles** — XGRIDS LCC → 3D Tiles. Reverse-engineered the uncompressed 32-B/splat
  `Data.bin` layout (pos f32×3 · color rgba8 (a=opacity) · rot u32 10-10-10-2 · scale u16×3),
  parses `meta.lcc` + `Index.bin` (Unit grid × LODs). Validated on `Guan_Temple`
  (154 tiles, 11,424,293 splats = `totalSplats`). Rotation matches the LCC-Web-SDK `QUAT_TAB`.
  Scale decode under active refinement (geometric vs. v5 codebook-LUT). SH not yet emitted.
- **i3s-to-3dtiles** — 🟡 draft (UNTESTED, no SLPK sample): node-tree → tileset, OBB→box,
  `DefaultGeometrySchema` mesh / PointCloud → glTF. Draco/textures/attributes/legacy index gated out.
- **potree-to-3dtiles** — 🟡 Potree octree point cloud → 3D Tiles glTF POINTS. Auto-detects 2.0
  (`metadata.json`/`hierarchy.bin`/`octree.bin`, incl. BROTLI) and 1.x (`cloud.js`/`.hrc`/`.bin`).
  Octree→tree, `refine: ADD`, GE = spacing/2^depth. 2.0 decode validated on a synthetic dataset
  (positions + RGB exact); 1.x best-effort; both untested on real data; output not geo-referenced.

### Fixed — rad-to-3dtiles (the "spiky render" saga)
- **SPZ v2, not v3** — `KHR_gaussian_splatting_compression_spz_2` is locked to SPZ v2 (3-byte
  "first-three" rotations). Emitting v3 mis-strided the rotation block in CesiumJS's decoder.
- **RAD column byte-layout** (the root cause, confirmed from SparkJS Rust `rad.rs` encoders):
  `f16`/`oct88r8` are **interleaved**, `ln_0r8`/`r8_delta` **planar**, `f32_lebytes` byte-transposed.
  Reading alpha & orientation as planar corrupted opacity + rotation (positions stayed correct, so
  the shape showed through the noise). Fixed; scales correctly reverted to planar.
- **`lodOpacity`** — RAD encoding params live under `meta.splatEncoding` (not `meta.encoding`);
  the missed `lodOpacity: true` meant opacity wasn't doubled. Cross-validated vs William's PLY
  pipeline: keep `α×1` (`--alpha-scale` flag added for A/B).
- **geometricError** — uniform-per-depth, anchored to a featureSize/spatial proxy with natural
  halving (`--ge-scale` / `--ge-layer`, default 1; an earlier ×16/×8 hack over-refined everything).
- **Bounding volumes** — emitted in the Z-up tileset frame (`RX+90°`), nested bottom-up
  (parent ⊇ children); root `RX(180°)` transform corrects the inverted-up artifact.
- Noise filtering made **opt-in** (`--opacity-filter`, `--max-scale-mult`, default off) — SparkJS
  renders the RAD without discarding splats, so we don't either by default.
- Processing-time estimate + actual-time logging.

### Added — viewer (`viewer.html`)
- Renderer toggle (CesiumJS / 3DTilesRendererJS-via-SparkJS); preset pills for every sample
  (RAD, SOG, LCC, COPC, PLY-comparison, alpha variants).
- SparkJS render settings on the 3DGS plugin (`maxStdDev=√8`, `blurAmount=0.3`); reaches the shared
  SparkRenderer to set `lodInflate`/`lodSplatScale`. 🪲 Debug tiles (boxes coloured by depth, dimmed).
  Max-SSE and FOV inputs; orbit/globe/env controls; Google-hybrid basemap default.

### Added — tooling & docs
- `tools-inspector/` (WilliamLiu 3DTiles-Inspector) with `npm run inspect:*` scripts.
- Local **build-lod** build recipe (rustup GNU + `rust-mingw` + `--no-default-features`) for the
  PLY→RAD→3DTiles comparison vs `3dgs-ply-3dtiles-converter`.
- `docs-references/`: `spz-format`, `KHR_gaussian_splatting(+_spz_2)`, `sog`, `streamed-sog`,
  `lcc-format`, `i3s-spec`, `nexus-format`, plus a top-of-README format-comparison table +
  per-format Mermaid diagrams.

### Known limitations
- **Spherical harmonics** not yet emitted (DC only) on any path — the largest remaining fidelity gap.
- LCC scale decode (v3 geometric vs v5 codebook) and SH still being finalised.
- Tile conversion is **single-threaded / sequential** (see README "Performance"); a worker pool is the
  obvious next optimization.
