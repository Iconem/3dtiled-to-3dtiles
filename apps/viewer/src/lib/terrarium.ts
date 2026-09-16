/**
 * Terrarium elevation (the open AWS Terrain Tiles, no key) as a Cesium terrain provider.
 *
 * 3DTRjs has this natively (TerrariumMeshPlugin); Cesium does not, but a CustomHeightmapTerrainProvider
 * on a web-mercator tiling scheme lines up 1:1 with the XYZ tiles: each Cesium tile (x, y, level) is
 * the Terrarium tile of the same address. The source stops at zoom 15; deeper tiles are cut out of their
 * zoom-15 ancestor, so the surface keeps refining geometrically instead of disappearing.
 *
 * Heights are metres above mean sea level (EGM96-ish), not above the WGS84 ellipsoid: the ~±100 m geoid
 * separation is NOT corrected. "Snap to ground" compares a dataset against whatever terrain is active,
 * so that offset is part of what it measures.
 */
import * as Cesium from 'cesium';

export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TERRARIUM_MAX_ZOOM = 15;
const POSTS = 65;                         // heightmap posts per side (Cesium's usual 65×65)
const SRC = 256;                          // Terrarium tile pixels per side

const decoded = new Map<string, Promise<Float32Array | null>>();

/** One Terrarium tile → 256×256 heights, cached (bounded, oldest first). */
function sourceTile(z: number, x: number, y: number): Promise<Float32Array | null> {
  const key = `${z}/${x}/${y}`;
  let p = decoded.get(key);
  if (!p) {
    p = (async () => {
      const res = await fetch(TERRARIUM_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
      if (!res.ok) return null;
      const bmp = await createImageBitmap(await res.blob());
      const canvas = new OffscreenCanvas(SRC, SRC);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0);
      const rgba = ctx.getImageData(0, 0, SRC, SRC).data;
      const h = new Float32Array(SRC * SRC);
      for (let i = 0; i < h.length; i++) h[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
      return h;
    })().catch(() => null);
    decoded.set(key, p);
    if (decoded.size > 256) decoded.delete(decoded.keys().next().value!);
  }
  return p;
}

function bilinear(h: Float32Array, px: number, py: number): number {
  const x0 = Math.min(SRC - 1, Math.max(0, Math.floor(px))), y0 = Math.min(SRC - 1, Math.max(0, Math.floor(py)));
  const x1 = Math.min(SRC - 1, x0 + 1), y1 = Math.min(SRC - 1, y0 + 1);
  const tx = px - x0, ty = py - y0;
  const a = h[y0 * SRC + x0] * (1 - tx) + h[y0 * SRC + x1] * tx;
  const b = h[y1 * SRC + x0] * (1 - tx) + h[y1 * SRC + x1] * tx;
  return a * (1 - ty) + b * ty;
}

export function createTerrariumTerrainProvider(): Cesium.TerrainProvider {
  return new Cesium.CustomHeightmapTerrainProvider({
    width: POSTS,
    height: POSTS,
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    credit: 'Terrain Tiles: Mapzen / AWS Open Data (SRTM, GMTED, ETOPO1, NED, …)',
    callback: (async (x: number, y: number, level: number) => {
      const d = Math.max(0, level - TERRARIUM_MAX_ZOOM);
      const sz = level - d, sx = x >> d, sy = y >> d;
      const src = await sourceTile(sz, sx, sy);
      if (!src) return new Float32Array(POSTS * POSTS);          // ocean / missing → sea level
      // this tile's window inside its source tile, in source pixels
      const span = SRC / 2 ** d, ox = (x - (sx << d)) * span, oy = (y - (sy << d)) * span;
      const out = new Float32Array(POSTS * POSTS);
      for (let r = 0; r < POSTS; r++) {
        for (let c = 0; c < POSTS; c++) {
          // posts sit ON the tile edges, so neighbouring tiles share their border heights
          out[r * POSTS + c] = bilinear(src, ox + (c / (POSTS - 1)) * span - 0.5, oy + (r / (POSTS - 1)) * span - 0.5);
        }
      }
      return out;
    }) as any,
  });
}
