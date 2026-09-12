# Changelog

All notable changes to **3dtiled-to-3dtiles** are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added / Fixed — 2026-09-12 (aggregate demo sets · truncation reasons · native file picker · packaging)
- **Added: `/aggregate?set=opendata|angkor|world`** — curated demo mosaics of real, public, key-less
  tilesets, defined server-side so the viewer, docs and desktop app share one list instead of three
  copies drifting apart. `GET /aggregate/demo.json` indexes them; `?set=` composes with `?url=`.
  `opendata` is the ten datasets from 3D Tiles' own `RESOURCES.md` (four continents, and all three
  `boundingVolume` kinds — `region`, `box`, `sphere`); `angkor` is Iconem's campaign as **23
  individual site tilesets**; `world` is both. All 33 probed before being added; 33/33 reachable.
- **The Angkor set is the partitioning proof.** The sites are not uniformly spread — 19 inside the
  Angkor park, four at PhnomKulen ~30 km north-east — and nothing tells the aggregator that; it sees
  23 bounding spheres. It splits them at the root anyway, and the innermost Angkor group it forms is
  Bayon + Baphuon + Phimeanakas, i.e. exactly the monuments **inside Angkor Thom's walls**. Root
  fanout 23 → 2, depth 8 geodetic / 7 mercator. Against the hand-authored merged root in the
  explorer: same 23 datasets, **max fanout 23 → 8**, costing 3 levels of depth.
- **Fixed: `/stats` said “truncated” without saying why.** Three budgets can stop a walk and the fix
  differs for each, so the response now carries `truncatedBy: ["nodes"|"depth"|"external"]` plus the
  `limits` actually applied, and `&maxExternal=` is tunable (was a hidden constant of 64). This was
  not cosmetic: **RAD Coit reported 2 296 nodes under a 20 000-node budget** and the reason was
  invisible — it had exhausted external-tileset refs at 64, not nodes. `/aggregate` mosaics hit the
  same cap, being made of external refs.
- **Answered with data, not guesses: the small tile counts are mostly real.** LCC Big Mirror → 3
  tiles, `truncatedBy: []`, `maxFanout: 1`. RAD Tastier → 11 tiles is a genuinely small 500 k-splat
  scene. Only RAD Coit was misleading, per the item above.
  **Correction (same day):** an earlier version of this entry explained Big Mirror as *"LCC is not an
  octree, so the adapter emits a LoD chain"*. That is wrong. LCC **is** hierarchical — `index.bin`
  packs each **Unit** as a grid cell, and the adapter emits *root → one child per Unit → a REPLACE
  LoD chain per Unit*, so root fan-out is the Unit count. Big Mirror is a **single-Unit** capture.
  Guan Temple (11.4 M splats) through the same adapter: **155 nodes, fan-out 41, depth 4**.
- **Added: explorer depth cap, external cap, Reload all, and demo presets.** The depth cap doubles as
  a display control — capping at level 8 keeps a deep tileset's top structure legible instead of
  burying it under 4 000 leaves. Options apply to newly added tilesets and **Reload all** re-walks
  the rest, rather than auto-refiring N remote walks on every dropdown change.
- **Added: a `⌗ hierarchy` button in the viewer top bar** that forwards the currently-loaded tileset.
  It sends the *resolved* URL, not the input field: in `raw url` mode the field holds a bare dataset
  (`…/cloud.js`), which `/stats` cannot walk — only the wrapped middleware URL can be.
- **Fixed: two explorer labels.** `?set=` mosaics showed `aggregate ×?` (nothing to count, since the
  set expands server-side) and a UUID filename showed raw; both now resolve to something readable.
- **Added: a native file picker in the desktop app** — File… / Folder… over RPC to the main process.
  It must be the main process: a webview `<input type=file>` yields a sandboxed `File` with no real
  path, and the middleware needs a filesystem path. Two buttons because tree formats are a folder and
  single-file formats are a file, and one Windows dialog cannot offer both. Construction is guarded
  so the same bundle still renders outside an Electrobun host (the buttons hide).
- **Packaging now works, and the blocker was upstream.** Electrobun **2.0.1 (current stable) cannot
  package on Windows**: it pins cottontail 0.5.0, whose windows-x64 release ships `cottontail.exe`
  but not the `cottontail-core` its own build step copies → `CopySourceMissing`. Pinned
  `2.0.2-beta.20` (cottontail 0.7.0-canary.2), and verified **both `dev` and `build`** on it —
  producing `3D Tiled-Setup.exe`, a 20 MB installer zip and an update bundle. Also: the build must
  run from **PowerShell, not MSYS**, where `tar` reads `C:\…` as a remote host.
  Signing is configured but **off by default and unverified** — no certificate in this repo.
- **Fixed: a HiDPI regression I had introduced.** Widening the desktop container from 720 px to
  1000 px re-broke the documented Windows clipping — on a 1120 px window at 150 % scaling the right
  column, including the new Browse buttons, was simply never on screen. A plain-browser preview
  cannot reveal this (no DPI mismatch); only running the real app did. Reverted, with the constraint
  written into the CSS so it does not get "improved" again.

### Added / Fixed — 2026-09-11c (geodetic nesting · hierarchy explorer · desktop library · Potree write-up)
- **Added: `/aggregate&nest=geodetic`, and the distinction it exists to make.** "Morton order" and
  "web-mercator quadtree" are not the same thing: Morton (Z-order) is an *addressing* scheme —
  interleave a cell's x/y bits — and says nothing about the projection. Bing's quadkey is the base-4
  Morton code of a **web-mercator** cell; 3D Tiles implicit tiling (and therefore Cesium) subdivides
  the **root bounding volume in its own coordinate space** — for a `region`, "`x`, `y`, and `z` refer
  to `longitude`, `latitude`, and `height`", bisected arithmetically — i.e. a **geodetic** quadtree
  (Cesium's `GeographicTilingScheme`, 2×1 cells at level 0) merely *indexed* with Morton codes. So
  Cesium's Morton order is **not** a mercator quadtree. Both schemes are now offered (`mercator`
  stays the `auto` default; `geodetic`/`morton`/`implicit`/`cesium` selects the other), and every
  group and dataset carries an `extras.cell` breadcrumb (`scheme`, path `key`, `level`, `morton`) so
  "why is this grouped here" is answerable from the tileset alone.
- **Fixed: `/aggregate` silently lost more than half its children at scale.** Firing all children at
  once with a plain `Promise.allSettled` is fine for 12 and broken for 500: a 500-dataset mosaic came
  back with **232 datasets and 268 bare `fetch failed` entries** — still answering `200`, because
  failed children degrade into `asset.extras.failed` by design. It looked fine and was missing half
  the world, and the survivors varied run to run, so the tree was not even reproducible. Child
  fetches now run through a **16-way pool**: 500/500, identical tree cold and warm.
- **Fixed: flat `/aggregate` roots violated the decrease-on-refine rule.** The flat root took
  `max(child GE)`, tying it to its largest child so both became selectable at the same SSE. Now ×2,
  matching what the nested path always did. Caught by the new test's monotonicity assertion.
- **Added: mosaic caching with a day-scale TTL** (`&ttl=`, default 86 400 s), keyed on the exact child
  set plus scheme; each child's fetched root is cached the same way, failures at 60 s so one dead host
  cannot pin a degraded mosaic for a day. `&ttl=0` bypasses the cache **in both directions** (an
  earlier pass skipped only the write, which still served stale data — the one thing the flag exists
  to prevent). Measured at 500 datasets: cold build ~156 ms (loopback, dominated by the N
  round-trips), tree build **2.4 ms**, root fanout **4**, depth 10.
- **Added: `scripts/debug-aggregate-nesting.mjs`** — 19 assertions over synthetic children served from
  a throwaway localhost server, so it is reproducible and host-independent: flat/mercator/geodetic
  shapes, Paris-groups-apart-from-Rome, country-scale-stays-shallow, GE monotonicity, cache-state
  independence, and the 500-dataset scale run. It found both bugs above.
