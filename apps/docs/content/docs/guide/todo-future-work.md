---
title: "TODO / Future work"
description: "Roughly in the order we're tackling them:"
---

Roughly in the order we're tackling them:

- [ ] **Composable `tiling=explicit`.** The still-open, more invasive half of an earlier item (see
  "Streaming endpoint consolidation" in the [Design log](/docs/guide/streaming-architecture-design-log)):
  route `&tiling=explicit` for COPC/Potree-2.0
  *through* the existing `/3dtiles-tools?tool=implicit-to-explicit` tool against their own implicit
  `/stream` output, instead of each format's live adapter keeping a bespoke `buildTilesetExplicit`.
  Deferred until the consolidation above has settled — untested whether `implicit-to-explicit`'s generic
  walker round-trips cleanly against our own live implicit tilesets. (I3S dropped out of scope here: it
  was simplified to always-explicit directly, having no implicit representation worth composing through
  the tool.) `viewer.html`'s Tools → implicit-to-explicit demo now includes a Potree and a COPC example
  against our own prebuilt output as a stopgap — that's the tool working *against* our formats offline,
  not the live routing described here.
- [ ] **Port the middleware into 3DTilesRendererJS itself.** Today `packages/tile-server` sits in
  front of 3DTilesRendererJS/CesiumJS as an HTTP layer; the longer-term idea is a 3DTilesRendererJS
  **plugin** (in the spirit of its existing `ImplicitTilingPlugin`/`GaussianSplatPlugin`) that lets the
  renderer consume COPC, Potree, streamed-SOG, LCC, etc. **directly** — any 3D-Tiles-consuming app
  gets native support for these tiled formats without running a separate server process.

  **Design sketch (not implemented) — what's portable vs. Node-only.** Surveyed what each
  `packages/tile-server/*-live.js` adapter actually leans on:
  - **Range-reads via `fetch` + `Range` header** — portable as-is. `copc-live.js`/`potree-live.js`/etc.
    already use plain `fetch(url, { headers: { Range: ... } })`, no Node-specific HTTP client. Browsers
    support `Range` requests against any host that sends `Accept-Ranges`/honors the header identically.
  - **In-memory hierarchy caching** (`memoizeAsync`-wrapped per-URL context: COPC node maps, RAD chunk
    topology, etc.) — portable as-is. It's a plain `Map`/closure cache, nothing Node-specific; a browser
    tab has the same "cache for the life of this session" lifetime a server process does.
  - **glTF encoding via `@gltf-transform/core`** — portable; `@gltf-transform/core` is isomorphic
    (pure JS/typed-arrays, no `fs`), already used that way in other JS-ecosystem viewers.
  - **Not portable as-is: `remote-zip.js`'s SLPK unzip.** It calls `node:zlib`'s `inflateRawSync`
    directly (`packages/tile-server/remote-zip.js`) for the DEFLATE entries inside `.slpk` archives —
    that's a Node built-in with no browser equivalent. A browser build would need to swap in
    `pako`'s `inflateRaw` or the browser-native `DecompressionStream('deflate-raw')` API. Everything
    else I3S's live adapter does (range-fetch, JSON/binary parsing, LEPCC decode) is plain JS already.
  - **Plugin surface, matched against 3d-tiles-renderer's own `ImplicitTilingPlugin`**
    (`node_modules/3d-tiles-renderer/src/core/plugins/ImplicitTilingPlugin.js`): plugins are plain
    classes with an optional `init(tiles)` (receives the `TilesRenderer` instance),
    `preprocessNode(tile, tilesetDir, parentTile)` (mutate a tile as it's registered — e.g. mark
    unrenderable/implicit tiles), `parseTile(buffer, tile, extension)` (turn fetched bytes into
    renderable content for tiles this plugin owns), `preprocessURL(url, tile)` (rewrite a tile's
    content URL before fetching — this is where a COPC/Potree plugin would synthesize a per-node
    tile URL instead of relying on a server), and `disposeTile(tile)` (cleanup). A per-format plugin
    (`CopcPlugin`, `PotreePlugin`, `SogPlugin`, …) would likely: fabricate the root tileset JSON
    in-memory from the format's own header/hierarchy (what `*-live.js`'s `tileset.json` handler does
    today, minus the HTTP framing) and hand it to `tiles.rootURL`/a synthetic loader; use
    `preprocessURL`/`parseTile` to intercept per-node "URLs" that are really just node-IDs, range-fetch
    that node's bytes directly from the plugin, decode, and hand back a GLB `ArrayBuffer` — the same
    decode logic `*-live.js` already has, just invoked in-browser instead of behind an HTTP route.
  - **What's genuinely new work per format**: none of the *decoders* need rewriting (COPC/LAZ, SPZ,
    LEPCC, OpenCTM are already plain JS with no Node dependency beyond the SLPK unzip above) — the work
    is wrapping each `*-live.js`'s tileset-building + per-node logic behind the plugin hooks above
    instead of Express-style request handlers, and replacing the one `node:zlib` call. This is a design
    sketch, not a scoped work estimate — actually landing it means picking one format (COPC is the
    simplest tree) as a proof of concept before generalizing the pattern to the rest.
