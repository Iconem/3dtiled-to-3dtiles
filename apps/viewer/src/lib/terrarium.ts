/**
 * Open raster elevation (Terrarium-encoded XYZ tiles) for both renderers, plus the open quantized-mesh
 * alternative. No keys anywhere.
 *
 * | id                   | source                                   | px  | max z | heights            |
 * |----------------------|------------------------------------------|-----|-------|--------------------|
 * | terrarium            | AWS Terrain Tiles (Mapzen)               | 256 | 15    | mean sea level     |
 * | mapterhorn           | tiles.mapterhorn.com                     | 512 | 12–17 | mean sea level     |
 * | mapterhorn-ellipsoid | Re:Earth mirror of Mapterhorn + EGM2008  | 512 | 14    | WGS84 ellipsoid    |
 * | reearth-qm           | Re:Earth quantized mesh (same data)      | —   | 14    | WGS84 ellipsoid    |
 *
 * The datum matters as soon as data meets terrain: 3D Tiles are placed in ECEF, i.e. on the ELLIPSOID,
 * while sea-level heights sit lower or higher by the geoid undulation (+55 m in the Alps, −100 m off
 * India). The two ellipsoidal sources are the ones to snap datasets against.
 *
 * 3DTRjs renders the rasters natively (TerrariumMeshPlugin). Cesium does not read Terrarium, so a
 * CustomHeightmapTerrainProvider on a web-mercator scheme adapts it: each Cesium tile (x, y, level)
 * is the XYZ tile of the same address. Deeper than the source goes — or where a source simply has no
 * tile (Mapterhorn is z12 globally, deeper only where regional DEMs exist) — the tile is cut out of
 * its nearest available ancestor, so the surface keeps refining instead of dropping to sea level.
 */
import * as Cesium from 'cesium';

export type RasterTerrainId = 'terrarium' | 'mapterhorn' | 'mapterhorn-ellipsoid';

export interface RasterTerrain {
  url: string;
  tileSize: number;
  maxZoom: number;
  datum: 'sea level' | 'ellipsoid';
  credit: string;
}

export const RASTER_TERRAINS: Record<RasterTerrainId, RasterTerrain> = {
  terrarium: {
    url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    tileSize: 256, maxZoom: 15, datum: 'sea level',
    credit: 'Terrain Tiles: Mapzen / AWS Open Data (SRTM, GMTED, ETOPO1, NED, …)',
  },
  mapterhorn: {
    url: 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp',
    tileSize: 512, maxZoom: 17, datum: 'sea level',
    credit: 'Mapterhorn (mapterhorn.com)',
  },
  'mapterhorn-ellipsoid': {
    url: 'https://terrain.reearth.land/mapterhorn-egm08/terrarium/ellipsoid/{z}/{x}/{y}.webp',
    tileSize: 512, maxZoom: 14, datum: 'ellipsoid',
    credit: 'Mapterhorn + EGM2008, served by Re:Earth Terrain (terrain.reearth.land)',
  },
};

/** Re:Earth's quantized-mesh version of the ellipsoidal Mapterhorn DEM (layer.json at this base). */
export const REEARTH_QM_URL = 'https://terrain.reearth.land/cesium-mesh/ellipsoid';

// Back-compat for the first version of this module.
export const TERRARIUM_URL = RASTER_TERRAINS.terrarium.url;
export const TERRARIUM_MAX_ZOOM = RASTER_TERRAINS.terrarium.maxZoom;

const POSTS = 65;                         // heightmap posts per side (Cesium's usual 65×65)
const decoded = new Map<string, Promise<Float32Array | null>>();

/** One source tile → size×size heights (null when the source has no such tile). Cached, bounded. */
function sourceTile(src: RasterTerrain, z: number, x: number, y: number): Promise<Float32Array | null> {
  const key = `${src.url}|${z}/${x}/${y}`;
  let p = decoded.get(key);
  if (!p) {
    p = (async () => {
      const res = await fetch(src.url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
      if (!res.ok) return null;
      const bmp = await createImageBitmap(await res.blob());
      const n = src.tileSize;
      const canvas = new OffscreenCanvas(n, n);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0, n, n);
      const rgba = ctx.getImageData(0, 0, n, n).data;
      const h = new Float32Array(n * n);
      for (let i = 0; i < h.length; i++) h[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
      return h;
    })().catch(() => null);
    decoded.set(key, p);
    if (decoded.size > 256) decoded.delete(decoded.keys().next().value!);
  }
  return p;
}

function bilinear(h: Float32Array, n: number, px: number, py: number): number {
  const x0 = Math.min(n - 1, Math.max(0, Math.floor(px))), y0 = Math.min(n - 1, Math.max(0, Math.floor(py)));
  const x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1);
  const tx = Math.min(1, Math.max(0, px - x0)), ty = Math.min(1, Math.max(0, py - y0));
  const a = h[y0 * n + x0] * (1 - tx) + h[y0 * n + x1] * tx;
  const b = h[y1 * n + x0] * (1 - tx) + h[y1 * n + x1] * tx;
  return a * (1 - ty) + b * ty;
}

/** The nearest available tile at or above (z, x, y), with this tile's window inside it. */
async function ancestorTile(src: RasterTerrain, level: number, x: number, y: number) {
  for (let d = Math.max(0, level - src.maxZoom); d <= level; d++) {
    const z = level - d, ax = x >> d, ay = y >> d;
    const h = await sourceTile(src, z, ax, ay);
    if (h) return { h, d, ax, ay };
  }
  return null;
}

export function createRasterTerrainProvider(id: RasterTerrainId): Cesium.TerrainProvider {
  const src = RASTER_TERRAINS[id];
  return new Cesium.CustomHeightmapTerrainProvider({
    width: POSTS,
    height: POSTS,
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    credit: src.credit,
    callback: (async (x: number, y: number, level: number) => {
      const t = await ancestorTile(src, level, x, y);
      if (!t) return new Float32Array(POSTS * POSTS);             // no data anywhere above → sea level
      const n = src.tileSize;
      const span = n / 2 ** t.d, ox = (x - (t.ax << t.d)) * span, oy = (y - (t.ay << t.d)) * span;
      const out = new Float32Array(POSTS * POSTS);
      for (let r = 0; r < POSTS; r++) {
        for (let c = 0; c < POSTS; c++) {
          // posts sit ON the tile edges, so neighbouring tiles share their border heights
          out[r * POSTS + c] = bilinear(t.h, n, ox + (c / (POSTS - 1)) * span - 0.5, oy + (r / (POSTS - 1)) * span - 0.5);
        }
      }
      return out;
    }) as any,
  });
}

/** @deprecated first version's name — AWS Terrain Tiles. */
export const createTerrariumTerrainProvider = () => createRasterTerrainProvider('terrarium');

/** Height (m, in the source's datum) of one lon/lat at a given zoom — for sampling without a renderer. */
export async function sampleRasterTerrain(id: RasterTerrainId, lon: number, lat: number, zoom = 14): Promise<number | null> {
  const src = RASTER_TERRAINS[id];
  const n = 2 ** zoom;
  const fx = ((lon + 180) / 360) * n;
  const latR = (lat * Math.PI) / 180;
  const fy = ((1 - Math.asinh(Math.tan(latR)) / Math.PI) / 2) * n;
  const x = Math.floor(fx), y = Math.floor(fy);
  const t = await ancestorTile(src, zoom, x, y);
  if (!t) return null;
  const span = src.tileSize / 2 ** t.d;
  return bilinear(t.h, src.tileSize, (fx - (t.ax << t.d)) * span - 0.5, (fy - (t.ay << t.d)) * span - 0.5);
}