- **Added: a React/shadcn hierarchy explorer** (`apps/viewer/hierarchy.html`, served at `/hierarchy`)
  over `/stats` — the multi-tileset counterpart to the server's own single-tileset page. Top-down
  tidy trees (`d3-hierarchy`) plus **overlaid** per-level charts for breadth, leaves and
  geometric-error distribution, a comparison table, and content-sample panels. Layout comes from d3,
  drawing does not: links are concatenated into one `<path>` and nodes batched **one path per depth
  level**, so a 4 000-node tree is ~20 DOM elements and several fit on screen at once. Hue identifies
  the tileset across every chart; lightness encodes depth. It is a **separate Vite entry**, not a
  route in the main app — confirmed by the build, which emits a 25 kB `hierarchy` chunk with no
  Cesium/three/Spark. Truncated walks are badged "hit node budget" so a budget cap never reads as a
  shallow tileset.
- **Added: desktop app — Library and Samples tabs.** Library tracks datasets as *source + options*
  (not a built URL, so entries stay re-editable), with a cached `/stats` check per row; budget-capped
  walks render as `≥N … (node budget reached)` in amber rather than as fact. Refresh is **sequential
  by design** — it fans out to arbitrary third-party hosts, the same unbounded-concurrency trap
  `/aggregate` just fixed. Samples ships a real public dataset per format (COPC, Potree, SOG, LCC,
  RAD, I3S) with origins credited. Row icons are generated **format glyphs, not thumbnails** — a real
  preview would mean a hidden Cesium view per row. Docs/viewer links resolve local-first: env var →
  reachable localhost → public deployment.
- **Docs: the Potree 1.x `.hrc` truncation bug is now written up in the format reference**, not only
  the changelog — chunk trees, why **boundary nodes** are the only edge between chunk generations, and
  why a re-entry guard that returns an empty list truncates a *lazy* walk at `stepSize − 1` with no
  error at all (Geghard: level 4 against a real depth of 11). New pages: **Meta-tilesets**
  (`/aggregate`) and **Hierarchy explorer** (`/stats`).
- **Docs: transform-gizmo future work.** A free 6-DoF gizmo that bakes back into the
  `&lon/&lat/&alt/&heading/&scale` params, with WilliamLiu's **3DTiles-Inspector** credited as the
  closest prior art (same interaction; the difference worth keeping is ending at a *stateless URL*
  rather than an edited tileset), plus the two traps: composing on top of each adapter's up-axis flip,
  and origin-vs-centre anchoring.

### Added / Fixed — 2026-09-11b (aggregate spatial nesting · stats content sampling · Bing raster basemap)
- **Added: `/aggregate` spatial auto-nesting** (`&nest=auto`, on from 8 children). A flat root is fine
  for a dozen datasets and wrong for 500: every child sat directly under the root, so the moment the
  root refined, all 500 child `tileset.json` were candidates. Nesting builds a **web-mercator
  quadtree** from nothing but each child's root bounding sphere — the only thing knowable without
  opening the datasets — the same idea as 3D Tiles implicit tiling and Bing's quadkeys. Each dataset
  is placed at the **deepest level whose cell still comfortably contains it** (4× slack), so a 200 m
  scan lands in its city cell while a country-wide dataset stays shallow and is never split; the trie
  is then path-compressed, giving continent → country → city only where datasets actually diverge.
  Culling does the work at render time, but the **geometric error is what stops the fetch**: a group's
  GE is 2× its children's (also satisfying the spec's monotonic-decrease rule), so from a world view a
  site-sized group subtends a fraction of a pixel and is never traversed. Verified with 28 datasets
  worldwide — root fanout 28 → 4, depth 8, 20 groups, Paris nesting as Eiffel+Louvre (r≈2 km) →
  Sacré-Cœur (3 km) → Versailles (10 km), GE strictly monotonic. `&nest=0` restores the flat root.
- **Added: `/stats` content sampling** (`&sample=N`) plus `leafNodes`, per-level `leaves`, and
  `maxFanout`. The sampler picks N content tiles **stratified across depth** (leaves *and* intermediate
  nodes) and parses **only the GLB JSON chunk** — primitive counts, extensions, texture MIME types and
  compression are all declared there, so no Draco/meshopt/SPZ decode is needed. Off by default; the
  rest of the walk still reads nothing but tileset JSON and subtree buffers. Verified across content
  types: Potree → points, no triangles; Bing → 512 triangles / 1536 vertices / JPEG, exactly the globe
  shell's 16×16×2 grid; WL Elevator → ~24.7 k splats/tile with `KHR_gaussian_splatting` +
  `_compression_spz_2` + `KHR_materials_unlit` + `EXT_splat_opacity`.
- **Changed: the Bing globe shell now defaults to Bing's own raster tiles.** Low zoom was never a gap
  in `tf=3dv4` — it is a different product: Bing Maps itself draws imagery-on-terrain there and only
  switches to photogrammetry around z13. Those raster tiles are keyless, quadkey-addressed, and on the
  **same host** as the mesh, so the shell now matches what it hands over to. `&basemap=osm` and any
  `{z}/{x}/{y}` / `{q}` template remain available; attribution resolves from the *requested* basemap.
- **Fixed: two dead viewer splat presets.** The 3DGS-plugin repo renamed its samples
  (`data/gaussianSplat1|2` → `Elevator-3dtiles` / `SvirnasAlyt-3dtiles`); both preset URLs had been
  404ing. Found by the new `/stats?sample=` reporting HTTP 404 for every sampled tile.

### Added / Fixed — 2026-09-11 (Bing low-zoom globe · desktop app · L-GSC docs · branch consolidation)
- **Added: `apps/desktop`, an Electrobun companion app** that runs the tile-server **on-device** and
  turns a dataset (local path or URL) into a paste-ready 3D Tiles endpoint — the "companion app"
  roadmap item, previously reshaped into `3dtiled serve`. Framework choice was constrained: Tauri
  needs a Rust + MSVC toolchain this machine lacks, Electron would add a ~200 MB dependency to a
  monorepo whose CI runs `pnpm install` on every build, and Vercel's Native SDK compiles to Zig with
  **no webview and no JS runtime**, so it cannot host the existing web UI at all. Electrobun is
  webview-based with official Windows 11 / macOS 14 / Ubuntu 24.04 support. `apps/desktop` is
  **excluded from the pnpm workspace** so `--frozen-lockfile` installs stay untouched. An
  already-running 3dtiled server is *adopted* rather than duplicated; the Cesium preview is served by
  the existing `scripts/static-server.mjs` so it is a plain `http://` page.
- **Added: Bing Maps 3D low-zoom globe shell** (`bing-globe.js`). Bing's `tf=3dv4` mesh does not exist
  above face-local **level 12** — measured, not assumed, with the new
  `scripts/debug-bing-coverage.mjs` (levels 0–11 return 0-byte bodies; level 12 returns a 155 KB GLB
  over London). Twelve empty levels means every zoomed-out view of `/bing/tileset.json` was blank.
  Tiles with no Bing mesh at/above `&globe` (default 11) now carry a basemap-draped ellipsoid patch;
  because a Bing face-local `(level,x,y)` **is** the global mercator tile at `(level+1)`, the raster
  lookup is 1:1 — no resampling, no reprojection. `REPLACE` refinement hands over to real mesh where
  it exists and keeps the shell where it never does (oceans), so there is no hole at the transition.
  Deliberately **no tile `transform`** (a transform is inherited by the Bing subtree, whose GLBs bake
  their own ECEF into the glTF node matrix) — absolute ECEF swizzled `(X, Z, −Y)` instead, so
  Cesium's glTF→Z-up `RX(+90°)` restores it. Basemap is a URL template (`&basemap=`,
  `BING_GLOBE_BASEMAP`, default OpenStreetMap, attribution emitted in `asset.copyright`);
  `&globe=off` restores the previous behaviour. Verified in stock CesiumJS with Cesium's *own* globe
  hidden, so all visible geometry came from the tileset.
