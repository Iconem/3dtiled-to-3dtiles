import { GOOGLE_MAPS_API_KEY } from './google';

// Ported verbatim (same ids/labels/urls) from viewer.html's FORMATS/DIRECT/TOOLS_DATASETS/SNIPPETS —
// see C:\Dev\Iconem\3d-tiles-converters\viewer.html lines ~578-834.

// Derived from window.location rather than hardcoded to 'localhost' — this app is reachable from
// other devices on the LAN (vite.config.ts's `server.host: true`), and a hardcoded 'localhost' would
// resolve to the REMOTE device itself in that case, not this machine, breaking every tileset/
// sample-data fetch even though the page itself loaded fine. Falls back to 'localhost' for any
// non-browser evaluation (e.g. a Node-based tooling script importing this file directly).
const ORIGIN_HOST = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
const ORIGIN_PROTOCOL = typeof window !== 'undefined' ? window.location.protocol : 'http:';

// Sample data is always served by the SAME origin as this app itself (vite's dev server in local dev,
// the viewer's own static file server in prod) — window.location.origin already carries the right
// port implicitly (or no port at all behind a reverse proxy on 443), so no hardcoded ":3000" is needed
// here at all. Only kept a literal fallback for non-browser evaluation.
const ORIGIN = typeof window !== 'undefined' ? window.location.origin : `${ORIGIN_PROTOCOL}//${ORIGIN_HOST}:3000`;
export const SDATA = `${ORIGIN}/sample-data`;

// The tile-server middleware, UNLIKE sample data above, is a genuinely separate origin in a real
// deployment behind a reverse proxy (e.g. Traefik routing viewer.example.com and
// tiles.example.com to two different containers, each on its own :443 — not the same host on a
// different port the way local dev's ORIGIN_HOST + ':3001' assumes). That can't be derived from
// window.location, so it's configurable two ways, checked in order:
//   1. window.__TILE_SERVER_URL__ — a RUNTIME override, regenerated from the container's own
//      TILE_SERVER_URL env var at container START (see public/env-config.js + docker-entrypoint.sh).
//      Takes effect on a plain container restart, no image rebuild needed.
//   2. import.meta.env.VITE_TILE_SERVER_URL — a Vite BUILD-TIME env var baked permanently into the
//      compiled JS bundle by the Dockerfile's viewer-build stage. Setting this in a compose file's
//      `environment:` block does NOTHING — that only affects the container's runtime environment,
//      which a static already-built JS bundle never reads. Kept for anyone who prefers baking it in
//      at build time (e.g. a one-off `docker build --build-arg`) over runtime configuration.
// Falls back to the same-host-different-port pattern for local dev and the bundled (non-Traefik)
// docker-compose.yml, where that assumption still holds.
export const MW =
  (typeof window !== 'undefined' && (window as any).__TILE_SERVER_URL__) ||
  import.meta.env.VITE_TILE_SERVER_URL ||
  `${ORIGIN_PROTOCOL}//${ORIGIN_HOST}:3001`;

// apps/docs — same three-tier resolution as MW above (runtime override → build-time env → local-dev
// same-host-different-port fallback). Used to exist as a same-origin `/docs` path, proxied to apps/docs'
// own dev server by vite.config.ts — reverted (docs now needs its own always-on process either way in
// prod, not something a dev-only proxy should paper over) in favor of linking to the real service
// directly, same as production's own separate 3dtiled-docs.* subdomain.
// Trailing `/docs`: apps/docs' own content routes live under that path segment on ITS OWN origin too
// (see apps/docs/next.config.mjs's comment — no root basePath, content is under src/app/docs/[[...slug]]),
// there's no root page. True for both local dev (:3002/docs) and prod (the subdomain's own /docs).
export const DOCS_URL =
  (typeof window !== 'undefined' && (window as any).__DOCS_URL__) ||
  import.meta.env.VITE_DOCS_URL ||
  `${ORIGIN_PROTOCOL}//${ORIGIN_HOST}:3002/docs`;

export type AssetType = 'mesh' | 'pointcloud' | 'splat';

export interface Asset {
  id: string;
  label: string;
  src?: string;
  streamSrc?: string;
  out?: string;
  url?: string;
  pkg?: string;
  type?: AssetType;
}

export interface FormatMeta {
  fmt: string;
  icon: string;
  label: string;
  type: AssetType;
  octree: boolean;
  stream: boolean;
  assets: Asset[];
}

export const SPLAT_FORMATS = new Set(['sog', 'lcc', 'lcc2', 'rad']);

