---
title: "TODO / Future work"
description: "Roughly in the order we're tackling them:"
---

Roughly in the order we're tackling them:

- [x] ~~`copc-to-3dtiles`: `--explicit` flag (one tile per COPC node instead of 3D Tiles 1.1 implicit
  tiling, for viewers without implicit-tiling support)~~ — **done**: both the offline converter and
  `/stream?format=copc` already take `--tiling explicit|implicit` / `?tiling=explicit`, default
  implicit. (This item had gone stale in the TODO list after being implemented.)
- [x] ~~Streaming endpoint consolidation~~ — **done** (2026-07-02): `/stream` reads `cache=none|hierarchy`
  (not `hierarchy=eager|lazy`); the old per-format aliases (`/copc`, `/potree`, `/sog`, `/lcc`, `/rad`,
  `/i3s`) are gone (verified redundant with `/stream/tileset.json?format=<fmt>`); `/tiles` dispatches
  to `/stream`/`/convert` in-process instead of a 307 redirect; Potree 1.x's `tiling=explicit`, and RAD
  and I3S entirely, were simplified to full materialization instead of per-chunk/lazy-fragment
  continuation routes; `/dump` was renamed `/extract` (clearer, less overloaded name). See "Endpoint
  rework" above and the CHANGELOG.
- [ ] **Composable `tiling=explicit`.** The still-open, more invasive half of the item above: route
  `&tiling=explicit` for COPC/Potree-2.0 *through* the existing `/3dtiles-tools?tool=implicit-to-explicit`
  tool against their own implicit `/stream` output, instead of each format's live adapter keeping a
  bespoke `buildTilesetExplicit`. Deferred until the consolidation above has settled — untested whether
  `implicit-to-explicit`'s generic walker round-trips cleanly against our own live implicit tilesets.
  (I3S dropped out of scope here: it was simplified to always-explicit directly, having no implicit
  representation worth composing through the tool.) `viewer.html`'s Tools → implicit-to-explicit demo
  now includes a Potree and a COPC example against our own prebuilt output as a stopgap — that's the
  tool working *against* our formats offline, not the live routing described here.
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
- [~] **Fumadocs migration — scaffolded** (2026-07-02), content migration started. `apps/docs`
  (a proper pnpm workspace member, `pnpm --filter docs dev` on port 3002) is a real, building
  Fumadocs/Next.js site: `README.md`'s 18 `##` sections and all 25 `docs-references/*.md` files are
  chunked into `content/docs/guide/*.md` and `content/docs/references/*.md` respectively (mechanical
  per-file/per-section split, `.md` not `.mdx` so `<SRC>`-style placeholder syntax throughout this repo's
  prose doesn't get misparsed as JSX) — verified rendering correctly (sidebar nav, in-page TOC, code
  blocks, checkboxes/strikethrough) via a full `next build` + dev-server check. **Not yet done**: the
  chunking is a first pass (one page per original heading, unreviewed boundaries — see `apps/docs/README.md`
  for the concrete next steps), no cross-linking between guide/reference pages, and `README.md` (not the
  new site) is still the canonical, most-current source until the migration catches up.
- [ ] **Port the middleware into 3DTilesRendererJS itself.** Today `packages/tile-server` sits in
  front of 3DTilesRendererJS/CesiumJS as an HTTP layer; the longer-term idea is a 3DTilesRendererJS
  **plugin** (in the spirit of its existing `ImplicitTilingPlugin`/`GaussianSplatPlugin`) that lets the
  renderer consume COPC, Potree, streamed-SOG, LCC, etc. **directly** — any 3D-Tiles-consuming app
  gets native support for these tiled formats without running a separate server process.
- [ ] **Test fixtures from open data.** Pin the small, `sample-data/`-friendly open datasets this repo
  already references throughout (Autzen, Eiffel COPC tiles, Skatepark/Roman Parish streamed-SOG,
  Tastier RAD, Geghard, Tende 3MX, …) as versioned fixtures — either vendored into their own small
  GitHub repo(s) or referenced by stable upstream URL — so CI and new contributors get a reproducible
  test corpus instead of relying on live third-party hosts.
- [ ] **Find a real open-data `.3tz`/`.3dtiles` package.** `viewer.html`'s Packages pills currently only
  demo our own repo-packed `sample-data/input/3DTILES-PACKAGES/tastier.{3tz,3dtiles}` — we don't have a
  publicly-hosted example of either package format found in the wild to verify `/3dtiles-self-contained`
  against a real third-party `.3tz`/`.3dtiles` file, not just our own packer's output.
- [x] ~~Add a generic CORS proxy~~ — done (2026-07-02): `/proxy?url=<source>`, tileset-aware
  `content.uri` rewriting so nested children keep routing through it. Fixes the Agisoft Jam pill (its
  host sends no CORS header at all, on any resource). See "`/proxy`" above.
- [x] ~~I3S: SLPK support~~ — the SLPK-archive code path already existed in `i3s-live.js`
  (`@loaders.gl/i3s`'s `parseSLPKArchive`) but only ever triggered on a URL literally ending in `.slpk`
  — ArcGIS Online's own download endpoint (`.../content/items/<id>/data`) has no `.slpk` anywhere in the
  URL (the real filename only shows up in a `Content-Disposition` header). Fixed 2026-07-02: sniff the
  first bytes for the PKZIP magic (`PK`) when the URL doesn't already look like JSON, so any zip-shaped
  response is detected regardless of URL shape.
- [x] ~~I3S: mesh textures rendering black~~ — done (2026-07-02). Two separate things were wrong:
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
- [ ] **Standalone React + Vite viewer app.** Port `viewer.html`'s functionality (format/cache/prefetch/
  transform/option/model top-bar pills, the full sidepanel — renderer choice, basemap, tileset/LOD,
  crop & extract, navigation, local frame — CesiumJS + 3DTRJS rendering, and a link to the new Fumadocs
  site) into a proper React app under `apps/viewer` (or similar), built with shadcn/ui for every input/
  label/select. `viewer.html` stays as-is alongside it during the transition — this is a rewrite, not a
  replace-in-place. See the architecture plan below before implementation starts.

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