- **Fixed: `scripts/cesium-harness.html` readiness loop** — `Cartographic.fromCartesian` returns
  `undefined` for a degenerate centre, which a whole-globe tileset genuinely has; the unhandled throw
  killed the loop so `window.READY` never flipped and screenshots timed out despite rendering fine.
- **Added: `KHR_gaussian_splatting_compression_lgsc`** (Qualcomm **L-GSC** v1.0) documented alongside
  `_spz_2`. The rename during review (`..._lgsc` → `..._compression_lgsc`) confirms Khronos treats
  splat compression as an open set of interchangeable children under one base, SPZ being first rather
  than only. The PR is open and README-only, so the JSON nesting/`bufferView` are explicitly *not*
  asserted here, and the codec publishes no benchmark numbers.
- **Changed: WilliamLiu's `3DGS-PLY-3DTiles-Converter` went closed source** — the repo no longer
  resolves; dead links unlinked and the geometric-error model it inspired is now written out in-page,
  since the source is no longer citable.
- **Fixed: README claimed no public deployment.** Docs/viewer/middleware are live via the GHCR images
  behind Traefik. Domains appear only in the README — served artifacts still build every link from
  `DOCS_URL`/`VIEWER_URL`/`REPO_URL`, so the no-committed-domains policy holds where it matters.
  `docs-pages.yml` is now `workflow_dispatch`-only: Pages is not the canonical deployment and is not
  enabled on the repo, so its push trigger failed every run.
- **Repo hygiene:** `main` fast-forwarded to `origin/main`; `t3code/feature-roadmap-exploration`
  merged with main (the `openapi.json` overlap auto-resolved — the roadmap branch expanded `paths`
  while `809f5f4` touched only `info.description`) and pushed as a tracked remote branch. Five local
  branches plus the remote `stream-cache` were deleted after verifying each held **zero** commits not
  already reachable from `origin/main`.

### Added / Fixed — 2026-08-22 (roadmap batch: potree depth fix · globe placement · Pages docs · /aggregate · /stats+/hierarchy · bench · `serve` CLI)
- **Fixed: Potree 1.x live streaming truncated at hierarchy-chunk depth** (`potree-live.js`). An
  already-loaded `.hrc` chunk returned empty boundaries from `loadOne`, so any subtree walk re-entering
  a loaded chunk root (the level-3 subtree walking through chunk `r` after the root subtree loaded it
  shallowly) never reached the next chunk generation — availability silently stopped at level
  `stepSize−1`. Geghard (302 M pts, stepSize 5) refined to level 4 only; real depth 11+. Boundaries are
  now cached per chunk so later, deeper walks traverse THROUGH loaded chunks. Verified live with a
  client-style subtree BFS (`scripts/debug-potree-depth.mjs`): availability through level 11, deep
  tiles decode, Potree 2.0 unaffected.
- **Added: tileset-level globe placement** — `&lon=&lat=[&alt=][&heading=][&scale=]` on `/stream`,
  `/convert` and `/tiles` `tileset.json` attaches a LOCAL dataset to a real location as a root ENU
  transform composed ON TOP of each adapter's local-upright flip (SOG RX(−90°), RAD RX(180°), LCC
  upright), so up-axis normalization + placement live in the tileset itself and any client (Cesium for
  Unreal/Unity, QGIS, CesiumJS) streams it in place. Own-georef sources win (params ignored + warning).
  `core/geo.js`: `mat4Multiply`, `placementMatrix`, `isEcefPlaced`, `applyPlacement`. Verified in stock
  CesiumJS (`scripts/cesium-harness.html`): lion_takanawa upright at the Eiffel Tower, Cesium's own
  computed lon/lat matching the params.
- **Added: docs static export + GitHub Pages deploy** — `DOCS_STATIC_EXPORT=1` flips `apps/docs` to
  `output:'export'` (repo-name basePath, trailingSlash); search becomes fumadocs' static Orama index
  (works identically in dev); `.github/workflows/docs-pages.yml` deploys on push to main (one-time
  repo setup: Settings → Pages → Source: GitHub Actions).
- **Added: `/aggregate` meta-tileset endpoint** (MosaicJSON/STAC-style) — one tileset whose children
  external-reference N given tileset URLs, bounding spheres derived from each child root
  (box/sphere/region × transform), failures skipped into `asset.extras.failed`. Verified: Geghard +
  placed lion + Marseille in one endpoint, rendered on two continents from the same URL in stock Cesium.
- **Added: `/stats` hierarchy walker + `/hierarchy` visualization** — walks explicit trees, 3D Tiles 1.1
  implicit tiling (`.subtree` decode via new `core` `parseSubtreeBuffer`), and external refs; renders a
  cosmograph-style radial depth/breadth graph + per-level chart/table (light+dark, validated ordinal
  ramp). Doubles as a live-adapter diagnostic — the pre-fix Geghard truncation reads as a ring that
  stops at level 4.
- **Added: reproducible converter benchmark** (`scripts/benchmark-converters.mjs` +
  docs `guide/planning/benchmarks`) — first numbers: potree2 lion 1.01 M pts/s, RAD 0.94 M splats/s,
  SOG 8.3 MB/s (single-core; the WorkerPool tier remains unwired headroom).
- **Added: `3dtiled serve` subcommand** — starts the tile-server and prints the ready-to-paste
  3D Tiles URL (localhost + LAN) for a given dataset, `/stream` vs `/convert` auto-picked, with
  `--lon/--lat/--alt/--heading` placement flags — the local-first "point Cesium for Unreal at it"
  one-liner (covers most of the Tauri-companion idea's value).
- Verification tooling committed under `scripts/`: stock-Cesium harness, CDP screenshot driver
  (real readiness waits, no puppeteer), Pages-emulating static server.

### Fixed — 2026-07-07 (`main`: 3DTRJS wrong up-orientation on repeat Auto-zoom)
- **Root cause**: `frameToTileset` (`apps/viewer/src/components/Viewport/ThreeDTRjsViewer.tsx`) decides
  whether a tileset needs the synthetic ENU anchor (for non-georeferenced local content, e.g. Potree
  "Lion 2.0") by checking whether its bounding sphere — transformed by `tiles.group`'s CURRENT matrix —
  sits near world origin. Sound on the first call (fresh load), but the anchor branch then moves
  `tiles.group` onto the real ellipsoid, so any LATER call (e.g. clicking "Auto-zoom to tileset" again,
  with zero navigation in between) sees that same sphere near the real ellipsoid surface —
  indistinguishable from genuinely georeferenced content — and wrongly resets the rotation to identity
  while leaving the position at the anchor point. Reproduced in every controls mode (Globe/Orbit/
  Environment) since the bug lives entirely before any controls code runs.
- **Fix**: decide (and cache) whether a tileset needs the ENU anchor only once, on the fresh-load call
  (`frameToTileset` now takes an `isFreshLoad` flag), and reuse that cached decision on every later
  re-frame instead of re-deriving it from an already-moved sphere.
- A preceding, separate real bug was also fixed along the way: `GlobeControls`/`EnvironmentControls`
  (from `3d-tiles-renderer`) track a `zoomDirectionSet`/`zoomPoint` pair internally that's only ever
  cleared by real pointer input — after free-navigating far from a tileset and then hard-teleporting the
  camera back (`frameToTileset`), the controls' next tick re-raycast along that stale direction from the
  camera's new position and reoriented around a garbage point. `setControlsPivot` now optionally resets
  that state, used specifically by `frameToTileset`'s hard camera teleport.
- Verified live: Lion 2.0 stays upright across repeated Auto-zoom clicks in all three controls modes;
  real georeferenced content (COPC Autzen) is unaffected across the same repeat-click test.

### Docs — 2026-07-07 (`main`: vitepress theme, sidebar regroup, full MDX conversion, Scalar theming)
- Switched the Fumadocs UI theme to the `vitepress` preset.
- Sidebar reorganized: "Guide" and "Per-format reference docs" are now plain (non-clickable) separator
  labels with their pages inlined; the per-format clusters (3DTiles+glTF, Pointclouds, Mesh/Generic,
  3DGS Splats, Others) are real collapsible folders, open by default; planning/roadmap docs
  (dependencies, TODO, candidate formats, sample data, design log, appendix) live in a new
  "Reference & Planning" folder, collapsed by default.
- Large content reorg/cleanup pass across `guide/`/`references/` — reordered and regrouped CLI usage,
  ambition/supported-formats, related tilers, TODO/future-work, and candidate-source-formats sections;
  moved sections between pages to their more logical home (e.g. the offline-tilers catalogue into
  "Existing tilers", I3S open-data samples into "Sample Data").
- **Converted every `content/docs/*.md` file to `.mdx`** so Fumadocs' `InlineTOC` component (now on all
  large guide/reference pages) actually renders — fumadocs-mdx silently strips all raw JSX/HTML in plain
  `.md` files, which `InlineTOC` needs. Escaped/fixed everything that broke on the conversion: GFM
  `<https://...>` autolinks (MDX's tag-sniffer mis-parses the URL's `/`), same-line
  `<details><summary>...` (MDX's JSX tag-balancer needs `<details>` on its own line before a blank-line +
  fenced-code boundary), a raw `<!-- -->` HTML comment (→ `{/* */}`), and one bare struct-literal-shaped
  brace expression in prose that was valid enough JS to compile but threw `ReferenceError` at build time
  (`stream-sog` parses as a subtraction). Verified with a full production build, not just a parser check.
