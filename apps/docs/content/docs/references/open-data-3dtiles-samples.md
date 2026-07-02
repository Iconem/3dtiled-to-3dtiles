---
title: "Open-Data 3D Tiles Sample Datasets"
description: "Two public repositories provide ready-to-use OGC 3D Tiles datasets for testing converters,"
---

Two public repositories provide ready-to-use OGC 3D Tiles datasets for testing converters,
viewers, and tools. Both are used by this project's **Tools** mode in the viewer.

---

## bertt/cesium_3dtiles_samples

<https://github.com/bertt/cesium_3dtiles_samples>

Hosted at `https://bertt.github.io/cesium_3dtiles_samples/samples/`.

| Dataset | URL path | Scheme | Version | Tile format | Notes |
|---------|----------|--------|---------|-------------|-------|
| Utrecht 3D | `utrecht3d/` | QUADTREE implicit | 1.0 | `.b3dm` | pg2b3dm 1.2, no `availableLevels` |
| Delaware 1.1 | `1.1/delaware/` | QUADTREE implicit | 1.1 | `.glb` | `EXT_structural_metadata`, `EXT_mesh_features` |
| Grenoble Trees | `1.1/grenoble_trees/` | QUADTREE implicit | 1.1 | `.glb` | 31K trees, `EXT_mesh_gpu_instancing`, `EXT_instance_features`, `EXT_structural_metadata` |
| Trees (i3dm) | `1.1/trees/` | QUADTREE implicit | 1.1 | `.i3dm`/`.cmpt` | ⚠ i3dm/cmpt not yet converted by this project |

### Utrecht 3D

```
tileset.json: asset.version = "1.0"
root.implicitTiling:
  subdivisionScheme: QUADTREE
  subtreeLevels: 7
  subtrees.uri: subtrees/{level}_{x}_{y}.subtree   ← underscore separator
root.content.uri: content/{level}_{x}_{y}.b3dm
```

- Implicit 1.0 QUADTREE with b3dm tiles — requires **both** `implicit-to-explicit` (to unroll the
  quadtree into an explicit children tree) and b3dm→glb conversion per tile.
- The `/3dtiles-tools?tool=implicit-to-explicit` endpoint handles both in one pass: builds the
  explicit tree, then converts b3dm→glb on each tile request.
- No `availableLevels` in the tileset — the server walks subtrees until no child subtrees are found.

### Delaware 1.1

```
tileset.json: asset.version = "1.1"
root.implicitTiling:
  subdivisionScheme: QUADTREE
  subtreeLevels: 3
  availableLevels: 4
  subtrees.uri: subtrees/{level}_{x}_{y}.subtree
root.content.uri: content/{level}_{x}_{y}.glb
```

- Fully spec-compliant 3D Tiles 1.1 QUADTREE implicit tileset with `.glb` tiles.
- `implicit-to-explicit` unrolls to an explicit tree; tiles are proxied as-is (already GLB).

---

## CesiumGS/3d-tiles-samples

<https://github.com/CesiumGS/3d-tiles-samples>

Hosted at `https://raw.githubusercontent.com/CesiumGS/3d-tiles-samples/main/1.1/`.

Comprehensive reference samples for all 3D Tiles 1.1 features:

| Directory | Features |
|-----------|----------|
| `TilesetWithDiscreteLOD/` | Explicit tree, mesh LOD |
| `TilesetWithTreeBillboards/` | Point instancing |
| `TilesetWithRequestVolume/` | Request volumes |
| `TilesetWithMultipleContents/` | Multiple contents per tile |
| `TilesetWithVariousMetadata/` | Metadata schemas |
| `SparseImplicitQuadtree/` | QUADTREE implicit, sparse, `{"constant":0}` availability |
| `SparseImplicitOctree/` | OCTREE implicit, sparse — good test for 3D (x/y/z) Morton decode |

The `SparseImplicit*` samples are the canonical correctness tests for `implicit-to-explicit`:
they exercise `{"constant": 0}` / `{"constant": 1}` sparse availability and cover both
Morton-2D (QUADTREE) and Morton-3D (OCTREE) decode paths.

`SparseImplicitOctree` URL:
`https://raw.githubusercontent.com/CesiumGS/3d-tiles-samples/main/1.1/SparseImplicitOctree/tileset.json`

---

## Other open datasets used in this project

| Dataset | URL | Format | Used as |
|---------|-----|--------|---------|
| Lille photomesh | `https://webimaging.lillemetropole.fr/externe/maillage/2016_mel_10cm/3dtiles/pyramid/tileset.json` | 3D Tiles 1.0 explicit, `.b3dm` | `upgrade` tool demo |
| Strasbourg photomesh | `https://s3.eu-west-2.wasabisys.com/ems-sgct-photomaillage/ODACIT/EMS_PM2022/tileset.json` | 3D Tiles | DIRECT preset |
| Clermont-Ferrand | `https://3d.craig.fr/datasets/Clermont/3dtiles/tileset.json` | 3D Tiles | DIRECT preset |

### Lille pyramid tileset

```
tileset.json: asset.version = "1.0"
Explicit tree (no implicitTiling)
Tile content: *.b3dm  (Batched 3D Model, 3D Tiles 1.0)
```

- Large photogrammetry mesh of Lille, France (10 cm resolution).
- Use the `upgrade` tool to serve b3dm tiles as GLB on-demand without pre-converting.
- The `pyramid/` subdirectory is a sub-tileset of the full dataset.

---

## Notes on QUADTREE vs OCTREE

The `implicit-to-explicit` tool in this project supports both:

| Scheme | Children/node | Morton | Key format | Bounding volume |
|--------|--------------|--------|------------|-----------------|
| OCTREE | 8 | 3D (x,y,z interleaved) | `level-x-y-z` | `box` |
| QUADTREE | 4 | 2D (x,y interleaved) | `level-x-y-0` | `region` (lon/lat) |

Geographic datasets (lon/lat CRS) use QUADTREE + `region` bounding volumes. Local-frame
datasets (COPC, Potree) use OCTREE + `box` bounding volumes.

QUADTREE subtree URI templates from pg2b3dm use underscore separators:
`subtrees/{level}_{x}_{y}.subtree` — the tool handles both `_` and `/` separators.
