---
title: "Live demo datasets — what's behind each viewer pill"
description: "The viewer's top-bar preset pills (COPC, Potree, SOG, LCC, GeoSplats, RAD, 3D Tiles, Packages, I3S, 3MX, Bing) each carry one or more named, clickable datasets. This page documents exactly what each one is and where it comes from."
---

The viewer's top-bar preset pills (COPC, Potree, SOG, LCC, GeoSplats, RAD, 3D Tiles, Packages, I3S,
3MX, Bing) each carry one or more named, clickable datasets, defined in `apps/viewer/src/lib/formats.ts`.
This page documents exactly what each one is and where it comes from, pulled directly from that file.

> This is **not** the same as [Sample Data](/docs/guide/sample-data), which covers the repo's own
> bundled/downloadable `sample-data/` directory (curl commands, local conversion). This page is
> specifically "here's what's behind each clickable pill in the live viewer" — many of the same
> upstream sources are shared between the two, but this page's job is the pill → source mapping.

---

## COPC ☁

Point-cloud octree, streamed live via `/stream?format=copc`.

| Pill | Source |
|------|--------|
| **Autzen** | `https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz` |
| **Eiffel** | `https://data.geopf.fr/telechargement/download/LiDARHD-NUALID/NUALHD_1-0__LAZ_LAMB93_KE_2025-06-06/LHD_FXX_0648_6863_PTS_LAMB93_IGN69.copc.laz` |
| **Texas** | `https://data.opengeos.org/USGS_LPC_TX_CoastalRegion_2018_A18_stratmap18-50cm-2995201a1.copc.laz` |

## Potree 🌲

Point-cloud octree (1.x and 2.0), streamed live via `/stream?format=potree`.

| Pill | Source |
|------|--------|
| **Lion 2.0** | `https://potree.org/pointclouds/lion/metadata.json` — potree.org's own hosted Potree-2.0 build of the lion scan |
| **Lion Takanawa 1.x** | `https://raw.githubusercontent.com/potree/potree/develop/pointclouds/lion_takanawa/cloud.js` — potree/potree's own bundled example |
| **Lion Takanawa LAZ** | `https://raw.githubusercontent.com/potree/potree/develop/pointclouds/lion_takanawa_laz/cloud.js` — same scan, tiled-LAZ nodes |
| **Vol Total** | `https://raw.githubusercontent.com/potree/potree/develop/pointclouds/vol_total/cloud.js` — Potree's own "Sorvilier" Swiss survey (courtesy sigeom sa); label kept from the original preset name |
| **Geghard (iconem)** | `https://api.iconem.com/s/rIdPkRfOmEdRtgsoO08TgNt9MSxh-woC/cloud.js` |

## SOG ⬢

Streamed-SOG (PlayCanvas LOD splats), streamed live via `/stream?format=sog`.

| Pill | Source |
|------|--------|
| **Skatepark** | `https://code.playcanvas.com/examples_data/example_skatepark_02/lod-meta.json` — PlayCanvas's own SOG example asset |
| **Roman Parish** | `https://code.playcanvas.com/examples_data/example_roman_parish_02/lod-meta.json` — PlayCanvas's own SOG example asset |
| **Arrival jaffa3 (.lod)** | `https://ugc.arrival.space/71585765/14ae36863868a5f74fbc29389e156bc5f18e0d7a612af78c492cd84cfa4a9c44_jaffa3_1777965648677_LOD/lod-meta.json` — Arrival.Space's `.lod` format, which is byte-shape-identical to streamed-SOG, so the SOG adapter reads it directly |

## LCC ◆

XGRIDS Lixel CyberColor splats, streamed live via `/stream?format=lcc`.

