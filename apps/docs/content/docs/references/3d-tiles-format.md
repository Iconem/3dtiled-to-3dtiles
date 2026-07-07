---
title: "3D Tiles format"
description: "OGC standard for streaming massive 3D geospatial datasets. A tileset consists of a tileset.json describing a spatial hierarchy of tiles."
---

**3D Tiles 1.1** — OGC standard for streaming massive 3D geospatial datasets. A tileset consists
of a `tileset.json` describing a spatial hierarchy of tiles, each referencing a GLB/B3DM/PNTS
payload. Version 1.1 adds implicit tiling (OCTREE/QUADTREE subdivision schemes with binary
subtree files), metadata schemas, and new glTF extensions including `KHR_gaussian_splatting`.
Tiles can carry a `transform` (column-major 4×4) to place them in any coordinate system —
ECEF (EPSG:4978) is conventional for globe viewers but not required.

### REPLACE vs ADD refinement

3D Tiles tilesets declare how children relate to their parent via the `refine` field:

- **`REPLACE`** — when a child tile loads, the parent is discarded. Each level of detail fully
  replaces the previous. Used by photogrammetry meshes (b3dm), Gaussian splat LoDs (RAD), and
  most point cloud viewers. Visual quality improves as finer tiles load; no double-drawing.

- **`ADD`** — children are *added on top of* the parent; the parent is never hidden. Each level
  independently contributes content. Used by COPC point clouds because every node holds a
  disjoint subset of points — hiding the parent would lose points that are only in that node.
  The total visible point count grows as finer tiles load.

Viewers must implement both correctly. A REPLACE tileset rendered as ADD would show every LoD
layer simultaneously (ghosting / double-draw). An ADD tileset rendered as REPLACE would hide
coarser nodes that contain unique points.

### Notes on QUADTREE vs OCTREE

The `implicit-to-explicit` tool in this project supports both:

| Scheme | Children/node | Morton | Key format | Bounding volume |
|--------|--------------|--------|------------|-----------------|
| OCTREE | 8 | 3D (x,y,z interleaved) | `level-x-y-z` | `box` |
| QUADTREE | 4 | 2D (x,y interleaved) | `level-x-y-0` | `region` (lon/lat) |

Geographic datasets (lon/lat CRS) use QUADTREE + `region` bounding volumes. Local-frame
datasets (COPC, Potree) use OCTREE + `box` bounding volumes.

QUADTREE subtree URI templates from pg2b3dm use underscore separators:
`subtrees/{level}_{x}_{y}.subtree` — the tool handles both `_` and `/` separators.
