---
title: "Missing features & unsupported code-paths"
description: "A consolidated, honest list of what is not handled (and where it would go). Items marked"
---

A consolidated, honest list of what is **not** handled (and where it would go). Items marked
**fast-fail** error out with a clear message rather than producing bad output.

### Format decode coverage
- **Spherical harmonics (SH)** — every splat converter emits **DC only**. Sources carry more: RAD `sh1`,
  LCC `Shcoef.bin` (64 B/splat, packed-11, degree-3), SOG higher SH bands. View-dependent color is dropped.
- **I3S** (draft): mesh **Draco** geometry is still gated (no decoder). **LEPCC-compressed PointCloud**
  is now decoded live (`packages/i3s-to-3dtiles/src/lepccDecode.js`, a pure-JS port of Esri's own OSS
  codec — see the I3S reference page's LEPCC section), and **JPEG/PNG base-color textures** are now
  embedded per-node — both no longer gated. Still dropped/unsupported: DDS/KTX2/Basis-encoded textures
  (no decoder), per-feature attributes, legacy per-node `3dNodeIndexDocument` index, **Point** (instance)
  & **Building** (composite) layers, **projected/vertical CRS** (only WGS84-geographic vertex placement
  is implemented), and per-vertex **normals left in the source frame** (not re-oriented to ECEF —
  affects lit shading only).

### Parallelism & performance
- **`WorkerPool` (worker_threads) tier not wired** — all converters use only the async-gzip + `parallelMap`
  tier (main-thread decode on the libuv pool). True multicore decode (the WASM/CPU-bound decoders) is unused headroom.
- ~~**RAD `geometricError` undershoots**~~ — **fixed**: `rad-to-3dtiles` now defaults to a **spatial**
  GE basis (`bboxDiag/∛count`, `--ge-basis=spatial`) instead of the featureSize basis that undershot
  by ~4× (Elevator: ours 1.22 vs William's 4.66) and caused renderers to under-refine at distance. The
  old featureSize basis is still available via `--ge-basis=featuresize` for comparison/legacy output.

### Architecture & runtime
- **Browser runtime not built** — `fs` / `zlib` / `worker_threads` are Node-only; core's planned `fs-io`
  abstraction + `CompressionStream`/WASM-brotli paths don't exist yet (decoders are mostly portable; see Runtime table).
- **`.3tz`/`.3dtiles` packaging IS built in** (`scripts/pack-3dtiles.mjs`, dependency-free) and serving
  packages in-place is too — see the `/3dtiles-self-contained` section below.
  **Tileset-level transforms** (version `upgrade` 1.0→1.1, `combine` multiple tilesets, content-format
  transcodes) are **not** built in; use Cesium's
  [3d-tiles-tools](https://github.com/CesiumGS/3d-tiles-tools) (CLI + JS API) for those — `npx
  3d-tiles-tools upgrade`, `… combine`, etc.


### Two modes (`packages/tile-server`, one HTTP server, CORS open)

| Mode | Endpoint | What it does | Formats |
|---|---|---|---|
| **Stream** (true online) | **`/stream`** | Range-read the hierarchy → tileset; **one byte range per tile** → GLB. Nothing pre-converted or fully downloaded. | per-format range adapters: **copc, potree, sog, lcc, rad, i3s** |
| **Preprocess** (cached) | **`/convert`** | Convert the **whole** dataset once on first hit (cached on disk), then serve static. | **every** format the meta-converter supports |
| **Package serve** | **`/3dtiles-self-contained`** | Serve `.3tz` (ZIP) or `.3dtiles` (SQLite) packages in-place with random access. Supports local paths and remote URLs. | `.3tz` local only; `.3dtiles` local + remote via sql.js (pure WASM) |

```sh
npm run serve:tiles            # alias: npm run serve:live  → http://localhost:3001
#   GET /stream/tileset.json?url=<SRC>&format=<fmt>[&cache=none|hierarchy][&prefetch=N] ← unified streaming dispatcher
#   GET /convert/tileset.json?url=<SRC>[&format=<fmt>][&centroids=1] ← preprocess+cache, any format
#   GET /3dtiles-self-contained/tileset.json?url=<local/path.3tz>    ← serve .3tz/.3dtiles in-place
```

`/stream` is the single front-door: it detects the format and delegates to that format's range adapter
(the range logic is necessarily format-specific — a COPC LAZ chunk vs a Potree octree-node byte range —
but the entry point is one URL, one namespace: `/stream/tileset.json`, `/stream/tile/…`,
`/stream/subtrees/…`). For a format without an adapter yet it returns **501** pointing you at
`/convert`. The old per-format aliases (`/copc`, `/potree`, `/sog`, `/lcc`, `/rad`, `/i3s`) are gone
(2026-07-02) — verified to be a strict subset of what `/stream` already did.

### COPC and Potree via `/stream` (true range-streaming ✅)

`packages/tile-server` is a working middleware (the TiTiler `/cog/tiles/...` analogue). COPC was the
first range adapter, Potree the second (the same model generalised) — nothing is pre-converted or
fully downloaded for either:

```sh
npm run serve:tiles      # → http://localhost:3001  (CORS open)
# then, in viewer.html, the pill "☁ Autzen" (COPC) or "🌲 …" (Potree) loads e.g.:
#   http://localhost:3001/stream/tileset.json?format=copc&url=<any COPC url>
```

- `GET /stream/tileset.json?format=copc&url=<COPC>` — range-reads the COPC header + hierarchy, returns
  a 3D Tiles 1.1 tileset (implicit octree by default, `&tiling=explicit` opts out; `ADD` refine; one
  ENU→ECEF root transform from the COPC WKT CRS via proj4).
- `GET /stream/tile/<D-X-Y-Z>.glb?format=copc&url=<COPC>` — range-reads **just that octree node**,
  decodes its points, returns a POINTS GLB on the fly (`core.buildPointsGlb`).
- `GET /stream/tileset.json?format=potree&url=<metadata.json|cloud.js>[&tiling=implicit|explicit]` —
  for 2.0: `metadata.json` (tiny) + `hierarchy.bin` fetched once to emit the tree, each tile
  HTTP-**range**-reads its own contiguous block from `octree.bin` (DEFAULT or BROTLI decode); for 1.x:
  `.hrc` chunks fetched lazily as the tree is walked. Potree's octree → 3D Tiles tree ~1:1 either way.

The COPC octree maps ~1:1 onto the 3D Tiles tree, so no re-tiling. Verified end-to-end: a browser
viewer (CesiumJS) renders Autzen geo-referenced over Oregon, streamed live from a COPC URL — the
viewer never sees the COPC, only 3D Tiles. Works with any 3D-Tiles client (CesiumJS, 3DTilesRendererJS,
cesium-for-unreal).

- `url` points at the dataset's `metadata.json` (2.0) or `cloud.js` (1.x); `hierarchy.bin` / `octree.bin`
  (2.0) or `.hrc` chunks (1.x) resolve as siblings.
- **Implicit tiling by default** (a 3D Tiles 1.1 tree whose subtrees are generated on the fly from the
  live availability set) — `&tiling=explicit` emits an explicit tree instead, for clients without
  implicit-tiling support.
- The source host must serve **HTTP 206** range responses (potree.org, S3, most static hosts do).
- Geo-referenced if `metadata.json` carries a CRS (`projection`/`crs`/WKT, via proj4); else local origin.
- **Potree 1.x** (`cloud.js` + `.hrc`) is range/lazy-served too: `.hrc` chunks are fetched only for the
  octree region actually being requested (no full-tree walk), and folded into the same implicit-subtree
  machinery as 2.0. (Potree 1.4's older *inline* `cloud.js` — the whole tiny hierarchy embedded in one
  file — is read eagerly since there's nothing to range into.)
- Verified end-to-end against **potree.org** (remote, internet) and local data. The decode is the same
  authoritative code the offline `potree-to-3dtiles` converter uses (shared `potree2.js`).

viewer.html pills: **⚡ Potree→3DT (stream, local)** and **⚡ Potree→3DT (stream, potree.org)**.

#### Streaming roadmap — per-format range adapters

A format can be **streamed** only if it persists **per-tile spatial bounds** (so the tileset tree is
emitted without decoding any geometry). That's the dividing line:

| Format | Persists tile bounds? | Status |
|---|---|---|
| **COPC** | ✅ octree cube → derived boxes; node = LAZ chunk byte range | **live `/stream`** ✅ |
| **Potree 2.0** | ✅ octree boxes; node = `octree.bin` byte range | **live `/stream`** ✅ |
| **Potree 1.x** | ✅ octree boxes (.hrc / inline); node = one `.bin`/`.laz` file fetch | **live `/stream`** ✅ |
| **streamed-SOG** | ✅ `lod-meta.json` tree carries per-node bounds + leaf `[file,offset,count]` runs | **live `/stream`** ✅ (fetch+decode the chunk WebP per leaf) |
| **LCC** | ✅ grid persisted (`cellLengthX/Y` + index cell x16/y16) → X/Y boxes, Z from scene bounds; unit LOD = `data.bin` byte range | **live `/stream`** ✅ |
| **RAD** | ❌ chunk bounds NOT persisted, and **chunks aren't spatial tiles** (a chunk mixes LoD-tree levels — confirmed by the Spark team, see RAD notes) | **live `/stream`** ✅ — see below, a different trick than the other rows |
| **I3S (REST)** | 🟡 REST node-page tree; multi-resource | **live `/stream`** ✅ for the common case (see I3S notes); `/convert` for the rest |

**RAD doesn't fit the "persisted bounds" pattern the other rows use, but it *is* streamed** — no
per-tile bounds, no spatial partition; its "chunks" are 64K-splat streaming groups ordered by
featureSize, spanning multiple LoD-tree levels, so there's no bounding box to range into without a
decode. The adapter (`rad-live.js`) sidesteps this with a cheap **metadata-only pass**: range-fetch
every chunk **in parallel** decoding just its `center`/`child_count`/`child_start` columns (no SPZ
encode, no gzip) to build the explicit tree topology + AABBs, then range-fetch + fully decode +
encode only the ONE chunk a requested tile needs. Cold-start cost is one parallel pass over the whole
file's chunk headers, not the whole geometry — see
[`rad-format-notes.md`](/docs/references/rad-format-notes) for the full rationale
on why RAD chunks aren't spatial tiles in the first place.

Everything not on a range adapter is still fully renderable today via `/convert` (below).

### `/geosplats` — live **MapTiler GeoSplats** → 3D Tiles (implemented ✅, reverse-engineered)

[MapTiler GeoSplats](https://www.maptiler.com/geosplats/) is a georeferenced HLOD Gaussian-splat
format with no published byte-spec — everything below was decoded from a real `model.json` +
`metadata.json` pair and the SDK bundle (`@maptiler/geosplats`, `maptiler-geosplats.mjs`). Full
format notes: [`maptiler-geosplats.md`](/docs/references/maptiler-geosplats).

```sh
#   GET /stream/tileset.json?format=geosplats&url=<model.json URL>[&lod=1..8]           → HLOD tileset
#   GET /stream/tile/<m>-<grid>-<oct>-<lod>.glb?format=geosplats&url=<model.json>       → one octant, KHR_gaussian_splatting GLB
```

- **Data primitive = SOGS** — same primitive our own `writeSog`/`readSog` (`@playcanvas/splat-transform`)
  already speak, so an octant's `means_l/u`, `quats`, `scales`, `sh0` WebPs decode straight to a
  `DataTable` and re-encode as an `_spz_2`-compressed glTF splat tile.
- **HLOD** — each sub-model's `metadata.json` carries a `voxel_grids` octree (`grid_1→8→64`, 8
  progressive LODs per cell); mapped to a 3D Tiles `REPLACE` octree by spatial containment
  (child-centre-in-parent-bbox, since the octant-id bit layout isn't trustworthy). `geometricError` =
  octant diagonal.
- **Origin-locked API keys** — MapTiler's demo keys only work from `maptiler.com`; the upstream octant
  fetch happens server-side (`Referer: https://www.maptiler.com/`) so the browser only ever talks to
  our middleware.
- Verified end-to-end in both **CesiumJS** and **3DTRJS** (viewer.html "✨ GeoSplats" pills).

**Georeferencing, reverse-engineered from the SDK** (`global_position` in `model.json` → a 3D Tiles
root `transform`):

| What | Formula | Notes |
|---|---|---|
| **Scale** | `S = model_scale · 512·ZOOM_TO_METER[14] · cos(lat)` | `512·ZOOM_TO_METER[14] = 2445.98` is the **equatorial** web-Mercator tile metre; Mercator stretches by `1/cos(lat)` off the equator, so real metres = mercator-metres·`cos(lat)`. Missing the `cos(lat)` term overscales by that same factor (a model at lat 55° came out ~1.7× too big; at lat 26°, ~1.1×) — this is what "latitude correction" fixes. `&scale=<f>` overrides. |
| **Orientation** | frame `enu2` = `[East, −North, −Up]` | Cesium/3d-tiles-renderer both apply the glTF Y-up→Z-up correction to tile content before the root transform runs; content's "up" ends up at −Z, so a naive ENU `[East,North,Up]` renders flat but **upside-down**. `enu2` is a 180° flip about East that rights it (a proper rotation, not a mirror). `&frame=enu\|enu2\|eun\|e-un\|e-nu` sweeps other candidates. |
| **Heading** | `yaw = offset.y_rot − 180°` | The per-model `global_position.offset.y_rot` is a compass heading authored in MapLibre's frame; in the `enu2` frame the aligning yaw is `y_rot − 180`. Rotates the ENU (E,N) basis about Up. `&yaw=<deg>` adds a fine-tune on top. |
| **Altitude** | default **0**, not `global_position.alt` | `alt` is expressed in MapTiler's `model_scale`-normalised MapLibre frame, not our 1:1 ellipsoidal metres — used raw it buries the scene ~300 m underground. 0 (≈ ellipsoid/ground for near-sea-level captures) is the sane default; `&alt=<m>` overrides. |

**Known residual: ~2–4% under-scale on some models, even after the `cos(lat)` fix.** The scale
formula above is the *inverse of MapTiler's own mercator-tile normalisation* — it recovers "how many
real metres the model's `model_scale`-normalised units represent at this latitude", not an independent
ground-truth measurement. Any small mismatch between MapTiler's own scene-capture georeferencing and
true surveyed scale (which the whole `global_position` block ultimately derives from) carries straight
through our formula. In other words: this is very likely accuracy in **MapTiler's own source georef**
for that particular capture, not an error in the scale derivation — the derivation is dimensionally
exact and matches two independent models to within a few percent already. `&scale=<f>` is the pragmatic
per-model pin if a specific scene needs it exact.

### `/extract` — bbox + geometric-error crop/extract (implemented ✅)

Its own endpoint family, **not** a `/convert` specialization — `packages/tile-server/extract-live.js`
ingests *any* 3D Tiles source (one of this repo's own live/offline outputs, or an external tileset)
and walks it with the same shared bbox+GE+refine-aware `traverse()` regardless of output kind:

```sh
GET /extract/{las|glb|copc|tileset|zip|splat}?url=<tileset.json>&bbox=<west,south,minH,east,north,maxH>[&maxGE=<m>][&maxDepth=N]
```

- `bbox` is **geographic** (lon/lat degrees + ellipsoidal height m) — what you'd draw on the globe;
  the viewer's "⬚ Set box to view" button fills it from the current camera frustum.
- `maxGE` picks the LOD to stop at (0 = finest available); traversal honors each tile's own `refine`:
  **ADD** tiles contribute at every level down to `maxGE` (accumulate), **REPLACE** tiles contribute
  only at the refinement frontier.
- Output kind selects the decode path: `las`/`copc` (points, via the shared LAS writer + optional
  `pdal translate` to COPC LAZ), `glb` (merged mesh), `tileset` (a filtered 3D Tiles tileset
  referencing only the in-bbox original tile URLs — no re-encode), `zip` (out-of-core streamed bundle
  of every in-bbox tile + a self-contained tileset.json), `splat` (merge in-bbox Gaussian-splat tiles
  into one SPZ/GLB/SOG/PLY file via `@playcanvas/splat-transform`, `&format=` picks the output,
  `&clip=0` disables per-splat centroid clipping).
- The splat path anchors its output coordinate frame at the **source tileset's own root origin**, not
  the crop's bbox center, so multiple crops of the same source share one coordinate system — the
  tradeoff is that a single crop far from the source root can look "off-center" relative to its own
  bounding box when loaded standalone in a viewer that assumes content sits near its own origin.
- LCC's (and, it turns out, SOG's) splat crop had a real placement bug: their root-transform already
  bakes the FULL Y-up→Z-up content flip in (unlike RAD's — the extractor's original default — which
  assumes the renderer applies that flip automatically), so the extractor's generic flip double-applied.
  Originally patched as a single hardcoded `isLcc` special-case, which — fair callout — was "pretty
  weird, double-flipping 180°" and not obviously generalizable. Replaced 2026-07-02 with a small,
  documented per-**format** table (`SPLAT_FLIP_BAKED = {lcc, sog}`) in `extract-live.js`'s `splatFlip()`:
  any format whose adapter bakes the full flip itself goes in the set; everything else (RAD, and any
  future format following RAD's convention) uses the default. This is the general answer to "should all
  tilesets crop the same way" — **yes**, modulo which of the two conventions (`auto` renderer-flip vs
  `baked` self-flip) that format's own `/stream` adapter already committed to; the table is where that
  one bit of per-format knowledge lives, not scattered special-casing. Verified against real tile data
  for all three formats (LCC, SOG, RAD) via centroid-vs-declared-box sampling. **Not yet verified**: the
  georeferenced vs. non-georeferenced case split for each format — see TODO/Future work.

viewer.html's "CROP & EXTRACT" sidebar section drives this directly.

### `/proxy` — generic CORS proxy (implemented ✅)

```sh
GET /proxy?url=<absolute source URL>
```

For public tilesets whose host sends no `Access-Control-Allow-Origin` at all (confirmed against
Agisoft Cloud's `cloud.agisoft.com/api/...tileset.json` — no CORS header on the tileset.json OR its
tile GLBs), a browser-side Cesium/3DTRJS fetch is blocked even though the data itself is public. A pure
byte passthrough only fixes the ROOT request — Agisoft's `content.uri`s are relative ("Data/d000.glb"),
so children resolve against `/proxy`'s own path once loaded through a naive proxy, not the original host.
So `/proxy` is tileset-aware: for a JSON response shaped like a 3D Tiles tileset (`asset`+`root`), it
recursively rewrites every `content.uri` to an absolute `/proxy?url=<resolved>` (same tree-walk as
`/gltf`'s `rewriteTree`), so children keep flowing back through the proxy however deep the tree goes.
A resolved child URI that carries no query string of its own **inherits the parent's** — Agisoft's own
access token lives only on the root `tileset.json?access=…` URL, and every child content URI is a bare
relative path with no token; confirmed live that the token is required per-resource (302 without it, 200
with), so silently dropping it while resolving relative paths would re-break every child tile. Anything
else (a tile GLB, a subtree binary) streams through byte-for-byte. Used by the Agisoft Jam pill.

### API playground & OpenAPI schema (implemented ✅)

`packages/tile-server` now has the "TiTiler-for-3D" bookend that title implies:

- `GET /` — a minimal, titiler-style landing page (title, one-line description, a link list) instead
  of a bare 404 at the root. Links to the playground, the OpenAPI JSON, this repo, and (if you set
  `DOCS_URL`/`VIEWER_URL` in your own deployment's environment) your docs site and demo viewer —
  deliberately not hardcoded to any real domain, same reasoning as the committed `docker-compose.yml`
  staying reverse-proxy-agnostic.
- `GET /openapi.json` — a hand-authored OpenAPI 3.0 spec covering every endpoint (`/tiles`, `/stream`,
  `/convert`, `/3dtiles-self-contained`, `/3dtiles-tools`, `/gltf`, `/bing`, `/extract`, `/proxy`,
  `/progress`), including query params, enums, and examples. Hand-authored rather than framework-derived
  (unlike FastAPI, which generates this from route/type annotations) since the server is plain Node
  `http`, not a schema-first framework — see `packages/tile-server/homepage-live.js`'s own comment for
  why that's still the right call here (no new runtime dependency, no build step).
- `GET /playground` (alias: `GET /docs`, the exact route FastAPI itself uses for the same purpose) — an
  interactive API reference driven by that spec, via [Scalar](https://github.com/scalar/scalar) (the
  modern successor to Swagger UI — FastAPI itself now ships it as an alternative to Swagger UI's own
  `/docs`). Loaded from Scalar's own CDN as a single script tag, the same pattern already used for the
  Draco/KTX2 decoders — no vendoring, no build step.

### COPC — Autzen Stadium, Oregon (10.6M pts)

```
Input:  autzen-classified.copc.laz  (77 MB)
        https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz

Output: 278 GLBs + 49 subtrees + tileset.json  (369 MB)
        6 octree levels, max level 5
        Attributes per GLB: POSITION (VEC3 f32), COLOR_0 (VEC4 f32),
                            _CLASSIFICATION (uint8), _RETURN_NUMBER (uint8)
        No WKT CRS in file → local coordinate output (no ECEF root transform)

Status: PASS ✓
```

> **Note:** The Autzen file has no WKT CRS VLR, so output is in local dataset coordinates.
> IGN LiDAR HD files include proper WKT → ECEF transform applied. Many COPC viewers (e.g.
> viewer.copc.io, lidar-viewer.gishub.org) position all files correctly because they read the
> internal spatial metadata directly — they do not rely on the 3D Tiles CRS transform.

> **Viewer note:** Open `viewer.html` via HTTP (`npx serve .`) — not `file://`, and not via
> Cesium Sandcastle (HTTPS). Sandcastle cannot reach HTTP localhost due to browser mixed-content
> policy even with `--cors`.

### RAD — Tastier 500K splats

```
Input:  tastier500k-lod.rad  (12 MB, BhattLod base=1.75, SH0, 702K splats in 11 chunks)
        https://wlt-ai-cdn.art/tastier_rad_500/0524c1a1-abf2-4969-ae40-9981ee836536_500k-lod.rad

Output: 11 GLBs + tileset.json  (~12 MB)
        Bounding box: centre=(-0.25, 0.43, -2.27), half-extents=(2.86, 3.03, 8.32)
        Attributes per GLB: POSITION (VEC3 f32), _ALPHA (uint16 f16)
        extensionsUsed: ["KHR_gaussian_splatting"]
        Hierarchical REPLACE tileset

Status: PASS ✓  (0.57s for 11 chunks)
```

> **Bug fixed during testing:** Bounding boxes were defaulting to a unit cube at origin.
> Now computed from actual decoded splat positions (f32_lebytes decode → AABB).
