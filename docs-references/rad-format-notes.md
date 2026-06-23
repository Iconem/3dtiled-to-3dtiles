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

## Why RAD has no `/stream` range adapter

A 3D-Tiles tileset needs **per-tile spatial bounds** to emit the tree. RAD persists **neither** tile
bounds **nor** a spatial tile partition. So you cannot build the hierarchy by reading metadata alone —
you must decode splats to compute bounds. That is exactly what `/convert` (preprocess+cache) does, so a
dedicated streaming adapter would do the same decode work with **no** benefit. → **RAD is served by
`/convert`.** (Contrast COPC/Potree/SOG, which persist bounds and stream cleanly.)

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
