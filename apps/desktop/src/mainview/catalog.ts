/**
 * Sample catalog — a starting library of real, publicly-hosted datasets, one or more per source
 * format this repo reads.
 *
 * These URLs are copied from the viewer app's own `FORMATS` preset table (apps/viewer/src/lib/
 * formats.ts) rather than invented here, so the desktop app demonstrates exactly the sources the
 * rest of the project is tested against. They are deliberately NOT imported from that module: it is
 * a Vite/React file that reads `import.meta.env` and `window`, and apps/desktop is outside the pnpm
 * workspace with its own Bun-flavoured toolchain. Duplication of ~20 string literals is the cheaper
 * of the two couplings — but if a preset URL rots, fix it in both places.
 */

export interface Sample {
  id: string;
  label: string;
  /** Format id understood by the middleware's `&format=` param. */
  format: string;
  /** Source URL handed to `&url=`. */
  src: string;
  /** Where it comes from — shown so nobody mistakes a third-party demo for our own data. */
  origin: string;
}

export interface SampleGroup {
  format: string;
  label: string;
  icon: string;
  kind: 'pointcloud' | 'splat' | 'mesh';
  samples: Sample[];
}

export const CATALOG: SampleGroup[] = [
  {
    format: 'copc', label: 'COPC', icon: '☁', kind: 'pointcloud',
    samples: [
      { id: 'autzen', label: 'Autzen Stadium', format: 'copc', origin: 'hobu', src: 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz' },
      { id: 'eiffel', label: 'Eiffel (LiDAR HD)', format: 'copc', origin: 'IGN geopf.fr', src: 'https://data.geopf.fr/telechargement/download/LiDARHD-NUALID/NUALHD_1-0__LAZ_LAMB93_KE_2025-06-06/LHD_FXX_0648_6863_PTS_LAMB93_IGN69.copc.laz' },
      { id: 'texas', label: 'Texas Coastal', format: 'copc', origin: 'USGS / opengeos', src: 'https://data.opengeos.org/USGS_LPC_TX_CoastalRegion_2018_A18_stratmap18-50cm-2995201a1.copc.laz' },
    ],
  },
  {
    format: 'potree', label: 'Potree', icon: '🌲', kind: 'pointcloud',
    samples: [
      { id: 'lion2', label: 'Lion 2.0', format: 'potree', origin: 'potree.org', src: 'https://potree.org/pointclouds/lion/metadata.json' },
      { id: 'takanawa', label: 'Lion Takanawa 1.x', format: 'potree', origin: 'github.com/potree', src: 'https://raw.githubusercontent.com/potree/potree/develop/pointclouds/lion_takanawa/cloud.js' },
      { id: 'voltotal', label: 'Vol Total (Sorvilier)', format: 'potree', origin: 'github.com/potree', src: 'https://raw.githubusercontent.com/potree/potree/develop/pointclouds/vol_total/cloud.js' },
    ],
  },
  {
    format: 'sog', label: 'SOG (streamed)', icon: '⬢', kind: 'splat',
    samples: [
      { id: 'skatepark', label: 'Skatepark', format: 'sog', origin: 'PlayCanvas', src: 'https://code.playcanvas.com/examples_data/example_skatepark_02/lod-meta.json' },
      { id: 'roman', label: 'Roman Parish', format: 'sog', origin: 'PlayCanvas', src: 'https://code.playcanvas.com/examples_data/example_roman_parish_02/lod-meta.json' },
      { id: 'grace', label: 'Grace Cathedral SF', format: 'sog', origin: 'Vincent Woo (community)', src: 'https://d28zzqy0iyovbz.cloudfront.net/b8b1fd14/v1/lod-meta.json' },
      { id: 'oval', label: 'Oval Interior Spaces', format: 'sog', origin: 'community capture', src: 'https://d28zzqy0iyovbz.cloudfront.net/b7c8d8c5/v1/lod-meta.json' },
    ],
  },
  {
    format: 'lcc', label: 'LCC (XGRIDS)', icon: '◆', kind: 'splat',
    samples: [
      { id: 'bigmirror', label: 'Big Mirror', format: 'lcc', origin: 'willeastcott assets', src: 'https://raw.githubusercontent.com/willeastcott/assets/main/lcc/bigmirror/meta.lcc' },
      { id: 'guan', label: 'Guan Temple (zip)', format: 'lcc', origin: 'XGRIDS sample data', src: 'https://da9i2vj1xvtoc.cloudfront.net/lcc-pub/fine_v2/Guan_Temple.zip' },
    ],
  },
  {
    format: 'rad', label: 'RAD (SparkJS)', icon: '✦', kind: 'splat',
    samples: [
      { id: 'coit', label: 'Coit Tower (40 M)', format: 'rad', origin: 'SparkJS CDN', src: 'https://wlt-ai-cdn.art/spark-2.0/rad/coit-40m-sh1-lod.rad' },
      { id: 'tastier', label: 'Tastier (500 k)', format: 'rad', origin: 'SparkJS CDN', src: 'https://wlt-ai-cdn.art/tastier_rad_500/0524c1a1-abf2-4969-ae40-9981ee836536_500k-lod.rad' },
    ],
  },
  {
    format: 'i3s', label: 'I3S (Esri)', icon: '🧱', kind: 'mesh',
    samples: [
      { id: 'nyc', label: 'New York buildings', format: 'i3s', origin: 'ArcGIS Online', src: 'https://tiles.arcgis.com/tiles/P3ePLMYs2RVChkJx/arcgis/rest/services/Buildings_New_York_3D/SceneServer' },
      { id: 'rancho', label: 'Rancho integrated mesh', format: 'i3s', origin: 'ArcGIS Online', src: 'https://tiles.arcgis.com/tiles/z2tnIkrLQ2BRzr6P/arcgis/rest/services/Rancho_Mesh_v17/SceneServer' },
      { id: 'morobay', label: 'Moro Bay LiDAR', format: 'i3s', origin: 'ArcGIS Online', src: 'https://tiles.arcgis.com/tiles/z2tnIkrLQ2BRzr6P/arcgis/rest/services/Moro_Bay_LiDAR/SceneServer' },
    ],
  },
];

/** External destinations the app links out to. Kept in one place so none are buried in markup. */
export const LINKS = {
  cesiumUnreal: 'https://cesium.com/platform/cesium-for-unreal/',
  cesiumUnity: 'https://cesium.com/platform/cesium-for-unity/',
  cesiumOmniverse: 'https://cesium.com/platform/cesium-for-omniverse/',
  cesiumJs: 'https://cesium.com/platform/cesiumjs/',
  spec: 'https://github.com/CesiumGS/3d-tiles',
  superSplat: 'https://superspl.at/',
  repo: 'https://github.com/jo-chemla/3dtiled-to-3dtiles',
};
