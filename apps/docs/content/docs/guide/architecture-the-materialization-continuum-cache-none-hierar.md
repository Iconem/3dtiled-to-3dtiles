---
title: "Architecture: the materialization continuum (cache = none · hierarchy · full)"
description: "Every converter — offline or live — is the same mapping:"
---

> This section captures a design discussion that defines how the whole project is organised. It is
> deliberately verbatim — the conceptual model below drives the converter/endpoint design.

### There's really only one idea here

Every converter — offline or live — is the *same mapping*:

```
input format                          3D Tiles
─────────────                         ─────────
hierarchy (octree pages / nodepages)  ↔  tile tree (implicit subtrees / explicit children)
node data (points / mesh / splats)    ↔  tile content (glTF + KHR_gaussian_splatting)
CRS + bounds                          ↔  root transform + bounding volumes
```

The *only* thing that differs across everything we've built is **when that mapping is evaluated, and
how much of it is persisted**:

| | evaluate | persist | that's our… |
|---|---|---|---|
| ahead of time, all of it | once, offline | to disk | CLI / SDK output, `.3tz`/`.3dtiles` packages |
| on first request, all of it | once, on hit | to cache | `/convert` |
| per request, only what's asked | every request | nothing | `/stream` + adapters |

### One axis: what the middleware caches

