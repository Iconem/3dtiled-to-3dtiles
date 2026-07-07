---
title: "Architecture: the materialization continuum (cache = none · hierarchy · full)"
description: "Every converter — offline or live — is the same mapping:"
---

### HLOD mapping

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
How much the middleware caches.

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

> **Harmonization plan, endpoint rework, and phasing** — the design discussion for *how* the live path
> got harmonized (the `FormatDriver` sketch, the shared `core/` services, the endpoint consolidation,
> and the chosen Phases 1–3 rollout) has moved into the
> [Design log](/docs/guide/planning/streaming-architecture-design-log) as a single continuous narrative, since
> it's a historical record of a completed migration rather than an ongoing architectural concern. The
> live `tiling=explicit` routing-through-`implicit-to-explicit` item that was still open there is
> tracked in [TODO / Future work](/docs/guide/planning/todo-future-work).

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

> **`centroids` per format** — works for **SOG / LCC / RAD** (the tiled-splat formats). Verified: the
> tileset omits the splat extension and each tile is a POINTS GLB (SOG 724 B vs 1160 B splat for the same
> run; LCC, RAD likewise). For RAD the flag rides on the absolute `/stream/rad/subtree/…` + `/stream/tile/…`
> URIs the lazy fragments emit. COPC/Potree are point clouds already.

> **Encode ops, ingestion decompress, and other forward-looking items for this pipeline** have moved to
> [TODO / Future work](/docs/guide/planning/todo-future-work)'s active list (encode-ops remainder, `rtc_center`/
> decompress for ingestion, browser-native bbox crop, 3MX siblings, server-side per-cache progress,
> Draco+KTX2 decode speed). The **Bing `td1` → explicit lazy fragments** work described in an earlier
> draft of this section is done — see the dedicated
> [Bing Maps 3D → 3D Tiles](/docs/guide/planning/streaming-architecture-design-log) section in the design log.
> The **fastest JS point-cloud tiler** idea is tracked in
> [Candidate source formats](/docs/guide/planning/candidate-source-formats-roadmap-not-yet-supported)'s research note.

> **Phasing (Phases 1–3, chosen scope) and the harmonization rollout** are documented as a completed
> historical migration in the [Design log](/docs/guide/planning/streaming-architecture-design-log) rather than
> here — offline converters remain conserved as described above; only the live (pull) path was
> harmonised.

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

## `/convert` — live any-format → 3D Tiles (implemented)

The same server also exposes a generic endpoint that works for **every format the meta-converter
supports** (potree, sog/streamed-SOG, rad, lcc, copc, i3s).

#### The current implementation (offline conversion, cached, served live)

`/convert` is a pragmatic stand-in that gets **every** format renderable today, before each
per-format range adapter exists (so far COPC, Potree, streamed-SOG, LCC, and RAD all do — see
["Streaming roadmap — per-format range adapters"](/docs/guide/planning/streaming-architecture-design-log)).
Where the range adapters are *per-tile*, `/convert` is *per-dataset*: on the
**first** request it resolves the source to a local dataset (downloading remote inputs), runs the
in-process `convert()` **once** (output cached on disk under the OS temp dir, keyed by
`sha1(format|src)`), then serves the static 3D Tiles output. So it converts the **whole** hierarchy
and **all** tile content up front, then streams from that cache — not range-streamed, but genuinely
on-demand and format-agnostic. Subsequent requests (and restarts) hit the warm cache instantly.

```sh
npm run serve:tiles
#   GET /convert/tileset.json?url=<SRC>[&format=<fmt>]   → tileset (content URIs rewritten absolute)
#   GET /convert/<key>/<path>                            → static tile / subtree / sub-tileset file
```

- `<SRC>` may be a **remote URL** *or* a **local path** (file or dataset dir). Remote directory
  formats are mirrored with the sibling files each converter reads — Potree 2.0 (`metadata.json` +
  `hierarchy.bin` + `octree.bin`), LCC (`meta.lcc` + `index.bin`/`data.bin`), SOG (`lod-meta.json` +
  every chunk `meta.json` + its WebP textures). Single-file formats (COPC/RAD/SLPK) download the one file.