- Re-themed the embedded (`/docs/api-reference`) and external (tile-server `/playground`) Scalar API
  reference to `theme: 'none'` + a hand-written `--scalar-*` variable set matching the vitepress palette
  exactly (same primary/background/border/foreground values, Inter font) — both now read as the same
  product as the surrounding docs instead of a visually distinct third-party widget.
- Fixed the "Demo Viewer" card on `/docs` (was hardcoded to the API Reference link by mistake) to use
  the expanded `process.env.VIEWER_URL`.
- Removed two orphaned early-prototype scratch files (`ref-convert-core.js`, `ref-gsplat1.json`) and the
  stale duplicate root `viewer.html`/`vite.config.mjs` (the real, Docker-shipped copy has lived in
  `apps/viewer` since an earlier "consolidate dev ports" pass) along with their root `package.json` deps.
- Removed the `VITE_TILE_SERVER_URL` production-domain build-arg from `docker-publish.yml` — per-
  deployment tile-server/docs origins are already configurable at container start via the runtime
  `TILE_SERVER_URL`/`DOCS_URL` env vars, so a published, reusable image shouldn't have one deployment's
  domain baked in at build time.

### Fixed/Added — 2026-07-03 (`main`: uniform crop, CORS proxy, I3S SLPK+textures, Agisoft pill)
- **Uniform splat-crop flip.** Replaced the hardcoded `isLcc` special-case in `extract-live.js` with a
  documented `SPLAT_FLIP_BAKED = {lcc, sog}` table + `splatFlip()` — discovered SOG had the identical
  latent bug LCC did. Verified against real tile data for LCC, SOG, and RAD.
- **Generic CORS proxy** (`packages/tile-server/proxy-live.js`, new file): `/proxy?url=<source>`,
  tileset-aware (recursively rewrites nested `content.uri` to route children back through the proxy,
  inheriting the parent's query string — Agisoft Cloud's access token lives only on the root URL).
  Fixes the Agisoft Jam pill (its host sends no CORS header on any resource).
- **I3S SLPK detection fixed**: only ever matched `.slpk` literally in the URL; ArcGIS Online's own
  download endpoint (`.../content/items/<id>/data`) has no `.slpk` anywhere in the URL. Now sniffs the
  PKZIP magic bytes via a ranged GET when the URL doesn't already look like JSON.
- **I3S textures implemented** (previously geometry-only, a documented scope-gate): `materialDefinitions`/
  `textureSetDefinitions` lookup picks a browser-native `jpg`/`png` format when available (DDS/KTX2/
  Basis-only stays gated, same as Draco/LEPCC); texture bytes fetched via the same per-node resource
  bucket geometry uses, trying the bare resource name first (live ArcGIS REST) then the real extension
  (SLPK archives have no bare-name alias); a magic-byte check guards against ArcGIS's CDN occasionally
  returning HTTP 200 with a JSON error body instead of a real 404. `glbBuild.js` gained a `TEXCOORD_0`
  accessor + embedded image/material.
- **Real pre-existing bug found while wiring up textures**: `glbBuild.js`'s binary-buffer assembly reset
  the running byte offset to each bufferView's own padded length (`offset = padded`) instead of
  accumulating (`offset += padded`) — silently correct for 2-view outputs (POSITION+COLOR_0 point
  clouds) but corrupting every bufferView from the 3rd onward for mesh outputs (POSITION+NORMAL+COLOR_0,
  worse once TEXCOORD_0+image were added) — the actual root cause of the reported all-black textures,
  not a texture-specific bug at all. Fixed; both offline (`i3s-to-3dtiles`) and live (`i3s-live.js`)
  paths share the fix via the same `buildGlb()`.
- I3S LEPCC decompression researched (not implemented): no public bitstream spec, no known open
  decoder — verdict hard/impractical without Esri publishing the format.
- Added the Agisoft Cloud tileset pill (routed through `/proxy`).

### Docs — 2026-07-02 (`main`: README accuracy pass + new TODO items)
- Fixed a stale `/package` endpoint name throughout README (renamed to `/3dtiles-self-contained` a
  while back, but several examples/prose references never got updated) — heading, example URLs, and
  cross-references now all agree.
- Documented `/bing/fragment/<face>-<level>-<x>-<y>.json?g=<genid>`, the lazy-continuation route behind
  `/bing/tileset.json` (previously undocumented despite being load-bearing for Bing streaming).
- Documented `/3dtiles-self-contained`'s local-filesystem-path support (`?url=` resolves relative to
  the tile-server's own CWD, not fetched over HTTP — unique among the adapters here).
- Clarified `viewer.html`'s Tools → `packages` grouping routes to `/3dtiles-self-contained`, not a real
  `/3dtiles-tools?tool=packages` value.
- Expanded the `/stream?transform=` table row with `ktx`/`ktx-uastc` (previously only mentioned in prose).
- Documented that Arrival.Space's `.lod` payload carries no georeferencing metadata (checked directly).
- New TODO items: migrate `/threemx`/`/geosplats` into `/tiles`; find a real open-data `.3tz`/`.3dtiles`
  sample (currently only our own repo-packed one); a new "Inspected, no tiled splat/generic format
  found" section (Scaniverse, ESRI beyond I3S, other Bentley services, ReCap, Leica/Faro/Matterport,
  Gauzilla Pro).

### Changed — 2026-07-02 (`main`: `/dump` renamed to `/extract`)
- `packages/tile-server/dump-live.js` → `extract-live.js`, `handleDump` → `handleExtract`, `X-Dump-*`
  response headers → `X-Extract-*`, `viewer.html`'s `dumpCrop`/`getDumpMatrix`/"Crop & Dump" → `extractCrop`
  /`getExtractMatrix`/"Crop & Extract". No back-compat alias — the old `/dump/*` paths are gone.

### Changed — 2026-07-02 (`main`: RAD and I3S always fully materialize — no more lazy-fragment mode)
- **RAD**: removed the 4-level lazy-fragment continuation (`buildRadLazySubtree`, `/stream/rad/subtree/<n>.json`).
  RAD has no persisted spatial index, so a "lazy" read still needs each chunk's full bytes — measured
  against the 1.28 GB `coit.rad` sample, eager (all chunks) took 9.7s vs the old lazy fragment's 7.6s,
  not enough of a win to justify a whole extra code path. `cache=none` and `cache=hierarchy` now both
  eager-scan once (cached per URL, same `makeTileset` either way).
