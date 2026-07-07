---
title: "Design log"
description: "---"
---

# Design log

> A faithful, structured synthesis of the design conversation that produced the live-streaming
> harmonization (lazy hierarchy, the `cache` continuum, and the per-format wiring) plus a running
> historical record of completed implementation work. It captures the questions asked, decisions made,
> the rationale, and the verification — not a byte-verbatim transcript. The canonical reference is
> ["Architecture: the materialization continuum"](/docs/guide/architecture-the-materialization-continuum-cache-none-hierar);
> this log records *how we got there*, and what shipped along the way.

---

## 1. Lazy hierarchy (the starting point)

**Problem.** Geometry was already fetched per-tile on demand for every live converter, but the
**hierarchy** was read in full at cold load (`getCtx`). For massive datasets that is the bottleneck:
a 302 M-point Potree 1.7 cloud took ~80 s to walk its `.hrc`; a 50 M-splat RAD took ~9.6 s for the
chunk pass; large COPC/Potree 2.0/I3S read the whole index up front.

**Principle stated by the user.** All stream converters must have minimal cold starts even for large
hierarchies. Out-of-core lazy — but not every level should reference the next as a separate external
tileset; use **multiple sub-trees** (like Potree's octree `stepSize`): for **implicit** octree/quadtree
formats emit `.subtree`s; for **explicit** formats emit N-level external-tileset fragments.

**What was implemented & verified (earlier rounds):**
- **Potree 1.x** — lazy implicit: load one `.hrc` chunk; generate each `.subtree` from only the chunks
  that block needs. Verified byte-identical to the eager build. 302 M cloud: ~80 s → ~0.2 s.
- **Potree 2.0** — lazy implicit: read only `firstChunkSize` of `hierarchy.bin`; load proxy chunks on
  subtree demand. Verified byte-identical (1624 nodes, 0 mismatches).
- **COPC** — lazy implicit: load only the root hierarchy page; load child pages on subtree demand;
  fire-and-forget warmup of the first block.
- **RAD** — lazy explicit: read only the JSON header; build 4-level fragments, boundary children become
  `/rad/subtree/<ci>.json` external refs. Was found **broken** (Sonnet pass emitted ~1 ref for a 50 M
  cloud) and **rewritten** to a correct recursive builder. Verified 765/765 reachable nodes. 9.6 s →
  0.015 s cold start.
- **I3S** — lazy explicit (`&lazy=1`): load node-page 0; 4-level fragments with `/i3s/node/<idx>.json`
  external refs; pages on demand. Verified 5882/5882 content tiles, tiles byte-identical to eager.

**Why lazy cold-starts but slightly slower subsequent tiles — and the fix.** Eager keeps all
availability in RAM (every later lookup is a hit); lazy pays a fetch on the first request into a new
region. Mitigations kept in the middleware: background **prefetch** of the first levels, and a per-URL
`getCtx` cache so a region is fetched at most once.

---

## 2. The conceptual step back — the materialization continuum

**The one idea.** Every converter (offline or live) is the *same mapping*: input-format
(hierarchy, node-data, CRS) ↔ 3D Tiles (tree, tile content, transform). The only thing that varies is
**when the mapping is evaluated and how much is persisted**.

**Push vs pull.** Offline conversion **pushes** — walks the format hierarchy top-down, building the tree
and emitting every tile. Live adapters **pull** — expose the tileset root, then answer each request by
extracting exactly the hierarchy/tile content needed. Same mapping, opposite direction. **Decision:
conserve the offline converters as-is** (they work and walk the hierarchy correctly); harmonize only the
live path.

**First framing (later corrected): two axes.** `mode` (materialization) × `hierarchy` (eager/lazy). The
naming `prebuilt | cached | live` + `hierarchy=eager|lazy` + `prefetch=N` was chosen, and Phases 1–3
implemented (shared services, unified octree builder, `/tiles?mode=` endpoint).

**The correction (user).** `prebuilt` doesn't make sense as a *middleware* mode: if you built a tileset
offline you point the viewer straight at its output `tileset.json` — the middleware isn't involved and
can't (shouldn't) know the input→output link. Dropping it collapses the two axes into **one ordered
axis: what the middleware caches.**

