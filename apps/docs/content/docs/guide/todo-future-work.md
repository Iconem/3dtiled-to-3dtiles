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
- [x] ~~Dockerize the server~~ — **done** (2026-07-02): `Dockerfile` (multi-stage: `tile-server` +
  `viewer`), `docker-compose.yml`, and `.github/workflows/docker-publish.yml` (builds + pushes both to
  **GHCR** on release, plus a `:main` tag on every push). `docker compose up --build` runs the whole
  stack. Verified end-to-end (both images build, both containers serve real traffic — including a live
  ArcGIS SceneServer tileset through the containerized tile-server). Building this surfaced three
  real, pre-existing bugs, all fixed alongside it: `pnpm-lock.yaml` was out of sync with
  `copc-to-3dtiles/package.json` (see the `@cesium/3d-tiles-tools` note above), Docker builds ignored
  `.npmrc`'s `node-linker=hoisted` (which the converters' cross-package imports depend on), and
  `vite build` silently never bundled `viewer.html` at all (only its own `index.html` redirect stub) —
  fixed via `build.rollupOptions.input` + `build.target: 'esnext'` (top-level await) in
  `vite.config.mjs`. Not yet done: an actual Portainer/Traefik reverse-proxy stack — the images publish
  to GHCR, but wiring them into a specific reverse-proxy setup is left to whoever deploys this.
- [ ] **Fumadocs migration.** This README has grown large enough to want a real table-of-contents /
  docs-site split (ambition vs. live features vs. format specs vs. raw findings) — see the note at the
  top of this document. Made more tractable by the fact that most of the deep material already lives
  in its own file under `docs-references/` — this is largely *chunking* existing docs, not writing new
  ones.
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