export const TOOLS_DATASETS: Record<string, Asset[]> = {
  'implicit-to-explicit': [
    { id: 'utrecht', label: 'Utrecht 3D (QT+b3dm→glb)', type: 'mesh', url: 'https://bertt.github.io/cesium_3dtiles_samples/samples/utrecht3d/tileset.json' },
    { id: 'delaware', label: 'Delaware 1.1 (QT+glb+metadata)', type: 'mesh', url: 'https://bertt.github.io/cesium_3dtiles_samples/samples/1.1/delaware/tileset.json' },
    { id: 'grenoble-trees', label: 'Grenoble Trees 1.1 (instanced glb)', type: 'mesh', url: 'https://bertt.github.io/cesium_3dtiles_samples/samples/1.1/grenoble_trees/tileset.json' },
    { id: 'potree-lion', label: 'Potree · Lion 2.0 (octree→explicit)', type: 'pointcloud', url: `${SDATA}/output/potree/lion_p2/tileset.json` },
    { id: 'copc-autzen', label: 'COPC · Autzen (octree→explicit)', type: 'pointcloud', url: `${SDATA}/output/copc/autzen-3dtiles-from-copc/tileset.json` },
  ],
  upgrade: [
    { id: 'lille-pyramid', label: 'Lille Pyramid (b3dm→glb)', type: 'mesh', url: 'https://webimaging.lillemetropole.fr/externe/maillage/2016_mel_10cm/3dtiles/pyramid/tileset.json' },
  ],
  packages: [
    { id: 'tastier-3tz', label: 'tastier .3tz (ZIP+index)', type: 'splat', pkg: 'sample-data/input/3DTILES-PACKAGES/tastier.3tz' },
    { id: 'tastier-3dtiles', label: 'tastier .3dtiles (SQLite)', type: 'splat', pkg: 'sample-data/input/3DTILES-PACKAGES/tastier.3dtiles' },
    { id: 'loadersgl-3tz', label: 'loaders.gl test.3tz (mesh)', type: 'mesh', pkg: 'sample-data/input/3DTILES-PACKAGES/loadersgl-test.3tz' },
  ],
};

