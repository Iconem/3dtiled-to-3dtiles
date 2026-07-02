---
title: "Streaming 3DGS worlds on the web — Spark 2.0"
description: "A technical deep dive into Spark 2.0's streamable, Level-of-Detail system for 3D Gaussian Splatting."
---

> Source: https://www.worldlabs.ai/blog/spark-2.0
> Published: April 14, 2026
> Author: World Labs / Spark team

A technical deep dive into Spark 2.0's streamable, Level-of-Detail system for 3D Gaussian Splatting.

---

## Overview

Spark is a dynamic 3D Gaussian Splatting (3DGS) renderer built for the web, integrating with THREE.js and WebGL2. Spark 2.0 adds a Level-of-Detail (LoD) system that can stream and render huge 3DGS worlds on any device.

> Note: This document is a text summary. For the interactive demos and images visit the original post at https://www.worldlabs.ai/blog/spark-2.0

---

## Three Core Techniques

Spark 2.0 employs three techniques to address scaling challenges:

1. **Level-of-Detail** — Preparing lower-resolution versions of the splats, calculating which subset to render for the camera viewpoint. Renders fewer splats when they're too far away, improving performance.
2. **Progressive Streaming** — Loading 3DGS details coarse-to-fine as data is downloaded, prioritizing data that best resolves details depending on camera position.
3. **Virtual Memory** — Fixed GPU memory pool for a splat page table that automatically swaps in and out chunks of 3DGS data as needed, giving access to huge pools of splats across multiple objects.

---

## Level-of-Detail (LoD)

### LoD Splat Tree

Spark's LoD design is a **continuous LoD method** where all splats exist in a hierarchy — an LoD splat tree. Each internal tree node is a lower-resolution version of its children, formed by merging the splats into a new one that approximates the shape and color of the child splats. This continues up to the root, a single large splat representing the aggregate of all splats.

Using this tree, Spark computes "slices" that select the best set of splats to render for the current viewport, maintaining a constant splat budget (500K–2.5M depending on device type) for steady high frame rates.

### LoD Tree Traversal Algorithm

Spark computes the best subset in O(N) time where N is the rendered splat budget, using a priority queue:

1. From root splat r₀, compute screen dimension d₀, insert into priority queue.
2. Pop maximum-sized splat rₘ from queue. If d < 1 pixel or rₘ is a leaf, add to output set.
3. If replacing rₘ with its children would exceed budget N, move all remaining queue splats to output and stop.
4. Otherwise, insert each child into queue with its screen dimension. Repeat step 2.

Implemented in Rust compiled to WebAssembly, running in a background Web Worker so LoD updates don't impact the main render loop.

### Foveated Rendering

Spark adjusts the LoD splat screen dimension by a foveation scale factor f(v̂) that varies as a function of splat view direction:

- **coneFov0** — Cone around view direction with full resolution
- **coneFov** — Larger cone with reduced detail  
- **coneFoveate** — Foveation scale at edge of coneFov (e.g., 10 = 10× larger splats)
- **behindFoveate** — Foveation scale behind the camera

### Generating LoD Trees

Two algorithms:
- **Tiny-LoD** — Quick, compact, used on-demand in browser (LoD base β ≈ 1.75)
- **Bhatt-LoD** — Higher quality offline using Bhattacharyya distance for merging (produces ~30-40% larger than input)

Bhatt-LoD names come from Bhattacharyya distance — measures statistical overlap between two 3DGS shapes. Pairs splats by shape + color similarity metric.

---

## Progressive Streaming & .RAD File Format

### Problems with Existing Formats

- **.PLY** — Row-order, uncompressed float32. 10M splats with SH0..3 = ~2.3 GB. Can be progressively loaded but huge.
- **.SPZ** — Column-order, quantized, GZ-compressed. 10M splats ≈ 200–250 MB. Cannot be progressively loaded (must receive entire file first).

### .RAD File Format

Goals: compressed, streamable, extensible, selectable precision, random access.

**Structure:**
```
[RAD0 magic 4B][uint32 jsonLen][JSON metadata][pad to 8B]
[RADC chunk 0][RADC chunk 1]...
```

