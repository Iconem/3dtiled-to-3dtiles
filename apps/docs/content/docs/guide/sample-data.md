---
title: "Sample Data"
description: "curl -L https://wlt-ai-cdn.art/spark-2.0/rad/coit-40m-sh1-lod.rad -o coit.rad"
---

> This page covers the repo's own bundled/downloadable `sample-data/` source files (curl commands,
> local conversion) plus open-data 3D Tiles for exercising tileset-level tools. For what's wired
> directly into the **live viewer's** clickable preset pills, see
> [Live demo datasets](/docs/guide/live-demo-datasets).

### RAD (Gaussian Splat LoD)

```sh
# Coit Tower, San Francisco — SparkJS BhattLod, SH1, 50M splats (1.2 GB monolithic)
curl -L https://wlt-ai-cdn.art/spark-2.0/rad/coit-40m-sh1-lod.rad -o coit.rad

# Jin-Ai-Machi — streaming manifest only (88 KB header, ~1.1 GB data fetched on demand)
curl -L https://cdn.lilea.net/spark/jinaimachi/jinaimachi-lod.rad -o jinaimachi.rad

# Tastier RAD 500K splats
curl -L https://wlt-ai-cdn.art/tastier_rad_500/0524c1a1-abf2-4969-ae40-9981ee836536_500k-lod.rad -o tastier500k.rad
```

> **RAD format note**: A `.rad` file can be either **monolithic** (all chunk data embedded) or
> a **streaming manifest** (88 KB JSON header only; chunk data fetched on demand via HTTP range
> requests). The converter detects streaming manifests and exits with a clear error — download
> the full monolithic file to convert. Run `node scripts/dump-rad-header.js <file.rad>` to inspect.

### Streamed SOG (PlayCanvas LOD)

PlayCanvas example datasets (download the whole tree with `sog-to-3dtiles/scripts/fetch-sog.mjs`):

```sh
cd packages/sog-to-3dtiles
# Skatepark — 20 chunks, 4 LOD levels (~160 files)
node scripts/fetch-sog.mjs https://code.playcanvas.com/examples_data/example_skatepark_02/ ../sample-data/input/sog/skatepark
# Roman Parish — 131 chunks, 7 LOD levels (~790 files)
node scripts/fetch-sog.mjs https://code.playcanvas.com/examples_data/example_roman_parish_02/ ../sample-data/input/sog/roman-parish
# then convert:
node src/index.js ../sample-data/input/sog/skatepark ../sample-data/output/sog/skatepark-3dtiles-from-sog
```

Both are wired into the viewer preset bar (**⬢ Skatepark / Roman Parish (SOG)**) and the inspector
(`cd tools-inspector && npm run inspect:skatepark` / `inspect:roman-parish`).

### COPC (LiDAR Point Cloud)

```sh
# Autzen Stadium, Oregon — classified, 10.6M pts (77 MB). Well-known test file.
curl -L "https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz" -o autzen.copc.laz

# USGS 3DEP Texas Coast 2018 — 50 cm density (154 MB)
curl -L "https://data.opengeos.org/USGS_LPC_TX_CoastalRegion_2018_A18_stratmap18-50cm-2995201a1.copc.laz" -o texas.copc.laz
# Online viewer: https://lidar-viewer.gishub.org/?url=https%3A%2F%2Fdata.opengeos.org%2FUSGS_LPC_TX_CoastalRegion_2018_A18_stratmap18-50cm-2995201a1.copc.laz

# IGN LiDAR HD — Tour Eiffel / Paris area, tile LHD_FXX_0648_6863 (France, 100 MB)
curl -L "https://data.geopf.fr/telechargement/download/LiDARHD-NUALID/NUALHD_1-0__LAZ_LAMB93_KE_2025-06-06/LHD_FXX_0648_6863_PTS_LAMB93_IGN69.copc.laz" -o eiffel.copc.laz

# USGS 3DEP — New Jersey tile (requires SAS token or STAC browser)
# https://usgslidareuwest.blob.core.windows.net/usgs-3dep-copc/usgs-copc/USGS_Lidar_Point_Cloud_NJ_SdL5_2014_LAS_2015/copc/18TWL805090.copc.laz
```

