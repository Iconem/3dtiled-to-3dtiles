# RAD (SparkJS / World Labs) → 3D Tiles — format notes & why it isn't "streamed"

Notes distilled from the Spark team + WilliamLiu (3DGS-PLY-3DTiles-Converter) on GitHub, captured to
explain how `rad-to-3dtiles` works and why RAD is served via `/convert` (preprocess+cache) rather than
the live `/stream` range adapters.

Sources:
- sparkjsdev/spark#372 — "Expose JS API lod tree walker" (replies from `mrxz`, Spark collaborator)
- WilliamLiu-1997/3DGS-PLY-3DTiles-Converter#25 — RAD opacity & orientation

## What RAD actually is

- **RAD's LoD structure is a per-splat LoD tree, not a spatial tile tree.** One hierarchy node is
  essentially **one renderable splat**; its children are the finer splats that simplify into it
  (WilliamLiu: "a per-splat LOD system, rather than a chunk/tile-level LOD system like 3D Tiles").
- **Chunks ≠ tiles.** RAD chunks are **storage/streaming** units: 64K splats ordered by `featureSize`
  (coarsest first), then grouped. The chunker *does* build an octree to spatially co-locate splats,
  **but that spatial partition is not persisted** — only used during construction (`mrxz`). A chunk can
  contain splats from **multiple LoD-tree levels**, and those shouldn't be rendered together.
- Consequence: recomputing chunk bounds offline reconstructs the *chunking* octree, **not** the LoD
  tree. To make real tiles you'd extract the **leaf-most** LoD-tree splats per chunk (direct children
  are never split across chunks), which requires the LoD tree — only available in `spark-lib` (wasm),
  not persisted in the `.rad` file.

## RAD `/stream` adapter (centers-only tree + on-demand encode)

A 3D-Tiles tileset needs **per-tile spatial bounds** to emit the tree. RAD persists **neither** tile
bounds **nor** a spatial tile partition, so — unlike COPC/Potree/SOG — we can't build the tree from
metadata alone. But the full `/convert` is overkill: the *tree* only needs each chunk's AABB, which
comes from the **`center` column alone**. So `/stream` (see `packages/tile-server/rad-live.js`) does:

- **tileset.json** — range-fetch the header, then range-fetch **every chunk in parallel** and decode,
  per chunk, the `center` column (→ AABB) **and** the `child_count`/`child_start` columns (→ LoD-tree
  topology) in a **single combined pass** (`chunkBoundsAndTopology`). No SPZ encode, no gzip.
- **tile/`<i>`.glb** — range-fetch that **one** chunk and full-decode + SPZ-v2 encode it on demand
  (~200 ms / 65k-splat chunk), reusing the shared `encodeChunkGlb`.

This defers the expensive per-tile decode+encode+gzip (which `/convert` runs for the *whole* dataset up
front) to on-demand. Bounds match the default (unfiltered) `/convert` output (outlier filtering is
opt-in/off by default).

**Cost of the cold tileset build (important for huge clouds).** RAD has *no top-level spatial index*,
so the tree build must touch **every chunk** — both the topology (child columns) and the bounds (center
column) live per-chunk. That's inherent, not a wart: a 100 M-splat `.rad` (~1500+ chunks) requires
reading + decompressing every chunk's center+child columns before the first tile appears. The adapter
mitigates this with (a) **HTTP range requests** (never buffers the whole multi-GB file; falls back to a
single full download only if the host ignores `Range`), (b) a **single parallel pass** (one decode per
chunk, bounded concurrency) instead of two sequential passes, and (c) per-URL caching of the result.
But the *first* load of a very large `.rad` is still bound by reading all chunk centers — for clouds
that big, **`/convert` (preprocess + cache once)** is the better mode, or persist a bounds/topology
sidecar. (This is why the original notes said RAD doesn't stream like COPC/Potree: those persist bounds;
RAD does not.)

**Caveat:** only **monolithic** `.rad` files stream (streaming-manifest `.rad` has no embedded chunk
data). And the LoD-tree-vs-chunking-octree subtlety above still applies — a chunk may mix LoD levels;
the adapter renders whole chunks, same as `/convert`. For a fully faithful per-LoD-leaf tiling you still
need the offline `spark-lib` path. `/convert` (preprocess+cache) remains available and produces
identical tiles; `/stream` just trades up-front conversion for on-demand latency.

The Spark team's own recommendation for a faithful converter is an **offline** process written against
`spark-lib` (or by adjusting the `build-lod` command to emit tile data directly), so the spatial
partition and LoD-tree membership are guaranteed.

## Current `rad-to-3dtiles` decode status (these are handled)

- **Opacity (the "spiky/faint splats" bug): fixed.** RAD stores quantisation under `splatEncoding`
  (per-chunk, mirrored from the root header), NOT `encoding`. When `splatEncoding.lodOpacity: true`,
  the real opacity is `stored/255 * 2` (SparkJS `unpackSplat`). The converter now reads `splatEncoding`
  and applies the ×2, so coarse splats blend correctly instead of showing needles through.
  See `packages/rad-to-3dtiles/src/index.js` (`lodOpacity`).
- **Orientation:** decoded as octahedral `(u,v)` + angle (`oct88r8`) → quaternion
  (`decodeOrientationToQuat`).
- **Scales:** log-quantised `ln_0r8`, `exp(lnMin + (v-1)/254·(lnMax-lnMin))` with ranges sourced from
  `splatEncoding.lnScaleMin/Max`.
- **Noise/outlier filtering:** optional opacity-floor and scale-outlier caps (off by default) to drop
  haze/giant-anisotropic "floating noise" splats that a baked HLOD would otherwise always render.
- Note: WilliamLiu is drafting an `EXT_splat_opacity` glTF extension so 3D-Tiles GLB can carry RAD's
  extended opacity range (up to ~1000) faithfully; until then the ×2 LoD-opacity decode is the
  pragmatic match.

## Known residual gap

Because chunks mix LoD-tree levels, the current chunk-as-tile mapping can only **approximate** RAD's
refinement, and the geometric error is therefore approximate. A faithful "v2" would be an offline,
LoD-tree-aware extraction (leaf-most per chunk) built against `spark-lib`. Deferred — out of scope for
a pure-JS `.rad` reader. The current converter is a good, renderable approximation.
