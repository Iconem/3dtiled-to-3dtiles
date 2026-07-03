// Ported verbatim (same ids/labels/urls) from viewer.html's FORMATS/DIRECT/TOOLS_DATASETS/SNIPPETS —
// see C:\Dev\Iconem\3d-tiles-converters\viewer.html lines ~578-834.

export const MW = 'http://localhost:3001'; // tile-server middleware
export const SDATA = 'http://localhost:3000/sample-data'; // sample data served by the MAIN vite dev server

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
    { id: 'autzen', label: 'Autzen', src: 'input/COPC/autzen.copc.laz', out: 'output/copc/autzen-3dtiles-from-copc' },
    { id: 'eiffel', label: 'Eiffel', src: 'input/COPC/eiffel.copc.laz', out: 'output/copc/eiffel-3dtiles-from-copc' },
    { id: 'texas', label: 'Texas', src: 'input/COPC/texas.copc.laz', out: 'output/copc/texas-3dtiles-from-copc' },
  ] },
  { fmt: 'potree', icon: '🌲', label: 'Potree', type: 'pointcloud', octree: true, stream: true, assets: [
    { id: 'lion2', label: 'Lion 2.0', src: 'input/POTREE/lion_p2/metadata.json', out: 'output/potree/lion_p2' },
    { id: 'takanawa', label: 'Lion Takanawa 1.x', src: 'input/POTREE/lion_takanawa/cloud.js', out: 'output/potree/lion_takanawa' },
    { id: 'takalaz', label: 'Lion Takanawa LAZ', src: 'input/POTREE/lion_takanawa_laz/cloud.js', out: 'output/potree/lion_takanawa_laz' },
    { id: 'voltotal', label: 'Vol Total', src: 'input/POTREE/vol_total/cloud.js', out: 'output/potree/vol_total' },
    { id: 'geghard', label: 'Geghard (iconem) ⬀', src: 'https://api.iconem.com/s/rIdPkRfOmEdRtgsoO08TgNt9MSxh-woC/cloud.js' },
  ] },
  { fmt: 'sog', icon: '⬢', label: 'SOG', type: 'splat', octree: false, stream: true, assets: [
    { id: 'skatepark', label: 'Skatepark', src: 'input/SOG/skatepark/lod-meta.json', out: 'output/sog/skatepark-3dtiles-from-sog' },
    { id: 'roman', label: 'Roman Parish', src: 'input/SOG/roman-parish/lod-meta.json', out: 'output/sog/roman-parish-3dtiles-from-sog' },
    { id: 'arrival-jaffa', label: 'Arrival jaffa3 (.lod) ⬀', src: 'https://ugc.arrival.space/71585765/14ae36863868a5f74fbc29389e156bc5f18e0d7a612af78c492cd84cfa4a9c44_jaffa3_1777965648677_LOD/lod-meta.json' },
  ] },
  { fmt: 'lcc', icon: '◆', label: 'LCC', type: 'splat', octree: false, stream: true, assets: [
    { id: 'guan', label: 'Guan Temple', src: 'input/LCC/Guan_Temple/meta.lcc', out: 'output/lcc/Guan_Temple-3dtiles-from-lcc' },
    { id: 'guanlan', label: 'Guanlan Town', src: 'input/LCC/Guanlan Ancient Town/meta.lcc', out: 'output/lcc/Guanlan_Ancient_Town-3dtiles-from-lcc' },
    { id: 'religious', label: 'Religious Center', src: 'input/LCC/religious_center_L2_P/meta.lcc', out: 'output/lcc/religious_center_L2_P-3dtiles-from-lcc' },
  ] },
  { fmt: 'rad', icon: '✦', label: 'RAD', type: 'splat', octree: false, stream: true, assets: [
    { id: 'coit', label: 'Coit', src: 'input/RAD/coit.rad', out: 'output/rad/coit-3dtiles-from-rad' },
    { id: 'tastier', label: 'Tastier', src: 'input/RAD/tastier500k.rad', out: 'output/rad/tastier500k-3dtiles-from-rad' },
    { id: 'elevator', label: 'WIP PLY-RAD · Elevator', src: 'input/PLY/Elevator-lod.rad', out: 'output/rad/Elevator-3dtiles-from-rad' },
    { id: 'svir', label: 'WIP PLY-RAD · Svirnas', src: 'input/PLY/SvirnasAlyt-lod.rad', out: 'output/rad/SvirnasAlyt-3dtiles-from-rad' },
  ] },
  { fmt: 'i3s', icon: '🧱', label: 'I3S', type: 'mesh', octree: false, stream: true, assets: [
    { id: 'nyc', label: 'NYC Buildings', src: 'input/I3S-SLPK/Buildings_NewYork_v18.slpk', streamSrc: 'input/I3S-SLPK/Buildings_NewYork_v18/3dSceneLayer.json.gz', out: 'output/i3s/Buildings_NewYork_v18' },
    { id: 'arcgis-mesh-slpk', label: 'ArcGIS Rancho Mesh (.slpk)', src: 'https://www.arcgis.com/sharing/rest/content/items/95a427c7a6ec4789b03c1a177366b54c/data' },
    { id: 'arcgis-mesh-svc', label: 'ArcGIS Rancho Mesh (SceneServer)', src: 'https://tiles.arcgis.com/tiles/z2tnIkrLQ2BRzr6P/arcgis/rest/services/Rancho_Mesh_v18/SceneServer' },
    { id: 'arcgis-pts-slpk', label: 'ArcGIS Moro Bay LiDAR .slpk (LEPCC — unsupported)', src: 'https://www.arcgis.com/sharing/rest/content/items/496552d059644b4892c51ad06bdba8e2/data' },
    { id: 'arcgis-pts-svc', label: 'ArcGIS Moro Bay LiDAR SceneServer (LEPCC — unsupported)', src: 'https://tiles.arcgis.com/tiles/z2tnIkrLQ2BRzr6P/arcgis/rest/services/Moro_Bay_LiDAR/SceneServer' },
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