**Online COPC viewers** (inspect before converting):
- [viewer.copc.io](https://viewer.copc.io) — drag-drop or paste URL
- [lidar-viewer.gishub.org](https://lidar-viewer.gishub.org) — drag-drop or paste URL

**More COPC sources:**
- **IGN France** — https://cartes.gouv.fr/telechargement/IGNF_NUAGES-DE-POINTS-LIDAR-HD
  Full national LiDAR HD coverage at 10 pts/m². Search tile ID (e.g. `LHD_FXX_0648_6863`).
- **USGS 3DEP STAC** — https://planetarycomputer.microsoft.com/api/stac/v1/collections/3dep-lidar-copc
  Browser: https://radiantearth.github.io/stac-browser/#/external/planetarycomputer.microsoft.com/api/stac/v1/collections/3dep-lidar-copc

---

## Open-Data 3D Tiles sample datasets

Two public repositories provide ready-to-use OGC 3D Tiles datasets for testing converters,
viewers, and tools — as opposed to the bundled non-3D-Tiles source data above, these are already 3D
Tiles, useful for exercising the `implicit-to-explicit` / `upgrade` tileset-level tools. Both are used
by this project's **Tools** mode in the viewer.

### bertt/cesium_3dtiles_samples

<https://github.com/bertt/cesium_3dtiles_samples>

Hosted at `https://bertt.github.io/cesium_3dtiles_samples/samples/`.

| Dataset | URL path | Scheme | Version | Tile format | Notes |
|---------|----------|--------|---------|-------------|-------|
| Utrecht 3D | `utrecht3d/` | QUADTREE implicit | 1.0 | `.b3dm` | pg2b3dm 1.2, no `availableLevels` |
| Delaware 1.1 | `1.1/delaware/` | QUADTREE implicit | 1.1 | `.glb` | `EXT_structural_metadata`, `EXT_mesh_features` |
| Grenoble Trees | `1.1/grenoble_trees/` | QUADTREE implicit | 1.1 | `.glb` | 31K trees, `EXT_mesh_gpu_instancing`, `EXT_instance_features`, `EXT_structural_metadata` |
| Trees (i3dm) | `1.1/trees/` | QUADTREE implicit | 1.1 | `.i3dm`/`.cmpt` | ⚠ i3dm/cmpt not yet converted by this project |

#### Utrecht 3D

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

#### Delaware 1.1

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

### CesiumGS/3d-tiles-samples

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

### Other open datasets used in this project

| Dataset | URL | Format | Used as |
|---------|-----|--------|---------|
| Lille photomesh | `https://webimaging.lillemetropole.fr/externe/maillage/2016_mel_10cm/3dtiles/pyramid/tileset.json` | 3D Tiles 1.0 explicit, `.b3dm` | `upgrade` tool demo |
| Strasbourg photomesh | `https://s3.eu-west-2.wasabisys.com/ems-sgct-photomaillage/ODACIT/EMS_PM2022/tileset.json` | 3D Tiles | DIRECT preset |
| Clermont-Ferrand | `https://3d.craig.fr/datasets/Clermont/3dtiles/tileset.json` | 3D Tiles | DIRECT preset |

#### Lille pyramid tileset

```
tileset.json: asset.version = "1.0"
Explicit tree (no implicitTiling)
Tile content: *.b3dm  (Batched 3D Model, 3D Tiles 1.0)
```

- Large photogrammetry mesh of Lille, France (10 cm resolution).
- Use the `upgrade` tool to serve b3dm tiles as GLB on-demand without pre-converting.
- The `pyramid/` subdirectory is a sub-tileset of the full dataset.

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

---

For the datasets this repo's own converters read *from* (COPC/Potree/SOG/RAD/LCC/I3S sources, not
already-3D-Tiles), see the sections above. For a tour of what's wired into the live viewer's preset
pills specifically (including these same open-data 3D Tiles as its DIRECT presets), see
[Live demo datasets](/docs/guide/live-demo-datasets).
