---
title: "RAD (SparkJS / World Labs) → 3D Tiles — format notes & why it isn't \"streamed\""
description: "Notes distilled from the Spark team + WilliamLiu (3DGS-PLY-3DTiles-Converter) on GitHub, captured to"
---

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

## Spark 2.0: the LoD system RAD comes from

> Source: https://www.worldlabs.ai/blog/spark-2.0 (published April 14, 2026, World Labs / Spark team).
> A technical deep dive into Spark 2.0's streamable, Level-of-Detail system for 3D Gaussian Splatting —
> summarized here since `.rad` is that system's on-disk format. For the interactive demos and images,
> see the original post.

Spark is a dynamic 3D Gaussian Splatting (3DGS) renderer built for the web, integrating with THREE.js
and WebGL2. Spark 2.0 adds a Level-of-Detail (LoD) system that can stream and render huge 3DGS worlds
on any device, via three core techniques:

1. **Level-of-Detail** — Preparing lower-resolution versions of the splats, calculating which subset to
   render for the camera viewpoint. Renders fewer splats when they're too far away, improving performance.
2. **Progressive Streaming** — Loading 3DGS details coarse-to-fine as data is downloaded, prioritizing
   data that best resolves details depending on camera position.
3. **Virtual Memory** — Fixed GPU memory pool for a splat page table that automatically swaps in and out
   chunks of 3DGS data as needed, giving access to huge pools of splats across multiple objects.

### LoD Splat Tree

Spark's LoD design is a **continuous LoD method** where all splats exist in a hierarchy — an LoD splat
tree. Each internal tree node is a lower-resolution version of its children, formed by merging the
splats into a new one that approximates the shape and color of the child splats. This continues up to
the root, a single large splat representing the aggregate of all splats.

Using this tree, Spark computes "slices" that select the best set of splats to render for the current
viewport, maintaining a constant splat budget (500K–2.5M depending on device type) for steady high
frame rates.

**LoD Tree Traversal Algorithm** — computes the best subset in O(N) time (N = rendered splat budget)
using a priority queue:

1. From root splat r₀, compute screen dimension d₀, insert into priority queue.
2. Pop maximum-sized splat rₘ from queue. If d < 1 pixel or rₘ is a leaf, add to output set.
3. If replacing rₘ with its children would exceed budget N, move all remaining queue splats to output
   and stop.
4. Otherwise, insert each child into queue with its screen dimension. Repeat step 2.

Implemented in Rust compiled to WebAssembly, running in a background Web Worker so LoD updates don't
impact the main render loop.

**Foveated rendering** — Spark adjusts the LoD splat screen dimension by a foveation scale factor f(v̂)
that varies as a function of splat view direction: `coneFov0` (cone around view direction with full
resolution), `coneFov` (larger cone with reduced detail), `coneFoveate` (foveation scale at edge of
`coneFov`, e.g. 10 = 10× larger splats), `behindFoveate` (foveation scale behind the camera).

**Generating LoD trees** — two algorithms: **Tiny-LoD** (quick, compact, used on-demand in browser, LoD
base β ≈ 1.75) and **Bhatt-LoD** (higher quality offline using Bhattacharyya distance for merging,
produces ~30-40% larger than input — the Bhatt-LoD name comes from the Bhattacharyya distance, which
measures statistical overlap between two 3DGS shapes, pairing splats by shape + color similarity).

### Progressive streaming & why `.RAD` exists

Existing formats don't support progressive, random-access streaming:
- **.PLY** — Row-order, uncompressed float32. 10M splats with SH0..3 ≈ 2.3 GB. Can be progressively
  loaded but huge.
- **.SPZ** — Column-order, quantized, GZ-compressed. 10M splats ≈ 200–250 MB. Cannot be progressively
  loaded (must receive the entire file first).

`.RAD`'s goals: compressed, streamable, extensible, selectable precision, random access. Structure:

```
[RAD0 magic 4B][uint32 jsonLen][JSON metadata][pad to 8B]
[RADC chunk 0][RADC chunk 1]...
```