**Final naming (chosen): `cache = none | hierarchy | full`.**

| `cache` | hierarchy up front | tiles persisted | = old |
|---|---|---|---|
| `none` | no (lazy, on demand) | no | `/stream` lazy |
| `hierarchy` | yes (whole tree in RAM) | no (per-request) | `/stream` eager |
| `full` | yes | yes (tree + all tiles → disk) | `/convert` |

`?cache=hierarchy` reads literally as "cache the hierarchy, not the tiles." The parameter name carries
the concept, so no one must memorize what "live" vs "cached" means. (Analogues: DB
materialized-table→view; Next.js SSG→ISR→SSR; GIS tile-cache→dynamic-tiling.)

---

## 3. Harmonization (chosen scope: shared services + unified live; offline `bake()` deferred)

**Phase 1 — shared services (byte-identical, verified).**
- `core/geo.js` — `llhToEcef` / `enuFrame` / `enuMatrix` / `georefFromCrs` (was duplicated 4× across
  copc/potree/lcc/i3s).
- `core/source.js` — `Source`: `.range` / parallel `.ranges` / `.full` / probe-once. RAD rewired onto it.
- `core/http.js` — `CORS` + `sendJson`/`sendGlb`/… across all adapters.

**Phase 2 — unified octree builder.** `core/octree.js` `buildImplicitTileset()` shared by COPC + Potree
(were near-identical). Output byte-identical (COPC availableLevels 9, Potree 2.0 25, 424 B subtrees).

**Phase 3 — single `cache` axis + `/tiles` endpoint.** `/tiles/tileset.json?cache=` 307-routes:
`none`/`hierarchy`→`/stream` (with `hierarchy=lazy`/`eager`), `full`→`/convert`. No `prebuilt`. Old
paths (`/stream`, `/convert`, `/copc`, …) kept as aliases. `tiling=explicit` routes *through* the
existing `implicit-to-explicit` tool (one composable pipeline).

**Harmonization plan (live path) — chosen scope: shared services + unified live.**

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

**Endpoint rework — done (2026-07-02).**

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

Live `tiling=explicit` routing *through* the existing `implicit-to-explicit` tool for octree formats
(COPC/Potree) — so the LIVE `/stream?tiling=explicit` path shares one explicit-tiling code path instead
of each octree adapter having its own bespoke `buildTilesetExplicit` — remains open (see
[TODO / Future work](/docs/guide/todo-future-work)). What shipped now is more modest:
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

**Deferred (Phase 4).** `bake(driver)` to power offline conversion from the same drivers — offline
converters stay untouched for now.

---

## 4. Wiring `cache` / `prefetch` across ALL converters + parallel hierarchy build

**Audit found** the eager knob was only on COPC + Potree 2.0 (and I3S via its `lazy` flag); RAD's eager
path existed but was unreachable; SOG/LCC/Potree 1.x weren't wired. The lazy fragment builders were also
partly **sequential** (RAD BFS, I3S recursion, Potree 1.x `ensureBlock` all `await`-per-node).

**Implemented:**
- `cache=hierarchy` (eager-drain) wired for **all** live converters with a hierarchy: COPC, Potree 2.0,
  **RAD** (full explicit tree), **Potree 1.x** (`drainAll` over the whole `.hrc`), I3S. SOG/LCC are
  single-index → `none`≡`hierarchy` (documented no-op).
- **Parallel hierarchy build** for the lazy fragment builders — RAD loads each BFS level concurrently;
  I3S loads each node-page level concurrently then builds the fragment **synchronously** (avoids a
  `seen` race); Potree 1.x loads each `.hrc` band concurrently (`loadChunkRoots`). All **bounded** at
  `min(cpus−1, 16)` via `parallelMap` so a deep multi-page fragment can't burst hundreds of fetches
  (an unbounded `Promise.all` first attempt caused `fetch failed` under load — fixed by bounding).