- [ ] **Idea (not scoped): a local desktop companion app for the middleware.** A Tauri app, distinct in
  shape from the `packages/tile-server` middleware above (that one is a live, no-storage, arbitrary-
  `<fmt>` pass-through server) — this would be local-first and personal instead: pick any source dataset
  in a format this repo already converts, convert it to 3D Tiles **on disk**, keep a local library of
  converted datasets, and serve them from a local HTTP server so their URL can be copied elsewhere —
  named explicitly for **Unreal Engine integration** (UE's Cesium-for-Unreal plugin, or similar, consumes
  a 3D Tiles URL directly). A gallery/browse view of already-converted local datasets would make it read
  as a personal dataset library, not a one-shot CLI wrapper. Purely an idea at this point — no design
  work, no scoping, not started.
- [ ] **Test fixtures from open data.** Pin the small, `sample-data/`-friendly open datasets this repo
  already references throughout (Autzen, Eiffel COPC tiles, Skatepark/Roman Parish streamed-SOG,
  Tastier RAD, Geghard, Tende 3MX, …) as versioned fixtures — either vendored into their own small
  GitHub repo(s) or referenced by stable upstream URL — so CI and new contributors get a reproducible
  test corpus instead of relying on live third-party hosts.
- [ ] **Find a real open-data `.3tz`/`.3dtiles` package.** `viewer.html`'s Packages pills currently only
  demo our own repo-packed `sample-data/input/3DTILES-PACKAGES/tastier.{3tz,3dtiles}` — we don't have a
  publicly-hosted example of either package format found in the wild to verify `/3dtiles-self-contained`
  against a real third-party `.3tz`/`.3dtiles` file, not just our own packer's output.
- [ ] **Real `3d-tiles-tools`: implicit↔explicit and glTF-to-3TILES packaging still missing.** The real,
  unscoped `3d-tiles-tools` npm package is now an actual dependency (`packages/3dtiles-tools`) and its
  tileset **upgrade** (1.0→1.1) is wired as `tool=upgrade-real` on `/3dtiles-tools` — see the Design log
  for how that landed and why it's a batch-then-serve-from-cache operation (the real package only
  supports local filesystem/`.3tz`/`.3dtiles` sources, no remote/streaming API). Still open: the same
  real package's **implicit↔explicit** conversion and **glTF-to-3TILES packaging** operations aren't
  wired to anything — worth the same `tool=<name>` treatment once there's a concrete need, following the
  `upgrade-real` pattern (mirror a remote source to a local temp dir first if needed, run the real
  package once, serve the result statically from a cache dir).
- [ ] **Test `/stream?cache=all`.** Recent verification passes (threemx/geosplats migration, uniform
  crop, ArcGIS I3S) only exercised `cache=none`. `cache=all` (routes to `/convert`, preprocess + cache
  the whole dataset) shares the same underlying adapters but hasn't been separately re-verified against
  the newer/changed formats.
