# Changelog

All notable changes to **3dtiled-to-3dtiles** are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Fixed — 2026-11-04 (Potree 1.x lost most of a cloud's finest points)
- **Potree 1.x leaves counted as 0 points were dropped.** PotreeConverter writes a count of 0 in the `.hrc` for a leaf
  whose `.bin` holds thousands of points: a leaf's points go to its `store`, and only an inner node adds to `numAccepted`. `/stream`, crawl exports and the offline converter all skipped them. On a
  1.3 billion point Iconem cloud that was 169,134 of 209,474 nodes, about 3/4 of the points, all at the fine end. Potree
  itself reads any listed node, which is why it showed more detail. Re-export any Potree 1.x cloud exported before this.
- **The offline converter on a remote Potree 1.x cloud lost the same points**: its mirror had its own copy of the filter
  and never downloaded those files. `/convert` caches from before this are not reused.
- **A failed `.hrc` read no longer loses a branch.** It counted as "no such chunk", and the server remembered the chunk
  as loaded, so one failed request dropped that branch until a restart (8 of 493 nodes, 1% of the points, in one test).
  Reads now retry, and a read that still fails is an error the next request retries.
- **One read layer for every source format** (`core/source-fetch.js`): retries, a cap per host, errors that keep the host's
  status. SOG, LCC, RAD, I3S and 3MX had no retries: one 503 on their first file failed the dataset until a restart, as a
  failed first read was remembered for good. It now expires after a minute, on all of them. Exported through a host failing
  every request once, COPC, Potree 1 and 2, SOG, LCC, RAD, I3S and plain 3D Tiles come out identical to a clean export.
- **`/stream` says why a read failed:** 502 if the host did not answer, 404 if the file is not there. A test runs these rules
  against every format. GeoSplats, `.3dtiles` and `.3tz` packages pass the same export check as the others.
- **Point tiles carry `_INTENSITY` and `_CLASSIFICATION`** as glTF custom attributes, from COPC and Potree 1.x/2.0, live
  and offline. Nothing was sent before: a cloud without RGB had only white `COLOR_0`.
- **A crawl export of a deep implicit tree shows progress and starts at once.** Reading the availability of a 25-level
  Potree cloud (the 1.5 billion point Venice scan) walked tens of thousands of subtrees before the first download and
  reported nothing meanwhile, so the desktop app sat on "Reading the tree" with an empty bar for minutes. The walk now
  counts the subtrees read, and a copy that keeps implicit tiling downloads each subtree and its tiles as soon as that
  subtree is read. The walk reads 8 subtrees at a time instead of every child at once, so the server that generates them
  keeps answering the viewer. Cancel stops the walk, not only the downloads after it.
- **Desktop: the folder pickers work on Windows.** Electrobun's dialog cannot pick a folder there (it opened the file
  dialog, in which no folder can be chosen); the folder buttons now open Windows' own folder dialog.
- **Desktop: the Advanced rows wrap** instead of squeezing five selects into one line.
- **Desktop: the servers the app starts exit with it.** Windows keeps a child running when its parent is killed or
  crashes; the tile-server of a dev build stayed up after the app was gone, and the next launch adopted it, running that
  old code. Both servers now follow the app's process, and closing the window stops them.
- **The cap on requests to one host adapts:** it halves when the host fails under load (a 429, a 503, a reset) and climbs
  back as reads pass, between 4 and the configured 32.
- **The tile-server listens in 0.5 s instead of 10–15 s:** the format adapters and the tools load after the port is bound.
- **Desktop: the window opens at once**, in its "starting the tile-server" state, and reloads with the ports when the servers
  are up. It used to wait for them, showing nothing for 15–20 s, and up to two minutes when a port probe hung.
- **Desktop: the view is React + Tailwind + shadcn/ui on Base UI**, built by Vite; same layout, texts and theme.
- **Windows Defender may quarantine the app's `launcher.exe`** (`Trojan:Win32/Bearfoos.A!ml`, a false positive on the unsigned
  Electrobun launcher, first seen 2026-11-04): the Start-menu shortcut then does nothing, an update fails while applying,
  and the installer fails with `AntivirusInterference`. See the desktop guide for the exclusion to add until the app is signed.
- **I3S: a node page that failed ended the pages**, and every node after it was lost until a restart. It now fails the
  request, and the next one resumes from that page.
- **I3S: a tile whose geometry could not be read was served as an empty tile**, and one whose texture or colours could not
  be read lost them, with a 200. An export now also asks for the whole tree when a huge layer was still loading.
- **LCC: a host that ignores `Range` got wrong splats**, read from the start of `data.bin`.
- **COPC: a CRS that could not be read left the dataset unplaced until a restart.** A file deeper than level 8 whose root
  page does not list the depth is no longer cut off there.
- **Offline converter: LCC's `index.bin` and `data.bin` could fail unnoticed.** Every mirror now retries.
- **An export of a mosaic that lost a child now says so**, under `hierarchyErrors`.
- **A failed hierarchy read reached clients as an empty file**, for every octree format: `/stream` sent its 200 before
  reading the subtree, so an error became an empty body.
- **A crawl pruned any subtree it could not read**, with no error. An export now stops on it, or with
  `hierarchyErrors: 'warn'` (`--hierarchy-errors warn`) lists it and carries on.
- **Potree 2: a block near the root could fire hundreds of range reads at once**, unbounded and without retries. On
  `lion` from potree.org, 25 of 116 subtrees failed and a client loaded 1,149 of its 1,624 nodes.
- **Potree 1.x: a subtree built while a chunk was in flight came out without it**, and a walk stopped at any chunk
  already loaded, missing those below it.

### Added — 2026-11-04 (desktop library)
- **Desktop: a progress bar in one block per step**, with *Step 2 of 3* in the status line.
- **Desktop: a theme button** (system, light, dark), shadcn-style controls, a footer at the bottom of the window, and the
  build in it: `v2026.11.4 · 1trdzhm`.
- **Library rows**, now the default: one line per entry, its title and buttons. A *Rows / Cards* switch brings back the cards.
- **Exports check themselves at the end**, on by default, for both methods: `verify` = `off`, `counts`, `sample` (default)
  or `full`. It walks the finished folder as a client would, reads every tile's header, and compares the points with the
  total a Potree or COPC source declares, which is the check that would have caught the Potree bug above. The outcome is
  in the status line and in `export-report.json`.