| Pill | Source |
|------|--------|
| **Big Mirror** | `https://raw.githubusercontent.com/willeastcott/assets/main/lcc/bigmirror/meta.lcc` |
| **Guan Temple (zip)** | `https://da9i2vj1xvtoc.cloudfront.net/lcc-pub/fine_v2/Guan_Temple.zip` — whole LCC file set bundled as one zip (XGRIDS' own CDN); `lcc-live.js` range-reads the zip entries directly |

> A third dataset, "PentHouse", was removed 2026-07-06: its bucket is missing the required `Data.bin`
> (confirmed `index.bin`'s own LOD offset table references byte ranges up to ~316 MB into it, but only
> a much smaller `environment.bin` actually exists there) — every tile request 404s, and no complete
> public mirror was found. Re-add if a fixed/alternate host turns up.

## RAD ✦

SparkJS BhattLod Gaussian-splat LoD, streamed live via `/stream?format=rad`.

| Pill | Source |
|------|--------|
| **Coit** | `https://wlt-ai-cdn.art/spark-2.0/rad/coit-40m-sh1-lod.rad` — William Liu's own CDN (the RAD/BhattLod format author) |
| **Tastier** | `https://wlt-ai-cdn.art/tastier_rad_500/0524c1a1-abf2-4969-ae40-9981ee836536_500k-lod.rad` — same CDN |
| **WIP PLY-RAD · Elevator** | `input/PLY/Elevator-lod.rad` — local sample-data only; no public source found (private/internal PLY-derived test asset) |
| **WIP PLY-RAD · Svirnas** | `input/PLY/SvirnasAlyt-lod.rad` — local sample-data only; no public source found |

## I3S 🧱

Esri Indexed 3D Scene Layer (mesh and point-cloud layers), streamed live via `/stream?format=i3s`.

| Pill | Source |
|------|--------|
| **NYC Buildings (SceneServer)** | `https://tiles.arcgis.com/tiles/P3ePLMYs2RVChkJx/arcgis/rest/services/Buildings_New_York_3D/SceneServer` — Esri's own official, live-hosted "Buildings New York 3D" service (item `3653d502714248f8b81a34faba956bdb`, owner `esri_3d`, built from NYC DoITT's 2014 building survey) |
| **ArcGIS Rancho Mesh v17 (.slpk)** | `https://www.arcgis.com/sharing/rest/content/items/e0dfde9f11054aac8e15edbb8aa1631d/data` — the v17 dataset ESRI's own Scene Viewer showcases publicly (Fire Station No. 3), with known-good textures |
| **ArcGIS Rancho Mesh v17 (SceneServer)** | `https://tiles.arcgis.com/tiles/z2tnIkrLQ2BRzr6P/arcgis/rest/services/Rancho_Mesh_v17/SceneServer` |
| **ArcGIS Moro Bay LiDAR (.slpk)** (point cloud) | `https://www.arcgis.com/sharing/rest/content/items/496552d059644b4892c51ad06bdba8e2/data` — LEPCC-compressed positions, decoded live |
| **ArcGIS Moro Bay LiDAR SceneServer** (point cloud) | `https://tiles.arcgis.com/tiles/z2tnIkrLQ2BRzr6P/arcgis/rest/services/Moro_Bay_LiDAR/SceneServer` |
| **ArcGIS USGSNYC 2014 LiDAR SceneServer** (point cloud) | `https://tiles.arcgis.com/tiles/z2tnIkrLQ2BRzr6P/arcgis/rest/services/USGSNYC_2014_LiDAR/SceneServer` |

See [`i3s-spec.md`](/docs/references/i3s-spec) and the I3S section of [Converters](/docs/guide/converters)
for the LEPCC decode / texture-embedding details behind these.

## 3D Tiles ◈ (DIRECT presets)

Already-3D-Tiles sources, loaded directly (no conversion/streaming adapter involved).

