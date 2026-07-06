---
title: "TODO / Future work"
description: "Roughly in the order we're tackling them:"
---

Roughly in the order we're tackling them:

- [ ] **Composable `tiling=explicit`.** The still-open, more invasive half of an earlier item (see
  "Streaming endpoint consolidation" in Done, below): route `&tiling=explicit` for COPC/Potree-2.0
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
- [ ] **Test fixtures from open data.** Pin the small, `sample-data/`-friendly open datasets this repo
  already references throughout (Autzen, Eiffel COPC tiles, Skatepark/Roman Parish streamed-SOG,
  Tastier RAD, Geghard, Tende 3MX, …) as versioned fixtures — either vendored into their own small
  GitHub repo(s) or referenced by stable upstream URL — so CI and new contributors get a reproducible
  test corpus instead of relying on live third-party hosts.
- [ ] **Find a real open-data `.3tz`/`.3dtiles` package.** `viewer.html`'s Packages pills currently only
  demo our own repo-packed `sample-data/input/3DTILES-PACKAGES/tastier.{3tz,3dtiles}` — we don't have a
  publicly-hosted example of either package format found in the wild to verify `/3dtiles-self-contained`
  against a real third-party `.3tz`/`.3dtiles` file, not just our own packer's output.
- [ ] **`/convert`-equivalent for `3d-tiles-tools`.** `3d-tiles-tools` (the real, unscoped npm package —
  see the dependencies note above) isn't wired up as a dependency anywhere in this repo despite being
  referenced in prose. Worth a `/convert`-style endpoint that shells out to / calls it directly (tileset
  upgrade, implicit↔explicit, glTF-to-3TILES packaging, etc. — whatever it covers that our own
  `/3dtiles-tools` endpoint's hand-rolled `implicit-to-explicit`/`upgrade` ops don't), mirroring how
  `/convert` relates to `/stream`: one endpoint per capability tier.
- [ ] **Test `/stream?cache=all`.** Recent verification passes (threemx/geosplats migration, uniform
  crop, ArcGIS I3S) only exercised `cache=none`. `cache=all` (routes to `/convert`, preprocess + cache
  the whole dataset) shares the same underlying adapters but hasn't been separately re-verified against
  the newer/changed formats.
- [ ] **Crop uniformity: georeferenced vs. non-georeferenced.** The `SPLAT_FLIP_BAKED` uniform-crop fix
  (see "`/extract`" above) was verified against georeferenced real-world tiles for LCC/SOG/RAD. Not yet
  separately verified: whether the same flip table holds for a **non-georeferenced** (local-frame, no
  ENU→ECEF root transform) source of each format — worth a dedicated pass before trusting it universally.
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

## Done

Completed items, moved out of the active list above but kept for history/context.

- [x] ~~`copc-to-3dtiles`: `--explicit` flag~~ (one tile per COPC node instead of 3D Tiles 1.1 implicit
  tiling, for viewers without implicit-tiling support) — **done**: both the offline converter and
  `/stream?format=copc` already take `--tiling explicit|implicit` / `?tiling=explicit`, default
  implicit. (This item had gone stale in the TODO list after being implemented.)
- [x] ~~Streaming endpoint consolidation~~ — **done** (2026-07-02): `/stream` reads `cache=none|hierarchy`
  (not `hierarchy=eager|lazy`); the old per-format aliases (`/copc`, `/potree`, `/sog`, `/lcc`, `/rad`,
  `/i3s`) are gone (verified redundant with `/stream/tileset.json?format=<fmt>`); `/tiles` dispatches
  to `/stream`/`/convert` in-process instead of a 307 redirect; Potree 1.x's `tiling=explicit`, and RAD
  and I3S entirely, were simplified to full materialization instead of per-chunk/lazy-fragment
  continuation routes; `/dump` was renamed `/extract` (clearer, less overloaded name). See "Endpoint
  rework" above and the CHANGELOG.
- [x] ~~Migrate `/threemx` and `/geosplats` into `/tiles`~~ — **done** (2026-07-02): both are now
  `/stream`'s `ADAPTERS` registry entries (`format=threemx`/`format=geosplats`), so they get the
  unified `cache=`/`/tiles` vocabulary like every other format. The old standalone `/threemx`,
  `/geosplats` endpoints are gone. 3MX keeps its own lazy per-`.3mxb` continuation route
  (`/stream/threemx/node/<path>.json`) — unlike RAD/I3S, 3MX is a genuine DAG with no persisted
  spatial index, so eager-scanning the whole tree isn't cheap.