The JSON header contains offsets and byte sizes of all chunks, enabling random-order fetching. Each RADC chunk:
```
[RADC magic 4B][uint32 jsonLen][JSON][pad to 8B][uint64 payloadBytes][payload]
```

Splat properties stored column-order with customizable encodings per property. Each property compressed with **raw DEFLATE** (miniz_oxide `compress_to_vec` → `decompress_to_vec`, no gzip header).

**Key encoding:** `f32_lebytes` (center) uses byte-plane interleaving: all byte-0s of all floats first, then byte-1s, etc. — improves compression ratio significantly.

### Spatially Partitioned Chunks

Chunks are filled with spatially co-located splats from largest to smallest within 64K blocks:
- Chunk 0: Largest 64K splats (root + first level children), coarse global view
- Subsequent chunks: Spatial AABB subdivisions, increasingly fine detail

Spark streams by loading chunk 0 first, then fetching chunks based on camera viewpoint priority using 3 parallel Web Workers.

### Streaming Manifest vs Monolithic

A `.rad` file can be either:
- **Monolithic** — All chunk data embedded (e.g., `coit-40m-sh1-lod.rad` at 1.2 GB)
- **Streaming index** — Header only with remote chunk offsets (e.g., `jinaimachi-lod.rad` at 88 KB header, 1.1 GB data fetched on demand)

---

## Virtual Memory

Spark allocates a fixed pool of 16M splats on the GPU and automatically manages mappings between 64K splat GPU "pages" and virtual 64K chunks of .RAD files.

- Chunks loaded into empty pages based on LoD traversal ordering
- Chunks evicted LRU when page table full and priority is lower
- Multiple .RAD files share same page table
- Global priority ordering across all files and chunks

---

## PackedSplats vs ExtSplats

The `.RAD` file format is **receiver-agnostic** — it can be decoded into either:

### PackedSplats (16 bytes/splat)
- `center.xyz` — float16 (3 × 2B)
- `RGBA` — 4 × uint8
- `scale.xyz` — 3 × uint8 (log-encoded, e^-12 to e^9)
- `quaternion` — oct88 (2 × uint8) + angle uint8

### ExtSplats (32 bytes/splat, Spark 2.0 preview)
- `center.xyz` — float32 (3 × 4B) — higher precision
- `opacity` — float16 (2B)
- `color.rgb` — 3 × float16 (6B)
- `ln(scale.xyz)` — 3 × float16 (6B)
- `quaternion` — packed oct+angle (10/10/12 bits, 4B)

### RAD encoding vs in-memory format

A `.rad` file with `f32_lebytes` center + `f16` alpha uses higher storage precision, but decodes into whichever format you instantiate:
```js
// Decode into PackedSplats (16B/splat, f16 center in memory)
const packed = new PackedSplats({ url: 'scene.rad' });

// Decode into ExtSplats (32B/splat, f32 center in memory)  
const ext = new ExtSplats({ url: 'scene.rad' });
```

The BhattLod `.rad` files (like `coit-40m-sh1-lod.rad`) use:
- `center: f32_lebytes` — storage precision higher than PackedSplats f16
- `alpha: f16` — matches ExtSplats
- `scales: ln_0r8` — uint8 log scale matching PackedSplats range
- `rgb: r8_delta` — uint8 delta-encoded, matching PackedSplats
- `orientation: oct88r8` — shared by both

**Bottom line**: The `.rad` format stores splats at the precision needed for the LoD tree, then the runtime converts to whatever in-memory format you request (PackedSplats or ExtSplats).

---

## Resources

- [Spark 2.0 blog post (with interactive demos)](https://www.worldlabs.ai/blog/spark-2.0)
- [Spark npm package](https://www.npmjs.com/package/@sparkjsdev/spark)
- [PackedSplats docs](https://sparkjs.dev/2.0.0-preview/docs/packed-splats/)
- [ExtSplats docs](https://sparkjs.dev/2.0.0-preview/docs/ext-splats/)
