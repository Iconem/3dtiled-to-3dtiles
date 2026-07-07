---
title: "Streamed SOG — (Playcanvas Supersplat)"
description: "Streamed SOG splits a Gaussian splat scene into spatial chunks at multiple LoDs"
---

> Source: https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/streamed-sog/
> Version covered: 1

Streamed SOG splits a Gaussian splat scene into spatial chunks at multiple **levels of
detail (LOD)**. A viewer walks a binary spatial tree to decide which chunks/levels to load
for the current camera, so very large scenes (tens of millions of Gaussians) stream
progressively. Authored with [SplatTransform](https://github.com/playcanvas/splat-transform)
(`--generate-lod` / "Generating Streamed SOG"). Each chunk is a standard unbundled [SOG](sog.md).

This is the structure `sog-to-3dtiles` consumes — it maps almost 1:1 onto an OGC 3D Tiles
HLOD tree (each node already carries an AABB; leaves carry per-LOD splat ranges).

---

## File set
```
scene/
├── lod-meta.json     # index: scene info + spatial tree (THE entry point)
├── 0_0/  meta.json + *.webp   # LOD 0 (finest), chunk 0 — unbundled SOG
├── 1_0/  …                    # LOD 1 (coarser), chunk 0
├── …                          # one dir per {lod}_{chunk}
└── env/  meta.json + *.webp   # optional environment (far-field, e.g. sky)
```
- The index is **always** `lod-meta.json` — loaders identify the format by this filename.
- Resolve chunk locations through the `filenames` array, **not** the `{lod}_{chunk}` naming.
- All paths in `lod-meta.json` are relative to its directory.

---

## lod-meta.json
```ts
interface LodMeta {
  version: 1;
  asset?:   { generator?: string };
  count:    number;     // total gaussians across all LODs (excludes environment)
  counts:   number[];   // gaussians per LOD level (index = level)
  lodLevels: number;
  environment?: string; // relative path to env SOG meta.json; omitted/null if none
  filenames: string[];  // chunk SOG meta.json paths, referenced by index
  tree: Node;
}
interface Node {
  bound: { min:[number,number,number]; max:[number,number,number] };  // AABB
  children?: [Node, Node];   // interior node — exactly two
  lods?: {                   // leaf node — map of LOD level → splat range
    [level: string]: { file: number; offset: number; count: number };
  };
}
```

## Spatial tree
- Binary subdivision. A node is **interior** (`children`, exactly 2) or **leaf** (`lods`) — never both.
- Leaf `bound` encloses each Gaussian's *rotated, scaled ellipsoid* extent (not just centers).
- Interior `bound` = union of children. Bounds are in the **same frame as the chunk splat positions**.

### LOD levels
- Level `0` = **highest detail**; higher levels are progressively coarser.
- A leaf's `lods` is keyed by decimal strings `"0".."lodLevels-1"`; a missing key = no splats at that level.
- All levels of a leaf cover the **same region** — a viewer picks exactly one per leaf (e.g. by distance).

### Chunk references
- `file` indexes `filenames`. `offset`/`count` select splats `[offset, offset+count)` in the chunk's
  storage order (splat indices, not bytes; pixel `(i%W, floor(i/W))`).
- A chunk's contents = concatenation of the leaf runs that reference it (non-overlapping, complete).
  Within a run, splats are Morton-sorted. **A chunk only ever holds splats of a single LOD level.**

## Environment
Optional `environment` → unbundled SOG of far-field splats outside the LOD scheme. A viewer
**should** render it unconditionally.

## Precision & versioning
- Non-integer `lod-meta.json` numbers are quantized to 7 significant digits (~float32).
- `version: 1`; reject greater major versions. Pre-versioned files omit `version`/`asset`/`count`/`counts`
  and may have `"environment": null`. Ignore unknown fields.

---

## Mapping to 3D Tiles (this repo's `sog-to-3dtiles`)
- Interior SOG node → empty 3D Tiles tile (boundingVolume from `bound`, children = its two subtrees).
- Leaf SOG node → a **vertical chain** of tiles, coarsest LOD (highest level) as ancestor down to
  level 0 (finest), `refine: REPLACE`, each tile's content = the decoded `[offset,count)` run from
  its chunk SOG, re-encoded as an SPZ-v2 GLB (`KHR_gaussian_splatting` + `_compression_spz_2`).
- Bounds are emitted in the Z-up tileset frame (SOG is Y-up) — same `RX(+90°)` convention as the
  RAD path. geometricError decreases with LOD level so a viewer refines the chain by distance.

## References
- Streamed SOG spec: https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/streamed-sog/
- SOG chunk format: [sog.md](sog.md)
- SplatTransform: https://github.com/playcanvas/splat-transform
