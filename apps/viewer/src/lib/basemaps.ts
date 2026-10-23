/**
 * Raster basemaps shared by both renderers. Esri World Imagery with the World Boundaries and Places
 * label layer on top is the default: global, sharp, sends CORS headers (3DTRjs fetches tiles with
 * fetch(), so it needs them — Google's hotlink does not, and goes through /proxy), and needs no key.
 * Esri tiles are addressed {z}/{y}/{x}.
 */
export type BasemapId = 'esri' | 'google' | 'osm' | 'none';

export interface RasterLayer { url: string; maxZoom: number; credit: string; proxy?: boolean }

const ESRI = 'https://services.arcgisonline.com/ArcGIS/rest/services';

export const BASEMAPS: Record<Exclude<BasemapId, 'none'>, { label: string; layers: RasterLayer[] }> = {
  esri: {
    label: 'Esri World Imagery + labels',
    layers: [
      { url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, maxZoom: 19, credit: 'Esri, Maxar, Earthstar Geographics' },
      { url: `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, maxZoom: 19, credit: 'Esri' },
    ],
  },
  google: {
    label: 'Google Hybrid',
    layers: [{ url: 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', maxZoom: 21, credit: 'Google Hybrid', proxy: true }],
  },
  osm: {
    label: 'OpenStreetMap',
    layers: [{ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, credit: '© OpenStreetMap contributors' }],
  },
};