| Pill | Source |
|------|--------|
| **3DT · GSplat 1 (WL)** | `https://raw.githubusercontent.com/WilliamLiu-1997/3DTilesRendererJS-3DGS-Plugin/main/data/gaussianSplat1/tileset.json` |
| **3DT · GSplat 2 (WL)** | `https://raw.githubusercontent.com/WilliamLiu-1997/3DTilesRendererJS-3DGS-Plugin/main/data/gaussianSplat2/tileset.json` |
| **3DT · Strasbourg** | `https://s3.eu-west-2.wasabisys.com/ems-sgct-photomaillage/ODACIT/EMS_PM2022/tileset.json` |
| **3DT · Clermont** | `https://3d.craig.fr/datasets/Clermont/3dtiles/tileset.json` |
| **3DT · Lille** | `https://webimaging.lillemetropole.fr/externe/maillage/2016_mel_10cm/3dtiles/tileset.json` |
| **3DT · Marseille (root.json)** | `https://d3h9zulrmcj1j6.cloudfront.net/Marseille_Cesium/root.json` |
| **3DT · CesiumGS discrete-LOD** | `https://raw.githubusercontent.com/CesiumGS/3d-tiles-samples/main/1.0/TilesetWithDiscreteLOD/tileset.json` |
| **3DT · Google Photorealistic** | `https://tile.googleapis.com/v1/3dtiles/root.json?key=…` (Google's public photorealistic 3D Tiles) |
| **3DT · ESRI Portcoast (mesh)** | `https://tiles.arcgis.com/tiles/V6ZHFr6zdgNZuVG0/arcgis/rest/services/Portcoast_industrial/3DTilesServer/tileset.json` |
| **3DT · ESRI Mantes-la-Jolie (splat)** | `https://tiles.arcgis.com/tiles/uujCiiEZAflDbdxE/arcgis/rest/services/Collégiale_Mantes_la_Jolie_Drone_3D_Gaussian_Splat/3DTilesServer/tileset.json` — ESRI's ArcGIS 3D Tiles Server publishing `KHR_gaussian_splatting`/SPZ splats directly, outside I3S |
| **3DT · Agisoft Jam (Cloud)** | Agisoft Cloud's `cloud.agisoft.com` tileset, routed through this repo's `/proxy` endpoint (Agisoft sends no CORS headers, so a browser can't fetch it directly) |

## Packages 📦 (Tools mode)

`.3tz`/`.3dtiles` self-contained packages, served in-place via `/3dtiles-self-contained`.

| Pill | Source |
|------|--------|
| **tastier .3tz (ZIP+index)** | `sample-data/input/3DTILES-PACKAGES/tastier.3tz` (bundled) |
| **tastier .3dtiles (SQLite)** | `sample-data/input/3DTILES-PACKAGES/tastier.3dtiles` (bundled) |
| **loaders.gl test.3tz (mesh)** | `sample-data/input/3DTILES-PACKAGES/loadersgl-test.3tz` (bundled) |

## GeoSplats ✨, Bing 3D 🗺, 3MX 🏛

These pseudo-format pills route to their own live adapters (`/stream?format=geosplats`, `/bing`,
`/threemx`) but currently have no named preset assets wired into `formats.ts` — they're driven by a
manual URL entry in the viewer instead. See [`maptiler-geosplats.md`](/docs/references/maptiler-geosplats),
the Bing section of [Vision: towards a TiTiler for 3D](/docs/guide/vision-towards-a-titiler-for-3d-now-live-for-every-supported),
and `streaming-adapter-plans.md` for what each adapter does.

## Tools mode datasets (implicit-to-explicit / upgrade)

The **⚙ Tools** mode's demo datasets (`TOOLS_DATASETS` in `formats.ts`), used to exercise the
tileset-level transforms rather than a format converter:

| Tool | Pill | Source |
|------|------|--------|
| `implicit-to-explicit` | Utrecht 3D (QT+b3dm→glb) | `https://bertt.github.io/cesium_3dtiles_samples/samples/utrecht3d/tileset.json` |
| `implicit-to-explicit` | Delaware 1.1 (QT+glb+metadata) | `https://bertt.github.io/cesium_3dtiles_samples/samples/1.1/delaware/tileset.json` |
| `implicit-to-explicit` | Grenoble Trees 1.1 (instanced glb) | `https://bertt.github.io/cesium_3dtiles_samples/samples/1.1/grenoble_trees/tileset.json` |
| `implicit-to-explicit` | Potree · Lion 2.0 (octree→explicit) | this repo's own converted output, `output/potree/lion_p2/tileset.json` |
| `implicit-to-explicit` | COPC · Autzen (octree→explicit) | this repo's own converted output, `output/copc/autzen-3dtiles-from-copc/tileset.json` |
| `upgrade` | Lille Pyramid (b3dm→glb) | `https://webimaging.lillemetropole.fr/externe/maillage/2016_mel_10cm/3dtiles/pyramid/tileset.json` |

These same bertt.github.io / CesiumGS sample tilesets are documented in more depth (tileset structure,
implicit-tiling schemes) on the [Sample Data](/docs/guide/sample-data) page's
"Open-Data 3D Tiles sample datasets" section.
