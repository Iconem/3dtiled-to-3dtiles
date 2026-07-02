---
title: "Monorepo & usage"
description: "npm-workspaces monorepo. Each input format is an independent converter with its own deps"
---

npm-workspaces monorepo. Each input format is an **independent converter** with its own deps
(install just the one you need); a shared **core** holds the common machinery; a **meta-converter**
detects any input and dispatches.

```
packages/
  core/      3dtiles-convert-core   — shared: SPZ-v2 GLB + POINTS GLB encoders (async gzip),
                                      parallelMap + WorkerPool, format detection
  convert/   3dtiles-convert        — meta-converter; exposes the `3dtiled` CLI + a JS/TS API
  rad-to-3dtiles/  sog-to-3dtiles/  lcc-to-3dtiles/  copc-to-3dtiles/  potree-to-3dtiles/  i3s-to-3dtiles/
                                    — the per-format converters (each its own package + deps)
```

All packages live under `packages/` (npm-workspaces members). Run `npm install` once at the repo root
to link the `3dtiles-convert-core` workspace symlink and each converter's deps.

*Naming:* per-format converters keep the descriptive **`<fmt>-to-3dtiles`** convention (not scoped
`@scope/<fmt>`); the two shared packages are the unscoped `3dtiles-convert-core` / `3dtiles-convert`.

### Meta-converter — convert anything

```sh
npm install                                  # wire up the workspaces
# CLI (auto-detects format):
npm run convert -- <input> <outDir> [--format rad|sog|lcc|copc|potree|i3s] \
                                    [--scale N] [--ge-scale N] [--ge-layer N] [-- <extra converter args>]
# or directly:
node packages/convert/cli.js sample-data/input/RAD/coit.rad sample-data/output/rad/coit-3dtiles-from-rad
```

```js
// JS/TS API — same detection + dispatch
import { convert, detectFormat, supportedFormats } from '3dtiles-convert';
await convert('path/to/input', 'out/dir', { geScale: 2, onLog: s => process.stdout.write(s) });
```

> Each `<fmt>-to-3dtiles` converter already lives under `packages/<fmt>-to-3dtiles/` and exports a
> uniform `convert(input, outDir, opts)`; the meta-converter's registry dispatches to it **in-process**
> (a plain `import`) by default. Child-process spawn is only a fallback for callers passing
> format-specific CLI flags (`opts.extraArgs`) the in-process options object doesn't model yet — not a
> sign of an incomplete migration. See [ARCHITECTURE.md](ARCHITECTURE.md).


### `/stream` lazy-loading status (geometry vs hierarchy)

Two independent questions for a streaming adapter: is **geometry** fetched per-tile on demand (vs.
converting everything up front), and is the **hierarchy/tree itself** built on demand (vs. reading the
whole index/hierarchy at cold load)? Geometry-on-demand is universal here; hierarchy-on-demand is the
hard part, and matters for **huge clouds** where reading the entire hierarchy before the first tile is
the bottleneck.

**Tiles vs hierarchy** — (1) **tile geometry** is fetched on demand for *every* format (universal).
(2) the **hierarchy** is the hard part. Each live converter exposes the `cache` axis (`none`=lazy,
`hierarchy`=eager-drain, `full`=`/convert`). The columns below: how tile geometry is fetched, the
lazy hierarchy strategy, whether the **hierarchy build is parallel** (bounded HTTP range/page fetches —
the lever for *massive multi-page* datasets), whether **tile fetches are parallel range**, and the
measured cold start.

| `/stream` source | Tile geometry | Lazy hierarchy | Parallel hierarchy build | Parallel tile fetch | `cache=hierarchy` (eager) | Cold start |
|---|:---:|:---:|:---:|:---:|:---:|---|
| **Potree 2.0** (`metadata.json`) | ✅ range `octree.bin` | ✅ lazy implicit | ✅ bounded (`ensureBlock2`/drain `Promise.all`) | ✅ per-tile | ✅ drain all chunks | instant (lazy==eager byte-identical, 1624 nodes) |
| **COPC** (`.copc.laz`) | ✅ range node block | ✅ lazy implicit | ✅ bounded (`ensureForSubtree`/`drainAll`) | ✅ per-tile | ✅ drain all pages (shared ctx) | instant (+bg prefetch) |
| **Potree 1.x `.hrc`** (`cloud.js`) | ✅ per-node fetch | ✅ lazy implicit | ✅ **bounded parallel** (`loadChunkRoots`, was sequential) | per-node | ✅ `drainAll` whole `.hrc` | ~0.2 s (302 M-pt; was ~80 s) |
| **RAD** (`.rad`) | ✅ range chunk | ✅ lazy explicit (4-lvl frags) | ✅ **bounded parallel** per BFS level (was sequential) | ✅ per-chunk | ✅ full explicit tree (1 parallel pass) | **0.015 s** (50 M; was 9.6 s) |
| **I3S** (`3dSceneLayer`/`.slpk`) | ✅ per-node geometry | ✅ lazy explicit (4-lvl frags) | ✅ **bounded parallel** page-load per level (was recursive-serial) | per-node | ✅ all node-pages (parallel batches) | ~0.2 s (lazy & eager both 5882/5882) |
| **Potree 1.4 inline** (`cloud.js`) | ✅ per-node | ➖ tree inline in `cloud.js` | n/a (one file) | per-node | ➖ no-op (single file) | instant |
| **streamed-SOG** (`lod-meta.json`) | ✅ per-chunk WebP | ➖ full tree in one JSON | n/a (one file) | per-tile | ➖ no-op (`none`≡`hierarchy`) | fast — nothing to defer |
| **LCC** (`meta.lcc`) | ✅ range `data.bin` | ➖ flat grid (`index.bin`) | n/a (one file) | ✅ per-tile | ➖ no-op (`none`≡`hierarchy`) | fast — flat grid |
| **Packages** (`.3tz`/`.3dtiles`) | ✅ range / sql.js | ➖ passthrough | n/a | ✅ / ➖ | ➖ as authored | instant |