- `prefetch=N` wired for the octree-lazy formats (COPC, Potree 2.0, Potree 1.x); for RAD/I3S the
  4-level fragment is itself the prefetch unit; SOG/LCC n/a.

**Re-verified after parallelization:** RAD 765/765, I3S 5882/5882, Potree subtrees valid, no errors.

---

## 5. Verification summary (endpoint/output level)

| Gate | Result |
|---|---|
| All format endpoints (`cache=none` & `cache=hierarchy`) | 200 |
| COPC / Potree 2.0 implicit output | byte-identical (availableLevels 9 / 25, 424 B subtrees) |
| Potree 2.0 hierarchy nodes (lazy drains to eager) | 1624 |
| RAD reachability (lazy fragments) | 765 / 765 |
| RAD eager | full 765-tile explicit tree (0 fragments) |
| I3S lazy coverage | 5882 / 5882 (tiles byte-identical to eager) |
| `/tiles?cache=` routing | none/hierarchy→/stream, full→/convert, bad→400 |
| Bounded parallel build under load | no `fetch failed` |

Verification was at the HTTP/output layer (byte-identity + coverage + no errors), where the refactor
risk lives; the renderer-facing outputs are unchanged, so Cesium/3DTRjs render behavior is preserved by
construction.

---

## 6. Phasing (chosen: Phases 1–3; Phase 4 deferred) — Phases 1–3 IMPLEMENTED

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

## 7. Bentley 3MX and Bing Maps 3D adapters (implemented)

### Bentley 3MX → 3D Tiles

✅ `GET /stream/tileset.json?format=threemx&url=<Scene.3mx | root.3mxb>`. Parses `3MXBO` node trees,
serves lazy external-tileset fragments per `.3mxb`, decodes **OpenCTM (MG1/LZMA)** geometry via vendored
js-openctm → glTF + JPEG baseColor. Verified live against the colorwlof/Unity-3mxb fixture (textured GLB
tiles render; decoded bbox matches node bbMin/bbMax). Georef via SRS+SRSOrigin when present.

### Bing Maps 3D → 3D Tiles

✅ `GET /bing/tileset.json?root=<quadkey>&g=<genid>&maxLevel=<L>[&decompress=1]`.
`tf=3dv4` GLB (Draco + KTX2, ECEF in node matrix) served as-is; quadtree of quadkeys as lazy fragments,
availability by HTTP probe, geographic `region` bounding volumes. Verified live (Berlin, keyless `g=15340`).
The lazy fragments are their own route, `GET /bing/fragment/<face>-<level>-<x>-<y>.json?g=<genid>` —
a partial explicit tileset continuing the tree from that boundary node; `tileset.json`'s deep tiles
reference these by absolute URL, fetched only as the camera refines in. Example: `/bing/fragment/0-3-3-2.json?g=15530`.

