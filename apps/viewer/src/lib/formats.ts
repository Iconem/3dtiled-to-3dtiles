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

export const SPLAT_FORMATS = new Set(['sog', 'lcc', 'rad']);

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
  { fmt: 'potree', icon: '🌲', label: 'Potree', type: 'pointcloud', octree: true, stream: true, assets: [
    // Real source: potree.org's own hosted Potree-2.0 build of the lion scan.
    { id: 'lion2', label: 'Lion 2.0', src: 'https://potree.org/pointclouds/lion/metadata.json', out: 'output/potree/lion_p2' },
    // Real sources: potree/potree's own bundled example point clouds (github.com/potree/potree).
    { id: 'takanawa', label: 'Lion Takanawa 1.x', src: 'https://raw.githubusercontent.com/potree/potree/develop/pointclouds/lion_takanawa/cloud.js', out: 'output/potree/lion_takanawa' },
    { id: 'takalaz', label: 'Lion Takanawa LAZ', src: 'https://raw.githubusercontent.com/potree/potree/develop/pointclouds/lion_takanawa_laz/cloud.js', out: 'output/potree/lion_takanawa_laz' },
    // "Vol Total" is Potree's own "Sorvilier" Swiss survey (courtesy sigeom sa) — same dataset, kept
    // this preset's existing label since it's just an id/display name, not a claim about the place.
    { id: 'voltotal', label: 'Vol Total', src: 'https://raw.githubusercontent.com/potree/potree/develop/pointclouds/vol_total/cloud.js', out: 'output/potree/vol_total' },
    { id: 'geghard', label: 'Geghard (iconem) ⬀', src: 'https://api.iconem.com/s/rIdPkRfOmEdRtgsoO08TgNt9MSxh-woC/cloud.js' },
  ] },
  { fmt: 'sog', icon: '⬢', label: 'SOG', type: 'splat', octree: false, stream: true, assets: [
    // Real sources: PlayCanvas's own SOG example assets (code.playcanvas.com) — see README's SOG
    // section (`fetch-sog.mjs` originally mirrored these here; now streamed straight from PlayCanvas).
    { id: 'skatepark', label: 'Skatepark', src: 'https://code.playcanvas.com/examples_data/example_skatepark_02/lod-meta.json', out: 'output/sog/skatepark-3dtiles-from-sog' },
    { id: 'roman', label: 'Roman Parish', src: 'https://code.playcanvas.com/examples_data/example_roman_parish_02/lod-meta.json', out: 'output/sog/roman-parish-3dtiles-from-sog' },
    { id: 'arrival-jaffa', label: 'Arrival jaffa3 (.lod) ⬀', src: 'https://ugc.arrival.space/71585765/14ae36863868a5f74fbc29389e156bc5f18e0d7a612af78c492cd84cfa4a9c44_jaffa3_1777965648677_LOD/lod-meta.json' },
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
  ] },
  { fmt: 'rad', icon: '✦', label: 'RAD', type: 'splat', octree: false, stream: true, assets: [
    // Real sources: the exact files this repo's own README setup instructions curl down as
    // coit.rad/tastier500k.rad (wlt-ai-cdn.art — William Liu's own CDN, the RAD/BhattLod format author).
    { id: 'coit', label: 'Coit', src: 'https://wlt-ai-cdn.art/spark-2.0/rad/coit-40m-sh1-lod.rad', out: 'output/rad/coit-3dtiles-from-rad' },
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
];

export interface DirectAsset { id: string; icon: string; label: string; type: AssetType; url: string }

export const DIRECT: DirectAsset[] = [
  { id: 'wl-splat1', icon: '◈', label: '3DT · GSplat 1 (WL)', type: 'splat', url: 'https://raw.githubusercontent.com/WilliamLiu-1997/3DTilesRendererJS-3DGS-Plugin/main/data/gaussianSplat1/tileset.json' },
  { id: 'wl-splat2', icon: '◈', label: '3DT · GSplat 2 (WL)', type: 'splat', url: 'https://raw.githubusercontent.com/WilliamLiu-1997/3DTilesRendererJS-3DGS-Plugin/main/data/gaussianSplat2/tileset.json' },
  { id: 'strasbourg', icon: '🏙', label: '3DT · Strasbourg', type: 'mesh', url: 'https://s3.eu-west-2.wasabisys.com/ems-sgct-photomaillage/ODACIT/EMS_PM2022/tileset.json' },
  { id: 'clermont', icon: '🏙', label: '3DT · Clermont', type: 'mesh', url: 'https://3d.craig.fr/datasets/Clermont/3dtiles/tileset.json' },
  { id: 'lille', icon: '🏙', label: '3DT · Lille', type: 'mesh', url: 'https://webimaging.lillemetropole.fr/externe/maillage/2016_mel_10cm/3dtiles/tileset.json' },
  { id: 'marseille', icon: '🏙', label: '3DT · Marseille (root.json)', type: 'mesh', url: 'https://d3h9zulrmcj1j6.cloudfront.net/Marseille_Cesium/root.json' },
  { id: 'cgs-lod', icon: '◈', label: '3DT · CesiumGS discrete-LOD', type: 'mesh', url: 'https://raw.githubusercontent.com/CesiumGS/3d-tiles-samples/main/1.0/TilesetWithDiscreteLOD/tileset.json' },
  { id: 'google-3dtiles', icon: '🌍', label: '3DT · Google Photorealistic', type: 'mesh', url: 'https://tile.googleapis.com/v1/3dtiles/root.json?key=REMOVED_GOOGLE_API_KEY' },
  { id: 'esri-portcoast', icon: '🌍', label: '3DT · ESRI Portcoast (mesh)', type: 'mesh', url: 'https://tiles.arcgis.com/tiles/V6ZHFr6zdgNZuVG0/arcgis/rest/services/Portcoast_industrial/3DTilesServer/tileset.json' },
  { id: 'esri-mantes', icon: '🌍', label: '3DT · ESRI Mantes-la-Jolie (splat)', type: 'splat', url: 'https://tiles.arcgis.com/tiles/uujCiiEZAflDbdxE/arcgis/rest/services/Coll%C3%A9giale_Mantes_la_Jolie_Drone_3D_Gaussian_Splat/3DTilesServer/tileset.json' },
  { id: 'agisoft-jam', icon: '☁', label: '3DT · Agisoft Jam (Cloud)', type: 'mesh', url: `${MW}/proxy?url=${encodeURIComponent('https://cloud.agisoft.com/api/teams/b9910e8d-6a0a-4e99-b389-d0a4e1939ce7/projects/2dfa164c-b36b-457f-83a2-488a3f158fa0/datasets/4dbe0ec8-f38e-4fc4-b136-b54f2d52c225/tilesets/aa1dd5c4-6c78-4a82-83ab-86e51c02f3d9/tileset.json?access=3c0b69cf-b7bf-44d0-9662-b3b016b8ba82')}` },
];

export const PSEUDO_FORMATS: [string, string][] = [
  ['3dtiles', '◈ 3D Tiles'],
  ['packages', '📦 Packages'],
  ['bing', '🗺 Bing 3D'],
  ['threemx', '🏛 3MX'],
  ['geosplats', '✨ GeoSplats'],
];

// The single, deliberately-grouped render order for the format pill row — cuts across the FORMATS
// vs. PSEUDO_FORMATS split (GeoSplats moves next to the other splat formats, I3S moves next to the
// other tileset-native/mesh formats), which is why this can't just be "FORMATS then PSEUDO_FORMATS"
// in array order. `group` drives the visual separators TopBar renders between clusters:
//   0: point-cloud octrees (COPC, Potree)
//   1: splat formats (SOG, LCC, GeoSplats, RAD)
//   2: tileset-native / mesh formats (3D Tiles, Packages, I3S, 3MX, Bing)
export const FORMAT_PILL_ORDER: { id: string; group: number }[] = [
  { id: 'copc', group: 0 },
  { id: 'potree', group: 0 },
  { id: 'sog', group: 1 },
  { id: 'lcc', group: 1 },
  { id: 'geosplats', group: 1 },
  { id: 'rad', group: 1 },
  { id: '3dtiles', group: 2 },
  { id: 'packages', group: 2 },
  { id: 'i3s', group: 2 },
  { id: 'threemx', group: 2 },
  { id: 'bing', group: 2 },
];

/** Look up a pill's icon+label whether it's a real FORMATS entry or a PSEUDO_FORMATS one. */
export function pillMeta(id: string): { icon: string; label: string } | null {
  const f = FORMATS.find((x) => x.fmt === id);
  if (f) return { icon: f.icon, label: f.label };
  const p = PSEUDO_FORMATS.find(([v]) => v === id);
  return p ? { icon: '', label: p[1] } : null;
}

export const fmtMeta = (fmt: string) => FORMATS.find((f) => f.fmt === fmt);
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