An earlier draft modelled this as two axes (`mode` × `hierarchy`). That was over-complicated. A
"prebuilt" tileset (built offline by the CLI/SDK or shipped as a `.3tz`/`.3dtiles` package) is **not a
middleware mode at all** — you point the viewer straight at its output `tileset.json`; the middleware
isn't involved and can't (and shouldn't) know the input→output link. Drop that, and the rest collapses
to a **single ordered axis: how much the middleware caches.**

```
cache = none | hierarchy | full          # default: none
prefetch = <N levels>                    # background-warm N levels below root (cache=none) — default: 1
tiling   = implicit | explicit           # octree/quadtree only — default: implicit
```

| `cache` | hierarchy read up front? | tile contents persisted? | first request | later / restart | = today's |
|---|---|---|---|---|---|
| **none** | no — root only, chunks on demand (lazy) | no | fast | re-derived; ephemeral | `/stream` lazy |
| **hierarchy** | yes — whole tree in RAM | no (per-request) | slower cold start, warm after | tree warm in RAM (per process) | `/stream` eager |
| **full** | yes | **yes — tree + all tile GLBs to disk** | **slow** (convert all) | served static; survives restart | `/convert` |

`?cache=hierarchy` reads literally as "cache the hierarchy, not the tiles." `cache=none` = fully
dynamic; `cache=full` = convert-and-store. The parameter name carries the concept, so nobody has to
memorise what "live" vs "cached" means.

> **Where each persists (explicit):** `cache=full` writes the **whole converted output to disk** (`/convert`
> — tiles can be huge, so disk), served static afterwards and **surviving restart**; `cache=hierarchy`
> holds **only the tree in RAM** (ephemeral, per process — it should fit); `cache=none` persists **nothing**
> (re-derived per request, with the per-URL `getCtx` cache warming as you go).

The same spectrum has three well-known names elsewhere, if it helps: **DB** materialized-table →
materialized-view → view; **Next.js** SSG → ISR → SSR; **GIS/TiTiler** pre-rendered tile cache →
cache-on-demand → dynamic tiling.

> **There is no "prebuilt" mode.** For an offline-built tileset, point the viewer directly at the output
> `tileset.json` (static file serving). The continuum above is only about what the *converter middleware*
> does when it's the one producing 3D Tiles from a non-3D-Tiles source.

### Push vs pull (why offline converters stay as they are)

Offline conversion **pushes**: it walks the input format's hierarchy top-down, building the tree along
the way and emitting every tile. The live stream adapters **pull**: they expose the tileset root, then
respond to each 3D Tiles request by extracting from the input format exactly the hierarchy/tile content
needed for that response — working the format the other way around. Same mapping, opposite direction.

The offline converters are **conserved as-is**: they work and walk the format hierarchy correctly. The
harmonization below targets the *live* path.

> **`bake(driver)` is possible but deferred.** Because push and pull are the same mapping in opposite
> directions, a single `bake(driver)` could in principle drive *offline* conversion from the very same
> per-format drivers the live path uses (walk root → children → content, write every tile + the tree to
> disk) — collapsing the two codebases into one. We are **not** doing this yet: the offline converters
> are battle-tested and have format-specific niceties (centroids, merging, per-format GE tuning) that a
> premature unification would risk. It's noted here as the natural endgame, to be taken per-format only
> when there's a concrete reason.

### Harmonization plan (live path) — chosen scope: shared services + unified live

Per-format `*-live.js` files currently duplicate cross-cutting code: georef math (`llhToEcef` +
`enuMatrix` in copc/potree/lcc/i3s — 4 copies), CORS/fetch/`rangeGet`, near-identical octree tileset
builders (copc & potree), `serveTileGlb` origin-shift+swizzle, and `handle<Fmt>` routing boilerplate.

Target — a **`FormatDriver`** capturing only format-specific knowledge, with generic machinery around it:

```
FormatDriver (per format — the ONLY thing that varies)
  open(source)            → { rootBox, transform, scheme: octree|quadtree|explicit, caps }
  availability(coordBlock)→ which (L,x,y,z) exist        (octree/quadtree; loads chunks lazily)
  children(nodeId)        → [{ id, box, geometricError, hasContent }]   (explicit)
  content(nodeId)         → { positions|mesh|splat buffers }   → shared GLB encoder

Generic services (core/):
  core/geo.js        ENU/ECEF + proj4 georef            (kills the 4× duplication)
  core/source.js     Source: .range / .ranges(parallel) / .full, probe 206 once
  core/octree.js     implicit tileset + subtree builder, coord↔box   (copc+potree share)
  core/explicit.js   N-level fragment builder + external refs        (rad+i3s share)
  core/glb.js        origin-shift + swizzle + points/mesh/splat encode
  core/serve.js      LiveServer(driver): root + subtree + tile + fragment + prefetch
  core/materialize.js  wraps a driver by cache scope: none | hierarchy | full
  core/http.js       one route matcher for every format
```

`prefetch=N` generalizes COPC's fire-and-forget warmup to *every* lazy format and makes it a dial —
this is the answer to "combine the benefits of lazy and eager."

### Endpoint rework — **done** (2026-07-02)

One primary endpoint, dispatching **in-process** (no redirect — the old 307 to `/stream`/`/convert`
this section originally proposed was replaced by a direct call once `/stream` learned to read `cache=`
itself, so the query string just carries through unchanged):

```
GET /tiles/tileset.json?url=<SRC>&format=<auto|copc|potree|sog|lcc|rad|i3s|package>
                         &cache=<none|hierarchy|full>   &prefetch=<N>   &tiling=<implicit|explicit>

cache=none|hierarchy → /stream (same cache= param)   cache=full → /convert
```

The old format-pinned aliases (`/copc`, `/potree`, `/sog`, `/lcc`, `/rad`, `/i3s`) are **gone** — they
were a strict subset of what `/stream/tileset.json?format=<fmt>` already did (verified: for COPC/Potree
they didn't even forward `hierarchy`/`prefetch`, so `cache=hierarchy` was silently unreachable through
them). `/3dtiles-tools` stays as its own endpoint (a tileset-level *transform*, not a format converter).

**Not yet done** (see [TODO / Future work](#todo--future-work)): live `tiling=explicit` routing
*through* the existing `implicit-to-explicit` tool for octree formats (COPC/Potree), so the LIVE
`/stream?tiling=explicit` path shares one explicit-tiling code path instead of each octree adapter
having its own bespoke `buildTilesetExplicit`. What shipped now is more modest:
- Potree 1.x's `tiling=explicit` was simplified to fully materialize the tree in one response (no more
  per-format lazy-fragment continuation needing its own routes).
- RAD and I3S (2026-07-02): removed their lazy-fragment continuation entirely (`/stream/rad/subtree/`,
  `/stream/i3s/node|tile/…&lazy=1`) — neither format has a persisted spatial index to make a partial
  read meaningfully cheaper than a full eager scan, so `cache=none`/`cache=hierarchy` are now
  equivalent for both, always fully materializing (same simplification as Potree 1.x above).
- **Offline-only**, not the live path above: `viewer.html`'s Tools → `implicit-to-explicit` demo now
  includes one Potree and one COPC example, pointing the *existing* tool directly at their prebuilt
  octree output — this demonstrates the tool against our own formats but doesn't change how live
  `/stream?tiling=explicit` builds its tree.

### Factory / composability ideas (future)

Several one-shot transforms are natural **`/3dtiles-tools` commands** that chain together rather than
being baked into each converter:
- `implicit-to-explicit` (exists), `upgrade` (b3dm/pnts→glb, glTF 1.0→2.0, `CESIUM_RTC` bake — exists),
- **`centroids`** — **now a streaming option** (`&centroids=1`): for tiled-splat formats (SOG, LCC, RAD)
  each tile is emitted as a glTF **POINTS** GLB of splat centres instead of full gaussians (cheap
  preview), and the tileset drops the `KHR_gaussian_splatting` requirement. Also available as the
  `--centroids-only` flag on the offline CLI / `/convert`. (A post-process form that takes an *arbitrary*
  finished splat tileset would need SPZ decode — future, same shape as `bake`.)
- **`gltf` — a generic per-tile glTF-Transform pipeline tool** — **decompress half IMPLEMENTED**
  (`/gltf/tileset.json?url=…&ops=decompress` proxies an explicit tileset; `/gltf/tile.glb?url=…&ops=…`
  transforms one tile). `ops` = `decompress` | `draco` | `meshopt` | `ktx`. Decodes **Draco** +
  **EXT_meshopt** geometry and **KTX2→PNG** textures via [`core/gltf-decompress.js`](packages/core/gltf-decompress.js)
  (gltf-transform + draco3dgltf + Basis WASM from `three` + pure-JS `pngjs` — **no `sharp`**). Verified
  on a real Bing `3dv4` tile (Draco+KTX2 → plain GLB, both extensions stripped). Encode ops below are next.
  Rather than one hard-coded texture step, this exposes **glTF-Transform**
  ([gltf-transform.dev](https://gltf-transform.dev)) ops as a chainable `/3dtiles-tools?tool=gltf&ops=…`
  that runs on **each mesh tile's GLB** on the fly (same streaming model as `upgrade`/`implicit-to-explicit`:
  tileset JSON cached once, tiles transformed on demand). Per tile: `upgradeGlb`→2.0 (gltf-transform needs
  2.0) → `io.readBinary` → `document.transform(...ops)` → `io.writeBinary`. This is the
  [gltf-pipeline #665](https://github.com/CesiumGS/gltf-pipeline/issues/665) /
  [glTF-Transform #591](https://github.com/donmccurdy/glTF-Transform/issues/591) /
  [#1622](https://github.com/donmccurdy/glTF-Transform/pull/1622) "apply a transform to every tile" pattern.
  - **Decompress first** (DONE): **Draco decode** + **EXT_meshopt decode** + **KTX2/Basis→PNG**. Note
    glTF-Transform does **not** decode these for you: Draco/meshopt require registering the
    `draco3dgltf` / `meshoptimizer` decoder deps (documented, intended — it deliberately keeps the WASM
    out of its tree), and **KTX2 decode has no library function at all** — gltf-transform's
    `ktxdecompress` ([#1622](https://github.com/donmccurdy/glTF-Transform/pull/1622), v4.1+) is **CLI-only
    and shells out to the native KTX-Software `ktx` binary**. So our in-process path (Basis WASM from
    `three` + pure-JS `pngjs`) is the correct **self-contained, no-native-binary** choice, **avoiding
    `sharp`** (libvips packaging pain + 16383²/13k AVIF/WebP size bugs).
  - **Compress later** (eventual): `draco`, `meshopt`, `quantize`, `ktx2` (etc1s/uastc), `webp`/`avif`,
    plus geometry ops `simplify`/`weld`/`dedup`/`flatten`/`join`/`instance`/`palette`/`prune` — all are
    glTF-Transform functions. For encode, prefer a **WASM encoder** (e.g. `@jsquash/webp`, libktx) over
    `sharp`; glTF-Transform's `textureCompress({encoder})` already accepts a pluggable encoder.

Composability goal: `source → convert → [centroids] → [gltf: draco/ktx2 decode|encode, simplify…] →
[implicit-to-explicit] → [upgrade] → 3D Tiles`, each stage a tool you can chain.

#### Live tools & endpoints — how to call (current)

| Endpoint | What | Ops / params (current) |
|---|---|---|
| `/stream/tileset.json?url=<SRC>&format=<fmt>&transform=<op>` (rides along on the tileset's own `/stream/tile/…` content URIs — no separate flag per tile request) | per-tile transform applied to **every streamed tile** (covers implicit COPC/Potree the `/gltf` proxy can't reach, since `/stream` builds each GLB itself) | `transform=meshopt` (**encode** — EXT_meshopt, works on POINTS → point tiles ~⅓ size) · `transform=draco` (encode, mesh tiles only, no-op on POINTS) · `transform=ktx` (encode ETC1S) · `transform=ktx-uastc` (encode UASTC, higher quality/larger) · `transform=decompress` (decode draco+meshopt+KTX2, `+&tex=jpg\|png` picks the KTX2 decode output) |
| `/convert/tileset.json?url=<SRC>[&format=<fmt>][&centroids=1]` | preprocess + cache: converts the **whole** dataset once, then serves static | any format the meta-converter supports (`cache=full` equivalent) |
| `/3dtiles-tools/tileset.json?tool=<t>&dir=<path>\|url=<tileset>` | per-tile tileset transforms | `tool=implicit-to-explicit` · `tool=upgrade` (b3dm/pnts→glb, glTF 1.0→2.0, `CESIUM_RTC` bake) |
| `/gltf/tileset.json?url=<tileset>&ops=<ops>[&tex=jpg\|png]` (+ `/gltf/tile.glb?url=<glb>&ops=`) | generic per-tile **glTF-Transform** pipeline (proxies an explicit tileset, recurses external refs) | `ops=decompress` (= `draco,meshopt,ktx`) · or any of `draco` · `meshopt` · `ktx` (decode); KTX2 decodes to `tex=jpg` (default, fast/small) or `png` |
| `/bing/tileset.json?root=<quadkey>&g=<genid>&maxLevel=<L>[&decompress=1]` | Bing Maps 3D (`tf=3dv4`) → 3D Tiles | `root` quadkey, `g` genid (default 15340), `maxLevel`, `decompress` |
| `/3dtiles-self-contained/tileset.json?url=<path\|URL.3tz\|.3dtiles>` | serve a `.3tz`/`.3dtiles` package in-place, no extraction | local path or `http(s)://`; `.3tz` local-only, `.3dtiles` local + remote via sql.js |

> The `/gltf` pipeline runs per-tile **only on explicit tilesets** (concrete tile URIs — 3MX/Bing/RAD/I3S
> outputs and external mesh 3D Tiles); it recurses external-tileset refs. **Implicit** COPC/Potree octree
> templates (`{level}-{x}-{y}`) can't be URL-rewritten per tile — so for those use **`/stream?transform=`**,
> which applies the op as `/stream` builds each tile GLB itself (no URL rewrite needed). `transform=meshopt`
> is the standout: it compresses **POINTS** (where Draco no-ops, having no indices), shrinking COPC/Potree
> point tiles to ~⅓ over the wire (decoded transparently by Cesium/3DTilesRendererJS). `transform=decompress`
> is the reverse — mainly for *ingesting existing remote 3D Tiles* into consumers that can't read
> Draco/KTX2/`CESIUM_RTC` (e.g. blender BLOSM). KTX2 **encode** still needs a native `toktx`/`ktx` binary
> (no in-process WASM encoder), so it stays a documented future add.
>
> **Why no built-in KTX decode dep / do we vendor the `ktx` CLI?** No — we do **not** use (or vendor)
> glTF-Transform's `ktxdecompress`, which is **CLI-only and shells out to the native KTX-Software `ktx`
> binary**. Our decode is **in-process** (Basis WASM from `three` + pure-JS `pngjs`), so the server needs
> no native binary. Draco/meshopt decode use the **documented** `draco3dgltf` / `meshoptimizer` dependency
> registration (glTF-Transform deliberately doesn't bundle those WASM decoders).

#### Future work (noted, not yet built)

- **Encode ops** — **done**: geometry (`/stream?transform=meshopt|draco`) AND **KTX2 textures
  in-process** (`/stream?transform=ktx` [ETC1S] · `ktx-uastc` [UASTC]; `compressGlb({ktx,uastc})`) via the
  **`ktx2-encoder` WASM basis encoder** + our pngjs/jpeg-js source decoder — **no native `toktx`**. Still
  to add: **WebP** texture encode (needs a WASM webp encoder; `textureCompress(webp)` would pull `sharp`),
  `simplify` / `weld` / `quantize`, and exposing encode on the `/gltf` proxy (not just `/stream`).
- **`rtc_center` / decompress for ingestion** — apply per-tile to *existing remote 3D Tiles* so consumers
  that can't read Draco/KTX2/`CESIUM_RTC` (e.g. blender **BLOSM**) can load them.
- **Bing `td1` → explicit lazy fragments — DONE** — `/bing` reads Bing's `td1` implicit manifest + `st`
  subtree availability and emits **explicit** 3D Tiles fragments with web-mercator-correct `region`s (4
  faces = quadrants; lon linear; lat = atan(sinh(mercator-y))), flipping `y→reverseY` to fetch
  `mtx`/`st` from Bing. This replaces both the old `mtx<quadkey>` probe (couldn't find Bing's deep-only
  tiles) and a naive implicit passthrough (Cesium can't do `MICROSOFT_webmercator_subdivision`, so it
  culled deep tiles). No API key needed. Verified content reaches Rome at 12.57°E/41.90°N. Related:
  [s1dny/bing-maps-tile-downloader](https://github.com/s1dny/bing-maps-tile-downloader/) — offline
  downloader for the same Bing `tf=3dv4` tiles (vs. our live `td1` → 3D Tiles proxy).
- **Browser-native bbox crop / subsample extract** — pull a cropped/decimated copy of a tiled asset
  (point cloud, mesh, or splat) by an OBB defined in the viewer — BLOSM-style but JS/browser-native.
  See [[dump-tiles-feature-idea]] (memory). **Refinement-aware traversal**: for **ADD** octrees (COPC/Potree)
  accumulate all points down to the desired geometric error within the OBB; for **REPLACE** trees (3D Tiles
  mesh) descend only where a parent's GE still exceeds the target. **Point clouds** → **hand-written LAS**
  (streamable, O(1) RAM even for 500 GB via header back-patch — `core/las-writer.js`, built) → shell to
  **`pdal writers.copc` / untwine** (out-of-core) for LAZ/COPC. **Meshes** → merge tile GLBs (geometry+UV+
  texture) via glTF-Transform → a binary mesh (glb/USD/USDZ). No JS/WASM LAS *writer* exists (node-las is
  archived; entwine/untwine are C++-only) and `laz-perf` WASM is decode-only — so hand-write + native CLI.
- **3MX siblings** — add Bentley **ContextCapture / Scalable Mesh** (`.3sm`) next to 3MX
  ([Bentley docs](https://docs.bentley.com/LiveContent/web/ContextCapture%20Help-v18/en/GUID-569C1E44-D86A-4942-9ABE-36C33FB5A7EB.html);
  cf. [OctopusET/mxmxmx2tiles](https://github.com/OctopusET/mxmxmx2tiles)). Working 3MX test: Tende village (dept06).
- **Server-side per-cache progress** — the eager-drain (`cache=hierarchy`) and convert (`cache=full`) loops
  need a job-progress endpoint the viewer can poll (the timing-log modal already renders client milestones).
- **Fastest JS point-cloud tiler** — a Potree-2.0-architecture out-of-core tiler (counting-sort on Morton
  codes → pre-allocated layout → scatter+spill) in JS, emitting COPC/Potree/3D Tiles.
- **Speed**: the per-tile Draco+KTX2 decode (~250 ms/tile) can be cut by (1) **passing KTX2 through
  untouched** when the consumer reads it, (2) emitting **WebP** (WASM encoder) instead of `pngjs` PNG,
  (3) reusing decoder/transcoder instances across tiles, (4) a worker-thread pool. pngjs PNG-encode of the
  ~1.4 MB RGBA is the main avoidable cost.

> **`centroids` per format** — works for **SOG / LCC / RAD** (the tiled-splat formats). Verified: the
> tileset omits the splat extension and each tile is a POINTS GLB (SOG 724 B vs 1160 B splat for the same
> run; LCC, RAD likewise). For RAD the flag rides on the absolute `/stream/rad/subtree/…` + `/stream/tile/…`
> URIs the lazy fragments emit. COPC/Potree are point clouds already.

### Phasing (chosen: Phases 1–3; Phase 4 deferred) — **Phases 1–3 IMPLEMENTED**

1. ✅ **Shared services, no behavior change** — `core/geo.js` (ENU/ECEF + proj4 georef, was duplicated
   4×), `core/source.js` (`Source`: range / parallel `ranges` / full / probe-once), `core/http.js`
   (CORS + `sendJson`/`sendGlb`/…). Wired into copc/potree/lcc/i3s/rad/sog. Verified: COPC still
   georeferenced, tiles byte-identical, RAD 765/765 after the `Source` rewire.
2. ✅ **Unify the octree builder** — `core/octree.js` `buildImplicitTileset()` shared by COPC + Potree
   (was near-identical in both). Verified byte-identical output (COPC availableLevels 9, Potree 2.0 25,
   424 B subtrees). *(The explicit-fragment unification for RAD+I3S was left in-place — both verified
   working — to avoid churn; it folds naturally into the driver model when Phase 4 happens.)*
3. ✅ **Single `cache=none|hierarchy|full` axis + `/tiles` endpoint.** `/tiles/tileset.json?cache=`
   dispatches **in-process** to `/stream` (`none`/`hierarchy`) or `/convert` (`full`) — originally a 307
   redirect translating `cache=` to a separate `hierarchy=` query param on `/stream`; both the redirect
   and the second vocabulary are gone as of 2026-07-02 (`/stream` reads `cache=` directly, so the query
   string just carries through). No `prebuilt` mode (point the viewer directly at an offline-built
   tileset). `cache=hierarchy` (a real eager-drain into the shared ctx, so warm subtrees reuse it) is
   wired for **all** live converters with a hierarchy — **COPC, Potree 2.0, Potree 1.x, RAD, I3S**
   (SOG/LCC are single-index, always-eager). `prefetch=N` warms N levels (COPC). Verified: routing,
   eager/lazy per format, RAD eager = full 765-tile explicit tree vs lazy fragments, and all coverage
   harnesses (RAD 765, Potree2 1624, I3S 5882) still pass.
4. *(deferred)* `bake(driver)` to power offline from the same drivers — offline converters stay as-is.

> **Note — offline converters conserved.** Per the push/pull split above, the offline `*-to-3dtiles`
> packages (which walk the format hierarchy top-down and emit the full tree) are deliberately left
> untouched: they work and are correct. Only the live (pull) path was harmonised.

---


### Parallelism (per converter)

Per-tile work — decode → SPZ/GLB encode → gzip → write — is **independent per tile**, so it is
embarrassingly parallel. The shared `core` (`packages/core`) provides the two tiers: **async gzip**
(`zlib.gzip` on the libuv threadpool) + `parallelMap` (bounded-concurrency = cores−1, no workers), and
a `WorkerPool` (`worker_threads`) for decode-heavy formats. **All five operational converters now use
tier 1** (`parallelMap` + async gzip/`buildPointsGlb`), each verified to produce output equivalent to
its prior serial version. The `WorkerPool` tier (true multicore decode) is not yet wired — it's the
remaining headroom for the WASM/CPU-bound decoders.

| Converter | Decode cost (per tile) | Parallel **today**? | Main-thread-bound part | Worker-extractable? |
|-----------|------------------------|:-------------------:|------------------------|---------------------|
| **rad** | pure-JS column unpack (interleaved/planar) — CPU-bound | ✅ `parallelMap` + async gzip (byte-identical) | JS decode | ✅ decode per chunk → `WorkerPool` (true multicore) |
| **sog** | **WebP WASM** decode per chunk | ✅ `parallelMap` + async gzip (content-identical) | WebP decode | ✅ **biggest win** (thousands of tiles); WASM runs in workers as-is |
| **lcc** | pure-JS `DataView` unpack — fast | ✅ `parallelMap` + async gzip | one ~3 M-splat tile is a serial tail | ✅ worker decode would split that giant tile |
| **copc** | **LAZ WASM** (`laz-perf`) decode — CPU-bound | ✅ `parallelMap` (byte-identical; ~27% faster) | LAZ decode | ✅ per-node decode → worker pool |
| **potree** | pure-JS slice (+ **brotli** for 2.0) — many small nodes | ✅ `parallelMap` (byte-identical) | per-node decode + brotli | ✅ many small nodes → ideal worker-pool fan-out |
| **i3s** (draft) | pure-JS geometry decode | ❌ (draft; serial) | — | ✅ later |

Measured (cores−1 lanes): copc autzen 23.0→16.9 s, potree lion 6.2→5.0 s — modest now (gzip/decode
still on the main thread via the libuv pool); the `WorkerPool` tier is where multicore decode lands.

**Short answer to "can main-thread work move to workers?"** Yes — for *every* converter. The pure-JS
decoders (rad, lcc, potree) gain the most (they're single-core-bound today → true multicore via
`WorkerPool`); the WASM decoders (sog, copc) are already fast per-op but still serialized on the main
thread, so a worker pool parallelizes them across cores. `core.WorkerPool` is the shared mechanism;
each converter just needs its tile loop ported (lcc is the worked example).

---