- [ ] **Crop uniformity: georeferenced vs. non-georeferenced.** The `SPLAT_FLIP_BAKED` uniform-crop fix
  (see "`/extract`" above) was verified against georeferenced real-world tiles for LCC/SOG/RAD. Not yet
  separately verified: whether the same flip table holds for a **non-georeferenced** (local-frame, no
  ENU→ECEF root transform) source of each format — worth a dedicated pass before trusting it universally.
- [ ] **Encode ops remainder** — geometry encode (`/stream?transform=meshopt|draco`) and in-process
  KTX2 texture encode (`/stream?transform=ktx|ktx-uastc`) are done; still to add: **WebP** texture
  encode (needs a WASM webp encoder; `textureCompress(webp)` would pull in `sharp`, which we
  deliberately avoid), `simplify` / `weld` / `quantize` geometry ops, and exposing encode on the
  `/gltf` proxy (currently only `/stream` has it).
- [ ] **`rtc_center` / decompress for ingestion** — apply the existing per-tile decompress pipeline to
  *existing remote 3D Tiles* (not just our own output) so consumers that can't read Draco/KTX2/
  `CESIUM_RTC` (e.g. blender **BLOSM**) can load them.
- [ ] **Browser-native bbox crop / subsample extract** — pull a cropped/decimated copy of a tiled asset
  (point cloud, mesh, or splat) by an OBB defined in the viewer — BLOSM-style but JS/browser-native.
  See the dump-tiles feature idea (memory). **Refinement-aware traversal**: for **ADD** octrees
  (COPC/Potree) accumulate all points down to the desired geometric error within the OBB; for
  **REPLACE** trees (3D Tiles mesh) descend only where a parent's GE still exceeds the target. **Point
  clouds** → **hand-written LAS** (streamable, O(1) RAM even for 500 GB via header back-patch —
  `core/las-writer.js`, built) → shell to **`pdal writers.copc` / untwine** (out-of-core) for
  LAZ/COPC. **Meshes** → merge tile GLBs (geometry+UV+texture) via glTF-Transform → a binary mesh
  (glb/USD/USDZ). No JS/WASM LAS *writer* exists (node-las is archived; entwine/untwine are C++-only)
  and `laz-perf` WASM is decode-only — so hand-write + native CLI.