The JSON header contains offsets and byte sizes of all chunks, enabling random-order fetching. Each
RADC chunk:

```
[RADC magic 4B][uint32 jsonLen][JSON][pad to 8B][uint64 payloadBytes][payload]
```

Splat properties are stored column-order with customizable encodings per property. Each property is
compressed with **raw DEFLATE** (miniz_oxide `compress_to_vec` → `decompress_to_vec`, no gzip header).
Key encoding: `f32_lebytes` (center) uses byte-plane interleaving — all byte-0s of all floats first,
then byte-1s, etc. — which improves compression ratio significantly.

**Spatially partitioned chunks** — chunks are filled with spatially co-located splats from largest to
smallest within 64K blocks: chunk 0 holds the largest 64K splats (root + first-level children, a coarse
global view); subsequent chunks are spatial AABB subdivisions, increasingly fine detail. Spark streams
by loading chunk 0 first, then fetching chunks based on camera-viewpoint priority using 3 parallel Web
Workers.

**Streaming manifest vs monolithic** — a `.rad` file can be either **monolithic** (all chunk data
embedded, e.g. `coit-40m-sh1-lod.rad` at 1.2 GB) or a **streaming index** (header only with remote
chunk offsets, e.g. `jinaimachi-lod.rad` at 88 KB header, 1.1 GB data fetched on demand).

### Virtual memory

Spark allocates a fixed pool of 16M splats on the GPU and automatically manages mappings between 64K
splat GPU "pages" and virtual 64K chunks of `.RAD` files. Chunks are loaded into empty pages based on
LoD-traversal ordering, evicted LRU when the page table is full and priority is lower; multiple `.RAD`
files share the same page table and one global priority ordering across all files and chunks.

## PackedSplats and ExtSplats: the two in-memory receiver formats

The `.RAD` format is **receiver-agnostic**: the same `.rad` file can be decoded into either
`PackedSplats` (16 B/splat) or `ExtSplats` (32 B/splat, Spark 2.0 preview) depending on which class you
instantiate in JavaScript:

```js
// Decode into PackedSplats (16B/splat, float16 center)
const packed = new PackedSplats({ url: 'coit.rad', lod: true });

// Decode into ExtSplats (32B/splat, float32 center — Spark 2.0 preview)
const ext = new ExtSplats({ url: 'coit.rad', lod: true });
```

**BhattLod `.rad` files** (like `coit-40m-sh1-lod.rad`) use per-property encodings chosen for
compression quality — the actual in-memory format is chosen at runtime by which class decodes it. The
RAD storage encodings for `coit.rad` are:
- `center: f32_lebytes` — byte-plane encoded float32 (higher precision than PackedSplats f16)
- `alpha: f16` — float16 opacity (matches ExtSplats)
- `scales: ln_0r8` — uint8 log scale (matches PackedSplats range)
- `rgb: r8_delta` — delta-encoded uint8 (matches PackedSplats)
- `orientation: oct88r8` — shared by both formats

**Bottom line**: the `.rad` format stores splats at the precision needed for the LoD tree, then the
runtime converts to whatever in-memory format you request (PackedSplats or ExtSplats).

### PackedSplats byte layout (16 bytes = 4 × uint32)

| Offset | Field | Size | Description |
|--------|-------|------|-------------|
| 0 | R | 1B | Red (uint8 0–255 → 0.0–1.0) |
| 1 | G | 1B | Green (uint8 0–255 → 0.0–1.0) |
| 2 | B | 1B | Blue (uint8 0–255 → 0.0–1.0) |
| 3 | A | 1B | Alpha/opacity (uint8 0–255 → 0.0–1.0) |
| 4–5 | center.x | 2B | float16 |
| 6–7 | center.y | 2B | float16 |
| 8–9 | center.z | 2B | float16 |
| 10 | quat oct.U | 1B | Octahedral quaternion U (uint8) |
| 11 | quat oct.V | 1B | Octahedral quaternion V (uint8) |
| 12 | scale.x | 1B | log-encoded uint8 (e^-12 to e^9) |
| 13 | scale.y | 1B | log-encoded uint8 |
| 14 | scale.z | 1B | log-encoded uint8 |
| 15 | quat angle θ | 1B | Rotation angle (uint8, θ/π×255) |