- `&format=` is optional — auto-detected from the path/extension (pass it for remote directory
  formats where the index filename isn't decisive, or to override).
- `&tiling=implicit|explicit` (COPC & Potree) chooses the tree encoding — implicit (subtree files) or
  an explicit nested tree. CLI: `--tiling=…`; API: `opts.tiling`. Defaults: COPC implicit, Potree
  explicit. Same flag works for the offline converters.
- `&centroids=1` (point clouds get this for free) renders **splat** datasets (RAD/SOG/LCC) as a
  POINTS tileset of splat **centroids** — so renderers without `KHR_gaussian_splatting` support can
  still display the scene. See [Centroids-only](#centroids-only-splats-as-point-clouds) below (same page).
- The served **root** tileset has its relative `uri`s rewritten to absolute `/convert/<key>/…` so
  content resolves regardless of how the viewer bases the query-string URL; nested sub-tilesets are
  served at their real paths so their own relative URIs already resolve.
- For big COPC, prefer `/stream?format=copc` (true range streaming) over `/convert` (downloads the
  whole `.laz`).

**Remote source notes / limits:**
- The **same remote support is shared by the CLI and JS API** (`packages/convert/fetch-source.js`):
  `3dtiled https://host/scene/metadata.json out/` and `convert('https://…', out)` download the source
  (+ the sibling files the format needs) to a temp dir, then convert. Local path or remote URL works
  identically across CLI, JS API, and the `/convert` middleware.
- Mirroring is server-side, so **no browser CORS** applies — but the source must serve **HTTP range
  206** for `/copc` and `/potree`, and **must not redirect in a way that drops the `Range` header**
  (e.g. some IGN LiDAR HD URLs 302 to an OVH bucket → range lost). `/convert` downloads in full so it
  tolerates that.
- **I3S** remote = `.slpk` **file** only; live **REST** SceneServer services (gzipped node-page tree)
  aren't mirrored yet — extract the `.slpk` / mirror the service locally and pass the directory.
- Use a **raw** file URL, not a hosting page — GitHub `…/blob/…#L2` returns HTML; use the
  `raw.githubusercontent.com` URL (or `?raw=1`).
- Don't mix protocols in a browser: an `https://` viewer page can't fetch an `http://localhost`
  tileset (mixed-content block). Serve the viewer over the same scheme as the tile-server.

viewer.html ships pills for each: **🛰 Potree / RAD / SOG / LCC / COPC →3DT (live)**.

#### Centroids-only: splats as point clouds

Gaussian-splat formats (**RAD / SOG / LCC**) normally emit `KHR_gaussian_splatting` GLB tiles, which
many 3D-Tiles clients can't render. `--centroids-only` (CLI) / `?centroids=1` (middleware) instead
emits a plain glTF **POINTS** tileset of the splat **centroids** — POSITION + COLOR_0 only, dropping
scale / rotation / gaussian opacity — placed in the exact same frame as the splat tiles. So any
point-cloud-capable renderer (CesiumJS, 3DTilesRendererJS, cesium-for-unreal, …) can display a
tiled-splat scene as points.

```sh
# offline conversion
3dtiled scene.rad out/ --centroids-only           # POINTS tileset instead of splats
# live middleware
GET /convert/tileset.json?url=<SRC>&centroids=1    # cached separately from the splat variant
```

Point-cloud inputs (COPC/Potree) are already POINTS, so the flag is a no-op for them. The output is a
standard POINTS tileset with **no** `KHR_gaussian_splatting` extension advertised.

## `/3dtiles-self-contained` — serve `.3tz` / `.3dtiles` packages in-place

```sh
# Open a .3tz package directly in any 3D Tiles viewer without extracting it:
GET http://localhost:3001/3dtiles-self-contained/tileset.json?url=/abs/path/to/scene.3tz
GET http://localhost:3001/3dtiles-self-contained/tiles/0/0/0.glb?url=/abs/path/to/scene.3tz
```

`?url=` also takes a **local filesystem path** (resolved relative to the tile-server's own CWD, not
fetched over HTTP) alongside `http(s)://` — unique among the adapters here, which all `fetch()` and so
need an absolute URL. Working example against this repo's bundled sample package:
```sh
GET http://localhost:3001/3dtiles-self-contained/tiles/node_7.glb?url=sample-data%2Finput%2F3DTILES-PACKAGES%2Ftastier.3dtiles&format=3dtiles-pkg
```

`.3tz` is a ZIP file with a `@3dtilesIndex1@` binary index that maps every tile path to its offset
in the ZIP, enabling O(1) random-access reads (no full-file scan). This project parses the index on
first open, then serves each tile with a single `fs.read()` at the stored offset — equivalent to
`npx 3d-tiles-tools serve` but in-process, with CORS open and no additional CLI.

`.3dtiles` is an SQLite database (`key TEXT, content BLOB`). Requires `better-sqlite3`:
```sh
pnpm add -w better-sqlite3   # needs C++ build toolchain
```

**Create packages** — this repo ships a dependency-free packer (`scripts/pack-3dtiles.mjs`, ZIP+STORED
for `.3tz`, sql.js for `.3dtiles`), or use the official `3d-tiles-tools`:
```sh
# In-repo packer (no external deps): writes <out>.3tz AND <out>.3dtiles
node scripts/pack-3dtiles.mjs sample-data/output/rad/tastier500k-3dtiles-from-rad sample-data/input/3DTILES-PACKAGES/tastier

# Official tool (CesiumGS) — `convert` replaces the old packageCreate/databaseToTileset commands:
npx 3d-tiles-tools convert -i ./tileset/ -o ./scene.3tz        # ZIP package
npx 3d-tiles-tools convert -i ./tileset/ -o ./scene.3dtiles    # SQLite package
#   --inputTilesetJsonFileName <name>   when the top-level JSON isn't called tileset.json
#   input/output may be a dir, a tileset.json, a .3tz, a .3dtiles, or a .zip containing tileset.json
```

A ready-made sample is built into `sample-data/input/3DTILES-PACKAGES/tastier.{3tz,3dtiles}` (from the
tastier RAD splat tileset) — open it via `GET /3dtiles-self-contained/tileset.json?url=sample-data/input/3DTILES-PACKAGES/tastier.3tz`.

#### Packaging-format specifications

| Format | What it is | Spec |
|--------|-----------|------|
| **`.3tz`** | ZIP with a `@3dtilesIndex1@` binary index for random access; STORED (uncompressed) tile entries | [erikdahlstrom/3tz-specification](https://github.com/erikdahlstrom/3tz-specification) · Maxar `MAXAR_content_3tz` |
| **`.3dtiles`** | SQLite DB, `media(key TEXT, content BLOB)`; keys are relative POSIX paths | [3D Tiles package format proposal — CesiumGS/3d-tiles#727](https://github.com/CesiumGS/3d-tiles/issues/727) ([PDF spec 1.0.0](https://github.com/CesiumGS/3d-tiles/issues/727)) |

Tooling & discussion: [`3d-tiles-tools convert`](https://github.com/CesiumGS/3d-tiles-tools#convert) ·
[extended package server — CesiumGS/3d-tiles-tools#86](https://github.com/CesiumGS/3d-tiles-tools/pull/86).
Local notes: [`3tz-3dtiles-packages.md`](/docs/references/3dtiles-gltf/3tz-3dtiles-packages).