- **I3S**: same simplification — removed `buildI3sFragment`, `/stream/i3s/node/<n>.json`, and the
  `&lazy=1` tile mode. I3S node pages are cheap JSON metadata (not geometry), so eager cold start (page 0
  sync + remaining pages in the background, capped at a 3s wait) was already fast; the lazy path bought
  little for the added complexity. `cache=none`/`cache=hierarchy` are now equivalent for I3S too.
- Both mirror the Potree 1.x `tiling=explicit` simplification from earlier this session — one
  fully-materialized-explicit-tree code path instead of eager+lazy forks.

### Fixed — 2026-07-02 (`main`: `/dump/splat` LCC crops placed splats dozens of meters off)
- **`dump-live.js`'s generic Y-up→Z-up flip (`YUP_ZUP`) double-applied for LCC sources**, since
  `lccGeoref`'s `[East,−Up,North]` root-transform columns already bake that same flip in (unlike every
  other adapter's plain `[East,North,Up]` georef, which needs `dump-live.js` to supply it separately).
  Net effect: a real rotation-about-local-X error in every LCC `/dump/splat` (and `/dump/zip`) crop.
  Quantified against 10 sampled Guan_Temple tiles' own declared bounding boxes: the old default placed
  splat centroids 50–246 m outside their own ~31 m-half-diagonal tile box; the corrected rotation lands
  them 11–25 m off (plausible centroid-vs-box-center noise, not error) — this is the "horse statue
  cropped a few dozen meters off" bug. `dump-live.js` now detects an LCC source (`format=lcc` in the
  nested `/stream` URL, or an `/LCC/` path segment) and uses the inverse rotation (`YUP_ZUP_P90`) for it;
  every other no-node-matrix format is untouched. `&rx=90|-90` still force either rotation for testing.