**Total: 16 bytes/splat**. With SH0+1+2+3: up to 56 bytes/splat.

```js
const packedSplats = new PackedSplats({
  url?: string,           // .ply, .spz, .splat, .ksplat, .rad
  fileBytes?: Uint8Array,
  maxSplats?: number,
  packedArray?: Uint32Array,
  numSplats?: number,
  construct?: (splats) => void,
  lod?: boolean | number,
  lodSplats?: PackedSplats,
  splatEncoding?: SplatEncoding,
});

// Unpack / pack / iterate (@sparkjsdev/spark utils)
const { center, scales, quaternion, color, opacity } = utils.unpackSplat(packedSplats.packedArray, index);
utils.setPackedSplat(packedSplats.packedArray, index, x, y, z, scaleX, scaleY, scaleZ, qx, qy, qz, qw, r, g, b, a);
packedSplats.forEachSplat((index, center, scales, quaternion, opacity, color) => { ... });
```

PackedSplats SH layout (extra property):

| Buffer | Words/splat | Coefficients | Quantization |
|--------|-------------|--------------|--------------|
| sh1 | 2 (8B) | 9 values (3 coeffs × RGB) | Sint7 |
| sh2 | 4 (16B) | 15 values (5 coeffs × RGB) | Sint8 |
| sh3 | 4 (16B) | 21 values (7 coeffs × RGB) | Sint6 |

### ExtSplats byte layout (32 bytes = 2 × uvec4 = 8 × uint32)

`extArrays[0]` (bytes 0–15):

| Offset | Field | Size | Description |
|--------|-------|------|-------------|
| 0–3 | center.x | 4B | float32 bits (uintBitsToFloat) |
| 4–7 | center.y | 4B | float32 bits |
| 8–11 | center.z | 4B | float32 bits |
| 12–13 | opacity | 2B | float16 |
| 14–15 | reserved | 2B | unused |

`extArrays[1]` (bytes 16–31):

| Offset | Field | Size | Description |
|--------|-------|------|-------------|
| 16–17 | color.r | 2B | float16 |
| 18–19 | color.g | 2B | float16 |
| 20–21 | color.b | 2B | float16 |
| 22–23 | ln(scale.x) | 2B | float16 (decoded with exp) |
| 24–25 | ln(scale.y) | 2B | float16 |
| 26–27 | ln(scale.z) | 2B | float16 |
| 28–31 | quaternion | 4B | packed oct+angle (10/10/12 bits) |

**Total: 32 bytes/splat.**

```js
const extSplats = new ExtSplats({
  url?: string,           // .ply, .spz, .splat, .ksplat, .rad
  fileBytes?: Uint8Array,
  extArrays?: [Uint32Array, Uint32Array],
  numSplats?: number,
  construct?: (splats) => void,
  lod?: boolean | number,
  lodSplats?: ExtSplats,
});

// @sparkjsdev/spark utils
utils.encodeExtSplat(extSplats.extArrays, index, x, y, z, sx, sy, sz, qx, qy, qz, qw, opacity, r, g, b);
const { center, scales, quaternion, color, opacity } = utils.decodeExtSplat(extSplats.extArrays, index);
extSplats.forEachSplat((index, center, scales, quaternion, opacity, color) => { ... });
```

Key differences vs PackedSplats:

| Property | PackedSplats | ExtSplats |
|----------|-------------|-----------|
| Size | 16 B/splat | 32 B/splat |
| center | float16 | **float32** (higher precision) |
| opacity | uint8 | **float16** |
| RGB color | uint8 (sRGB) | **float16** |
| scales | uint8 log (e^-12..e^9) | float16 log |
| quaternion | oct88 + u8 angle | oct10/10 + 12-bit angle |