Legend: ✅ done · ➖ not applicable / single-index (nothing to parallelize or defer) · "lazy implicit" =
tiny implicit root, each `.subtree` built on demand from only the chunk(s) it needs · "lazy explicit" =
root fragment of N levels, boundary children are external-tileset refs fetched as the camera refines in.

**Parallel hierarchy build** (the massive-multi-page lever): the eager/drain paths always used
`Promise.all`; the **lazy fragment builders are now bounded-parallel too** — RAD loads each BFS level
concurrently, I3S loads each node-page level concurrently (then builds the fragment synchronously, no
`seen` race), and Potree 1.x loads each `.hrc` band concurrently (`loadChunkRoots`). All capped at
`min(cpus−1, 16)` via `core/parallel.js` `parallelMap` so a deep multi-page fragment can't burst
hundreds of simultaneous range requests. **Parallel tile fetch** is inherent — the renderer requests
many tiles at once and Node serves them concurrently; a single tile is one range read + decode.

All lazy paths verified to reach the **same node set as eager** after parallelization: Potree 2.0
byte-identical (1624 nodes), RAD 765/765 reachable, I3S 5882/5882 content tiles.

### Multi-page hierarchies: the native chunking unit per format (and why we prefetch)

Lazy hierarchy is only possible when the **format itself chunks its hierarchy** into independently
fetchable pieces. This is the same idea everywhere, with different names — and 3D Tiles has *both* output
forms of it: **`.subtree` files** (implicit) and **external `tileset.json` references** (explicit). The
job of each adapter is to map the *source* format's chunking unit onto one of those two 3D Tiles forms.

