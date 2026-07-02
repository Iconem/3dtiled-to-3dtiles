---
title: "Vision: towards a TiTiler for 3D — now live for EVERY SUPPORTED 3D-TILED FORMAT"
description: "A TiTiler equivalent for 3D formats: middleware that reads cloud-native, internally tiled 3D"
---

A **TiTiler equivalent for 3D formats**: middleware that reads cloud-native, internally tiled 3D
formats and streams OGC 3D Tiles 1.1 **on demand** — transcribing the source octree/hierarchy into a
3D Tiles tree and converting raw node geometry to glTF/GLB, served over HTTP Range so nothing is
re-encoded or re-sorted. Like TiTiler for COG: zero re-tiling, zero copy.


### `/convert` — live **any-format** → 3D Tiles (implemented ✅)

The same server also exposes a generic endpoint that works for **every format the meta-converter
supports** (potree, sog/streamed-SOG, rad, lcc, copc, i3s).

#### The intent (online, range-streamed — word for word)

> Could it not be fully online, fetching only the required portions of the underlying format
> hierarchy to build the 3dtiles json hierarchy, and then when glb tiles are requested, fetch (via
> range requests) the corresponding {copc, stream-sog, lcc, potree, etc} contiguous memory block
> just to build the requested tile?

This is exactly what **`/copc` already does** for one format: it range-reads only the COPC header +
hierarchy to emit the tileset JSON, and on each `tile/<key>.glb` request range-reads **just that
octree node's** contiguous point block to build the tile. Nothing is fully downloaded; nothing is
pre-converted. The end state is the same model generalised to every internally-tiled format
(streamed-SOG chunk runs, LCC unit LOD runs, Potree octree-node byte ranges, …): a per-format
"range adapter" mapping a requested 3D-Tiles key → the source byte range to fetch and transcode.

#### The current implementation (offline conversion, cached, served live)