ExtSplats SH layout (extra property) — SH3 split into sh3a + sh3b (different from PackedSplats):

| Buffer | Words/splat | Coefficients |
|--------|-------------|--------------|
| sh1 | 4 (16B) | sh1_0, sh1_1, sh1_2, sh2_0 (4th word reused by SH2) |
| sh2 | 4 (16B) | sh2_1..sh2_4 |
| sh3a | 4 (16B) | sh3_0..sh3_3 |
| sh3b | 4 (16B) | sh3_4..sh3_6 |

Each RGB coefficient: 8-bit magnitude per channel + 5-bit shared exponent + 3 sign bits = 4 bytes/coefficient.

## RAD LoD: geometric error, bounding volumes & coordinates

How `rad-to-3dtiles` builds a tile hierarchy that selects levels correctly in both
CesiumJS and 3DTilesRendererJS:

- **Geometric error = uniform per depth, anchored to a rendering-error proxy — then scaled to
  match renderer expectations.** *(This describes the original **`--ge-basis=featuresize`** approach,
  kept below for the design rationale. The undershoot noted at the end of this bullet is why the
  **default basis is now `spatial`** — `bboxDiag/∛splatCount` — instead; `featuresize` is opt-in
  legacy. See the RAD `geometricError` note in the
  [Design log](/docs/guide/streaming-architecture-design-log).)* Each tile records a feature size =
  `mean over splats of max(scaleₓ,scaleᵧ,scale_z) × 3` (≈ SparkJS BhattLod `featureSize`),
  then the builder collapses these to **one error per LoD level** (mean featureSize at each depth,
  forced strictly decreasing). This mirrors the
  [3DGS-PLY-3DTiles-Converter](https://github.com/WilliamLiu-1997/3DGS-PLY-3DTiles-Converter)
  model where all siblings at a level share one error so they **refine together**. Per-*node*
  errors vary within a level and make siblings pop in/out at different distances. Uniform per-depth
  fixes that.

  Two optional modifiers (both **default 1**, mirroring the
  [3DTiles-Inspector](https://github.com/WilliamLiu-1997/3DTiles-Inspector) sliders and the
  reference converter's `errorTargetLayerMultiplier`) can tune this:

  1. **Layer multiplier** (`--ge-layer`, default `1`): stretches the per-depth range —
     `GE(d) = leafGE + (GE(d) − leafGE) × geLayer`. `1` = natural halving, which is what the
     reference uses and what makes sibling levels refine together.
  2. **Global GE scale** (`--ge-scale`, default `1`): multiplies all GE values by a constant.

  **These default to 1** because the raw featureSize GE is already the right magnitude: Coit's root
  GE is ≈ 1.1, matching the [3DGS-PLY-3DTiles-Converter](https://github.com/WilliamLiu-1997/3DGS-PLY-3DTiles-Converter)
  reference's ≈ 2.07 for a comparable scene (verified by fetching its `tiling/geometric-error.js` and
  a rendered reference tileset). An earlier attempt set these to `16`/`8` — that over-inflated GE so
  every tile's SSE always exceeded the threshold, forcing **full-detail-everywhere refinement
  regardless of camera distance** (high-res tiles loading away from the camera focus, the whole scene
  rendering as dense spikes). That was a mis-calibration compensating for the half-opacity `lodOpacity`
  bug; with opacity fixed, raw GE is correct. If a scene under-refines, nudge `--ge-scale=2` (the
  reference sits ~2× our magnitude); values like `16` are far too high.
- **Bounding volumes are emitted in the Z-up tileset frame.** Bounds are computed from the glTF
  (Y-up) splat positions, but a 3D Tiles tile's `boundingVolume` lives in the tileset frame, which
  is Z-up — both CesiumJS and 3DTilesRendererJS rotate glTF content by `RX(+90°)` → `(x,y,z) →
  (x,−z,y)`. Emitting the box in the raw Y-up frame makes the boxes appear **rotated ~90° off the
  rendered splats** (the splats stand upright, the boxes lie down). The builder now rotates every
  box into Z-up (`yUpBoxToZUp`), so box centres coincide with the rendered splat centres. (The COPC
  writer already bakes this convention into its per-point swap; this brings the RAD path in line.)
- **Bounding volumes are nested bottom-up.** RAD's ~1.5-fanout octree plus the fact that splats
  are *shapes* (a merged parent splat can be smaller than a child covering spatial outliers)
  means per-node AABBs do **not** contain their children on their own. The builder expands each
  node's box to enclose all descendant boxes (`parent ⊇ children`), which both renderers require
  for correct frustum culling and screen-space-error refinement. (Before this fix, 56% of Coit
  parent→child pairs were non-nested, with children up to 14× larger than their parent.)
- **Root node RX(180°) transform corrects the inverted-up artifact.** After the glTF→tileset
  `RX(+90°)` that both renderers apply to GLB content, RAD splats appeared upside-down. A
  `root.transform = diag(1,−1,−1,1)` (column-major RX 180°) is written into the root tile only —
  children inherit it automatically per the 3D Tiles spec, so no intermediate or leaf nodes carry
  a transform. This is the correct place: intermediate/leaf transforms would fight the inherited
  value on each child's rendered position.
- **Native RAD coordinates, no global-centroid subtraction.** Splats keep their raw RAD frame —
  subtracting a float offset before int24 quantisation buys nothing (RAD scenes already sit near
  the origin) and only adds a lossy step. RAD has no per-node transforms, so all tiles share one
  frame; the single root transform above is sufficient to orient the content correctly.
- **`lodOpacity` must be applied — the cause of the "thin/spiky" artifact.** RAD stores its
  quantisation ranges and flags under `meta.splatEncoding` (per-chunk, mirrored from the root
  header), **not** `meta.encoding`. Reading the wrong key silently fell back to defaults, missing
  `lodOpacity: true`. SparkJS's `unpackSplat` does `opacity = stored/255; if (lodOpacity) opacity ×= 2`
  — i.e. RAD LoD files store **half** the real opacity. Without the ×2 every splat rendered at half
  opacity, so the large coarse splats could not blend and the sharp needle splats (scale anisotropy
  reaches 100–1000× on merged LoD representatives — legitimately needle-shaped) showed through as
  spikes. Sourcing `lnScaleMin/Max`/`lodOpacity` from `splatEncoding` fixes it (and is robust for RAD
  files whose ranges differ from the `−12…9` default). Note: the SPZ encoding itself was verified
  **byte-identical** to SparkJS's `SpzWriter` (positions int24/4096, alpha ×255, rgb via `SH_C0/0.15`,
  scales `(ln s + 10)×16`, v2 first-three rotations) — the bug was purely the missed opacity doubling
  in the RAD decode, not the SPZ storage.

Toggle **🪲 Debug tiles** in `viewer.html` to draw the tile bounding volumes coloured by octree
depth — CesiumJS via `debugShowBoundingVolume`/`debugColorizeTiles`, 3DTRJS via `DebugTilesPlugin`
(`displayBoxBounds` + `colorMode: DEPTH`). Useful for eyeballing nesting and LoD selection.

## Resources

- [Spark 2.0 blog post (with interactive demos)](https://www.worldlabs.ai/blog/spark-2.0)
- [Spark npm package](https://www.npmjs.com/package/@sparkjsdev/spark)
- [PackedSplats docs](https://sparkjs.dev/2.0.0-preview/docs/packed-splats/)
- [ExtSplats docs](https://sparkjs.dev/2.0.0-preview/docs/ext-splats/)
- sparkjsdev/spark#372 — "Expose JS API lod tree walker" (replies from `mrxz`, Spark collaborator)
- WilliamLiu-1997/3DGS-PLY-3DTiles-Converter#25 — RAD opacity & orientation