### Fixed — 2026-07-02 (`main`: LCC scenes with no EPSG rendered lying on their side)
- **`lccGeoref()` returning `null` (meta.epsg 0/unknown — Guanlan Ancient Town, religious_center_L2_P)
  left `root.transform` unset entirely**, so the splat GLB content stayed in its raw Y-up frame while
  `boundToZUpBox` had already (unconditionally) RX(+90°)-flattened the bounding boxes — the box/content
  axis mismatch rendered as "lying vertical instead of flat" (confirmed: Guan_Temple has a real EPSG
  4547 and rendered correctly; the other two have `epsg: 0` and didn't).
- Added `LCC_LOCAL_UPRIGHT` (`packages/core/geo.js`) — the same RX(+90°) flip baked into `lccGeoref`'s
  `[East,−Up,North]` columns, but with identity East/Up/North and zero translation (no real ENU
  placement). `lcc-live.js` and `lcc-to-3dtiles` now fall back to it whenever `lccGeoref()` returns
  `null`, so ungeoreferenced LCC scenes still render flat/upright at the local frame origin — just not
  geolocated.

### Changed — 2026-07-02 (`main`: streaming endpoint consolidation, no back-compat)
- **`/stream` now reads `cache=none|hierarchy`**, not `hierarchy=lazy|eager` — matches the `/tiles`
  vocabulary, which now passes its query string straight through instead of translating it.
- **`/tiles` dispatches in-process** to `/stream`/`/convert` instead of a 307 redirect.
- **Removed the direct per-format endpoints** — `/copc`, `/potree`, `/sog`, `/lcc`, `/rad`, `/i3s` are
  gone. Verified they were a strict subset of `/stream/tileset.json?format=<fmt>` (for COPC/Potree they
  didn't even forward `hierarchy`/`prefetch`, so `cache=hierarchy` was silently unreachable through
  them). `viewer.html` and all sample pills updated to call `/stream` directly.
- **Potree 1.x's `&tiling=explicit` simplified**: now fully materializes the tree in one response
  (draining every `.hrc` chunk first) instead of lazily fragmenting it across per-chunk
  `/potree/hrc/<name>.json` continuation requests — one fewer moving part, and the removed direct
  endpoint would have broken that continuation chain anyway. Fine size-wise since Potree is already
  well-chunked; implicit tiling (the default) remains the path for genuinely huge datasets.
- **RAD's and I3S's lazy-fragment continuation** (needed for their core `cache=none` streaming, since
  neither has a true implicit-tiling representation to range into) moved from `/rad/subtree/<n>.json` /
  `/i3s/node/<n>.json` to `/stream/rad/subtree/<n>.json` / `/stream/i3s/node/<n>.json` (+
  `/stream/i3s/tile/<n>.glb`, which needs `&lazy=1` threaded through to hit the right cached context).
- No backwards-compatibility shims — this project has one user right now. If that changes, the old
  query param / endpoints would need explicit aliasing back in.

### Docs — 2026-07-02 (`main`: /dump documented, endpoint docs re-synced, ordered TODO)
- Added a proper `/dump` section (bbox + geometric-error crop/extract) to the README's Vision
  chapter — previously only mentioned once in passing in the Ambition paragraph despite being a
  real, separate endpoint family (not a `/convert` specialization).
- Re-synced the "Endpoint rework", "Two modes", and RAD streaming-roadmap sections to the
  now-implemented reality above (they'd described this as a "future" proposal, and separately still
  described RAD as unstreamable — both stale: RAD *is* streamed, just via a metadata-only parallel
  pass over every chunk rather than persisted per-tile bounds).
- Reordered `TODO / Future work` per plan: the streaming consolidation above (done) → the deferred,
  more invasive composable `tiling=explicit` via `/3dtiles-tools?tool=implicit-to-explicit` → Docker/
  GHCR/Traefik packaging → Fumadocs migration → the 3DTilesRendererJS-native plugin idea → pinned
  open-data test fixtures.

### Docs — 2026-07-02 (`main`: broader README staleness pass, 5 parallel audits)
- **RAD LoD geometric-error doc still described only the legacy `featuresize` basis** as if it were
  current — added a note pointing at the now-default `spatial` basis (kept the detailed writeup, since
  `--ge-basis=featuresize` still exists and behaves exactly as described).
- **`.3tz` packaging vs tileset-upgrade claims contradicted each other**: one section said packaging
  "is not built in," another correctly documented the in-repo packer (`scripts/pack-3dtiles.mjs`) and
  `/package` serving. Split the claim: packaging *is* built in; tileset-level transforms (`upgrade`,
  `combine`) still aren't, and still point at `3d-tiles-tools`.
- **`/geosplats/tile.glb`'s documented `grid=` values were missing `512`** (the endpoint accepts
  `1|8|64|512`; the HLOD tileset builder just doesn't request 512 automatically) — fixed.
- **"Potree 1.x always lazy" was wrong** — it supports `hierarchy=eager` (`drainAll`) exactly like
  every other converter with a hierarchy; fixed the "wired for" list to include it.
- **A `--3tz`/`--3dtiles` CLI flag was documented for `rad-to-3dtiles`/`copc-to-3dtiles` that doesn't
  exist** — `@cesium/3d-tiles-tools` is an optional dependency but isn't wired to any flag. Reworded
  in both the converter note and the Dependencies table to point at what actually works today
  (`scripts/pack-3dtiles.mjs` / `npx 3d-tiles-tools convert`).
- **RAD's LoD fanout numbers were swapped and one was fabricated** — the source spec gives Tiny-LoD a
  base β≈1.75 and leaves Bhatt-LoD's fanout unspecified; the README had them backwards ("BhattLod
  ~1.75 / TinyLod ~1.5"). Corrected and noted the ~1.5 as our converter's own observed value, not a
  spec'd number.

### Docs — 2026-07-02 (`main`: second README staleness pass)
- **`i3s-to-3dtiles` mislabeled "UNTESTED"** in the docs-references summary table while its own
  dedicated section already documents it as validated on `Buildings_NewYork_v18.slpk` (5882 tiles,
  placed correctly in NYC) — fixed the summary to match.
- **"Performance & parallelism" described conversion as still single-threaded/sequential**, with a
  worker/bounded-concurrency pool as "the clear next optimization... not yet done" — that work is
  already done (all five operational converters use `parallelMap` + async gzip, tier 1) and is
  accurately described in the separate "Parallelism (per converter)" section a few hundred lines
  earlier; this section just never got updated. Corrected in place (kept, since other headings link
  to it) rather than deleted, and pointed at the accurate section.
- **RAD `geometricError` undershoot listed as an open bug with only a `--ge-scale` workaround** —
  `rad-to-3dtiles` already defaults to a spatial GE basis (`bboxDiag/∛count`, `--ge-basis=spatial`)
  that fixes the underlying ~4× undershoot; the featureSize basis this bullet described as the only
  option is now opt-in legacy (`--ge-basis=featuresize`). Marked resolved.

### Docs — 2026-07-02 (`main`: README staleness pass)
- Fixed several stale claims flagged during review: the meta-converter dispatch note and two
  "Missing features" bullets described converters as not-yet-moved under `packages/<fmt>/` and
  dispatch as child-process-only — both are already done (in-process `import()` by default,
  child-process only as an `extraArgs` fallback; workspace `workspace:*` deps already declared, so
  the old "needs `npm install` first" caveat no longer applies). The `/potree` section described the
  default tileset as "explicit" and Potree 1.x as not range-served — both wrong: implicit tiling is
  the default (`&tiling=explicit` opts in), and 1.x's `.hrc` chunks are lazily range-served through
  the same implicit-subtree machinery as 2.0 (the streaming-roadmap table just below already said so
  correctly — the prose above it hadn't caught up).
- Reworked the Ambition section's "where this is going next" paragraph to call out Docker/GHCR/Traefik
  packaging and a Fumadocs migration as concretely addressable near-term items (not just aspirational),
  and note that the Fumadocs move is mostly *chunking* material that already exists in
  `docs-references/*.md` rather than writing new docs.

### Fixed — 2026-07-02 (`main`: Potree 2.0 hierarchy race, Cesium Local-Frame Z-offset, README overhaul)
- **Potree 2.0 live streaming (`/potree`, `/stream`) could serve incomplete implicit subtrees on a
  cold cache.** `loadChunk2()` marked a hierarchy chunk as loaded and removed it from the pending set
  *before* awaiting its actual fetch — a second, concurrent `ensureBlock2()` (routine on first load,
  when many `.subtree` requests arrive in parallel) could see the chunk as "already loaded" and index
  availability before that chunk's nodes had actually landed, so its subtree came back with that
  branch looking empty. 3d-tiles-renderer doesn't retry a subtree it already resolved, so the branch
  stayed empty until something else (e.g. reloading via explicit tiling) happened to fully populate
  the shared per-URL cache. Fixed to share one in-flight promise per chunk across concurrent callers —
  the same fix already applied to the Potree 1.x `.hrc` path (`loadOne`) previously, but missed here.
- **Cesium "Z offset" silently un-placed non-georeferenced tilesets** (most test splat data has no
  real CRS and auto-places via "Local Frame", i.e. `Cesium.Transforms.eastNorthUpToFixedFrame`).
  `applyZOffset()` replaced `tileset.modelMatrix` with a bare translation, discarding that ENU
  rotation outright — looked exactly like "Z offset does nothing" for splats specifically, since
  georeferenced point-cloud/mesh test data never went through the Local-Frame path. Now composes the
  vertical nudge on top of whatever placement (georef or Local Frame) is already in effect.
- **README**: major reorganization — Ambition/format-comparison/related-tilers move to the front;
  `/stream` lazy-loading status moves up next to the meta-converter docs; a new `TODO / Future work`
  section (Docker/GHCR/Traefik packaging, a 3DTilesRendererJS-native plugin, pinned open-data test
  fixtures, Fumadocs) sits right after `Monorepo & usage`; the materialization-continuum architecture
  doc moves ahead of the individual per-format converter docs; per-format schema diagrams move to a
  new end-of-document appendix. Format tables: added 3D Tiles packages (`.3tz`/`.3dtiles`), 3MX and
  Bing Maps 3D as a new "generic tiled formats" table (removing them from the stale "candidate/roadmap"
  list, where 3MX in particular was wrongly still listed as unsupported); dropped plain LAS/LAZ from
  the comparison table (no native tiling/LoD — point clouds there are now just COPC + Potree); removed
  a stale `copc-to-3dtiles` TODO for explicit tiling — both the offline converter and the live `/copc`
  endpoint already support `--tiling`/`?tiling=explicit`. Added a distilled local mirror of the COPC
  spec (`docs-references/copc-format.md`) alongside the existing per-format mirrors.

### Fixed — 2026-07-02 (`main`: splat/GeoSplats export & viewer follow-ups)
- **`/dump/splat` Y-up→Z-up regression on third-party tiles (WL Grange) fixed.** The 2026-07-01 auto-pick
  (`hasNodeMatrix ? YUP_ZUP_P90 : YUP_ZUP`) meant to give node-matrix-authored tiles real Cesium
  `Y_UP_TO_Z_UP` — but the two constants' inline labels were swapped (verified against a real
  `Cesium.Axis.Y_UP_TO_Z_UP` multiply in Node): `YUP_ZUP` is the one that equals it, not `YUP_ZUP_P90`. So
  third-party tiles got the inverse rotation — fixed the earlier vertical flip (a Y-histogram only checks
  up/down) but silently inverted the horizontal/depth axis instead. Both branches now default to `YUP_ZUP`;
  `&rx=90|-90` still forces either for one-off testing. Confirmed unaffected: every `/dump/*` export kind
  (las/copc/glb/zip/splat/tileset) shares one `traverse()` bbox+GE+refine walker — this was isolated to the
  splat content-decode step, not a codepath divergence.
- **GeoSplats Cesium Z-offset (`⊕ Local Frame → Z offset`) lag on splat tiles.** Cesium's native Gaussian-splat
  primitive caches its own ENU anchor and only rebuilds it after ~2 stable frames (or a ~30-frame/~0.5s stall
  fallback while a tileset is still streaming) — up to half a second of apparent "did nothing". `applyZOffset()`
  now also resets the primitive's internal anchor so the nudge is visible on the next frame.
- **3DTRJS large/slow tilesets (e.g. GeoSplats' aerial model) looked stuck.** Only the Cesium load path had
  tile-load progress feedback (`tlog`/`setStatus`); the 3DTRJS path set a status message once and then went
  silent for the whole (potentially multi-minute, single-threaded live-conversion) stream. Added the same
  first-tile/streaming-count/tiles-ready feedback used by Cesium.
- **3DTRJS globe mode: ortho could only zoom out, and mousewheel felt like it rotated instead of zoomed.**
  `GlobeControls` defaults `maxZoom` to `0.01`, calibrated for its own earth-scale ortho camera; our ortho
  camera is sized from the loaded tileset instead and starts at three.js's default `zoom=1` (~100× over that
  cap), so every zoom-IN tick was silently rejected — leaving only the incidental "tilt towards centre while
  zooming out near the surface" behaviour visible, which read as "wheel controls orientation". Removed the cap
  (`minZoom=0`, `maxZoom=Infinity`).
- **3DTRJS ortho↔perspective toggle was an instant cut.** Perspective and ortho can't share one camera object,
  but the outgoing/incoming projection matrices are now cross-faded over ~350ms so the switch reads as an
  animated transition instead of a pop.
- **3DTRJS "env" control mode hid the globe entirely**, even under georeferenced content where it's a useful
  ground/basemap reference (and gives `EnvironmentControls`' ground-raycast something to hug). Now shown
  whenever the loaded tiles are actually ECEF-placed; still hidden for local/non-georeferenced content.
- **GeoSplats pills renamed** from generic "model A (Baltic)"/"model B" to their actual place names —
  "Jastrzębia Góra, Poland" and "Biltmore Hotel, Miami".
- **README**: restated the project's ambition (converter → live streaming middleware → crop/export tool →
  planned splat-editor UI / geolocator / cross-platform aggregator), documented the GeoSplats SDK
  reverse-engineering findings (scale formula incl. the `cos(lat)` latitude correction, orientation frame,
  heading, altitude) in a new `/geosplats` section, and noted a Fumadocs migration as a follow-up (this file
  has grown large enough to want a real table-of-contents).

### Fixed — 2026-07-02 (`main`: 3DTRJS orthographic camera)
- **3DTRJS orthographic toggle now works.** The ortho frustum was sized from `controls.target`, which in globe
  mode is ~earth-centre → an earth-sized frustum (whole continent in view). Now sized from the distance to the
  loaded tileset's world centre. Returning to perspective reconstructs the eye from the scene focus + ortho
  zoom (GlobeControls moves the ortho camera far along its forward axis, so its position isn't a usable
  perspective eye). Splats DO render under 3DTRJS ortho (unlike Cesium). Transition is an instant cut — a
  smooth 1 s persp↔ortho via `CameraTransitionManager` is a possible future enhancement.
- **Cesium ortho + splats: documented Cesium limitation.** `PrimitiveGaussianSplatVS.glsl` computes the EWA
  covariance Jacobian as `focal / t.z` (perspective-only), so splat quads collapse under an ortho frustum and
  nothing draws. Ortho works for basemap/mesh/points in Cesium; use 3DTRJS for ortho splat comparison.

### Added — 2026-07-02 (`main`: viewer show/hide + orthographic camera)
- **"Show asset" toggle** in the sidebar — hide/show the loaded 3D asset (splat / mesh / point cloud) without
  unloading, to compare its footprint against the basemap. Works in CesiumJS (`tileset.show`) and 3DTRJS
  (`tiles.group.visible`); persists across loads.
- **"Orthographic camera" toggle** — plan/true-scale projection for distortion-free footprint checks, in both
  renderers (Cesium `switchToOrthographicFrustum`; 3DTRJS swaps in a `THREE.OrthographicCamera` + rebinds
  controls/tiles/globe). NB Cesium's Gaussian-splat shader does not draw under an ortho frustum — ortho is for
  basemap/mesh/point-cloud comparison; splats show in perspective.

### Fixed — 2026-07-02 (`main`: GeoSplats per-model heading)
- **GeoSplats compass heading was wrong** (model B / Biltmore rotated vs the map). The SDK stores a per-model
  heading in `global_position.offset.y_rot`; in the enu2 frame the aligning yaw is **`y_rot − 180°`** (B
  y_rot=217 → 37°: tennis courts land east, golf west, matching satellite; A y_rot=−178 → ≈+2°, negligible).
  Applied automatically; `&yaw=<deg>` fine-tunes on top. The `&yaw` knob now rotates the ENU basis about Up
  (a true heading) instead of the old content-Y spin.

### Fixed — 2026-07-02 (`main`: GeoSplats real-world scale + upright orientation)
- **GeoSplats models had no real-world scale** (B — the Biltmore Hotel, ~486 m — rendered ~4 m). `readSog`
  units are per-model and don't match; `model_scale` normalises them. Decoded from the MapTiler SDK: the
  world-unit→metre factor is `512·ZOOM_TO_METER[14]` = 2445.98, so real size ≈ `raw · model_scale · 2445.98`.
  Now baked as a uniform scale into the root transform's ENU basis (all geometricErrors ×S to keep LOD
  consistent). Verified: A ≈ 2 km (Jastrzębia Góra), B ≈ 486 m (Biltmore). `&scale=<f>` overrides.
