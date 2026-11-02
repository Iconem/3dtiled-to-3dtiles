/**
 * terrain.js — sample open Terrarium elevation tiles in Node (for /aggregate's `&snap=`).
 *
 * Same sources as the viewer's lib/terrarium.ts. Heights are in the source's datum; the default,
 * `mapterhorn-ellipsoid`, is ellipsoidal like 3D Tiles themselves. Tiles are decoded once (WebP via
 * the @jsquash WASM codec — no native dependency — PNG via pngjs) and kept in a small LRU. A point is
 * read from the deepest available tile at or above the requested zoom.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);

export const TERRAINS = {
  wgs84: { flat: true },                       // the bare ellipsoid: every height is 0
  'mapterhorn-ellipsoid': { url: 'https://terrain.reearth.land/mapterhorn-egm08/terrarium/ellipsoid/{z}/{x}/{y}.webp', size: 512, maxZoom: 14, datum: 'ellipsoid' },
  mapterhorn: { url: 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp', size: 512, maxZoom: 17, datum: 'sea level' },
  terrarium: { url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png', size: 256, maxZoom: 15, datum: 'sea level' },
};

let webpDecode = null;
async function decodeWebp(buf) {
  if (!webpDecode) {
    const mod = await import('@jsquash/webp/decode.js');
    const pkgDir = dirname(require.resolve('@jsquash/webp/package.json'));
    await mod.init(await WebAssembly.compile(readFileSync(pkgDir + '/codec/dec/webp_dec.wasm')));
    webpDecode = mod.default;
  }
  return webpDecode(buf);
}

async function decodePng(buf) {
  const { PNG } = await import('pngjs');
  const png = PNG.sync.read(Buffer.from(buf));
  return { data: png.data, width: png.width, height: png.height };
}

const cache = new Map();                       // key → Promise<{h, n} | null>
function tile(src, z, x, y) {
  const key = `${src.url}|${z}/${x}/${y}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const r = await fetch(src.url.replace('{z}', z).replace('{x}', x).replace('{y}', y));
      if (!r.ok) return null;
      const buf = await r.arrayBuffer();
      const img = src.url.endsWith('.png') ? await decodePng(buf) : await decodeWebp(buf);
      const n = img.width;
      const h = new Float32Array(n * n);
      for (let i = 0; i < h.length; i++) h[i] = img.data[i * 4] * 256 + img.data[i * 4 + 1] + img.data[i * 4 + 2] / 256 - 32768;
      return { h, n };
    })().catch(() => null);
    cache.set(key, p);
    if (cache.size > 512) cache.delete(cache.keys().next().value);
  }
  return p;
}

/** Height at (lon°, lat°), or null. */
export async function sampleTerrain(id, lon, lat, zoom = 14) {
  const src = TERRAINS[id];
  if (!src) throw new Error(`unknown terrain "${id}" — ${Object.keys(TERRAINS).join(', ')}`);
  if (src.flat) return 0;
  const z0 = Math.min(zoom, src.maxZoom);
  const n0 = 2 ** z0;
  const fx = ((lon + 180) / 360) * n0;
  const fy = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n0;
  for (let d = 0; d <= z0; d++) {
    const z = z0 - d, s = 2 ** d;
    const x = Math.floor(fx / s), y = Math.floor(fy / s);
    const t = await tile(src, z, x, y);
    if (!t) continue;
    const px = ((fx / s) - x) * t.n - 0.5, py = ((fy / s) - y) * t.n - 0.5;
    const x0 = Math.max(0, Math.min(t.n - 1, Math.floor(px))), y0 = Math.max(0, Math.min(t.n - 1, Math.floor(py)));
    const x1 = Math.min(t.n - 1, x0 + 1), y1 = Math.min(t.n - 1, y0 + 1);
    const tx = Math.max(0, Math.min(1, px - x0)), ty = Math.max(0, Math.min(1, py - y0));
    const a = t.h[y0 * t.n + x0] * (1 - tx) + t.h[y0 * t.n + x1] * tx;
    const b = t.h[y1 * t.n + x0] * (1 - tx) + t.h[y1 * t.n + x1] * tx;
    return a * (1 - ty) + b * ty;
  }
  return null;
}
