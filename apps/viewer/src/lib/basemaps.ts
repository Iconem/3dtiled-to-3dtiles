/**
 * Raster basemaps shared by both renderers. Esri World Imagery alone (no labels) is the default: a
 * clean satellite ground under point clouds, global, sharp, sends CORS headers (3DTRjs fetches tiles
 * with fetch(), so it needs them — Google's hotlink does not, and goes through /proxy), and needs no
 * key. Esri tiles are addressed {z}/{y}/{x}. "Esri + labels" adds the World Boundaries and Places
 * layer on top. Mapbox Satellite is listed when `VITE_MAPBOX_TOKEN` is set at build time.
 */
export type BasemapId = 'esri-sat' | 'esri' | 'mapbox' | 'google' | 'osm' | 'none';

export interface RasterLayer { url: string; maxZoom: number; credit: string; proxy?: boolean }
export interface Basemap { label: string; layers: RasterLayer[] }

const ESRI = 'https://services.arcgisonline.com/ArcGIS/rest/services';
// blankTile=false: where Esri has no imagery at a level it answers 404 instead of a grey "no data"
// tile, so the renderer keeps the parent's imagery there rather than drawing the placeholder.
const ESRI_IMAGERY: RasterLayer = { url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}?blankTile=false`, maxZoom: 19, credit: 'Esri, Maxar, Earthstar Geographics' };
const MAPBOX_TOKEN = (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined) || '';

export const BASEMAPS: { [K in Exclude<BasemapId, 'none'>]?: Basemap } = {
  'esri-sat': { label: 'Esri World Imagery', layers: [ESRI_IMAGERY] },
  esri: {
    label: 'Esri World Imagery + labels',
    layers: [
      ESRI_IMAGERY,
      { url: `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, maxZoom: 19, credit: 'Esri' },
    ],
  },
  ...(MAPBOX_TOKEN ? {
    mapbox: {
      label: 'Mapbox Satellite',
      layers: [{ url: `https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=${MAPBOX_TOKEN}`, maxZoom: 22, credit: '© Mapbox © Maxar' }],
    },
  } : {}),
  google: {
    label: 'Google Hybrid',
    layers: [{ url: 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', maxZoom: 21, credit: 'Google Hybrid', proxy: true }],
  },
  osm: {
    label: 'OpenStreetMap',
    layers: [{ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, credit: '© OpenStreetMap contributors' }],
  },
};

/** The layers of a basemap, bottom first; none for 'none' or an id this build does not offer. */
/** The basemap a fresh session opens with: Mapbox Satellite when this build has a token, else Esri. */
export const DEFAULT_BASEMAP: BasemapId = MAPBOX_TOKEN ? 'mapbox' : 'esri-sat';

export const basemapLayers = (id: BasemapId): RasterLayer[] => (id === 'none' ? [] : BASEMAPS[id]?.layers ?? []);