- **GeoSplats rendered upside-down** with the earlier `[East, North, Up]` frame (flat but inverted — only
  obvious once B was scaled up to a recognisable building). After the renderer's glTF Y-up→Z-up correction
  the content's up is −Z, so the correct frame is `enu2` = **`[East, −North, −Up]`** (a 180° flip about East,
  a proper rotation). Now default. N/S heading is flipped 180° (SDK offset Euler still off); `&yaw` nudges.

### Fixed — 2026-07-01 (`main`: splat crop-export vertical flip + GeoSplats orientation)
- **Splat crop export (`/dump/splat`) flipped third-party 3D-Tiles splats vertically** (WL GSplat: the
  electric pole pointed away from the ground; adjacent tiles looked vertically offset). The dump baked a
  fixed `RX(−90)` Y-up→Z-up, but Cesium/3d-tiles-renderer use `RX(+90)` (`Y_UP_TO_Z_UP`) for standard
  Y-up glTF. Our own converters (`buildSpzGlb`) emit a bare `{mesh:0}` node and bake orientation into the
  tileset root transform, so they need `RX(−90)`; standard tilesets bake per-tile placement into an explicit
  `node.matrix` and need `RX(+90)`. The dump now **auto-detects per tile** (explicit `node.matrix` → RX(+90),
  else RX(−90)); `&rx=90|-90` forces it. Verified via Y-histogram: WL and LCC exports both land ground-down.
- **GeoSplats rendered as a vertical slab** in Cesium and 3DTRJS (models A and B). Both renderers apply the
  glTF Y-up→Z-up correction before the tileset transform, so the frame must be the **standard ENU
  `[East, North, Up]`** — the previous `[East, Up, −North]` double-rotated it upright→sideways. Now default;
  `&frame=` selects variants. (B is a genuinely small ~4 m capture, not mis-scaled.)

### Fixed — 2026-07-01 (`main`: GeoSplats now render in Cesium + correct altitude)
- **Cesium failed every GeoSplats tile** with `attribute.value.length must be in the range [1, 4]`. Root
  cause: the tileset.json didn't declare the `3DTILES_content_gltf` → `KHR_gaussian_splatting` extension, so
  Cesium routed our splat GLBs to its **mesh** loader (which chokes on the splat-only SCALE/ROTATION
  attributes) instead of its native Gaussian-splat renderer. The tileset now emits that extension block —
  the same one every other splat converter here already emits (`GaussianSplat3DTileContent.tilesetRequires
  GaussianSplattingExt` gates on it). GeoSplats render in **both** Cesium and 3DTRJS; the force-3DTRJS
  workaround in `viewer.html` is removed.
- **Scene was buried ~300 m underground.** `global_position.alt` is in MapTiler's `model_scale`-normalised
  MapLibre frame, not our 1:1 ellipsoidal metres (model A `alt=−307.6`; `alt·model_scale ≈ −0.2 m ≈ 0`).
  Placement height now defaults to **0** (origin on the ellipsoid ≈ ground for these near-sea-level
  captures); `&alt=<m>` overrides. Verified in Cesium: scene sits on the ground, correctly oriented
  (measured `X→East, Y→Up, Z→North`).
- **Sporadic tile failures.** Transient MapTiler rate-limiting (429) now retried with exponential backoff;
  deep octants whose `counts[]` claim a LOD with no baked `delta_data` entries now fall back to the highest
  available LOD instead of returning HTTP 500.

### Added — 2026-07-01 (`main`: GeoSplats HLOD octree)
- **`/geosplats` now emits an HLOD octree** from each sub-model's `voxel_grids` (grid_1 → grid_8 →
  grid_64), instead of one tile per sub-model. Parent→child by **spatial containment** (child octant
  centre inside parent bbox — independent of the octant-id bit layout); `geometricError` = octant diagonal
  (monotonically decreasing → correct `REPLACE` refinement); finer grids fetch higher progressive LODs
  (grid_1→LOD4, grid_8→LOD6, grid_64→LOD8, clamped to a LOD that has splats). Only occupied octants become
  tiles. Verified: model A → 1892 tiles, depth 3, GE 7880→722→378→38, every level a valid `_spz_2` GLB.
  grid_1's cell omits a bbox in the metadata, so it's synthesised from the sub-model bounds.