`/bing` reads Bing's `td1` implicit manifest + `st` subtree availability and emits **explicit** 3D Tiles
fragments with web-mercator-correct `region`s (4 faces = quadrants; lon linear; lat =
atan(sinh(mercator-y))), flipping `y→reverseY` to fetch `mtx`/`st` from Bing. This replaces both the old
`mtx<quadkey>` probe (couldn't find Bing's deep-only tiles) and a naive implicit passthrough (Cesium
can't do `MICROSOFT_webmercator_subdivision`, so it culled deep tiles). No API key needed. Verified
content reaches Rome at 12.57°E/41.90°N. Related:
[s1dny/bing-maps-tile-downloader](https://github.com/s1dny/bing-maps-tile-downloader/) — offline
downloader for the same Bing `tf=3dv4` tiles (vs. our live `td1` → 3D Tiles proxy).

Nexus (`.nxs/.nxz`) remains postponed — see
[Candidate source formats](/docs/guide/candidate-source-formats-roadmap-not-yet-supported).

---

## 8. Known blockers — resolved

### RAD splats rendered wrong after conversion — RESOLVED: emit SPZ v2, not v3

**Symptom.** The same `.rad` file rendered perfectly in SparkJS directly, but once converted to a
3D-Tiles GLB with an embedded SPZ payload it looked wrong (off scale / falloff / orientation) in
*both* CesiumJS and 3DTilesRendererJS (whose 3DGS plugin decodes via SparkJS).

**What was verified correct.** Every SPZ field encoder was checked byte-for-byte against SparkJS's
own `SpzWriter` and the Niantic SPZ reference:
- **Scale** — `byte = (ln(s) + 10) × 16`; decode yields `ln(s)`, renderer applies `exp` once → `s`. Single exp, correct.
- **Colour** — SH-DC basis `byte = sh_dc·0.15·255 + 128`. (The "factor 2" you sensed was a *documentation typo* in `spz-format.md`, where the decode divisor read `0.15·128` instead of `0.15·255`; the code was always correct. Now fixed.)
- **Opacity** — `byte = round(opacity·255)`; the SPZ/KHR sigmoid/inv-sigmoid pair is a net no-op. Correct.
- **Header / block order** — magic, version, numPoints, shDegree, fractionalBits; planar blocks positions→alpha→rgb→scales→rotations. All correct.

**Root cause — SPZ version. The extension is locked to SPZ v2; we were emitting v3.** Tracing the
extension's [inception](/docs/references/3d-gaussian-splatting-extension-lineage) shows
`KHR_gaussian_splatting_compression_spz_2` is **pinned to SPZ v2** (the `_2` is the SPZ format
version — a KHR extension cannot float across SPZ versions for IP/portability reasons, so it is
deliberately fixed). The two SPZ versions differ in the **rotation block**:

| | SPZ v2 (`packQuaternionFirstThree`) | SPZ v3 (`packQuaternionSmallestThree`) |
|---|---|---|
| Rotation bytes/splat | **3** — store x,y,z (w≥0 recovered) | 4 — smallest-three packed `uint32` |
| Per-splat total | 19 bytes | 20 bytes |

We had been writing v3 (4-byte rotations, `version = 3` header) — what SparkJS *writes* by default
— under the v2 extension. CesiumJS's bundled Niantic decoder reads the v2 layout, so it consumed a
**4-byte rotation block at a 3-byte stride**, corrupting every rotation (and looking like global
scale/falloff weirdness). The 3DGS plugin showed the same because the GLB itself was non-conformant.

**The fix (applied).** `rad-to-3dtiles` now emits SPZ **v2**: `SPZ_VERSION = 2`, `encodeQuat` writes
3 bytes via the first-three scheme (`byte = round(comp·127.5 + 127.5)`, w canonicalised ≥ 0 and
recovered on decode), and `buildSpzBuffer` uses a 19-byte/splat layout. Verified against the Niantic
`load-spz.cc` v2 path **and** SparkJS's reader, which version-dispatches and reads the 3-byte branch
(`comp = byte/127.5 − 1`) — so the same GLB now decodes correctly in CesiumJS *and* the 3DTRJS 3DGS
plugin. Re-run the converter on your `.rad` files to regenerate v2 tilesets.

> If a future tiler/decoder targets SPZ v3, restore the 4-byte `packQuaternionSmallestThree`
> encoder (in this file's git history) and set `SPZ_VERSION = 3` — but only under a v3-capable
> extension, never under `_spz_2`. See the dedicated
> [3D Gaussian Splatting extension lineage](/docs/references/3d-gaussian-splatting-extension-lineage) section for
> the full history and links.

### COPC point clouds look "upside down" in 3DTRJS Env controls (fine in Globe)

**Symptom.** A georeferenced COPC tileset displays correctly in Globe controls but appears
rotated/upside-down under EnvironmentControls.

**Root cause — not a converter bug.** `glbWriter.js` stores points as `(East, Up, −North)` so
that after the renderer's standard glTF→3D-Tiles `RX(+90°)` correction they become the
right-handed `(East, North, Up)` frame — correct, and confirmed by the flawless Globe render.
The problem is purely viewer-side: after that correction the data is **Z-up**, but
`EnvironmentControls` assumes a **Y-up** local ground plane, so a georeferenced tileset viewed
in Env mode looks tipped over.

**How to overcome it:** use the new **Local orbit** control mode (added to the 3DTRJS toolbar),
which runs `ReorientationPlugin` to recenter the tileset at the origin with `up = +Y` and then a
plain Three.js `OrbitControls`. That presents any tileset — ECEF or local — in a clean upright
orbit, independent of the ECEF root transform, and was also added to verify that the
world→local matrix concatenation is not what limits fine-detail streaming.

---

## 9. Live-path verification narratives (historical)

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

Everything not on a range adapter is still fully renderable today via `/convert`.

### `/geosplats` — live MapTiler GeoSplats → 3D Tiles (implemented ✅, reverse-engineered)

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
  georeferenced vs. non-georeferenced case split for each format — see [TODO/Future work](/docs/guide/todo-future-work).

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

### Architecture & runtime note

**Browser runtime not built** — `fs` / `zlib` / `worker_threads` are Node-only; core's planned `fs-io`
abstraction + `CompressionStream`/WASM-brotli paths don't exist yet (decoders are mostly portable). See
[TODO / Future work](/docs/guide/todo-future-work) for the design sketch of porting the middleware into
3DTilesRendererJS itself. **`.3tz`/`.3dtiles` packaging IS built in** (`scripts/pack-3dtiles.mjs`,
dependency-free) and serving packages in-place is too (`/3dtiles-self-contained`, documented in
[Ambition](/docs/guide/ambition)). **Tileset-level transforms** (version `upgrade` 1.0→1.1, `combine`
multiple tilesets, content-format transcodes) beyond what `/3dtiles-tools` already covers are **not**
built in; use Cesium's [3d-tiles-tools](https://github.com/CesiumGS/3d-tiles-tools) (CLI + JS API) for
those — `npx 3d-tiles-tools upgrade`, `… combine`, etc.

### RAD `geometricError` undershoot — fixed (historical)

`rad-to-3dtiles` now defaults to a **spatial** GE basis (`bboxDiag/∛count`, `--ge-basis=spatial`)
instead of the featureSize basis that undershot by ~4× (Elevator: ours 1.22 vs William's 4.66) and
caused renderers to under-refine at distance. The old featureSize basis is still available via
`--ge-basis=featuresize` for comparison/legacy output.

---

## 10. Migrations & fixes — Done list

Completed items, kept here for history/context.

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
  with `copc-to-3dtiles/package.json` (see the `@cesium/3d-tiles-tools` note in [CLI usage](/docs/guide/cli-usage)),
  Docker builds ignored `.npmrc`'s `node-linker=hoisted` (which the converters' cross-package imports
  depend on), `vite build` silently never bundled `viewer.html`/`vanilla-viewer.html` at all (only its
  own `index.html` redirect stub) — fixed via `build.rollupOptions.input` + `build.target: 'esnext'`
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
  blocks, checkboxes/strikethrough) via a full `next build` + dev-server check. The guide + reference
  files are cross-linked throughout, and the root `README.md` was trimmed to a pitch + quickstart
  pointing at the docs site (see the Docker item above) — the docs site is now the canonical source,
  not README.
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

---

## Open / deferred

- **Phase 4** — `bake(driver)`: unify offline conversion behind the same drivers. Deferred; offline
  converters conserved.
- **`centroids` as a chainable `/3dtiles-tools` command** (currently a `/convert` flag).
- **Multi-page COPC/Potree timing** — lazy/eager split is verified *correct* on local single-page/small
  samples; the dramatic cold-start win only shows on genuinely huge multi-page clouds.

See [TODO / Future work](/docs/guide/todo-future-work) for the full active list.