`/convert` is a pragmatic stand-in that gets **every** format renderable today, before each
per-format range adapter exists (so far `/copc` and `/potree` do; LCC/RAD are next — see the roadmap
above). Where `/copc` and `/potree` are *per-tile*, `/convert` is *per-dataset*: on the
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
  still display the scene. See [`--centroids-only`](#centroids-only-splats-as-point-clouds) below.
- The served **root** tileset has its relative `uri`s rewritten to absolute `/convert/<key>/…` so
  content resolves regardless of how the viewer bases the query-string URL; nested sub-tilesets are
  served at their real paths so their own relative URIs already resolve.
- For big COPC, prefer `/stream?format=copc` (true range streaming — this section's `/copc` is that
  adapter's original name, since folded into `/stream`) over `/convert` (downloads the whole `.laz`).

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

### `/3dtiles-self-contained` — serve `.3tz` / `.3dtiles` packages in-place ✅

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
Local notes: [`docs-references/3tz-3dtiles-packages.md`](docs-references/3tz-3dtiles-packages.md).

### 3D Tiles → 3D Tiles transcodes

The input is *already* 3D Tiles — these are tileset-level transforms (the live/streaming-flavored
counterparts to [`3d-tiles-tools`](https://github.com/CesiumGS/3d-tiles-tools), referenced above).
Served live by the **`/3dtiles-tools`** endpoint (`packages/tile-server/3dtiles-tools-live.js`):
tileset JSON is rewritten once and cached; each tile is converted on demand (like `/stream`).

**`tool=implicit-to-explicit`** — read a tileset with `implicitTiling` (OCTREE/QUADTREE) + `.subtree`
files, walk the availability bitstreams, and emit an **explicit** nested tree (derived boxes via the
same `octreeSubCube`/`cubeToBox` core helpers as the octree converters). Per-tile `.b3dm`/`.pnts`
content is converted to glb on the fly; `.glb` is proxied as-is. Works on local dirs and remote URLs.

**`tool=upgrade`** — legacy → 3D Tiles 1.1 with per-tile content conversion (`packages/3dtiles-tools/upgrade.js`):
- **JSON-level:** `asset.version` → `1.1`, legacy `content.url` → `uri` (older 1.0/0.0 tilesets).
- **`b3dm` → `glb`:** a b3dm is a header + feature/batch tables + an embedded GLB — extracted by slicing
  to the GLB (zero-copy where possible).
- **`pnts` → `glb`:** parsed and re-encoded to a glTF `POINTS` GLB (native fast builder; POSITION /
  POSITION_QUANTIZED, RGBA/RGB/RGB565/CONSTANT_RGBA, RTC_CENTER → node translation).
- **glTF 1.0 → 2.0:** if the embedded GLB is **version 1** (legacy `pg2b3dm`/older exporters), it is
  upgraded to glTF 2.0 via **`gltf-pipeline`** (`processGlb`) so Three.js/3DTRjs can load it (CesiumJS
  reads glTF 1.0 natively, Three.js does not).
- **`CESIUM_RTC` baking:** because we serve a plain GLB (bypassing each renderer's native b3dm/RTC
  handling), the b3dm's `CESIUM_RTC.center` (an ECEF offset) is folded into a wrapper **node
  translation** and the extension stripped. The center is **pre-rotated by the inverse glTF up-axis**
  (RX−90°: `(x,y,z)→(x,z,−y)`) so the renderer's Y-up→Z-up RX+90° restores the true ECEF position —
  otherwise the ~6378 km-magnitude center is itself rotated 90° and the geometry lands thousands of km
  away (correct bounding boxes, empty tiles). The small relative mesh vertices still get RX+90°, as in
  native b3dm.

`i3dm`/`cmpt` content and full PBR material rebuilds are deferred to `3d-tiles-tools`
(`upgrade --targetVersion 1.1`).

**`viewer.html`'s "⚙ Tools" mode groups a third operation, `packages`,** alongside these two for UX —
but it isn't a `/3dtiles-tools?tool=…` value at all: it routes to the *separate*
**`/3dtiles-self-contained`** endpoint (a `.3tz`/`.3dtiles` package → a standard streamed 3D Tiles
tileset — see "`/3dtiles-self-contained` — serve `.3tz` / `.3dtiles` packages in-place" below), not a
tileset-level transcode. The grouping is "pick an operation to demo," not an architectural claim that
`packages` lives under `/3dtiles-tools`.

**Doable but low value (noted, not planned):**
- **Point-budget / downsample proxy** — serve fewer/decimated tiles to weak clients. Marginal: a
  capable renderer (CesiumJS / 3DTilesRendererJS) already loads only what its SSE budget needs.
- **Mesh → points** — emit only vertices of a mesh tileset. Niche (loses the surface; render-time can
  approximate), listed for completeness.

For full offline pipelines (merge, `mergeJson`, `upgrade`, `b3dmToGlb`/`pnts`/`i3dm`/`cmpt` → glTF),
use **[`3d-tiles-tools`](https://github.com/CesiumGS/3d-tiles-tools)** — the canonical CesiumGS toolbox.

### `potree-to-copc` (assessed — blocked on a JS LAZ encoder)

Potree and COPC are both octrees, so the hierarchy/metadata is a near 1:1 map and the read side is
ready (the readers extract points + the octree + the `cloud.js`/metadata **CRS**). The blocker is the
**write**: COPC mandates LAZ, and there is **no pure-JS LAZ encoder** (`laz-perf`'s WASM build is
decode-only; `copc.js` is read-only). Realistic paths: compile a Rust crate
([copc-rs](https://github.com/pka/copc-rs) / [copc-converter](https://github.com/360-geo/copc-converter)
with `laz-rs`) to **WASM**, or shell out to [PDAL `writers.copc`](https://pdal.io/en/stable/stages/writers.copc.html)
/ [copc-lib](https://github.com/RockRobotic/copc-lib). Deferred until a JS/WASM LAZ writer is wired.


# Appendix: Findings