- [x] ~~Dockerize the server~~ — **done** (2026-07-02, extended 2026-07-03): `Dockerfile` (multi-stage:
  `tile-server` + `viewer` + `docs`), `docker-compose.yml`, and `.github/workflows/docker-publish.yml`
  (builds + pushes all three to **GHCR** on release, plus a `:main` tag on every push).
  `docker compose up --build` runs the whole stack. Verified end-to-end (all three
  images build, all three containers serve real traffic — including a live ArcGIS SceneServer tileset
  through the containerized tile-server, and real Fumadocs pages through the `docs` container). Building
  this surfaced four real, pre-existing bugs, all fixed alongside it: `pnpm-lock.yaml` was out of sync
  with `copc-to-3dtiles/package.json` (see the `@cesium/3d-tiles-tools` note above), Docker builds
  ignored `.npmrc`'s `node-linker=hoisted` (which the converters' cross-package imports depend on),
  `vite build` silently never bundled `viewer.html`/`vanilla-viewer.html` at all (only its own
  `index.html` redirect stub) — fixed via `build.rollupOptions.input` + `build.target: 'esnext'`
  (top-level await) in `vite.config.mjs`/`vite.config.ts` — and (2026-07-03) `apps/docs`'s
  `next start` couldn't find its own `next` binary in the final runtime stage (hoisted node-linker puts
  it in the ROOT `node_modules/.bin`, not `apps/docs/node_modules/.bin`, and that stage never copies
  `pnpm-workspace.yaml` for `pnpm run start` to resolve the workspace root either) — fixed by putting
  the root `.bin` on `PATH` and invoking `next` directly, skipping pnpm in that stage.
  `docker-compose.yml` itself stays reverse-proxy-agnostic (plain `ports:` on all three, no assumed
  setup) — wiring it behind Traefik/Caddy/nginx with real domains is left to whoever deploys it; the
  compose file's own comment on the `docs` service spells out which paths need to route there instead
  of to `viewer` if you do.
- [x] ~~Fumadocs migration~~ — **done** (scaffolded 2026-07-02, functionally complete 2026-07-06).
  `apps/docs` (a proper pnpm workspace member, `pnpm --filter docs dev` on port 3002) is a real, building
  Fumadocs/Next.js site: `README.md`'s 18 `##` sections and all 25 `docs-references/*.md` files are
  chunked into `content/docs/guide/*.md` and `content/docs/references/*.md` respectively (mechanical
  per-file/per-section split, `.md` not `.mdx` so `<SRC>`-style placeholder syntax throughout this repo's
  prose doesn't get misparsed as JSX) — verified rendering correctly (sidebar nav, in-page TOC, code
  blocks, checkboxes/strikethrough) via a full `next build` + dev-server check. The 18 guide + 25
  reference files are now cross-linked (`format-comparison.md` links every format to its reference-page
  mirror, `documentation.md` cross-references, 11+ files carry internal `/docs/guide/`/`/docs/references/`
  links), and the root `README.md` was trimmed to a pitch + quickstart pointing at the docs site (see
  the Docker item above) — the docs site is now the canonical source, not README.
- [x] ~~Add a generic CORS proxy~~ — **done** (2026-07-02): `/proxy?url=<source>`, tileset-aware
  `content.uri` rewriting so nested children keep routing through it. Fixes the Agisoft Jam pill (its
  host sends no CORS header at all, on any resource). See "`/proxy`" above.