export const FORMATS: FormatMeta[] = [
  { fmt: 'copc', icon: '☁', label: 'COPC', type: 'pointcloud', octree: true, stream: true, assets: [
    // Real, independently-hosted public sources (not this app's own /sample-data) — see README's
    // "COPC — Autzen Stadium" section for provenance/attribution of all three.
    { id: 'autzen', label: 'Autzen', src: 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz', out: 'output/copc/autzen-3dtiles-from-copc' },
    { id: 'eiffel', label: 'Eiffel', src: 'https://data.geopf.fr/telechargement/download/LiDARHD-NUALID/NUALHD_1-0__LAZ_LAMB93_KE_2025-06-06/LHD_FXX_0648_6863_PTS_LAMB93_IGN69.copc.laz', out: 'output/copc/eiffel-3dtiles-from-copc' },
    { id: 'texas', label: 'Texas', src: 'https://data.opengeos.org/USGS_LPC_TX_CoastalRegion_2018_A18_stratmap18-50cm-2995201a1.copc.laz', out: 'output/copc/texas-3dtiles-from-copc' },
  ] },
  // A PDAL/QGIS virtual point cloud: one .vpc indexing many COPC files, served as a mosaic of their streams
  // (/stream?format=vpc hands it to /aggregate). Not an octree itself, and nothing to convert offline.
  { fmt: 'vpc', icon: '🗂', label: 'VPC', type: 'pointcloud', octree: false, stream: true, assets: [
    // Real: nine 1 km AHN5 tiles over Amsterdam, 227 M points, from HPC-DAT/copc-dataset (COPC on the AHN bucket).
    { id: 'ahn5-amsterdam', label: 'AHN5 Amsterdam, 9 tiles (HPC-DAT, 227M) ⬀', src: 'https://raw.githubusercontent.com/HPC-DAT/copc-dataset/main/ahn5.vpc' },
    // Real: QGIS's own test fixture, four tiny COPC files (253 points) with an overview asset.
    { id: 'qgis-sunshine-coast', label: 'QGIS test · Sunshine Coast, 4 tiles ⬀', src: 'https://raw.githubusercontent.com/qgis/QGIS/master/tests/testdata/point_clouds/virtual/sunshine-coast/combined-with-overview.vpc' },
    // Self-made (scripts/copc-to-vpc.mjs) over flai's public COPC mirror of NYU's Dublin 2015 scan, CC BY 4.0.
    { id: 'dublin-2015', label: 'Dublin City 2015, 35 tiles (NYU via flai, 1.4G, self-made VPC) ⬀', src: 'https://raw.githubusercontent.com/jo-chemla/3dtiled-to-3dtiles/main/packages/tile-server/samples/dublin-city-2015.vpc' },
    // Self-made over flai's mirror of Luxembourg's 2019 national LiDAR (CC0): every one of its 10 906 500 m tiles, gzipped to 1.0 MB.
    // The mosaic is served cut into external tilesets every 4 group levels (the root is 10 KB, not 7 MB).
    { id: 'luxembourg-2019', label: 'Luxembourg 2019, all 10 906 tiles (via flai, 80G, self-made VPC) ⬀', src: 'https://raw.githubusercontent.com/jo-chemla/3dtiled-to-3dtiles/main/packages/tile-server/samples/luxembourg-2019.vpc.gz' },
    // Self-made over flai's COPC mirror of IGN's LiDAR HD (Licence Ouverte 2.0): the 100 km Lambert-93 block X 600–700 / Y 6800–6900 km,
    // Paris and most of Île-de-France, 5 712 of the 337 206 tiles mirrored. 127 G points.
    { id: 'france-lidarhd-paris', label: 'IGN LiDAR HD, Paris 100 km block, 5 712 tiles (via flai, 127G, self-made VPC) ⬀', src: 'https://raw.githubusercontent.com/jo-chemla/3dtiled-to-3dtiles/main/packages/tile-server/samples/france-lidarhd-paris-100km.vpc.gz' },
    // ALL of flai's IGN LiDAR HD mirror, 337 206 tiles, 10.07 T points, three ways. The country-scale sets are assets of the
    // `sample-assets-v1` GitHub release (too large for the repository), every file a sibling (scripts/vpc-split.mjs --flat).
    // 1. a GRID VPC (packages/tile-server/vpc-grid.js): the Lambert-93 km grid, a URL template and the rows of squares that
    //    exist, with each tile's heights and count from its header. One 1.5 MB file.
    { id: 'france-lidarhd', label: 'IGN LiDAR HD, all of France, 337 206 tiles (via flai, 10.07T, grid VPC, 1.5 MB) ⬀', src: 'https://github.com/jo-chemla/3dtiled-to-3dtiles/releases/download/sample-assets-v1/france-lidarhd-stats.gridvpc.json.gz' },
    // 2. the same grid with the availability alone: 9.5 KB, every square given the country's height range (so a tile opens from further away).
    { id: 'france-lidarhd-grid', label: 'IGN LiDAR HD, all of France, availability-only grid VPC (9.5 KB) ⬀', src: 'https://raw.githubusercontent.com/jo-chemla/3dtiled-to-3dtiles/main/packages/tile-server/samples/france-lidarhd.gridvpc.json.gz' },
    // 3. the STAC VPC a PDAL / QGIS reader opens, every header read, split by scripts/vpc-split.mjs into a 60 KB root over 563 child VPCs (30 MB).
    { id: 'france-lidarhd-stac', label: 'IGN LiDAR HD, all of France, split STAC VPC of VPCs (563 children, 30 MB) ⬀', src: 'https://github.com/jo-chemla/3dtiled-to-3dtiles/releases/download/sample-assets-v1/france-lidarhd.vpc.gz' },
    // Self-made from swisstopo's STAC API: every swissSURFACE3D 1 km tile served as COPC (15 643 of 58 987 items on 2026-11-10), headers read, split into 27 children.
    { id: 'switzerland-swisssurface3d', label: 'swissSURFACE3D, 15 643 COPC tiles (swisstopo, 515G, split VPC) ⬀', src: 'https://github.com/jo-chemla/3dtiled-to-3dtiles/releases/download/sample-assets-v1/switzerland-swisssurface3d.vpc.gz' },
    // Self-made over NRCan's CanElevation bucket (OGL-Canada): the whole of New Brunswick and Prince Edward Island, 90 764 of its 751 929 COPC tiles,
    // every header read (1.73 T points, 39 projects 2015–2024), split into 147 child VPCs (9.9 MB gzipped in all) under a 16 KB root.
    { id: 'canada-canelevation-nb-pei', label: 'CanElevation, New Brunswick + PEI, 90 764 tiles (NRCan, 1.7T, split VPC) ⬀', src: 'https://github.com/jo-chemla/3dtiled-to-3dtiles/releases/download/sample-assets-v1/canada-canelevation-nb-pei.vpc.gz' },
    // Self-made over NOAA Digital Coast's unsigned COPC copy of a USGS 3DEP project (Fairbanks, AK, 2017, QL1 + QL2): 7 471 tiles, 63 G points, headers read.
    { id: 'usgs-3dep-fairbanks-2017', label: 'USGS 3DEP Fairbanks 2017 via NOAA, 7 471 tiles (63G, split VPC) ⬀', src: 'https://github.com/jo-chemla/3dtiled-to-3dtiles/releases/download/sample-assets-v1/usgs-3dep-fairbanks-2017.vpc.gz' },
  ] },
  { fmt: 'potree', icon: '🌲', label: 'Potree', type: 'pointcloud', octree: true, stream: true, assets: [
    // Real source: potree.org's own hosted Potree-2.0 build of the lion scan.
    { id: 'lion2', label: 'Lion 2.0', src: 'https://potree.org/pointclouds/lion/metadata.json', out: 'output/potree/lion_p2' },
    // Real sources: potree/potree's own bundled example point clouds (github.com/potree/potree).
    { id: 'takanawa', label: 'Lion Takanawa 1.x', src: 'https://raw.githubusercontent.com/potree/potree/develop/pointclouds/lion_takanawa/cloud.js', out: 'output/potree/lion_takanawa' },
    { id: 'takalaz', label: 'Lion Takanawa LAZ', src: 'https://raw.githubusercontent.com/potree/potree/develop/pointclouds/lion_takanawa_laz/cloud.js', out: 'output/potree/lion_takanawa_laz' },
    // "Vol Total" is Potree's own "Sorvilier" Swiss survey (courtesy sigeom sa) — same dataset, kept
    // this preset's existing label since it's just an id/display name, not a claim about the place.
    { id: 'voltotal', label: 'Vol Total', src: 'https://raw.githubusercontent.com/potree/potree/develop/pointclouds/vol_total/cloud.js', out: 'output/potree/vol_total' },
  ] },
  { fmt: 'sog', icon: '⬢', label: 'SOG', type: 'splat', octree: false, stream: true, assets: [
    // Real sources: PlayCanvas's own SOG example assets (code.playcanvas.com) — see README's SOG
    // section (`fetch-sog.mjs` originally mirrored these here; now streamed straight from PlayCanvas).
    { id: 'skatepark', label: 'Skatepark', src: 'https://code.playcanvas.com/examples_data/example_skatepark_02/lod-meta.json', out: 'output/sog/skatepark-3dtiles-from-sog' },
    { id: 'roman', label: 'Roman Parish', src: 'https://code.playcanvas.com/examples_data/example_roman_parish_02/lod-meta.json', out: 'output/sog/roman-parish-3dtiles-from-sog' },
    { id: 'arrival-jaffa', label: 'Arrival jaffa3 (.lod) ⬀', src: 'https://ugc.arrival.space/71585765/14ae36863868a5f74fbc29389e156bc5f18e0d7a612af78c492cd84cfa4a9c44_jaffa3_1777965648677_LOD/lod-meta.json' },
    // Remote, stream-only community captures (splat-transform-authored streamed-SOG, CloudFront-hosted).
    { id: 'oval-interior', label: 'Oval Interior Spaces ⬀', src: 'https://d28zzqy0iyovbz.cloudfront.net/b7c8d8c5/v1/lod-meta.json' },
    { id: 'grace-cathedral-ext', label: 'Grace Cathedral SF ext (Vincent Woo) ⬀', src: 'https://d28zzqy0iyovbz.cloudfront.net/b8b1fd14/v1/lod-meta.json' },
    { id: 'cathedral-interior', label: 'Cathedral Interior ⬀', src: 'https://d28zzqy0iyovbz.cloudfront.net/02d5f4eb/v3/lod-meta.json' },
    { id: 'vysehrad-prague', label: 'Vyšehrad Basilica & parks, Prague (D. Dworschak, 83M) ⬀', src: 'https://d28zzqy0iyovbz.cloudfront.net/1b7afbf6/v1/lod-meta.json' },
    { id: 'jastrzebia-gora-sog', label: 'Jastrzębia Góra 4×2 km (A. Shramko, CC BY, 106M) ⬀', src: 'https://d28zzqy0iyovbz.cloudfront.net/221ee167/v1/lod-meta.json' },
    // The scene of PlayCanvas' slide at the MSF splat-compression town hall (2026-11-03): 259 M gaussians at LOD 0, 518 M over 13 levels.
    { id: 'lublin-sog', label: 'Lublin, Poland (A. Shramko, CC BY, 259M) ⬀', src: 'https://d28zzqy0iyovbz.cloudfront.net/2f1ddf5f/v1/lod-meta.json' },
    { id: 'itaka-stadium-sog', label: 'Itaka Stadium, Opole (A. Shramko, CC BY, 212M) ⬀', src: 'https://d28zzqy0iyovbz.cloudfront.net/7b43aca7/v1/lod-meta.json' },
    { id: 'dittrichova-hrobka', label: 'Dittrichova hrobka, Krásná Lípa (D. Dworschak, 54M) ⬀', src: 'https://d28zzqy0iyovbz.cloudfront.net/6c09cd54/v1/lod-meta.json' },
  ] },
  { fmt: 'lcc', icon: '◆', label: 'LCC', type: 'splat', octree: false, stream: true, assets: [
    // Real public .lcc downloads (found via XGRIDS' own sample-data page,
    // developer.xgrids.com/#/download?page=sampledata, and a hobbyist's own R2/GitHub mirrors) —
    // replaces the earlier private/local-only showcase captures (Guan Temple/Guanlan Town/Religious
    // Center), which had no public source and stayed on local sample-data.
    // PentHouse REMOVED (2026-07-06): its bucket is missing the required Data.bin — confirmed
    // index.bin's own LOD offset table references byte ranges up to ~316MB into it, but only
    // meta.lcc/index.bin/a much smaller environment.bin actually exist there. Every tile request
    // 404s; no complete public mirror found. Re-add if a fixed/alternate host turns up.
    { id: 'bigmirror', label: 'Big Mirror', src: 'https://raw.githubusercontent.com/willeastcott/assets/main/lcc/bigmirror/meta.lcc', out: 'output/lcc/bigmirror-3dtiles-from-lcc' },
    // Whole LCC file set bundled as one .zip (XGRIDS' own CDN) — lcc-live.js detects the `.zip`
    // extension and reads meta.lcc/index.bin/data.bin as zip entries via range reads instead of
    // sibling HTTP files (see remote-zip.js). data.bin is DEFLATE-compressed inside the zip (not
    // byte-seekable), so it's decompressed once per cold source (~5-13s) and cached, not per-tile.
    { id: 'guan-temple', label: 'Guan Temple (zip)', src: 'https://da9i2vj1xvtoc.cloudfront.net/lcc-pub/fine_v2/Guan_Temple.zip', out: 'output/lcc/Guan_Temple-3dtiles-from-lcc' },
    // The LCC v1 samples of Spark's radix viewer (World Labs), on a public GCS bucket that answers Range: the LCC
    // scene of XGRIDS' 3dgs-unreal-example content pack (the one public LCC that is georeferenced, EPSG:4547 → Hunan),
    // XGRIDS' PortalCam showroom (one 30 m cell: its finest level is one 6 M-splat tile, a 192 MB read), and two
    // scenes converted from PLY by radix's tools (Mip-NeRF 360's bicycle with SH 3, Sutro Tower).
    { id: 'radix-unreal-lcc', label: 'Unreal example scene (XGRIDS, 3.4M, EPSG:4547, 115 MB) ⬀', src: 'https://storage.googleapis.com/forge-dev-public/asundqui/radix/261012/lcc/unreal/meta.lcc' },
    { id: 'radix-showroom2-lcc', label: 'Showroom (XGRIDS PortalCam, 11.6M, 1 cell, 372 MB) ⬀', src: 'https://storage.googleapis.com/forge-dev-public/asundqui/radix/261012/lcc/showroom2/showroom2.lcc' },
    { id: 'radix-sutro-lcc', label: 'Sutro Tower (radix, from PLY, 3.8M, 360 MB) ⬀', src: 'https://storage.googleapis.com/forge-dev-public/asundqui/radix/261012/lcc/sutro/meta.lcc' },
    { id: 'radix-bicycle-lcc', label: 'Bicycle, Mip-NeRF 360 (radix, from PLY, 11.9M, 1.1 GB) ⬀', src: 'https://storage.googleapis.com/forge-dev-public/asundqui/radix/261012/lcc/bicycle/meta.lcc' },
  ] },
  { fmt: 'lcc2', icon: '◈', label: 'LCC2', type: 'splat', octree: false, stream: true, assets: [
    // XGRIDS LCC2: a *.lcc2 JSON manifest (a tree of nodes with boxes) over chunk files, bundled .sog, .spz or .ply.
    // Tunis is the scene PlayCanvas hosts for its `streamed-lcc2` engine example: 84 M splats, 8 LODs, 140 chunks,
    // 1.4 GB, streamed one chunk read per group of tiles (lcc2-live.js). Local frame, no EPSG.
    { id: 'tunis-lcc2', label: 'Tunis (XGRIDS PortalCam, 84M, 1.4 GB) ⬀', src: 'https://code.playcanvas.com/examples_data/tunis_01/03-19-195651.lcc2' },
    // The LCC2 samples of Spark's radix viewer, on its GCS bucket: XGRIDS' own two LCC2 scenes from the
    // 3dgs-unreal-example content pack (byte for byte the Content.zip ones, .sog chunks), and the LCC v1 samples
    // above converted by radix's to-lcc2 tool to one chunk type each, .spz, .ply or .sog (the docs page says how
    // their node boxes compare with their splats). None is georeferenced (the street has `epsg: 1`, read as none).
    { id: 'radix-street-lcc2', label: 'Unreal street (XGRIDS, 2.8M, 6 LODs, .sog, 46 MB) ⬀', src: 'https://storage.googleapis.com/forge-dev-public/asundqui/radix/261012/lcc2/street/LCC2.lcc2' },
    { id: 'radix-statues-lcc2', label: 'Unreal statues (XGRIDS, 1.5M, 7 LODs, .sog, 19 MB) ⬀', src: 'https://storage.googleapis.com/forge-dev-public/asundqui/radix/261012/lcc2/lcc2-1/LCC2.lcc2' },
    { id: 'radix-showroom2-spz', label: 'Showroom (XGRIDS PortalCam, radix, 11.6M, .spz, 182 MB) ⬀', src: 'https://storage.googleapis.com/forge-dev-public/asundqui/radix/261012/lcc2/showroom2-spz/showroom2-spz.lcc2' },
    { id: 'radix-unreal-ply', label: 'Unreal example scene (XGRIDS, radix, 3.4M, .ply, 199 MB) ⬀', src: 'https://storage.googleapis.com/forge-dev-public/asundqui/radix/261012/lcc2/unreal-ply/unreal-ply.lcc2' },
    { id: 'radix-sutro-spz', label: 'Sutro Tower (radix, 3.8M, .spz, 119 MB) ⬀', src: 'https://storage.googleapis.com/forge-dev-public/asundqui/radix/261012/lcc2/sutro-spz/sutro-spz.lcc2' },
    { id: 'radix-bicycle-sog', label: 'Bicycle, Mip-NeRF 360 (radix, 11.9M, .sog, 250 MB) ⬀', src: 'https://storage.googleapis.com/forge-dev-public/asundqui/radix/261012/lcc2/bicycle-sog/bicycle-sog.lcc2' },
  ] },
  { fmt: 'rad', icon: '✦', label: 'RAD', type: 'splat', octree: false, stream: true, assets: [
    // Real sources: the exact files this repo's own README setup instructions curl down as
    // coit.rad/tastier500k.rad (wlt-ai-cdn.art — William Liu's own CDN, the RAD/BhattLod format author).
    { id: 'coit', label: 'Coit', src: 'https://wlt-ai-cdn.art/spark-2.0/rad/coit-40m-sh1-lod.rad', out: 'output/rad/coit-3dtiles-from-rad' },
    { id: 'poland-rad', label: 'Poland village (Teleportour, 106M, 2.75 GB) ⬀', src: 'https://wlt-ai-cdn.art/spark-2.0/rad/poland-lod.rad' },
    { id: 'cave-rad', label: 'Cave (World Labs, 73M, 1.46 GB) ⬀', src: 'https://wlt-ai-cdn.art/spark-2.0/rad/cave-lod.rad' },
    { id: 'tastier', label: 'Tastier', src: 'https://wlt-ai-cdn.art/tastier_rad_500/0524c1a1-abf2-4969-ae40-9981ee836536_500k-lod.rad', out: 'output/rad/tastier500k-3dtiles-from-rad' },
    // No public source found for either — private/internal PLY-derived test assets (WIP label already
    // flags these as such). Stay on local sample-data.
    { id: 'elevator', label: 'WIP PLY-RAD · Elevator', src: 'input/PLY/Elevator-lod.rad', out: 'output/rad/Elevator-3dtiles-from-rad' },
    { id: 'svir', label: 'WIP PLY-RAD · Svirnas', src: 'input/PLY/SvirnasAlyt-lod.rad', out: 'output/rad/SvirnasAlyt-3dtiles-from-rad' },
  ] },
  { fmt: 'i3s', icon: '🧱', label: 'I3S', type: 'mesh', octree: false, stream: true, assets: [
    // Swapped from a local Buildings_NewYork_v18.slpk file to Esri's own official, live-hosted
    // "Buildings New York 3D" SceneServer (item 3653d502714248f8b81a34faba956bdb, owner esri_3d, built
    // from NYC DoITT's 2014 building survey) — no `out`/streamSrc since there's no local prebuilt/SLPK
    // counterpart for this one anymore, same shape as the arcgis-mesh-svc entries below.
    { id: 'nyc', label: 'NYC Buildings (SceneServer)', src: 'https://tiles.arcgis.com/tiles/P3ePLMYs2RVChkJx/arcgis/rest/services/Buildings_New_York_3D/SceneServer' },
    // v17, not v18 — v17 is the one ESRI's own Scene Viewer showcases publicly (Fire Station No. 3,
    // https://www.arcgis.com/home/webscene/viewer.html?layers=4028eb46e12e42f7889367bafcd6866d), with
    // known-good textures. v18 (same org, different item) may just be a different/less-maintained
    // dataset — swapped to the one actually verified end-to-end against a real reference render.
    { id: 'arcgis-mesh-slpk', label: 'ArcGIS Rancho Mesh v17 (.slpk)', src: 'https://www.arcgis.com/sharing/rest/content/items/e0dfde9f11054aac8e15edbb8aa1631d/data' },
    { id: 'arcgis-mesh-svc', label: 'ArcGIS Rancho Mesh v17 (SceneServer)', src: 'https://tiles.arcgis.com/tiles/z2tnIkrLQ2BRzr6P/arcgis/rest/services/Rancho_Mesh_v17/SceneServer' },
    // LEPCC point-cloud decoding (2026-07-06): ported Esri's own github.com/Esri/lepcc XYZ codec to
    // JS (packages/i3s-to-3dtiles/src/lepccDecode.js) — both these datasets' `lepcc-xyz`-encoded
    // positions now decode to real geometry, verified against real ArcGIS-hosted nodes (checksum +
    // blobSize match, decoded coordinates sane vs. the layer's own extent). The .slpk archive was
    // MISDIAGNOSED as "single root node" in an earlier pass — the real cause (fixed in i3s-live.js)
    // was that PointCloud node pages (v2.0) express children via `firstChild`+`childCount`, not the
    // explicit `children:[idx…]` array mesh node pages use; `buildTile` only ever read `.children`,
    // so EVERY point-cloud tileset (SLPK or SceneServer) silently built as root-only. Both now expand
    // to their full tree (SLPK: 2624 tiles, SceneServer: 13775 tiles).
    // `type: 'pointcloud'` override: the `i3s` group defaults to `type: 'mesh'` (most I3S samples are
    // mesh layers), but these three ARE PointCloud layers — without the override CesiumViewer treated
    // them as meshes, which forced LIT shading (meshes have real normals) even though point clouds
    // never carry a NORMAL attribute; with no normal, lit shading zeroed every point to black
    // regardless of the actual (now correctly LEPCC-RGB-decoded) vertex color. Also ported RGB itself:
    // a SEPARATE per-node `nodes/<res>/attributes/<key>` LEPCC ClusterRGB blob, not part of
    // DefaultGeometrySchema — see lepccDecode.js's decodeLepccRgb + its header comment for why the
    // resource URL (no trailing `/0`) took a second pass to get right.
    { id: 'arcgis-pts-slpk', label: 'ArcGIS Moro Bay LiDAR (.slpk)', type: 'pointcloud', src: 'https://www.arcgis.com/sharing/rest/content/items/496552d059644b4892c51ad06bdba8e2/data' },
    { id: 'arcgis-pts-svc', label: 'ArcGIS Moro Bay LiDAR SceneServer', type: 'pointcloud', src: 'https://tiles.arcgis.com/tiles/z2tnIkrLQ2BRzr6P/arcgis/rest/services/Moro_Bay_LiDAR/SceneServer' },
    { id: 'arcgis-usgsnyc-svc', label: 'ArcGIS USGSNYC 2014 LiDAR SceneServer', type: 'pointcloud', src: 'https://tiles.arcgis.com/tiles/z2tnIkrLQ2BRzr6P/arcgis/rest/services/USGSNYC_2014_LiDAR/SceneServer' },
  ] },
  // OSGB (OpenSceneGraph binary tiled meshes: ContextCapture, DJI Terra, …), streamed only (no offline converter, so no
  // `out`). `src` is the dataset's metadata.xml, or its root .osgb where the folder has a single one, or a zip of one
  // tile, or the CSV index of such zips (a collection: one external tileset per zip, opened as the camera nears it).
  // The first two are Hong Kong's Planning Department 3D photo-realistic model (data.gov.hk terms, free reuse): the
  // whole set, 2 150 zips of 250 m each over Kowloon and Hong Kong Island, 467 GB, of the order of 10 G vertices, read
  // in place by range requests; and one of its tiles. The other four are folders of public GitHub repositories under an MIT
  // licence, read through raw.githubusercontent.com: the server finds the top tiles with one GitHub tree API call,
  // or by their names when that call is refused.
  { fmt: 'osgb', icon: '🧊', label: 'OSGB', type: 'mesh', octree: false, stream: true, assets: [
    { id: 'hk-pland', label: 'Hong Kong, PlanD photo-realistic model (2 150 zipped tiles, 467 GB, ~10 G vertices)', src: 'https://pdmap.pland.gov.hk/PLANDWEB/public/3d_photo_realistic_models/Metadata/GridIdx_OSGB.csv' },
    { id: 'hk-pland-tile', label: 'Hong Kong, PlanD tile +005_+006, Mong Kok (one zip, 78 MB, 873 k vertices, 12 levels)', src: 'https://pdmap.pland.gov.hk/PLANDWEB/public/3d_photo_realistic_models/OSGB/Tile_+005_+006_OSGB.zip' },
    { id: 'weinan', label: 'Weinan (ContextCapture, 30 tiles, 183 MB)', src: 'https://raw.githubusercontent.com/xyxfa/UnityOSGB-main/main/Assets/StreamingAssets/weinan/metadata.xml' },
    { id: 'dayanta', label: 'Dayanta pagoda, Xi’an (ContextCapture, 63 tiles, cut at L17)', src: 'https://raw.githubusercontent.com/Sogrey/Cesium-start-Example/master/SampleData/models/dayanta_osgb/osgb/metadata.xml' },
    { id: 'hongkong', label: 'Hong Kong Central, tile 21-25 (LandsD mesh, OSG 3.2, 217 MB)', src: 'https://raw.githubusercontent.com/fafa1899/GISBasic/main/Data/Model/hongkong/tile_21_25/Data/Model/Model.osgb' },
    { id: 'generic', label: 'One tile to L22 (ContextCapture, 32 MB)', src: 'https://raw.githubusercontent.com/xarray/generic-osgb/master/examples/data/Tile_1/Tile_1.osgb' },
  ] },
  // Nexus (CNR-ISTI multiresolution meshes, the format of 3DHOP; `.nxs` plain, `.nxz` Corto-compressed): one file, read
  // by range requests (the header and tables, then one node at a time), live or converted offline. The gargoyle is
  // 3DHOP's own example (from its GPL-3 repository, the model the lab's sample); the shell and the bust are Smithsonian scans
  // (CC0) packed as Nexus in a Hugging Face dataset, the shell textured (28 JPEGs); the Stanford dragon is for
  // non-commercial use. Every host answers Range.
  { fmt: 'nexus', icon: '🗿', label: 'Nexus', type: 'mesh', octree: false, stream: true, assets: [
    { id: 'gargoyle', label: 'Gargoyle (3DHOP sample, 187 nodes, 4.0 M triangles, 7.3 MB)', src: 'https://raw.githubusercontent.com/cnr-isti-vclab/3dhop/master/examples/models/gargo.nxz' },
    { id: 'shell', label: 'Unio hainesianus shell, textured (Smithsonian CC0, 28 nodes, 0.54 M triangles, 28 JPEGs, 40 MB)', src: 'https://huggingface.co/datasets/JulyTheMonth/NexusDataset/resolve/main/shell.nxz' },
    { id: 'dragon', label: 'Stanford dragon (85 nodes, 1.7 M triangles, 3.5 MB)', src: 'https://huggingface.co/datasets/JulyTheMonth/NexusDataset/resolve/main/dragon.nxz' },
    { id: 'bust', label: 'George Washington bust, textured (Smithsonian CC0, 2 541 nodes, 52.1 M triangles, 242 MB)', src: 'https://huggingface.co/datasets/JulyTheMonth/NexusDataset/resolve/main/bust.nxz' },
  ] },
];

export interface DirectAsset { id: string; icon: string; label: string; type: AssetType; url: string }

export const DIRECT: DirectAsset[] = [
  // The plugin repo's sample splats were renamed: data/gaussianSplat1|2 (404 since) → Elevator /
  // SvirnasAlyt. Caught by /stats?sample= returning HTTP 404 for every sampled tile.
  { id: 'wl-splat1', icon: '◈', label: '3DT · Elevator (WL)', type: 'splat', url: 'https://raw.githubusercontent.com/WilliamLiu-1997/3DTilesRendererJS-3DGS-Plugin/main/data/Elevator-3dtiles/tileset.json' },
  { id: 'wl-splat2', icon: '◈', label: '3DT · Svirnas Alyt (WL)', type: 'splat', url: 'https://raw.githubusercontent.com/WilliamLiu-1997/3DTilesRendererJS-3DGS-Plugin/main/data/SvirnasAlyt-3dtiles/tileset.json' },
  { id: 'strasbourg', icon: '🏙', label: '3DT · Strasbourg', type: 'mesh', url: 'https://s3.eu-west-2.wasabisys.com/ems-sgct-photomaillage/ODACIT/EMS_PM2022/tileset.json' },
  { id: 'clermont', icon: '🏙', label: '3DT · Clermont', type: 'mesh', url: 'https://3d.craig.fr/datasets/Clermont/3dtiles/tileset.json' },
  { id: 'lille', icon: '🏙', label: '3DT · Lille', type: 'mesh', url: 'https://webimaging.lillemetropole.fr/externe/maillage/2016_mel_10cm/3dtiles/tileset.json' },
  { id: 'marseille', icon: '🏙', label: '3DT · Marseille (root.json)', type: 'mesh', url: 'https://d3h9zulrmcj1j6.cloudfront.net/Marseille_Cesium/root.json' },
  { id: 'cgs-lod', icon: '◈', label: '3DT · CesiumGS discrete-LOD', type: 'mesh', url: 'https://raw.githubusercontent.com/CesiumGS/3d-tiles-samples/main/1.0/TilesetWithDiscreteLOD/tileset.json' },
  { id: 'google-3dtiles', icon: '🌍', label: '3DT · Google Photorealistic', type: 'mesh', url: `https://tile.googleapis.com/v1/3dtiles/root.json?key=${GOOGLE_MAPS_API_KEY}` },
  { id: 'esri-portcoast', icon: '🌍', label: '3DT · ESRI Portcoast (mesh)', type: 'mesh', url: 'https://tiles.arcgis.com/tiles/V6ZHFr6zdgNZuVG0/arcgis/rest/services/Portcoast_industrial/3DTilesServer/tileset.json' },
  { id: 'esri-mantes', icon: '🌍', label: '3DT · ESRI Mantes-la-Jolie (splat)', type: 'splat', url: 'https://tiles.arcgis.com/tiles/uujCiiEZAflDbdxE/arcgis/rest/services/Coll%C3%A9giale_Mantes_la_Jolie_Drone_3D_Gaussian_Splat/3DTilesServer/tileset.json' },
  { id: 'agisoft-jam', icon: '☁', label: '3DT · Agisoft Jam (Cloud)', type: 'mesh', url: `${MW}/proxy?url=${encodeURIComponent('https://cloud.agisoft.com/api/teams/b9910e8d-6a0a-4e99-b389-d0a4e1939ce7/projects/2dfa164c-b36b-457f-83a2-488a3f158fa0/datasets/4dbe0ec8-f38e-4fc4-b136-b54f2d52c225/tilesets/aa1dd5c4-6c78-4a82-83ab-86e51c02f3d9/tileset.json?access=3c0b69cf-b7bf-44d0-9662-b3b016b8ba82')}` },
];

export const PSEUDO_FORMATS: [string, string][] = [
  ['3dtiles', '◈ 3D Tiles'],
  ['packages', '📦 Packages'],
  ['bing', '🗺 Bing 3D'],
  ['google', '🌍 Google 3D'],
  ['threemx', '🏛 3MX'],
  ['geosplats', '✨ GeoSplats'],
  ['aggregate', '🧩 Aggregate'],
];

// The single, deliberately-grouped render order for the format pill row — cuts across the FORMATS
// vs. PSEUDO_FORMATS split (GeoSplats moves next to the other splat formats, I3S moves next to the
// other tileset-native/mesh formats), which is why this can't just be "FORMATS then PSEUDO_FORMATS"
// in array order. `group` drives the visual separators TopBar renders between clusters:
//   0: point-cloud octrees (COPC, Potree)
//   1: splat formats (SOG, LCC, LCC2, GeoSplats, RAD)
//   2: tileset-native / mesh formats (3D Tiles, Packages, I3S, 3MX, Bing, Google)
//   3: meta-tilesets — /aggregate mosaics that mix all of the above
export const FORMAT_PILL_ORDER: { id: string; group: number }[] = [
  { id: 'copc', group: 0 },
  { id: 'potree', group: 0 },
  { id: 'vpc', group: 0 },
  { id: 'sog', group: 1 },
  { id: 'lcc', group: 1 },
  { id: 'lcc2', group: 1 },
  { id: 'geosplats', group: 1 },
  { id: 'rad', group: 1 },
  { id: '3dtiles', group: 2 },
  { id: 'packages', group: 2 },
  { id: 'i3s', group: 2 },
  { id: 'threemx', group: 2 },
  { id: 'osgb', group: 2 },
  { id: 'nexus', group: 2 },
  { id: 'bing', group: 2 },
  { id: 'google', group: 2 },
  { id: 'aggregate', group: 3 },
];

/** Look up a pill's icon+label whether it's a real FORMATS entry or a PSEUDO_FORMATS one. */
export function pillMeta(id: string): { icon: string; label: string } | null {
  const f = FORMATS.find((x) => x.fmt === id);
  if (f) return { icon: f.icon, label: f.label };
  const p = PSEUDO_FORMATS.find(([v]) => v === id);
  return p ? { icon: '', label: p[1] } : null;
}

export const fmtMeta = (fmt: string) => FORMATS.find((f) => f.fmt === fmt);
/** Formats with a live /stream adapter and no offline converter: cache=all (/convert) has nothing to offer them. */
export const STREAM_ONLY_FORMATS = new Set(['osgb']);
export const canCentroids = (fmt: string) => SPLAT_FORMATS.has(fmt);

export const SNIPPETS: Record<string, { title: string; code: string; note: string }> = {
  pointcloud: {
    title: 'Point Cloud — CesiumJS',
    code: `const tileset = await Cesium.Cesium3DTileset.fromUrl(\n  url\n);\nviewer.scene.primitives.add(tileset);\nviewer.zoomTo(tileset);`,
    note: 'Serve via HTTP:  npx serve .\nThen open: http://localhost:3000/viewer.html',
  },
  splat: {
    title: 'Gaussian Splat — CesiumJS ≥ 1.115',
    code: `const tileset = await Cesium.Cesium3DTileset.fromUrl(\n  url,\n  { maximumScreenSpaceError: 2, skipLevelOfDetail: false }\n);\nviewer.scene.primitives.add(tileset);\nviewer.zoomTo(tileset);`,
    note: 'KHR_gaussian_splatting requires CesiumJS ≥ 1.115.\nServe via:  npx serve .',
  },
  mesh: {
    title: '3D Mesh — CesiumJS',
    code: `const tileset = await Cesium.Cesium3DTileset.fromUrl(url);\nviewer.scene.primitives.add(tileset);\nviewer.zoomTo(tileset);`,
    note: 'Explicit tiling, REPLACE refinement, b3dm tiles.\nNote: CORS must be enabled on the tile server.',
  },
  local: {
    title: 'Non-georeferenced — Local Frame',
    code: `// Place tileset origin at lon/lat/alt\nconst origin = Cesium.Cartesian3.fromDegrees(lon, lat, alt);\nconst enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin);\ntileset.modelMatrix = enu;`,
    note: "The model matrix maps the tileset's local ENU frame to ECEF.",
  },
};
