---
title: "Sample Data"
description: "curl -L https://wlt-ai-cdn.art/spark-2.0/rad/coit-40m-sh1-lod.rad -o coit.rad"
---

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