### Fixed — 2026-07-01 (`main`: GeoSplats orientation)
- **Scene was mis-oriented** (appeared vertical): the `global_position.offset` Euler is **per-model** (real
  orientation, not a constant), and — decoded from the SDK — is `Rx(x_rot)·Ry(y_rot)·Rz(z_rot)` applied in
  a Y-up model world (`X=East, Y=Up, Z=South`). The converter now applies exactly that (was wrong order /
  dropped) in the `[East, Up, −North]` placement frame. `model_scale` stays un-applied (readSog already
  yields real metric units; A ≈ 500 m aerial, B ≈ 4.6 m object). Heading may still need a visual tweak.

### Added — 2026-07-01 (`main`: MapTiler GeoSplats → 3D Tiles live converter)
- **`/geosplats` stream converter** (`packages/tile-server/geosplats-live.js`) — turns a MapTiler
  **GeoSplats** `model.json` into OGC 3D Tiles, reverse-engineered from the format + SDK bundle
  (see [`docs-references/maptiler-geosplats.md`](docs-references/maptiler-geosplats.md)):
  - `GET /geosplats/tileset.json?url=<model.json>[&lod=1..8]` → georeferenced tileset, one tile per
    sub-model (grid_1/octant_0), placed via `global_position` (lat/lon/alt) in a local **Y-up** ENU frame
    (`[East, Up, −North]`), recentred by the union bbox of all sub-models.
  - `GET /geosplats/tile.glb?…&m&grid&oct&lod` → fetch the octant bundle from the API proxy
    (`…/<modelId>/<baseurl>/<grid>/<octant>/<lod>` = the `entries` files concatenated in array order),
    slice by the TOC, `readSog` → **`KHR_gaussian_splatting_compression_spz_2`** GLB (`buildSplatTileGlb`).
  - **Keys are origin-restricted**, so the upstream fetch runs server-side with
    `Referer: https://www.maptiler.com/` — the browser only ever talks to our middleware.
  - Scale: `readSog` already decodes means to real local units, so `model_scale` (SDK raw-texture path,
    even `/=256`) is **not** applied; positions are placed 1:1 (was shrinking the scene sub-metre).
  - HLOD over the `voxel_grids` octree is a TODO (MVP = one tile per sub-model).
- **Viewer: ✨ GeoSplats format pills** (models A/B) → `/geosplats/tileset.json`. README + a
  reverse-engineered format mirror added under `docs-references/`.

### Fixed — 2026-07-01 (`main`: splat dump orientation + GeoSplats render)
- **Splat dump emitted ENU Z-up → ~90° tilt in SuperSplat** ("grass aligned along some directions"):
  splat-transform's engine space is PlayCanvas **Y-up** (`Transform.PLY` is only Rz180). The `/dump/splat`
  output frame is now local **Y-up** (`[East, Up, −North]`). Verified: LCC Guan height lands on Y.
- **Multi-tile splat dumps stacked all tiles at the origin** — each tile's node-local SPZ was never baked
  into a common frame, so `combine()` (identical transforms) baked nothing. Now each tile's `DataTable`
  is tagged with its `worldM·YUP_ZUP·nodeM` placement (→ positions + quats + scales + SH baked), anchored
  at the **source scene's own root origin** so multiple crops share one coordinate system.
- **Cesium crashed on splat tilesets** (fragment-shader compile error, `POINTS`+`UNLIT`): the shadeless
  CustomShader was being attached to splats. It's now **mesh-only** (Bing/3MX) — Cesium renders
  `KHR_gaussian_splatting` GLBs natively, so GeoSplats/other splats load there without the crash.

### Fixed — 2026-06-30 (`main`: 3DTRJS gizmo drag + mousewheel crash)
- **Crop gizmo drag was inverted/"applied twice":** `_closestOnAxis` (closest point of the mouse ray to a
  handle's world axis) had a sign error — it computed `(f − b·e)/(1−b²)` = **−s**, reflecting the dragged
  point through the current handle, so a face/arrow moved the wrong way by the same magnitude. Now
  `(b·e − f)/(1−b²)`. Verified numerically (ray over x=5 → closest (5,0,0), was (−5,0,0)). Affected both
  the face-resize handles and the translate arrows. (The old `_cropGizmoInfo` self-test missed it — it
  bypasses `_closestOnAxis`.)
- **3DTRJS mousewheel crash** (`Cannot read properties of null (reading 'layers')`, spamming every frame):
  `GlobeControls.update()` raycasts the whole scene on zoom (`intersectObject(scene)`); a tile disposed
  mid-frame leaves a transient null in the traversal. `controls.update()` is now wrapped in try/catch
  (log-once), mirroring the existing `tiles.update()` guard.
- **Gizmo handles smaller** (handle 0.06→0.03 of max half-extent; arrows 1.6→1.1× + shorter head) — they
  were bulky. **Auto-shown** now after "⬚ Set box to view" in 3DTRJS mode.

### Fixed — 2026-06-30 (`stream-cache` cont.: splat-dump output corruption + dump/viewer feedback)
- **`/dump/splat` produced corrupt SPZ/SOG/PLY** — three independent `@playcanvas/splat-transform` bugs,
  all now fixed + verified end-to-end with a standalone DataTable harness (see
  `memory/splat-transform-output-gotchas.md`):
  - **Buffer over-read (all 3 formats):** `mfs.results.get(name)` is a `Uint8Array` *view* into a 5 MB
    scratch buffer (`MemoryWriter.close` → `new Uint8Array(buffer.buffer, 0, cursor)`). `Buffer.from(out.buffer)`
    wrapped the whole 5 MB → trailing garbage. → SPZ NaN positions (SuperSplat `translate(NaN)`), SOG EOCD
    buried 5 MB from the end ("End of central directory not found"), bloated PLY. Now emits
    `Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)`.
  - **SOG was not a bundle:** `writeSog` needs `bundle: true` to emit a single self-contained `.sog` zip;
    without it, loose `.webp`+meta files were written and `crop.sog` wasn't a zip.
  - **PLY wrote SPZ bytes:** the `else` branch routed `ply` → `writeSpz` into a `.ply` ("invalid file header").
    Now uses `writePly({ plyData: { elements: [{ name: 'vertex', dataTable }] } })`.
- **Dump now honours the viewer's extra modelMatrix** (`&matrix=<16 col-major>`): a Z-offset nudge
  (e.g. Geghard −1800 m) or local-frame ENU placement applied in the viewer is no longer invisible to the
  dumper — `traverse`/`forEachPoint` seed the world chain with it, so the crop matches the on-screen position.
  Cesium reads `tileset.modelMatrix`; 3DTRJS reports the globe-mode Z-offset (translate along ECEF up).
- **3DTRJS "⬚ Set box to view"** now works in 3DTRJS mode (was a Cesium-only no-op): raycasts the inner-80%
  canvas corners against the loaded tiles (fallback: globe surface), ECEF→carto → geographic crop bbox.
- **3DTRJS globe zoom no longer resets** as nested external tilesets stream in: framing is now one-shot per
  load (external `*.json` children also re-emit `load-tileset`); the ↗ Fly-to button re-frames on demand.

### Added — 2026-06-30 (`stream-cache` cont.: 3DTRJS point size + Bing city pills)
- **3DTRJS point-size slider** (Crop & Dump-adjacent control, 3DTRJS mode): sets the PointsMaterial `size`
  (screen px, sizeAttenuation off) on POINTS tiles — applied to loaded tiles and each as it streams in.
- **Bing 3D city pills** — Roma / Washington / Berlin load the same world tileset and fly the camera to the
  city (re-clicking a city when the world tileset is already loaded just flies, no reload). Works in both renderers.
- *Note on mesh GLB streaming:* a single merged-GLB 2-pass stream stays deferred — the GLB JSON chunk must
  declare every accessor's byte layout up front (needs all geometry **and** texture sizes, i.e. fetching
  textures, before any bytes are written; gltf-transform has no stream-writer). `/dump/zip` already streams
  meshes out-of-core (one tile in RAM at a time).

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