- [x] ~~I3S: SLPK support~~ — **done**. The SLPK-archive code path already existed in `i3s-live.js`
  (`@loaders.gl/i3s`'s `parseSLPKArchive`) but only ever triggered on a URL literally ending in `.slpk`
  — ArcGIS Online's own download endpoint (`.../content/items/<id>/data`) has no `.slpk` anywhere in the
  URL (the real filename only shows up in a `Content-Disposition` header). Fixed 2026-07-02: sniff the
  first bytes for the PKZIP magic (`PK`) when the URL doesn't already look like JSON, so any zip-shaped
  response is detected regardless of URL shape.
- [x] ~~I3S: mesh textures rendering black~~ — **done** (2026-07-02). Two separate things were wrong:
  (1) textures were **never implemented** at all — `uv0` was decoded from the geometry buffer and then
  silently dropped before reaching the glTF writer, and no texture image was ever fetched (an explicit,
  documented scope-gate, not a bug). Added: `materialDefinitions`/`textureSetDefinitions` lookup (picks
  a browser-native `jpg`/`png` format when the layer offers one; DDS/KTX2/Basis-only layers are gated
  out the same way Draco/LEPCC are — geometry still renders, untextured), texture fetch via the same
  per-node resource bucket geometry uses (`nodes/<res>/textures/<name>.bin`, uniform across the SLPK/
  REST-dir/live-SceneServer source modes), and a `TEXCOORD_0` accessor + embedded image/material in
  `glbBuild.js`. (2) A genuine **pre-existing bug** in `glbBuild.js`'s binary-buffer assembly: the
  running byte offset was reset to each bufferView's own padded length (`offset = padded`) instead of
  accumulating (`offset += padded`) — a no-op for 2-view outputs (POSITION+COLOR_0 point clouds) but
  silently corrupting every bufferView from the 3rd onward once meshes had POSITION+NORMAL+COLOR_0 (and
  worse once TEXCOORD_0+image were added) — the actual root cause of the reported all-black textures.
  Verified live against the real ArcGIS Rancho Mesh SceneServer (JPEG magic bytes at the correct offset,
  full-color textured mesh rendering in the viewer).
- [x] ~~I3S: LEPCC decompression~~ — **done** (2026-07-06). Ported Esri's own open-source
  `github.com/Esri/lepcc` (Apache-2.0) XYZ decoder to pure JS (`packages/i3s-to-3dtiles/src/
  lepccDecode.js`) — the earlier "no public bitstream spec / no open-source decoder" note was wrong;
  Esri does publish a small, actively-maintained reference decoder, just not under the LERC name.
  Verified against real ArcGIS-hosted PointCloud layers (Moro Bay LiDAR, USGSNYC 2014 LiDAR): checksum
  + blob-size match, decoded coordinates sane vs. the layer's own extent. See the I3S reference page's
  "LEPCC point-cloud decoding" section for the format writeup. Scope: XYZ position only — RGB/Intensity
  are separate LEPCC blob types, not yet ported (no dataset found so far that both declares one AND
  actually serves the underlying attribute resource — Moro Bay's own `RGB` attribute 404s server-side
  despite being advertised in its schema). Fixing this also surfaced a SEPARATE, unrelated bug: every
  I3S PointCloud tileset (LEPCC or not) was silently building as root-only, because PointCloud node
  pages express children via `firstChild`+`childCount` instead of mesh layers' explicit `children:[…]`
  array — fixed the same day, see "I3S: PointCloud tree" below.
- [x] ~~I3S: PointCloud tree building as root-only~~ — **done** (2026-07-06). Root-caused: PointCloud
  node pages (I3S v2.0) carry `firstChild`+`childCount`, not the `children:[idx…]` array mesh node
  pages use — the tile builder only ever read `.children`, so every point-cloud tileset (live
  SceneServer or `.slpk`) silently stopped at the root. This was also the real explanation for an
  earlier "Moro Bay `.slpk` exposes a single root node" finding — same bug, not a property of that
  archive. Fixed via a shared `childIndices()` helper in `i3sParse.js`, used by both `i3s-live.js` and
  the offline draft converter. Verified: Moro Bay SceneServer 1 → 13,775 tiles, its `.slpk` 1 → 2,624.
- [x] ~~Standalone React + Vite viewer app~~ — **done** (2026-07-06). `apps/viewer` (React) now has full
  feature parity with the legacy `viewer.html`/`vanilla-viewer.html`: all 11 format preset pills
  (COPC/Potree/SOG/LCC/GeoSplats/RAD/3D Tiles/Packages/I3S/3MX/Bing), renderer choice (Cesium/3DTRJS),
  basemap/terrain, LOD controls, crop & extract (format-aware as of 2026-07-06), Local Frame, and
  navigation are all ported. The legacy HTML files are kept only as historical reference — no unique
  functionality remains there that isn't also in `apps/viewer`.

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
