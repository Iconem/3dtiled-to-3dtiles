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

> **Harmonization plan, endpoint rework, and phasing** — the design discussion for *how* the live path
> got harmonized (the `FormatDriver` sketch, the shared `core/` services, the endpoint consolidation,
> and the chosen Phases 1–3 rollout) has moved into the
> [Design log](/docs/guide/streaming-architecture-design-log) as a single continuous narrative, since
> it's a historical record of a completed migration rather than an ongoing architectural concern. The
> live `tiling=explicit` routing-through-`implicit-to-explicit` item that was still open there is
> tracked in [TODO / Future work](/docs/guide/todo-future-work).

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
> [TODO / Future work](/docs/guide/todo-future-work)'s active list (encode-ops remainder, `rtc_center`/
> decompress for ingestion, browser-native bbox crop, 3MX siblings, server-side per-cache progress,
> Draco+KTX2 decode speed). The **Bing `td1` → explicit lazy fragments** work described in an earlier
> draft of this section is done — see the dedicated
> [Bing Maps 3D → 3D Tiles](/docs/guide/streaming-architecture-design-log) section in the design log.
> The **fastest JS point-cloud tiler** idea is tracked in
> [Candidate source formats](/docs/guide/candidate-source-formats-roadmap-not-yet-supported)'s research note.

> **Phasing (Phases 1–3, chosen scope) and the harmonization rollout** are documented as a completed
> historical migration in the [Design log](/docs/guide/streaming-architecture-design-log) rather than
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