- [ ] **3MX siblings** — add Bentley **ContextCapture / Scalable Mesh** (`.3sm`) next to 3MX
  ([Bentley docs](https://docs.bentley.com/LiveContent/web/ContextCapture%20Help-v18/en/GUID-569C1E44-D86A-4942-9ABE-36C33FB5A7EB.html);
  cf. [OctopusET/mxmxmx2tiles](https://github.com/OctopusET/mxmxmx2tiles)). Working 3MX test: Tende
  village (dept06).
- [ ] **Server-side per-cache progress** — the eager-drain (`cache=hierarchy`) and convert
  (`cache=full`) loops need a job-progress endpoint the viewer can poll (the timing-log modal already
  renders client milestones).
- [ ] **Draco+KTX2 decode speed** — the per-tile decode (~250 ms/tile) can be cut by (1) **passing
  KTX2 through untouched** when the consumer reads it, (2) emitting **WebP** (WASM encoder) instead of
  `pngjs` PNG, (3) reusing decoder/transcoder instances across tiles, (4) a worker-thread pool. pngjs
  PNG-encode of the ~1.4 MB RGBA is the main avoidable cost.
- [ ] **I3S: remaining gaps.** Mesh **Draco** geometry compression has no decoder (gated); DDS/KTX2/
  Basis-encoded textures have no decoder (JPEG/PNG base-color textures ARE embedded already); per-feature
  attributes are dropped (no `EXT_mesh_features`/metadata mapping); the legacy per-node
  `3dNodeIndexDocument` index (pre-1.7) isn't read; **Point** (symbol/instance) and **Building**
  (composite) layers aren't handled (only `IntegratedMesh`/`3DObject`/`PointCloud`); only WGS84-geographic
  vertex placement is implemented (**projected/vertical CRS** placement is not); and per-vertex
  **normals are left in the source frame** (not re-oriented to ECEF — affects lit shading only).
- [ ] **`WorkerPool` (`worker_threads`) tier not wired.** All converters currently use only the
  async-gzip + `parallelMap` tier (main-thread decode on the libuv pool) — see
  ["Parallelism (per converter)"](/docs/guide/architecture-the-materialization-continuum-cache-none-hierar)
  for the per-converter breakdown of what's worker-extractable. True multicore decode (the WASM/CPU-bound
  decoders — LAZ, WebP, brotli) is unused headroom; the pure-JS decoders (rad, lcc, potree) stand to gain
  the most since they're single-core-bound today.
- [ ] **Spherical harmonics (view-dependent color) for Gaussian splats.** Every splat converter
  (RAD/LCC/SOG/GeoSplats) currently emits **DC-only** color — the source formats' higher-order SH bands
  are decoded-and-discarded (or never touched) on the way to a 3D Tiles GLB, so specular/view-dependent
  appearance is lost.

  **Design sketch (not implemented) — this is a design note, not a work-estimate promise.**
  - **What each format actually stores** (per this repo's own reference docs):
    - **RAD** (`apps/docs/content/docs/references/rad-format-notes.md`) — per-splat LoD tree; the
      converter notes don't document an `sh1`/higher-band column explicitly beyond opacity/orientation/
      scale decode, so the first step for RAD specifically would be confirming which SH bands (if any)
      the monolithic `.rad` chunk layout actually persists before designing a carry-through path —
      flagged here as a gap in the existing notes, not assumed absent.
    - **LCC** (`apps/docs/content/docs/references/lcc-format.md`) — `Shcoef.bin`, present only when
      `fileType: "Quality"` (absent for `"Portable"`). **64 bytes/splat = 15 packed-11 coefficients**
      (`sh1`..`sh15`), decoded via `DecodePacked11` then lerped through `attributes.shcoef` min/max —
      i.e. **SH degree 3** (3 coefficients × RGB × ... the doc counts 15 coeffs total, matching degree-3's
      15 AC terms). Already positionally mapped in the doc's own "planned `lcc-to-3dtiles`" section as
      "SH (Quality) → KHR `SH_DEGREE_*` attributes" — i.e. the target mapping is already anticipated,
      just not implemented.
    - **SOG** (`apps/docs/content/docs/references/sog.md`) — optional `shN_centroids.webp` +
      `shN_labels.webp` palette: `bands ∈ [1,3]` → **3, 8, or 15 coefficients/channel** (degree 1/2/3),
      16-bit per-Gaussian label indexing a 64-entry-per-row centroid palette, each channel itself a
      codebook index into a shared 256-float `shN.codebook`. Two levels of indirection (label → centroid
      row → codebook value) versus LCC's direct packed-11 lerp.
    - **GeoSplats** — not covered by its own dedicated format-notes doc in `references/` the way
      RAD/LCC/SOG are (it's built on SOG octants per the MapTiler GeoSplats memory notes), so its SH
      story is presumably SOG's `shN_*` mechanism inherited as-is — needs confirming against the actual
      GeoSplats reference doc before design, not assumed here.
  - **What the OUTPUT side needs**: `apps/docs/content/docs/references/KHR_gaussian_splatting.md`
    (Khronos Release Candidate, 2026) already defines the extension attributes for this —
    `KHR_gaussian_splatting:SH_DEGREE_1_COEF_[0-2]` (VEC3 float, degree 1), `..._DEGREE_2_COEF_[0-4]`
    (degree 2), `..._DEGREE_3_COEF_[0-6]` (degree 3) — all listed **optional** attributes alongside the
    required POSITION/SCALE/ROTATION/OPACITY/`SH_DEGREE_0_COEF_0`. So the glTF-side target already
    exists and needs no new extension design — it's a matter of populating additional accessors that
    the spec already reserves. Degree-3 sources (LCC Quality, SOG `bands:3`) map directly onto the
    extension's own degree-3 ceiling; nothing in RAD/LCC/SOG currently claims degree 4 (SPZ v4 does,
    per this doc's own SPZ roadmap section below, but that's a different source format not yet a
    converter input).
  - **Rough per-converter work sketch**: for LCC and SOG this looks like "carry the extra bytes through
    and write new glTF accessors" rather than a geometry re-derivation — both formats already deliver
    SH coefficients in a fixed per-splat layout that only needs dequantizing (LCC: packed-11 lerp,
    already documented; SOG: label→centroid→codebook, two indirections but no new math) and writing
    into `VEC3 float` accessors matching the extension's `SH_DEGREE_n_COEF_m` semantics — no
    re-deriving normals or a new basis, since the SH basis is defined relative to the existing splat
    rotation/scale the converters already decode. RAD needs the "does the format even carry this"
    question answered first. Quantized (non-float) accessor types aren't listed as allowed for the SH
    attributes in the extension table above (only POSITION/SCALE/ROTATION/OPACITY list
    byte/short/normalized variants) — so output accessors would be plain `float`, meaning the main
    per-converter cost is likely the extra GLB payload size (degree-3 = 15 extra VEC3-float attributes
    per splat) more than decode complexity. This is a sketch to scope future work, not a commitment to
    a specific implementation order or timeline.

### Inspected, no tiled splat/generic format found

A quick pass over other capture/scanner ecosystems, looking for a *tiled* (multi-file, LOD-hierarchy)
splat or generic point/mesh format worth adding an adapter for — none surfaced. Not deeply
independently researched (a web-search-depth pass, not a spec audit like the sources in
`docs-references/`), so treat as a starting point, not a verdict:
- **Niantic Scaniverse** — exports single-file GLB/USDZ/OBJ/PLY splat or mesh scans; no multi-file tiled
  hierarchy format found *today*. Worth revisiting: SPZ's own roadmap (see "SPZ v4/v5 roadmap" below)
  states v5 aims to add **spatial chunking and LOD** — Scaniverse is SPZ's reference exporter, so a
  future Scaniverse export could plausibly become tiled once v5 ships.
- **ESRI tiled data** beyond I3S (already supported) — didn't find another ESRI *tiled point-cloud/mesh*
  format distinct from I3S worth a separate adapter. Note ESRI's **3D Tiles Server** product (distinct
  from I3S) *does* publish Gaussian-splat 3D Tiles directly — see the I3S section above; that's not a
  new format to adapt, it's already OGC 3D Tiles.
- **Bentley/other Bentley services** — ContextCapture emits **3MX** (already supported); didn't find a
  second Bentley tiled format beyond that and standard **Cesium 3D Tiles** (already the target format).
- **Autodesk ReCap `.rcp`/`.rcs`** — already tracked as blocked (see the point-cloud adapter tiers
  above): no open reader/writer, not itself a *tiled* container in the sense the other formats here are.
- **Laser scanner vendors (Leica, Faro, Matterport)** — proprietary single-project registration formats
  (Leica `.lgs`/e57 export, Faro `.fls`/`.fws`, Matterport's own cloud pipeline); no publicly documented
  *tiled* multi-LOD format surfaced for any of the three.
- **Gauzilla Pro** — a Gaussian-splat viewer/tool, not a distinct tiled storage format of its own (reads/
  writes standard PLY/SPZ-family splat files as far as could be found).
- **DJI Terra / DJI Reality** — DJI's photogrammetry/splat reconstruction software; ships a web viewer
  at `3dviewer.dji.com` (the specific link checked was **stale/unreachable**, so this couldn't be
  confirmed directly). Plausibly a *tiled HLOD* splat format given DJI Reality targets large drone-scale
  captures (the same scale problem GeoSplats/RAD/LCC solve with HLOD), but unverified — flagged here as
  a format worth investigating once a live viewer link is found, not a confirmed adapter target.

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
one — worth a re-check once v5 actually publishes something concrete to read against, not before.

---
