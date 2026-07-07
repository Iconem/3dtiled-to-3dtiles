---
title: "Sample Data"
description: "curl -L https://wlt-ai-cdn.art/spark-2.0/rad/coit-40m-sh1-lod.rad -o coit.rad"
---

> This page covers the repo's own bundled/downloadable `sample-data/` source files (curl commands,
> local conversion) plus open-data 3D Tiles for exercising tileset-level tools. For what's wired
> directly into the **live viewer's** clickable preset pills, see
> [Live demo datasets](/docs/guide/viewer#live-demo-datasets--whats-behind-each-viewer-pill).

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

### I3S (Esri SceneServer / SLPK)

**I3S open-data samples** (beyond `Buildings_NewYork_v18.slpk`, mesh-only) — SLPK + hosted-service
pairs for both integrated mesh and point-cloud layers, from Esri's own [`i3s-spec` sample data
readme](https://github.com/Esri/i3s-spec/blob/master/docs/2.1/pcsl_ReadMe.md), the [ArcGIS JS SDK
3D-object sample gallery](https://developers.arcgis.com/javascript/latest/sample-code/?tagged=3dobject),
and the [ArcGIS 3D Tiles samples experience](https://experience.arcgis.com/experience/e2e1e497d13b41cab368c894fd9b3df7)
(ArcGIS portal items — open each `item.html` link and use its "Download" button for the SLPK, or the
REST service URL directly for streaming). All four verified live against `/stream?format=i3s`:
- Integrated mesh (**works, fully textured**) — SLPK: [item `95a427c7a6ec4789b03c1a177366b54c`](https://3dcities.maps.arcgis.com/home/item.html?id=95a427c7a6ec4789b03c1a177366b54c) (`Rancho_Mesh_v18.slpk`, 285 MB) · service: [item `01eff699c8404a27a65e0877201136b4`](https://3dcities.maps.arcgis.com/home/item.html?id=01eff699c8404a27a65e0877201136b4) → `https://tiles.arcgis.com/tiles/z2tnIkrLQ2BRzr6P/arcgis/rest/services/Rancho_Mesh_v18/SceneServer`. The SLPK link is ArcGIS Online's own download endpoint (`.../content/items/<id>/data`) — no `.slpk` anywhere in the URL (only in a `Content-Disposition` header), which the adapter didn't originally detect as an archive at all; both this and the texture support were fixed 2026-07-02, verified byte-identical (same JPEG at the same buffer offset) against both the SLPK and the SceneServer URL for the same underlying dataset.
- Point cloud (**LEPCC-compressed — now decoded, both work**) — SLPK: [item `496552d059644b4892c51ad06bdba8e2`](https://www.arcgis.com/home/item.html?id=496552d059644b4892c51ad06bdba8e2) (`Moro_Bay_LiDAR.slpk`, 578 MB, 2,624 tiles) · service: [item `908d6b986f314d51b1ff50b3bc321dfd`](https://www.arcgis.com/home/item.html?id=908d6b986f314d51b1ff50b3bc321dfd) → `https://tiles.arcgis.com/tiles/z2tnIkrLQ2BRzr6P/arcgis/rest/services/Moro_Bay_LiDAR/SceneServer` (13,775 tiles). Position decodes correctly (checksum + extent-verified); RGB doesn't render yet — it's a separate LEPCC blob type not yet ported, and this specific dataset's `RGB` attribute resource 404s server-side anyway despite being advertised in its schema. A second point-cloud sample (item `fc3f4a4919394808830cd11df4631a54`, `BARNEGAT_BAY_LiDAR_UTM`) is also LEPCC — every real ArcGIS point-cloud SceneServer sample found so far uses it, since it's Esri's own default point-cloud codec.
- **Live ArcGIS SceneServer REST support added** (2026-07-02) to test the "service" URLs above directly
  (previously the adapter only read a static `3dSceneLayer.json`/SLPK tree, not the REST API's
  `?f=json`-based resource paths) — see `arcgisSceneServerReader()` in `i3s-live.js`.
- Also referenced: portal item `fc3f4a4919394808830cd11df4631a54` (point cloud) and `001bb7ee3ce44ae5a8a15bef72f4404a` (integrated mesh) — not yet run against `i3s-to-3dtiles`/`/stream?format=i3s`, listed here as further samples to pull in.

---

## Open-Data 3D Tiles sample datasets

Cesium and partner organizations, plus a handful of public repositories, provide ready-to-use OGC
3D Tiles datasets for testing converters, viewers, and tools — as opposed to the bundled
non-3D-Tiles source data above, these are already 3D Tiles, useful for exercising the
`implicit-to-explicit` / `upgrade` tileset-level tools. Several are used by this project's
**Tools** mode in the viewer.

**CesiumGS open data (Ion)** — https://cesium.com/platform/cesium-ion/content/
- Assets marked "open data" are publicly accessible with any Ion account token.
- Examples: Google Photorealistic 3D Tiles (assetId 2275207), Bing Imagery basemap.

**More public 3D Tiles / 3DGS / OSM-3D endpoints** — see the curated list in
[blosm#498](https://github.com/vvoovv/blosm/issues/498) (3D Tiles + Gaussian-splat + city-model sources).

**Esri I3S samples (for `i3s-to-3dtiles`)** — [loaders.gl I3S test data](https://github.com/visgl/loaders.gl/tree/master/modules/i3s/test/data)
has both `.slpk` packages and **raw REST/file-server layouts** (`3dSceneLayer.json` + `nodepages/` + `nodes/`
trees on disk — the converter reads those directly, no unzip). Mix of `3DObject`/`IntegratedMesh` (mesh),
`PointCloud`, and Draco-compressed layers (Draco/LEPCC are gated out). Local samples live in
`sample-data/input/I3S-SLPK/` (NYC buildings mesh ✓, Autzen point cloud → LEPCC, gated).

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

Hosted at `https://raw.githubusercontent.com/CesiumGS/3d-tiles-samples/main/1.1/`
(raw GitHub, CORS-friendly, verified 200) — comprehensive reference samples for all 3D Tiles 1.1
features:

| Directory | Features |
|-----------|----------|
| `TilesetWithDiscreteLOD/` | Explicit tree, mesh LOD |
| `TilesetWithTreeBillboards/` | Point instancing |
| `TilesetWithRequestVolume/` | Request volumes (also: mesh + point cloud, `1.0/TilesetWithRequestVolume/`) |
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

All three city mesh tilesets below use RGF93/Lambert-93 or WGS84 coordinates and are served with
CORS — they work in `viewer.html` via the built-in city mesh presets.

| Dataset | URL | Format | Used as |
|---------|-----|--------|---------|
| Lille photomesh | `https://webimaging.lillemetropole.fr/externe/maillage/2016_mel_10cm/3dtiles/pyramid/tileset.json` | 3D Tiles 1.0 explicit, `.b3dm` | `upgrade` tool demo |
| Strasbourg Od@CiT | `https://s3.eu-west-2.wasabisys.com/ems-sgct-photomaillage/ODACIT/EMS_PM2022/tileset.json` | 3D Tiles 1.0, explicit tiling, **REPLACE**, b3dm photogrammetry mesh | DIRECT preset |
| Clermont-Ferrand (CRAIG) | `https://3d.craig.fr/datasets/Clermont/3dtiles/tileset.json` | 3D Tiles 1.0, explicit, **REPLACE**, b3dm | DIRECT preset |
| Lille Métropole | `https://webimaging.lillemetropole.fr/externe/maillage/2016_mel_10cm/3dtiles/tileset.json` | 3D Tiles 1.0, explicit, **REPLACE**, b3dm | DIRECT preset |

#### Lille pyramid tileset

```
tileset.json: asset.version = "1.0"
Explicit tree (no implicitTiling)
Tile content: *.b3dm  (Batched 3D Model, 3D Tiles 1.0)
```

- Large photogrammetry mesh of Lille, France (10 cm resolution).
- Use the `upgrade` tool to serve b3dm tiles as GLB on-demand without pre-converting.
- The `pyramid/` subdirectory is a sub-tileset of the full dataset.

---

For the datasets this repo's own converters read *from* (COPC/Potree/SOG/RAD/LCC/I3S sources, not
already-3D-Tiles), see the sections above. For a tour of what's wired into the live viewer's preset
pills specifically (including these same open-data 3D Tiles as its DIRECT presets), see
[Live demo datasets](/docs/guide/viewer#live-demo-datasets--whats-behind-each-viewer-pill).