- **Point clouds in Cesium for Unreal**: the app and the [Demo viewer](/docs/guide/demo-viewer#point-clouds-need-a-low-target)
  page explain why its default screen-space error of 16 loads far fewer points, with measurements.

### Changed — 2026-11-03 (static docs)
- **The docs image serves plain files.** Pages were already pre-rendered when the image was built, but a Next.js server
  still ran to hand them out. It now holds the static export and a small file server, on the same port and address.
- **The desktop window opens at its content's width**, with the content centred if you widen it. Closing a preview
  returns the window to that size.

### Added — 2026-11-03 (desktop previews, viewer guide)
- **Desktop app icon**: the installer, shortcuts and taskbar use the 3D Tiled logo.
- **Desktop previews open over the launcher**, with a *Back to menu* button, instead of replacing the page with only
  Alt+Left to return. **Preview in 3DTRjs** joins *Preview in Cesium*, through the demo viewer. The API playground and
  hierarchy graph open the same way.
- **New docs page, [Demo viewer](/docs/guide/demo-viewer)**: both renderers, every sidebar option, when Auto controls
  switch, how a mosaic is built, and what is fetched from the root to the tiles as screen-space error is reached.

### Fixed — 2026-11-03
- A select's long value no longer pushes the sidebar's content past its right edge: it is cut with an ellipsis.
- `AGGREGATE_CACHE_DIR` without a trailing slash, as the desktop app sets it, wrote the cache beside the folder instead
  of inside it (`aggregate-cachesnap-offsets.json`).

### Added — 2026-11-03 (mosaics appear at once, snap follows)
- **A snapped mosaic no longer blocks on its first build** (22 s for the 660 Iconem datasets). It loads unsnapped at once,
  its dots show grey at their own height and settle one by one as each offset arrives, with a count next to *snap*,
  then the tileset moves to the snapped one. Already built, it loads directly.
- **`GET /aggregate/snap.ndjson`** streams the offsets, one line per dataset as each resolves.
- **Snap offsets are kept on the server's disk**, so a restart no longer costs the first build again. A deploy replaces
  the container, so that also needs a volume on `AGGREGATE_CACHE_DIR`, now in `docker-compose.yml`. Two clients asking for
  the same mosaic or offset now share one build.

### Added — 2026-11-03 (JSON subtrees)
- **The server tools read JSON subtrees as well as binary ones**, with external buffers and `constant` availability:
  `implicit-to-explicit`, `/stats`, `/export` and `/extract`, through one `loadSubtree` in `packages/core`. A crop used
  to treat a JSON subtree as missing, and silently return less. An implicit export keeps the source's encoding, with
  external buffers beside their subtree.

### Added — 2026-11-03 (desktop app library and layout)
- **Two flows in the Build tab**: enter a dataset, then *Live-stream* (copy a URL) or *Export to disk*. Everything else is
  folded under *Advanced*.
- **History** in the Library tab, next to bookmarks: what you served or exported, with JSON import and export of both.
  The library moves to `%LOCALAPPDATA%\3D Tiled\library.json`, so it survives updates.
- **The app is named `3DTiled`**, so that Windows search finds it by that word.
- A build updates from the releases of the repository that built it, so Iconem's builds follow Iconem's.

### Added — 2026-11-03 (usage analytics)
- **Umami for the demo and docs**, off unless configured: `UMAMI_SRC` and `UMAMI_WEBSITE_ID` on the viewer container, the
  repository variables `UMAMI_SRC` and `UMAMI_DOCS_WEBSITE_ID` for the docs image, `deploy/analytics` to run it.
- **`deploy/traefik/access-log.yml`**, a JSON access log and metrics for the tile-server that drop query strings, as they
  hold share links and SAS signatures.

### Security — 2026-11-03
- The Iconem viewer and tile-server images built before the keys left the source are deleted from the registry (162 versions).
  Publishing to Iconem's packages works again after Paul reset the GitHub Actions access on them, a settings change.

### Changed — 2026-11-03 (desktop app)
- **One-file installer, a portable zip, and automatic updates** for the Windows app, as in terrain-viewer. The installer
  no longer needs a `.installer` folder beside it. Updates download in the background and wait for an *Update ready* button.
- **Its servers listen on `127.0.0.1` only** (`HOST`), so Windows no longer asks to allow Node through its firewall, a dialog
  that needs admin rights. Docker and `pnpm dev` keep listening on all interfaces.
- On stable Electrobun 2.0.2, which can package on Windows, rather than a beta.

### Changed — 2026-11-03 (3d-tiles-renderer 0.5.4)
- **Viewer on `3d-tiles-renderer` 0.5.4**, which ships our [#1780](https://github.com/NASA-AMMOS/3DTilesRendererJS/pull/1780)
  and [#1782](https://github.com/NASA-AMMOS/3DTilesRendererJS/pull/1782). `lib/implicitAddFix.ts` and the vendored
  `potree-lab/vendor` copies are gone. Three local changes upstream does not have stay, without a copy:
  `lib/potreePlugin.ts` (aborted hierarchy chunks, uint16 colours) and the child boxes in `lib/addRefinePointSize.ts`.
- **Re:Earth (Mapterhorn geoid)** in the terrain list, for both renderers: heights above the ellipsoid, so
  correctly georeferenced data sits on the terrain without a snap.
- The debug list has *Cells only* above *Cells + dataset roots*.

### Fixed — 2026-11-03
- **Colour by height on native Potree leaves.** A model whose tile was not attached yet was measured in its source
  CRS, read as ECEF: Etretat's range came out around 675 km. Native models now name the frame they belong to.

### Added — 2026-11-02 (desktop app release)
- **Windows desktop app on GitHub Releases** (`desktop-latest`), built by the `Desktop app (Windows)`
  workflow. It now carries its own Node and tile-server, so it no longer needs this repo or a system Node;
  the workflow installs it on the runner with the system Node hidden before publishing.

### Changed — 2026-11-02 (licence)
- **MIT licence** for the repository.

### Security — 2026-11-02 (API keys out of the repository)
- **Google and Cesium ion keys are no longer in the source or in git history.** Set them in
  `apps/viewer/.env.local` (see `.env.example`), or as `GOOGLE_MAPS_API_KEY` and `CESIUM_ION_TOKEN` on the
  viewer container, which keeps them out of published images. Without them, Google 3D and Cesium World
  Terrain are greyed out. History was rewritten, so existing clones must be reset to the new `main`.

### Fixed — 2026-11-02 (Terrarium globes, follow the terrain, crop box)
- **Mapterhorn and AWS terrain failed tile by tile in 3DTRjs** whenever imagery was on: since
  `fd46d51` the globe registered an undefined `load-model` listener, and three's event dispatch threw on
  every loaded tile. AWS Terrain Tiles work again.
- **Mapterhorn 404s** left holes in the globe. Open ocean now reads as sea level, and a deep tile without
  a regional DEM is cut out of its nearest ancestor.
- **Auto (follow the terrain) on mosaics**: `&snap=` used Mapterhorn even on WGS84, and never changed
  with the terrain. It now follows it, with a new `&snap=wgs84`; each dataset's samples are cached apart
  from the terrain, so switching takes 0.08 s on the 660 Iconem datasets (22 s for the first build).
- **Auto on a single tileset**: Google 3D and World Terrain mounted after the listener was attached,
  so a first failed measurement was never retried, and the ray could hit anything in the scene; it
  now reads the terrain renderer only. A failed measurement also retries as the data loads, on any terrain.
- **Set box to view (3DTRjs)**: its "east" axis was not east, which turned and mis-sized the box;
  a flat view gave a box with no height, hence empty extracts. It now uses true east/north, 80 % of the
  view as labelled, and pads the heights.
- **3D crop box**: it did not show until an unrelated re-render, ignored the numbers, and a drag never
  reached them, so the extract ignored it. It now follows the sidebar and writes back on release.
- **Switching controls**: a frame between the mount and the pivot could leave Orbit's target at the
  Earth's centre.

### Changed — 2026-11-02 (terrain list, controls Auto, point colour)
- **3DTRjs is the default renderer**, in the viewer, the aggregate builder and the desktop app's links.
  `?renderer=cesium` still opens Cesium; a link without `renderer` now opens 3DTRjs.
- **Terrain list**: WGS84, Google 3D, Mapterhorn, AWS Terrain Tiles, Cesium World Terrain. In 3DTRjs,
  Mapterhorn is now mapterhorn.com's own Terrarium webp tiles (sea level) rather than Re:Earth's
  ellipsoidal mirror (z14). A georeferenced dataset therefore floats above it by the geoid undulation
  until snapped. Its depth follows the location, z12 to z16, each missing tile being cut out of its
  nearest ancestor.
- **Controls mode Auto**: Globe from far away, Orbit below 3 km above the ground, back to Globe above 6 km.
- **Point colour** (RGB, one colour, height) in every material mode, replacing X-ray's own setting.
- **Debug: Cells only**, without the dataset roots' bounding spheres.
- **Native Potree leaves** on by default.
- **Auto (follow the terrain)** is the first control of Local Frame.

### Changed — 2026-10-30 (level Trackball and Fly, faster Orbit damping)
- **Trackball and Fly keep the camera level**, like Orbit: the roll each accumulates (Trackball
  rotates `camera.up` with the drag, Fly composes pitch and yaw in the camera's frame) is removed
  after every update, against the ellipsoid normal on the globe. Trackball stops 2° short of the
  poles; Fly's Q E roll no longer applies.
- **Orbit damping** 0.05 → 0.3: it settles six times faster.
- **Mosaic children never drain upfront.** `&cache=hierarchy` on `/aggregate` now asks each child
  for the new `/stream` **`cache=refine`**: open with nothing prefetched, then drain the whole
  hierarchy in the background on the first tile request below the root, so only the datasets a user
  zooms into are drained and nothing waits (Bastia: root in 186 ms, drain at ~270 `.hrc`/s, tile
  and subtree requests under 100 ms meanwhile). `&cache=none` passes `&prefetch=N` through. The
  top bar keeps none/hierarchy for mosaics (no `all`), and every cache pill and the prefetch input
  now explain their upfront cost and what they buy on hover.
- **Point colours as normalized `u16`** instead of `f32`: `/stream` and the offline converters write
  `COLOR_0` as normalized unsigned short VEC4 (8 B a point instead of 16; a Bastia tile 28 → 20 B a
  point), lossless for 8-bit sRGB sources. `&colors=u8|u16|f32` per `/stream` request,
  `POINT_COLORS` server-wide; `u8` halves again but bands the darkest values (glTF colours are
  linear). The vendored 3DTRjs Potree loader stores linear `Uint16` too (24 → 18 B a point).
- **Max SSE shows what auto is** for the loaded tileset (`auto · 2` for points).

### Fixed — 2026-10-31 (data stopped refining: the globe filled the shared tile cache)
- Measured, a globe tile holds a 512² RGBA imagery texture (1.05 MB), its share of a 514² Float32
  elevation grid (1.06 MB, shared by up to 16 tiles) and a 33×33 mesh (~70 KB). 3DTRjs's cache
  charges every tile for the whole shared grid: 161 tiles counted 350 MB for 223 MB really held
  (169 MB imagery, 43 MB for 41 grids, 11 MB meshes).
- 3DTRjs shares one LRU tile cache (0.4 GiB) between every renderer, and a renderer whose cache is
  full requests nothing more. The terrain and imagery globe weighs ~2.2 MB a tile: measured over
  Bastia at 150 m, 161 globe tiles held 350 MB of the 429 and the dataset's 211 point tiles 66 MB.
  A pitched view or a long browse filled the cache with terrain and the data stopped at whatever it
  had, often the root. The globe renderers now have their own cache; the data renderer and its
  native-leaf children keep the default one to themselves.

### Added — 2026-10-30 (baked mosaic bounds, `&cache=` on mosaics, tile-count table)
- **Docs: "What a mosaic costs"** in the meta-tilesets guide: where a dataset's sphere comes from
  (baked, cached, or probed), what the client fetches and when, what a lazy `/stream` open reads,
  what `cache=hierarchy` drains (one 2.45-billion-point Iconem cloud: 46,993 `.hrc` files, 210 s
  before the first answer, against 0.2 s lazy), and a table of every cache with its lifetime.
- **Aggregate presets wait for the server's set list**: `?preset=agg-iconem-all` used to load the
  open-data mosaic when the list arrived after the first render, and stay there.
- **Uploaded manifests keep their set name when baked**: the upload hash ignores `bounds`.
- **Points without RGB are white** (streaming and offline), not intensity-as-grey, which came out
  near black for the usual small 16-bit intensity values.
- **Imagery None** draws the 3DTRjs terrain unlit and black instead of a white hillshade.
- **X-ray points**: *RGB* or *one colour* with a colour picker (white by default).
- **`scripts/aggregate-bake-bounds.mjs`** writes each manifest entry's placement
  (`bounds: { sphere, geometricError, native? }`) into the manifest; `/aggregate` then builds the
  mosaic and its index without fetching any child root. The Iconem index (692 datasets) answers in
  60 ms on a cold server with no cache. Every committed manifest is baked; `iconem-share-links.mjs`
  and `openheritage3d-manifest.mjs` keep bounds across regenerations. `&ttl=0` and `&curved=` ignore
  them.
- **`&cache=none|hierarchy` on `/aggregate`**, passed to every `/stream` child, and the viewer's
  top-bar cache pill reaches the aggregate presets. Default stays `none`: measured cold on Iconem
  share links, `hierarchy` took 183 s and over 300 s for a cloud's first root (it drains the whole
  hierarchy), against 0.1–0.2 s lazy, and point tiles are built per request either way.
- The child-root cache key ignores `cache=`, so probing never drains a hierarchy and both modes
  share one cache.
- **Docs**: measured terrain and imagery tile counts per camera pitch, nadir to 110°.

### Fixed — 2026-10-29d (COPC geometric error was the node diagonal: everything refined to 2 px)
- **`/stream` COPC tilesets declared `geometricError = cube diagonal / 2^level`** (explicit and
  implicit trees alike), 100–200× the point spacing a tile actually carries, where Potree streams
  declare the spacing. With a 2 px error target that refines every node until it is two pixels wide:
  the `open` mosaic seen from orbit marked **14 829** tiles used and queued **7 591** downloads in
  3DTRjs — the national flai overviews (one with a 5 486 km cube) traversed to depth 13 — which is the
  "seeing the whole of France is slow" cost, in Cesium as much as in 3DTRjs. COPC tiles now declare
  `spacing / 2^level` from the COPC info VLR (fallback cube/128, the Potree convention): same view,
  **146** used, **39** queued. The mosaic's leaf error is unchanged (it takes the larger of the dataset's
  tileset-level error and sphere radius), and the viewer's adaptive point size now reads COPC tiles'
  spacing from the error directly, as it does for Potree.

### Added — 2026-10-29d (3DTRjs navigation, picking, loading and marker styling)
- **One picking rule** (`apps/viewer/src/lib/picking.ts`) for double-click, middle-drag and the
  controls' own drag/rotate/zoom pivots (GlobeControls/EnvironmentControls `_raycast` is wrapped per
  instance): never a hidden object (a picker-hidden dataset, the inactive native/stream variant),
  a wireframe (the reference sphere with imagery off), a transparent material or a back face; the data
  wins over the terrain when both are under the cursor, the nearest terrain hit otherwise.
- **Footprint gate** (`lib/footprintGate.ts`, a `calculateTileViewError` plugin): a mosaic dataset
  root is not requested until its bounding sphere spans 24 px on screen — the marker stands for it —
  so a national mosaic from orbit no longer fetches 100+ external roots and their root content
  (native Potree leaves included: the child renderer never mounts for a 5 px dataset).
- **Stale download abort** (`lib/staleLoads.ts`): 3DTRjs only cancels tiles still QUEUED; tiles
  downloading or parsing while unused for 12 updates are now removed from the cache (fetch aborted,
  parse discarded) on the mosaic, its native-leaf children and every globe renderer — the "loads every
  tile along the camera path" stall on a fast fly-to. The imagery globe refines to 2 px, not the
  plugin's recommended 1 px.
- **Terrain behind data** (on): terrain first, depth cleared, then the data (a render-order 0.5 hook;
  content models get render order 1), so datasets under the DEM stay visible. The camera roll is left
  to the controls (GlobeControls: local vertical near the surface, north only from far away).
- **Controls freeze**: two causes handled — a gizmo unmounted mid-drag leaving drei's
  `controls.enabled = false` (re-enabled whenever no gizmo is shown), and EnvironmentControls' stale
  `up` refusing near-parallel drags after the camera travelled (its up follows the ellipsoid normal at
  the camera every frame).
- **Motion LOD** (`lib/motionLod.ts`): for the duration of a scripted fly-to (`flight.active`) the
  globe renderers' error target is multiplied by 6, so the frames of the flight request only coarse
  imagery and terrain and the frame after arrival requests the destination at the normal target.
  Globe renderers only, flights only: a first version boosted every renderer from the camera's speed,
  which made the points and the terrain flicker between levels while panning or orbiting.
- **Picker**: the in-view list is a tree — country (ISO 3166-1 alpha-3) → agency / project → site —
  with one checkbox per level for everything under it and single-child levels collapsed; the
  provider "markers" pills are now **source pills** (the mosaic's server sets, or its providers when it
  has one) that hide the datasets themselves, tiles and markers. A hidden dataset is masked in the
  traversal too (`FootprintGatePlugin.isHidden`): its tiles stop loading and leave the cache instead
  of merely being drawn invisible. `/aggregate/index.json` rows carry `country` / `countryName` (from
  the manifest entry's `country`, else the "(XX)" alpha-2 in its project or name); the committed
  manifests (flai, cities, Esri, Open Heritage 3D, Aerometrex, Vexcel) and RESOURCES.md entries are
  tagged.
- **Z offset**: **Auto (follow the terrain)** keeps a tileset snapped to the ground — the dataset's own
  low bins against the selected terrain source (Mapterhorn/Terrarium sampled, World Terrain / Re:Earth /
  Google 3D by ray, WGS84 as 0), re-measured when the terrain under it refines, when the terrain mode
  changes and when a new tileset loads; on a mosaic it toggles the server-side per-dataset `&snap=`.
  **Undo** after a snap restores the previous offset (or removes the mosaic's `&snap=`): there was no
  way back before. **Clearance above ground** (10 m default) is added by Snap and Auto, so a scan lies
  above most of the terrain rather than half inside it.
- **Child-root cache persisted** (`.local/aggregate-cache/child-roots.json`, `AGGREGATE_CACHE_DIR`):
  a mosaic's child roots survive restarts and deploys, and a stale entry is served while it refreshes
  in the background — the Iconem mosaic no longer re-fetches 692 roots from the share-link API (9 s
  locally, a minute on prod) after every restart or 24 h.
- **Controls**: **Trackball** (free rotation about the target) and **Fly** (W A S D / R F / Q E, drag
  to look, speed from the height above ground; runs the frame loop while active) join Globe, Orbit and
  Environment. Bare `controls.update()` calls skip FlyControls (its update needs the frame delta; an
  undefined delta turned the camera to NaN).
- **X-ray** has an **opacity** slider (points; meshes at 60 % of it) and **RGB / white** points.
- **Sidebar regrouped** into six foldable sections that remember their state (localStorage): Basemap &
  Terrain, Camera & Controls, Tileset & LOD, Material & Points, and Crop & Extract / Local Frame, which
  start folded. **Material** (3DTRjs): Default / X-ray (additive, no depth write: meshes as a tint,
  points at 35 %) / Wireframe, applied to every loaded tile and native Potree leaf.
- **Open Heritage 3D manifest rebuilt from the source** (`scripts/openheritage3d-manifest.mjs`): 441
  point clouds from 243 projects (was 10 hand-picked), with title, country, licence and the project
  map's coordinates; 146 projects have no Potree viewer yet and 70 name clouds that were never
  uploaded (every URL is probed). **Terrain behind data** is now on by
  default.
- **Globe parse queue** (`GLOBE_PARSE_QUEUE`, 32 jobs) for the imagery and Terrarium globes: their
  `parseToMesh` is a network wait (elevation grid, then overlay image) and 3DTRjs ran it through the
  shared 5-job parse queue sized for Draco/glTF decoding, so a close view's ~300 terrain tiles drained
  five round-trips at a time — measured headless, fine imagery finished 8-10 s after arrival at a
  400 m view while each fetch took ~10 ms. The data renderers keep the shared queue. (The camera
  tween never held requests back; the parse queue did.)
- **Fixed: Orbit controls crashed the 3DTRjs viewer** (`installFilteredRaycast`: drei's OrbitControls
  has no `_raycast` to wrap — skipped now).
- **Fixed: native Potree leaf "Cannot read properties of undefined (reading 'childMask')"** after a
  fast camera move (a controls switch): the vendored loader marked a v1 hierarchy chunk as loaded
  before its fetch finished, so an aborted chunk (the tile left the cache) was never re-requested and
  the node's children were later expanded against a hierarchy that did not know them. The chunk is
  marked loaded once parsed, and a node without a hierarchy entry is a leaf.
- **Fixed: middle-drag zoom "did not react" on a point cloud**, especially right after flying to a
  marker: the points pick tolerance was one world radius for the whole ray, sized at the dataset's
  distance, so a stray point two metres in front of the lens matched and, being nearest, became the
  pivot. A point now counts only within 15 px at its own distance (`pickPoint`, also for the controls'
  own pivots).
- **Basemap**: Mapbox Satellite is the default when the build has `VITE_MAPBOX_TOKEN` (a git-ignored
  `apps/viewer/.env.local`), Esri World Imagery otherwise; Esri tiles are requested with
  `blankTile=false`, so a level with no imagery answers 404 and the parent's imagery stays instead of
  the grey placeholder.
- **Markers**: 13 px pastel discs with a bold dark anti-aliased ring (8 px grey when picker-hidden), the
  same in Cesium (outline 2.5); one colour for every format by default (new `uniform` colour mode, the
  per-format palette is pastel too). A marker now hides only when its dataset spans more than 10 % of
  the viewport **and** has tiles on screen (sampled every 10 frames from `visibleTiles`), or fills
  60 %: a nearby cloud that has not loaded keeps a clickable marker. Hover card redesigned (header with
  format badge, key/value grid: extent, captured, provider, licence; mosaic cell and snap in a quiet
  row).
- **Basemaps**: *Esri World Imagery* without labels is the default (both renderers); *Esri + labels*
  stays; *Mapbox Satellite* is listed when `VITE_MAPBOX_TOKEN` is set at build time.
- **Potree lab**: switching control schemes keeps the camera in place (the new scheme adopts the
  current focus: orbit target / pivot, else the dataset point under the screen centre, else the view
  axis); middle-drag dolly and filtered picks as in the viewer. Fixes a `tiles` temporal-dead-zone
  error when the page opened with `?controls=globe`.
- Not done: a Web Mercator / planar view. 3DTRjs's planar mode is for its generated image surface
  only; 3D Tiles content stays ECEF and would need per-vertex reprojection plus matching bounding
  volumes (see viewer.mdx, "Navigating in 3DTRjs").

### Docs — 2026-10-29c (changelog in the site, curved placement design, handoff)
- **The changelog is now a page of the docs site** (`/docs/changelog`, first entry of the sidebar and
  a card on the index): `apps/docs/scripts/sync-changelog.mjs` mirrors this file into
  `content/docs/changelog.mdx` before every `dev` and `build` (MDX-escaped), and the output is
  committed so a checkout without a build step has it too.
- **Curved placement, the design behind it** (`meta-tilesets.mdx`, "Why this shape, and what was not
  done"): the options table — one root transform, one transform per tile, exact per point, sampled per
  tile (chosen), regions instead of boxes — with cost and verdict for each, and why the root frame is
  kept for the whole dataset. The explicit-tree paragraph now states the 8-corner box fit under 20 km
  and the per-source cache (2026-10-29b).
- **Handoff note** (`planning/handoff-2026-10-29.mdx`) gained the table of exactly which vendored
  files, local plugins, imports and docs paragraphs to delete or change when PR #1780, PR #1782 and
  #1783 land upstream, and what to keep until each does.

### Fixed — 2026-10-29b (the prod stall: curved COPC trees built 113 times on the event loop)
- **Root cause of "3dtiled stalls on the open mosaic", found after the hang-up fix landed and prod
  got slower, not faster:** curved placement (2026-10-26) builds an EXPLICIT tree for every
  country-scale COPC, 15–25 k tiles with a 5×5×2 proj4 sample grid per tile — ~1 s of CPU locally,
  ~8 s on prod — and `/aggregate`'s `childInfo` fetched that whole 6–10 MB tree from our own
  `/stream` just to read the root bounds, 113 times for `flai`, on the single event loop. Before the
  hang-up fix most of those loads failed fast, which hid the cost behind holes in the mosaic; with
  every dataset loading, `set=open` took over five minutes on prod and the root page five seconds.
- **`/stream/tileset.json?…&depth=0`** returns the root tile alone (copc-live: from the header and
  root page already in the context, no drain, no prefetch, a curved root box from the cube corners);
  `childInfo` appends it to every `/stream` child URL. **`curvedBox`** samples only the 8 corners of
  tiles under 20 km (the `sag` term already covers the chord dip; the fine grid stays for the few
  tiles above), and the finished curved tree is **cached per context and CRS**, so the first client to
  open a dataset builds it once (~150–250 ms locally).
- Measured on a cold local server: Liège root-only 766 B in 0.35 s; full curved tree 6 MB in 0.4 s;
  **`flai` (113 COPCs) 2.4 s cold, 15 ms warm, 113/113 roots, no failures**; `open` 3.8 s. S3 still
  reset 4 range reads during that run; all 4 were retried successfully by `range-getter.js`.

### Changed — 2026-10-29 (ADD-skip regression filed upstream, public reproducer repo)
- **Upstream issue [#1781](https://github.com/NASA-AMMOS/3DTilesRendererJS/issues/1781) and PR
  [#1782](https://github.com/NASA-AMMOS/3DTilesRendererJS/pull/1782)** for the ADD-skip traversal
  regression (fork branch `fix-implicit-add-skip`, `53a4415`), after Garrett asked for a dedicated
  issue in the #912 thread. `lib/implicitAddFix.ts` now points at them.
- **New public samples repo [jo-chemla/3dtiles-samples](https://github.com/jo-chemla/3dtiles-samples)**
  (GitHub Pages, CORS `*`): `lion_takanawa/implicit-octree/tileset.json` is the Lion `/stream`
  tileset exported static with `3dtiled export --keep-implicit` (no depth cap needed: 167 glb, 128
  subtrees, 7.8 MB, 9.5 s), so the upstream reproducer no longer depends on our server. The headless
  harness gives identical numbers against the Pages URL (master 0 tiles beyond 0.5 m, fix 1).
  `tileset-x100.json` next to it carries a root transform of scale 100 **and** geometric errors
  ×100 (3DTRjs divides the raw geometric error by distance, it does not scale it by the transform),
  so the 464 m model is on screen at the kitchen-sink example's 690 m start and vanishes past ~1 km
  on master.
- **Feature request [#1783](https://github.com/NASA-AMMOS/3DTilesRendererJS/issues/1783)**, adaptive
  point size for implicit ADD octrees (the generic form of our child-box sizing), with a proposed
  implementation shape; PR offered, pending Garrett's direction.
- PR #1780 review follow-up: the R3F `TilesPlugin` args note moved from the generated `API.md` into
  the JSDoc (`2878f781`); Potree's own material has `minSize` 2 / `maxSize` 50, our `maxPointSize`
  stays 0 (off) by default unless Garrett prefers 50.

### Fixed — 2026-10-29 (tile-server: S3 "socket hang up" no longer sticks)
- **Prod logs showed repeated `FetchError … socket hang up` from node-fetch inside the `copc` library**
  while the `open` mosaic loaded the DEFRA / NOAA overview COPCs. The errors were caught per request,
  so nothing crashed, but three things made one transient hang-up permanent until a restart:
  `memoizeAsync` cached a failed root load forever (the dataset answered 500 for the life of the
  process), `ensureForSubtree` / `drainAll` deleted a hierarchy page from `pendingPages` before
  reading it (a failed read lost the page and every subtree under it came back empty, silently), and
  a curved-placement tileset of a 900 km COPC drained its whole hierarchy with one unpooled,
  un-retried request per page (96 pages for DEFRA 2008) while the aggregate fanned out 16 such loads.
- **New `packages/tile-server/range-getter.js`** replaces the library's `Getter.http` for COPC: range
  reads issued in the same tick are sorted and coalesced when adjacent or less than 64 KB apart
  (capped at 8 MB per merged request), capped at 32 in flight per host (`TILED_RANGE_MAX_PER_HOST`),
  retried three times with backoff on resets / hang-ups / timeouts / 429 / 5xx, and any other non-2xx
  throws instead of being parsed as hierarchy or points. Measured: Liège overview, curved, 54 pages
  → 4 requests total (was 57); DEFRA 2008, 96 pages → 4 requests (was 99); Autzen implicit → 3.
- **`memoizeAsync` caches the promise** (concurrent first calls for one source share a single build)
  and takes `{ failureTtlMs }`; `copc-live` and `potree-live` pass 60 s, so a broken source still
  fails fast under polling but a hang-up during the root read heals by itself. Other adapters keep
  the permanent failure cache.
- **copc-live hierarchy pages are loaded through one in-flight map**: concurrent subtree requests
  share a page read instead of one of them answering with an empty block, a failed read puts the
  page back in `pendingPages`, and a failed `drainAll` resets so the next request finishes it.
  Verified by failing the first drain read three times: all 54 pages restored, next request loads
  them in one read. Background prefetches (`copc-live`, `potree-live`) now log failures instead of
  surfacing as `unhandledRejection` (the old `try { return promise } catch {}` caught nothing).

### Changed — 2026-10-28b (3DTRjs point-cloud patches proposed upstream)
- **Upstream [PR #1780](https://github.com/NASA-AMMOS/3DTilesRendererJS/pull/1780)** (branch `jo-chemla/3DTilesRendererJS:pointcloud-fixes`),
  off upstream master (which has not touched the Potree / point-cloud plugins since `0.5.3` shipped
  them on 2026-09-18), one commit per patch, each with a CHANGELOG line in upstream's format and
  passing upstream's lint: Potree 1.8 attribute objects ([`c3381669`](https://github.com/NASA-AMMOS/3DTilesRendererJS/pull/1780/commits/c3381669)), a clear error for LAS/LAZ node
  files and BROTLI encoding ([`8cb78c1e`](https://github.com/NASA-AMMOS/3DTilesRendererJS/pull/1780/commits/8cb78c1e)), a thrown error when a hierarchy or node download fails
  instead of decoding the error page as points ([`6b9071f5`](https://github.com/NASA-AMMOS/3DTilesRendererJS/pull/1780/commits/6b9071f5), found while testing: the loader had
  "loaded" a 403 body as 11 points per node), `maxPointSize` ([`ed4bcbb3`](https://github.com/NASA-AMMOS/3DTilesRendererJS/pull/1780/commits/ed4bcbb3)), `sizeAttenuation = false`
  ([`4e313f88`](https://github.com/NASA-AMMOS/3DTilesRendererJS/pull/1780/commits/4e313f88)), and an R3F docs note that `TilesPlugin` `args` are compared shallowly, so inline
  callbacks rebuild the plugin every render ([`aecb1edd`](https://github.com/NASA-AMMOS/3DTilesRendererJS/pull/1780/commits/aecb1edd)). Verified against the unpatched loader on a
  public Potree 1.8 cloud from Iconem's STAC catalogue (32 of the first 80 items are 1.8): upstream
  throws `Cannot read properties of undefined (reading 'name')`, the branch parses r=3409, r0=2788…
  points, same shape as the 1.7 Lion control.
- **Vendored copies re-synced to the branch.** `PotreeLoader.js` is the branch file verbatim; the
  material and effects plugin keep their patches with comments now naming the upstream commit, and
  only the child-box ADD sizing remains marked local (its generic form, an active-nodes driver for
  implicit octrees, is a separate feature request). Docs updated: the plugins are released in 0.5.3,
  the copies stay for the patches.
- Not in the PR: the per-renderer EDL pre-pass (dropped) and per-point LOD for non-Potree octrees
  (kept for later).
- **The ADD-skip traversal regression (#1673) is fixed on its own fork branch**,
  `jo-chemla/3DTilesRendererJS:fix-implicit-add-skip` (`53a4415`): the additive parent error skip
  in `markUsedTiles` now requires a parent with renderable content, as CesiumJS's
  `meetsScreenSpaceErrorEarly` does. Reproduced and verified headlessly in Node (no WebGL) with
  `.local/addskip-harness.mjs` on the public Lion Takanawa `/stream` tileset at
  3dtiled.iconem.com: master shows 0 visible tiles at 3, 10, 30 and 100 m (root content child
  error 13.8 px under the 16 px target); fixed, the root is drawn at every distance and 3 tiles at
  0.5 m. Upstream lint and the core/three/r3f suites pass (Babylon/PlayCanvas tests fail on
  pristine master too). `lib/implicitAddFix.ts` stays until a release ships it.

### Changed — 2026-10-28 (3DTRjs: native leaves switch in place, round points, ADD-refinement sizing)
- **Native Potree leaves no longer reload the mosaic.** An `/aggregate` URL is always requested with
  `&native=1` (the mosaic is the same either way), and `NativeLeavesPlugin` now mounts, per Potree
  leaf, both a `PotreePlugin` child and a plain `/stream` child renderer, created lazily: the
  checkbox flips which one updates and draws. Nothing is re-requested; the inactive reader keeps its
  tiles until the shared LRU evicts them, so flipping back is instant. The `/stream` child gets the
  parent's plugin set (implicit tiling, the ADD-refine fix, glTF extensions) and its models are
  picked, styled and sized like the parent's own.
- **One point renderer in 3DTRjs: `PointCloudEffectsPlugin` everywhere.** The main viewer now
  registers 3DTilesRendererJS's (vendored, unreleased) `PointCloudEffectsPlugin` on the parent
  renderer and on every `/stream` child, and the native leaves' `PotreePlugin` extends the same
  class, so one sidebar block drives all of them: **Point shape** (round / square / sphere, new,
  3DTRjs only) and **Eye-dome lighting** with its strength (previously Cesium-only in the main
  viewer; the lab had it). The hand-written `PointsMaterial` shader patch is gone.
- **Two local patches on the vendored `PointCloudMaterial`** (marked `LOCAL PATCH`, candidates for
  upstream): `maxPointSize`, a screen-size cap for attenuated points (three has none; Cesium has
  `maximumAttenuation`), set to 8 × the px size; and `sizeAttenuation = false` support, so the fixed
  pixel size works through the material. `PointCloudEffectsPlugin.processTileModel` keeps the
  source material's `sizeAttenuation`.
- **ADD-refinement point sizing.** A `/stream` Potree/COPC cloud refines additively, so a coarse
  tile kept drawing its points at its own spacing under its finer children: big blobs among small
  points ("weird adaptive point sizing"). Potree's per-point sizing needs an octree texture only
  `PotreePlugin` fills; `AddRefinePointSizePlugin` does it at tile granularity for any ADD tileset:
  each tile's material gets the boxes of up to 8 visible children (looking through implicit subtree
  roots) and the size to use inside each — the child's size scaled to the finest spacing visible in
  its subtree — and the vertex shader picks it per point (the child-box uniforms are the second
  local patch on the material).

### Fixed — 2026-10-28 (3DTRjs: native leaves surviving re-renders, zoom gestures, point-size cap)
- **Native Potree leaves vanished on a terrain, point-size or controls change.** `<TilesPlugin>`
  re-instantiates its plugin whenever its `args` object changes, and an inline literal with a fresh
  callback did that on every render of the scene: the Potree child renderers were disposed and the
  new plugin never re-claimed the already-parsed leaves. The args are now created once.
- **Middle-drag zoom** goes toward the point under the cursor (content or terrain), drag **down**
  zooms in, and OrbitControls' own middle-button dolly (which pulled the other way at the same time)
  is off. In globe/env mode the clicked point also becomes the pivot.
- **Double-click** zooms toward content *and* terrain in every control mode, the controls' built-in
  double-tap zoom is off (it raced the animated one: a jump, then the tween), any damping still in
  flight is cancelled first, and the tween starts from the camera's real orientation (the roll no
  longer snaps on the first frame). OrbitControls' cached up vector follows at the end.
- **Point size cap:** attenuated points are clamped to a screen size (8× the slider, 12–48 px) in
  the vertex shader. Zooming close into a dense cloud used to draw tens of thousands of points
  hundreds of pixels wide each, which stalls the GPU on fill rate (what a "freeze past a given zoom
  level" looks like); Cesium has `maximumAttenuation` for the same reason.
- **Default view** over AlUla (most Iconem projects are in Europe and MENA): a world-sized mosaic root
  used to be framed from the Canvas default on +Z, i.e. over the north pole.
- **Globe on/off is a checkbox** beside the Terrain select (the terrain choice is kept) instead of a
  "None (no globe)" terrain mode.
- `?load=` without `&type=` on a `/stream` point-cloud format loads as a point cloud (2 px error
  target, not the mesh default of 16).

### Fixed — 2026-10-27 (3DTRjs navigation, terrain "none", markers)
- **3DTRjs Environment controls:** left/right drag works on the terrain, not only on the loaded
  content: the controls now raycast the content *and* the globe/terrain renderers, and the fallback
  plane (a drag that hits nothing) is the local horizontal at the pivot instead of world Y = 0.
- **Framing faces north** (the camera used to sit north of the tileset, looking south).
- **Orbit/env near plane** also follows the camera's height above the ellipsoid, so content a few
  metres away is not clipped when the pivot was left kilometres behind (the tileset or the terrain
  "disappearing" in orbit).
- **Double-click fly:** the view direction and the roll ease from the current state (no jump on the
  first frame).
- **Adaptive point size** on 3D Tiles point clouds (Angkor): a tile's geometric error is only used as
  the point spacing when it is one; otherwise the spacing is estimated from the tile's own points.
- **Dataset markers** are composited on top (no depth test, far side of the globe culled in the
  shader): no more z-fighting with the ground.
- **Terrain "None (no globe)"** in both renderers, switched in place (the loaded tileset is untouched),
  for datasets that sit under the terrain or clouds seen from below.

### Fixed — 2026-10-27 (Azure SAS access for live Potree)
- **Azure SAS support (live Potree 1.x/2.0 only):** preserves the metadata URL query
  and forwards reusable Azure container/account SAS to same-origin child files
  without replacing child queries. This is not general signed-URL inheritance.
  Object-bound signatures and arbitrary metadata queries are not forwarded.

### Fixed — 2026-10-26 (country-scale COPC placement, 3DTRjs controls, viewer)
- **`/stream` COPC: curved placement past a 20 km extent.** Points are written through proj4 → ECEF
  → the root frame instead of "source minus origin" on the tangent plane, which floated Corsica 30 km
  above the ground in the France-wide IGN overview (d²/2R) and misplaced Catalonia and the Canaries.
  Such a source is served as an explicit tree with per-tile boxes fitted to the placed corners.
  `scripts/check-curved.mjs` verifies a tileset's farthest tile. The placement is sampled per tile
  on a ≤ 505 m grid and interpolated (1 cm), not computed per point; `&curved=on|off` (viewer:
  the *curved:* select) overrides the 20 km rule, and a mosaic forwards it to its COPC children.
- **3DTRjs orbit/env controls:** switching controls keeps the point last looked at as the pivot and
  takes "up" from the ellipsoid there (not the tileset's centre, degrees off once far from it);
  near/far clip planes now follow the pivot distance each frame (they were frozen at the first
  framing, so zooming into a facade clipped it).
- **3DTRjs native Potree leaves + picker:** re-showing a dataset also restyles the models its child
  renderer loaded while it was hidden (they stayed invisible).
- **3DTRjs picker "in view" list:** tested against the view pyramid alone, not the live clip planes
  (after framing a world mosaic the near plane sat at 200 km until the controls' next tick, so the
  picker listed nothing on screen).
- **Viewer:** everything clickable shows a pointer cursor (Tailwind v4 preflight left buttons at
  `default`); the 📂 manifest button moved into the *Aggregate* row, where each uploaded manifest is
  a pill before the server sets, named by the page URL (`preset=agg-upload-<hash>`); a `?load=`
  link to an uploaded mosaic shows that pill too.

### Added — 2026-10-23 (upload your own set manifest)
- **`POST /aggregate/set`** takes a local-set manifest (`{ label, entries: [{ url, format, name? … }] }`)
  and answers with `set=upload-<hash>`, usable with every `/aggregate` parameter. In memory, 24 h
  after last use, at most 20 × 10 MB; never listed in `demo.json`. The name hashes the entries, so
  the same file always gives the same URL.
- **Viewer: 📂 manifest** button next to *builder*: pick a `.json` from your disk, it is uploaded and
  loaded as a mosaic. The page URL gets `?load=<mosaic>` and the file stays in localStorage, so a
  reload after a server restart re-sends it first.

### Changed — 2026-10-23 (no Iconem share links in the repository)
- The `angkor` and `iconem-open` aggregate sets moved out of code into machine-local manifests
  (`.local/aggregate-sets/angkor.json`, `iconem-open.json`, gitignored). They appear only where those
  files exist; the *Iconem — demo* pill now requires its set.
- `world` is every committed dataset: `opendata` + `cities` + `esri-3d` + Aerometrex + Vexcel.
- Geghard is gone from the Potree presets, the desktop catalogue, the potree lab and the vanilla
  viewer; the lab's aggregate example is now Open Heritage 3D, the Potree debug script defaults to
  Lion Takanawa. The Angkor entries in the hierarchy explorer became the `open` set.

### Added — 2026-10-23 (native Potree leaves in mosaics)
- **`/aggregate?native=1`:** each Potree leaf also carries its source in
  `content.extensions.ICONEM_content_source` (`format`, `version`, `encoding`, `uri`, and a
  `transform` from the cloud's own coordinates to the leaf frame), listed in `extensionsUsed` only.
  `content.uri` is still the `/stream` 3D Tiles wrapper, so Cesium and other clients are unaffected.
  On the full Iconem manifest all 628 Potree leaves qualify (337 × 1.7, 291 × 1.8, all `.bin`).
- **`/stream` Potree roots report `extras.native`** (version, encoding, origin), which the aggregate
  reads from the child root it already fetches.
- **Viewer, 3DTRjs mode: *Native Potree leaves*** (`?native=true`). A plugin
  (`lib/nativeLeaves.ts`) mounts a `PotreePlugin` child renderer per visible Potree leaf, sharing
  the mosaic's cache and queues. Hide, tint, point size and raycast picking work on native points.
- **Measured:** identical nodes, points and placement to `/stream` at normal error targets
  (Geghard, six Angkor Thom clouds). At 0.25 px, native kept refining to 3.7 M points while `/stream`
  stopped at 1.7 M: under 3DTRjs, `/stream` Potree never passed level 3, its first child-subtree
  boundary. That is a separate `/stream` bug, logged in docs *Meta-tilesets*.

### Noted — 2026-10-20 (spec direction)
- glTF#1809 (Draco point compression) closed as superseded by `KHR_meshopt_compression`; Cesium's
  benchmark puts meshopt point GLBs at 1.01 GiB vs 1.19 GiB for `.pnts`+Draco on 313 M points, same
  load time. Confirms `/stream?transform=meshopt`; follow-ups in docs *TODO → Spec direction*.
- 3D Tiles 2.0 will be a set of glTF 2.1 extensions (3d-tiles#803, CesiumGS/glTF `3d-tiles-2.0`
  branch); `3DTILES_georeference` covers local → ECEF via a tangent plane, which is what the
  `&lon/&lat/&alt/&heading` placement already computes.

### Added — 2026-10-01 (open data sources)
- Three new committed sets, all in the *Open data* mosaic: `cities` (swisstopo, 3D BAG, PDOK, PLATEAU
  Japan, Helsinki, 12 more CRAIG meshes), `esri-3d` (nine Living Atlas integrated meshes as 3D Tiles,
  two I3S layers) and `openheritage3d` (ten Potree 2.0 heritage scans, licences per entry).
- Looked at and NOT added, with why (docs: Meta-tilesets): OpenTopography (per-dataset Potree viewers
  are per-job and gone; only four sample EPTs persist, and the server reads no EPT), Cesium ion (no
  public search API; Google/OSM/Bing assets need a token per request), Google/Bing 3D (global
  tilesets would draw over everything — they stay terrain choices), city-model ledgers (awesome-citygml,
  TU Delft 3D open cities STAC: CityGML/CityJSON downloads, no streamable tilesets).

### Changed — 2026-10-01 (lab controls feel · loading knobs · point controls on mixed mosaics)
- **Potree lab:** inertia slider (0.05 s default instead of 3DTRjs's 0.15 s), double-click to pivot
  and zoom with every control scheme, and loading knobs (parallel downloads, parses per frame, tile
  cache) with live queue/cache readouts in the HUD.
- **Point controls** apply to any tileset holding points, whatever the preset's type (the *Open data*
  mosaic is `mesh` but holds 113 COPC clouds); Cesium's style size is now the floor under attenuation.
- **Point clouds default to 2 px SSE** (was 4) in both renderers: a Potree root's spacing otherwise
  only refined below ~1 km.
- `iconem-open` is labelled **demo** (© Iconem, shared for demos), not public.

### Added / Changed — 2026-09-18 (debug cells · point controls · two pills · lab controls · external open)
- **Debug select** replaces the debug checkbox: **cells + dataset roots** draws the loaded tileset's own
  declared tiles (a mosaic's quadtree cells by depth, dataset roots in white; `lib/mosaicOutlines.ts`,
  both renderers); **all tiles** is the renderers' full debug view.
- **Point-cloud controls** in the sidebar for both renderers: point size, adaptive sizing (Cesium
  attenuation; 3DTRjs world-space size from the tile's geometric error), and eye-dome lighting +
  strength on Cesium.
- **Aggregate pills** are now two: *Iconem — all formats* first, then *Open data* (new `open` set:
  RESOURCES.md + Aerometrex + flai + Vexcel, 145 datasets). *Iconem — public* (new `iconem-open` set:
  Angkor + Geghard) stands in where the Iconem manifest is absent. The Angkor / Mes Aynak / per-format
  pills are gone — the picker does that.
- **Picker:** the *in view* list opens by default; the colour mode colours markers only; **⧉** opens a
  dataset alone in a new tab (potree lab for Potree, the 3DTRjs viewer otherwise).
- **Potree lab:** a **controls** select — EnvironmentControls, GlobeControls or three's OrbitControls
  (`?controls=`).
- **3DTRjs:** double-click and fly-to-sphere keep the camera upright (local up, or north when looking
  straight down) instead of three's default +Y roll.

### Added / Changed — 2026-09-17c (per-dataset snap · cell default · in-place picker · Vexcel · Esri · Mapterhorn default)
- **`&snap=`** on `/aggregate` snaps **each dataset separately**. Each leaf gets its own translation
  along the local up, computed server-side from the dataset's own top geometry against Mapterhorn.
  - New modules: `packages/core/dataset-ground.js` (shared with the viewer) and
    `packages/core/terrain.js` (Terrarium in Node, WebP via WASM).
  - Mes Aynak's seven captures: +3.2 to +6.5 m. The viewer's snap button now uses this on mosaics;
    snapping the mosaic as one tileset was why "Mes Aynak multi" did not snap.
  - Ground bins are now **8 × 8** (were 12 × 12).
- **`bv=cell` is the default.** Group tiles are their quadtree cells. `index.json` rows now carry
  `cell` and `depth`; the hover card and picker show where each dataset's root sits.
- **Picker changes no longer reload the mosaic.** The renderers keep the unfiltered tileset and hide
  datasets in place by their tile-metadata `id`.
  - Cesium: `tileVisible` sets `model.show` and `model.color`.
  - 3DTRjs: `scene.visible` and the materials.
  - Rapid clicks no longer lose changes while the index loads.
- **Picker controls:**
  - **colour** `format | provider | dataset` colours the markers and the data (one colour per Mes
    Aynak capture);
  - **provider pills** show or hide markers;
  - **bounds** and **snap** are segmented controls;
  - switching a format off removes its markers instead of greying them.
- **Vexcel:**
  - 10 Australian collections in a `vexcel` set and in `world` (55 datasets);
  - `/proxy` injects `VEXCEL_API_KEY` server-side and strips it from every URL it returns;
  - the server reads machine-local secrets from the gitignored `.local/tile-server.env`;
  - `requiresEnv` hides the set where the key is missing.
- **CRS placement:** `georefFromCrs` builds a **1 m trihedron** through proj4 instead of a plain
  ENU frame, keeping grid convergence and scale. The COPC offline converter uses it too.
- **Viewer defaults:**
  - **Esri World Imagery + labels** basemap in both renderers;
  - terrain **Mapterhorn (auto)**: quantized mesh in Cesium, Terrarium in 3DTRjs;
  - Re:Earth's z0 ellipsoid tile returns HTTP 500, so it is substituted;
  - 3DTRjs fly-to is north-up.
- **Aggregate Builder:** importing a tileset keeps its hierarchy (Angkor: 18 groups, 23 datasets,
  depth 8), with Flatten / group-by options.
- **Potree lab:** choosing a dataset in the select actually loads it (lil-gui `options()` dropped
  the change handler).
- **Desktop:** exports run either in the tile-server or as a CLI subprocess (allow-listed scripts,
  cancel, output tail, chained pack step).

### Added / Fixed — 2026-09-17b (terrain · snap · bounds · export options · providers · 3DTRjs findings)
- **Terrain:**
  - Added Mapterhorn in three forms: Re:Earth **quantized mesh (ellipsoidal)**, Re:Earth Terrarium
    (ellipsoidal) and mapterhorn.com Terrarium (sea level), next to the AWS Terrain Tiles, in both
    renderers.
  - Cesium's raster provider now falls back to the nearest available ancestor tile.
  - The docs explain the datum: 3D Tiles are ellipsoidal, and sea-level DEMs are off by the geoid
    undulation.
- **Snap to ground reads the dataset's own geometry.** It decodes the root content (glb/b3dm/pnts),
  bins it 12 × 12 and takes each bin's 10th-percentile height as the ground; the Z offset is the 70th
  percentile of terrain − ground. Both renderers now agree exactly: Geghard −53.5 m on Mapterhorn
  ellipsoid, 88/88 bins, i.e. the dataset floats ~55 m high. Picking remains as the fallback for
  compressed content.
- **`&bv=cell` and `&bv=box`:** groups bounded by their actual quadtree cells (geodetic 2×1 or
  web-mercator, widened only where a dataset pokes out), or by ENU-oriented boxes. Angkor pills for
  both.
  - **Fixed:** the geodetic cell key re-encoded the hemisphere bit and dropped the finest longitude
    bit, so cells were twice as wide as their key said.
  - Nesting tests now cover cell and box containment, plus a 2,000-point `cellAt` → `cellBounds`
    round trip.
- **Providers and attribution** on every dataset:
  - carried in index rows and tile metadata, and set in manifests and code sets;
  - the viewer shows "Data: …" credits for what is on screen;
  - the `world` set now includes the 12 Aerometrex cities (45 datasets), credited.
- **Aggregate Builder:**
  - several sources at once, with provider/set/format chips and a tag filter;
  - provider metadata end to end;
  - windowed tree;
  - tested on all 692 Iconem datasets (660 rows in ~100 ms; export of 660 datasets in 2–6 ms).
- **Export:**
  - `keepImplicit` (copies subtrees and templated tiles);
  - `method: "convert"` (the per-format offline converter, with its options);
  - `pack: ["3tz", "3dtiles"]` via the new `packages/convert/pack.js`;
  - CLI `--keep-implicit --pack`;
  - the desktop card gains method/option controls, a live "equivalent CLI" block, and links to the
    docs, the middleware home and the demo viewer (`?load=`).
- **Fixed: fly-tos lost at start-up in both renderers.**
  - Cesium dropped a fly-to issued before the viewer existed.
  - `App`'s renderer-switch reload also ran on mount and re-framed the whole tileset.
  - Cesium's preset fly-to now **looks at** its point (it used to look `height` m north of it).
- **Found: 3DTRjs `PotreePlugin` fails on every Potree 1.8 cloud** (attribute objects; 95% of
  Iconem's clouds). The lab's vendored loader carries a local patch. COPC and BROTLI Potree 2.0 are
  unsupported upstream, so COPC keeps going through `/stream`.
- **Upstream research, the ADD skip:**
  - It is a 3DTRjs **v0.5.1 regression** (#1673).
  - CesiumJS avoids it (`meetsScreenSpaceErrorEarly` returns early for implicit/tileset-content
    parents).
  - It is not reported yet. Draft issue:

    > **Traversal: implicit ADD tilesets render nothing at distance — the ADD-parent error skip
    > applies to SUBTREELoader's content child (regression in 0.5.1).** Load an implicit tileset with
    > `refine: "ADD"` (e.g. a point cloud) and move back until the root's SSE ≤ `errorTarget`: nothing
    > renders. `markUsedTiles` (traverseFunctions.js, #1673) skips a child when
    > `error × parent.geometricError / child.geometricError ≤ errorTarget`, and
    > `SUBTREELoader.expandSubtree` moves the root content into a clone with the *same* geometric
    > error under an unrenderable parent, so the ratio is 1. Suggested fix, as CesiumJS does: apply
    > the skip only when the parent has renderable content.

### Added — 2026-09-17 (export to folder · aggregate builder)
- **Added: export any tileset to a local folder.** `POST /export` on the tile-server, `3dtiled export`
  on the CLI, and an *Export to a folder* card in the desktop app. It crawls the URL, so `/stream`,
  `/convert`, `/tiles`, `/aggregate`, `/proxy` and remote 3D Tiles all work.
  - The output is a static, self-contained tree: relative uris, implicit tilings expanded (depth-capped
    via the new `implicit-to-explicit` `maxLevels`), sharded tile folders, and failures listed in
    `export-report.json` after retries.
  - `GET /export/{id}/files/…` previews the copy.
  - Writing to disk needs `TILED_ALLOW_EXPORT=1`, which the desktop app sets, and answers loopback
    clients only.
  - Verified: Geghard via the desktop UI (48 files in 5.3 s), Geghard and Brooklyn via the CLI (both
    copies render from a static server), and a proxied Aerometrex mosaic over HTTP. The Electrobun
    build succeeds.
- **Added: Aggregate Builder (`/builder`, 🧱 in the viewer's top bar)**, pure React + shadcn with no new
  dependencies.
  - Layout: a library of datasets (server sets, or any URL; fuzzy search), a drag-and-drop tree with
    groups, and an inspector for name, date, notes, custom metadata, refine, and display mode
    (`all` / `latest` / `first`).
  - Undo/redo, autosave, and project import/export.
  - Exports a 3D Tiles 1.1 `tileset.json` (sphere unions, GE doubling, tile metadata) or an aggregate set
    manifest.
  - **Preview in viewer** posts an in-memory draft (`POST /aggregate/draft`, 50 drafts, 24 h) and opens
    it through the viewer's new `?load=<url>&fly=<lon,lat,height>` start parameters.
  - Drafts also get `index.json` and the picker's filters. 62 self-checks cover the tree operations and
    export.

### Added / Fixed — 2026-09-16d (open sets · proxy · terrain · snap · 3DTRjs implicit fix)
- **Added: `set=flai`**: 113 national open-LiDAR campaigns from flai-ai/open-lidar-data as COPC
  overviews; all place and none fail. They are generated from the flai README by
  `scripts/flai-open-lidar-set.mjs`.
- **Added: `set=aerometrex`**: 12 US city meshes through `/proxy`. Committed public manifests now
  live in `packages/tile-server/aggregate-sets/`; entries may carry `proxy`, `crs`, `licence` and ISO
  date intervals.
- **Corrected: the "missing tileset-aware proxy" was never missing.** `/proxy` already rewrites child
  URIs; Brooklyn's 1,003 tiles stream through it. The docs said otherwise and are fixed.
- **Added: `/stream …&crs=EPSG:<n>`** for COPC/Potree files that declare no CRS. `core/geo.js` gains
  definitions for 15 national grids plus UTM rules (`crsDefinition`).
- **Added: dataset names in the 3D Tiles output.** Aggregate leaves carry 3D Tiles 1.1 tile
  metadata (class `dataset`).
- **Added: build timings in `asset.extras.build`** (`childRootsFetched`, `fetchMs`, `treeMs`).
  Iconem: a cold build fetches 692 roots in 10.8 s and builds the tree in 16 ms; a warm rebuild in
  another scheme takes 257 ms end to end.
- **Added: an *Angkor — 23 sites (regions)* preset** (`bv=region`); it renders in both Cesium and
  3DTRjs.
- **Docs:** a step-by-step account of how a mosaic is built, and why the output is an explicit
  quadtree with no height split.
- **Fixed: 3DTRjs showed nothing for implicit point clouds at normal distances.** This is an upstream
  traversal bug (the ADD-parent skip ignores unrenderable parents); `ImplicitAddRefineFixPlugin` works
  around it.
- **Fixed: 3DTRjs preset fly-tos were lost about half the time**: `flyToCity` reached the in-Canvas
  scene before it mounted. Such calls are now queued until the scene exists.
- **Added: Terrarium terrain** (open AWS tiles) in both renderers. Cesium gets it through a custom
  heightmap provider.
- **Added: ⤓ Snap to ground** in both renderers: 9 × 9 top-surface vs terrain samples, 80th
  percentile, two passes. On Geghard the renderers agree within 5 m.
- **Added: ✺ potree lab button** in the top bar. The lab gains a `tileset` mode (any URL, e.g. an
  aggregate), COPC input and `#crs=`.
- **Added: `scripts/build-3dtr-master.mjs` + `npm run dev:3dtr-master`**: the whole viewer on a
  from-source 3DTilesRendererJS build, with a Windows fix for upstream's library build. Verified at
  `70847eb`.
- `window.tiles3dtr` exposes the 3DTRjs renderer for inspection, like Cesium's `window.viewer`.
- The repo now pushes to both `jo-chemla/3dtiled-to-3dtiles` and `iconem/3dtiled-to-3dtiles`
  (`origin` has two push URLs).

### Added / Fixed — 2026-09-16c (aggregate picker · dates · regions · 3DTRjs markers)
- **Added: a dataset picker** for loaded mosaics. It lists what is on screen, grouped by platform
  scene, with per-dataset checkboxes and capture dates. Per-site **latest** and **all** buttons cover
  diachronic series (Mes Aynak) and multi-part sites (Venice). It also has format chips derived from
  the index, a global *latest only* switch and a capture-date range. Every action is a URL param, so
  the view stays one shareable tileset.
- **Added: `/aggregate` params `&hide=<id>`, `&latest=1`, `&from=` / `&to=`, `&bv=region`.** Each
  dataset has a stable `id`. `latest` keeps the newest capture among datasets on the same ground
  (geometric test, mixed date precision handled); on the Iconem set it keeps 625 of 660. `bv=region`
  bounds quadtree groups with lon/lat/height regions, verified to enclose every descendant.
- **Added: capture dates.** The share-link script records the platform `date`, or parses Iconem names
  (`_dYYYYMM`, `YYYY-MM`, bare years within 1990–2035; the `_p` processing date is ignored), along
  with project, scene and asset ids: 399 of 692 datasets are dated. `index.json` returns `id`, `group`
  and `date`.
- **Added: hover cards on markers** (name, scene, project, format, date, size) instead of the native
  canvas tooltip. Cesium hover now uses `drillPick`, so markers under already-loaded data still
  respond.
- **Added: markers in 3DTRjs**: one `THREE.Points` layer with the 10%-of-viewport hand-off in the
  vertex shader, screen-space hover/click and a fly-to. The 3DTRjs overlay plugins drape onto
  surfaces, so they don't fit this.
- **Added: typo-tolerant dataset search** ("mes aynek 2011", "venezzia"), and an *Iconem — latest
  captures* preset that flies to Mes Aynak.
- **Fixed: 3DTRjs flung worldwide mosaics off the globe.** Their Earth-centred root sphere looked like
  local, unplaced content, so the viewer re-anchored it to the local frame. Planet-sized spheres are
  now treated as global.

### Added / Fixed — 2026-09-16b (Potree 1.8 · aggregate search + markers)
- **Fixed: every Potree 1.8 dataset rendered nothing.** 1.8's `pointAttributes` are objects with a
  `size` field; the decoder read `byteSize`, so the point stride was `NaN` and every node decoded to
  zero points — the root tile 404'd ("no such node") and only the bounding sphere showed (e.g.
  Quéribus). Sweep of 60 Iconem Potree datasets: 27/60 → **60/60** (all 33 1.8 ones fixed). Affects
  both `/stream` and the offline converter. Unknown attribute sizes now throw instead of silently
  producing empty tiles.
- **Added: `/aggregate/index.json`** — one row per placed dataset (name, project, scene, format,
  lon/lat/height, radius) plus unplaced/failed, sharing the tileset's selection and cached mosaic.
- **Added: search box + dataset markers in the demo app** for any loaded mosaic: accent-insensitive
  dataset search plus OSM place search (Photon), and fixed-size format-coloured markers on the
  ellipsoid that hide once a dataset spans >10% of the viewport (per-point
  `DistanceDisplayCondition`); hover names, click flies. Cesium only for markers.
- **Changed: worldwide mosaics get an Earth-centred root sphere** when it is tighter than the greedy
  union (Iconem: 9 526 → 6 401 km).
- **Changed: Iconem pills only appear when the server has the set**, replacing the "(local)" suffix;
  Angkor demo entries carry distinct names ("PhnomKulen 02-1 OuThmorDab" instead of four
  "PhnomKulen").

### Added / Fixed — 2026-09-16 (Iconem share links · point colours · Potree lab · 0.5.2 · aggregate pill)
- **Ran the share-link script against production:** 692 `single-meta-tileset` links created (658
  Potree, 17 3D Tiles, 17 COPC) across 139 projects, 0 failures; a second run reused all 692 and
  created none. Every sampled link is public with CORS; COPC links answer range requests (`206 LASF`).
  `?set=iconem` mosaics them: 692 children, 0 failed.
- **Confirmed the COPC container finding empirically, not just from source.** In one project, COPC
  share A's token reads COPC file B (`206 LASF`), because a `las` share's container is the project.
  Blob names are UUIDs and nginx drops client query strings (no listing), which limits practical
  exposure, but a COPC link is still not scoped to its own file.
- **Fixed: every point cloud rendered washed out.** glTF `COLOR_0` is linear; all point writers wrote
  raw sRGB. Found by rendering Geghard through 3DTRjs's `PotreePlugin` (correct colours) and through
  `/stream` (pale) side by side. Colours are now linearised on write via a 16-bit table in the core
  writer, the offline COPC writer, and the `.pnts` upgrader (which also moves to normalized uint16 so
  linear shadows don't band). Splat centroids, already linear, opt out. 11 unit checks. `/convert`
  cache keys gain an output version so pre-fix conversions are rebuilt instead of served forever.
- **Fixed: the Angkor mosaic loaded nothing.** Iconem's site tilesets declare geometric error √3 for
  ~240 m sites; the reference tile copied it and every group doubled from there, so nothing refined
  beyond ~100 m. The reference tile's error is now `max(tileset GE, root GE, bounding radius)`.
  Verified in the demo app: sites load at Angkor Thom from 1.8 km.
- **Fixed: datasets without a georeference polluted mosaics.** Their centre is the Earth's core, so
  they landed in arbitrary cells and inflated the root past the planet's radius. Now excluded and
  listed in `asset.extras.unplaced` (32 of 692 on the Iconem set). An aggregate with nothing placeable
  answers `422` with the lists and a placement hint instead of `500`.
- **Added: `/aggregate&format=potree|copc|3dtiles`**: per-format variants of one mosaic (Iconem: 660
  all, 17 3D Tiles, 628 Potree, 15 COPC).
- **Added: 🧩 Aggregate pill in the demo app**: world / open data / Angkor (both nestings, PhnomKulen
  filter) and the four Iconem variants; Angkor presets fly close enough for sites to load.
- **Changed: viewer on `3d-tiles-renderer` 0.5.2** (was 0.4.28). Typecheck, build and point-cloud
  rendering verified. Splat rendering is identical on both versions under headless GL (A/B tested by
  reverting to 0.4.28), so the upgrade is neutral there, but splats remain unverified on a real GPU.
- **Added: `/potree-lab`**: one dataset at a time with 3DTRjs's unreleased `PotreePlugin` and
  `PointCloudEffectsPlugin` (vendored at a pinned commit, Apache-2.0): adaptive point size, shapes,
  eye-dome lighting, debug colours, plus a `stream` mode rendering our `/stream` output through the
  same effects for comparison. Iconem datasets are listed from the local manifest, served to loopback
  clients only. Finding: per-tile point sizing from geometric error is not enough for additive
  tilesets (ancestors draw blobs), so passing density down to plain 3D Tiles needs Potree's per-point
  active-node scheme, which our implicit `(level,x,y,z)` keys could drive (not built).
- **Added: `cdp-screenshot.mjs --print-eval`**, used for every headless check above.

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
  while `423f963` touched only `info.description`) and pushed as a tracked remote branch. Five local
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