| Format | Native hierarchy chunking unit (per spec) | Maps to 3D Tiles | Lazy? |
|---|---|:--:|:--:|
| **3D Tiles** | `.subtree` (implicit, `subtreeLevels` deep) · external `tileset.json` (explicit) | — (native) | ✅ |
| **COPC** | **hierarchy pages** — EPT-style; root page in the COPC info, child pages referenced by offset/size (COPC is "COG for point clouds"; pages are its analog of COG overviews) | implicit `.subtree` | ✅ |
| **Potree 2.0** | **hierarchy chunks** in `hierarchy.bin` — `firstChunkSize` + type-2 **proxy** nodes pointing to child chunks | implicit `.subtree` | ✅ |
| **Potree 1.x** | **`.hrc` files** — one per `hierarchyStepSize` band; boundary nodes reference the next `.hrc` | implicit `.subtree` | ✅ |
| **I3S** | **node pages** — `nodepages/{n}.json`, fixed `nodesPerPage` (default 64); contiguous node-index ranges | explicit external tileset (`/i3s/node/`) | ✅ |
| **RAD** | **no separate index** — topology is *distributed in the chunks* (each chunk's `child_count`/`child_start`); the `.rad` JSON header only lists chunk byte-ranges | explicit external tileset (`/rad/subtree/`) | ✅ (defer chunk reads; header lists all chunks) |
| **streamed-SOG** | **none** — `lod-meta.json` carries the **whole** spatial tree in one file | (whole tree at once) | ➖ monolithic |
| **LCC** | **none** — `Index.bin` is a flat per-Unit array (`Total Units = fileSize / indexDataSize`), no page structure | (whole grid at once) | ➖ monolithic |

So **yes** — COPC pages, I3S node pages, Potree chunks/`.hrc` are all the same multi-page concept as
3D Tiles subtrees/external-tilesets, which is exactly why those formats support true lazy hierarchy.
**SOG and LCC do not** (rechecked against the specs): their index is a single monolithic file with no
sub-pages, so there is no portion to defer — `cache=hierarchy ≡ cache=none` for them (both fetch+parse
the one index; "no-op" means the eager knob has nothing extra to do). For a *very large* SOG/LCC that
single index is genuinely not free to parse — but the **format provides no paging to exploit**, so the
honest answer is "out of our hands until the format chunks its index." (RAD is the in-between case: its
header lists every chunk, which is O(chunks) and unavoidable, but the expensive topology+bounds are read
lazily per 4-level fragment.)

**Why prefetch.** With a chunked hierarchy, `cache=none` reads only the page(s) a request needs, so the
*first* request into a new region pays a fetch. `prefetch=N` warms the next N levels in the background so
the renderer usually finds them already resident — combining a lazy cold start with eager-like
refinement. It is meaningful only where there *are* pages to warm: **COPC, Potree 2.0, Potree 1.x**
(octree-lazy). For RAD/I3S the 4-level fragment is itself a prefetch unit. SOG/LCC have no pages → n/a.

> **Can we avoid reading availability/`getCtx` up front *and* not pay it lazily either?**
> Largely yes. For the **octree/quadtree implicit** formats (Potree 2.0, COPC, Potree 1.x) `getCtx` no
> longer reads the whole hierarchy — only the root chunk/page — and each `.subtree` is generated from
> just the chunk(s) that block needs, so the up-front cost is gone and the per-subtree cost is bounded
> (a few range reads, not the whole index). For the **explicit** formats (RAD, I3S) we emit N-level
> fragments whose boundary children are external-tileset refs, so the same bound applies. The only
> remaining strictly-eager cases are SOG/LCC, where the entire index is a single small file you must
> read anyway — there is no sub-index to defer, so laziness buys nothing.

> **Why lazy cold-starts but slightly slower *subsequent* tiles — and how to get both.**
> Eager fills all availability in RAM once, so every later `.subtree`/child lookup is a pure in-memory
> hit. Lazy defers that, so the *first* request into a new region pays a chunk/page fetch. Two mitigations,
> both kept in the middleware so you get fast cold start **and** warm refinement:
> 1. **Background prefetch** — after the root tileset is served, COPC fires a fire-and-forget
>    `ensureForSubtree(0,0,0,0)`; the first levels are usually warm before the renderer asks.
> 2. **Per-URL `getCtx` cache** — once a chunk/page is loaded it stays resident, so a region is fetched
>    at most once; repeat passes are in-memory.
>
> Both eager and lazy implementations are retained rather than replaced: implicit formats keep the eager
> full-hierarchy reader behind the scenes for the offline converter, and **I3S exposes `&lazy=1`** (lazy
> explicit fragments) vs. its default parallel-eager full tree — so you can pick minimal cold start or
> a complete in-RAM tree per request.

> **Note — huge clouds need lazy hierarchy, not just lazy geometry.** Building the full tree up front
> doesn't scale: a 100 M-splat RAD or a 302 M-point Potree 1.7 cloud otherwise reads its entire
> hierarchy/index before showing anything (measured ~80 s for the latter, 9.6 s for a 50 M-splat RAD).
> Lazy hierarchy collapses both to well under a second.

**Octree key convention:**
The implicit `level-x-y-z` tile coordinates are derived from each node's **bounding-box
position** relative to the root box — not from the node-name bit-decomposition. Potree's
own naming uses bit0→Z, bit1→Y, bit2→X (opposite of the 3D Tiles OCTREE convention of
bit0→X, bit1→Y, bit2→Z). Using the box position is convention-agnostic and self-validating
(verified: 0 box mismatches on all tested datasets). The same `coordsOfBox()` derivation is
used in both the offline converters and the live stream adapters.

---


### Individual converter (à la carte)

Each converter also runs standalone (only its own deps):

```sh
node packages/rad-to-3dtiles/src/index.js    <coit.rad>            sample-data/output/rad/<name>-3dtiles-from-rad
node packages/sog-to-3dtiles/src/index.js    <scene-dir>           sample-data/output/sog/<name>-3dtiles-from-sog
node packages/lcc-to-3dtiles/src/index.js    <lcc-dir>             sample-data/output/lcc/<name>-3dtiles-from-lcc
node packages/copc-to-3dtiles/src/index.js   <input.copc.laz>      sample-data/output/copc/<name>-3dtiles-from-copc
node packages/potree-to-3dtiles/src/index.js <potree-dir>          sample-data/output/potree/<name>
node packages/i3s-to-3dtiles/src/index.js    <extracted-slpk-dir>  sample-data/output/i3s/<name>   # draft
```

> Output convention: regenerate into **`sample-data/output/<fmt>/…`** (the viewer presets and
> `tools-inspector` scripts point there).

---
