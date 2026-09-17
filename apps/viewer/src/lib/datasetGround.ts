/**
 * Where is the ground of a dataset? Read from the dataset's OWN coarse geometry, not from picks.
 *
 * Picking a grid of vertical rays against a rendered tileset (the first version of "snap to ground")
 * depends on what happens to be loaded and on each renderer's pick tolerance: over sparse points most
 * rays miss, wide pick volumes return the highest point in a column, and the two renderers disagreed.
 * Instead, fetch the tileset's top content (the root tile, or the first tiles under a content-less
 * root), decode its positions, and bin them on a horizontal grid: each bin's low points estimate the
 * ground there. Every sample then sits where the dataset actually has data, and the answer is the same
 * whatever renderer is showing it.
 *
 * Reads glTF/GLB (float POSITION, node transforms, CESIUM_RTC), b3dm (RTC_CENTER) and pnts (POSITION,
 * RTC_CENTER). Draco/meshopt-compressed or quantized content is skipped — the caller falls back to picks.
 */
import { llhToEcef, ecefToLlh } from '@/builder/geo';

export interface GroundSample { lon: number; lat: number; h: number; n: number }

type M4 = number[];                                     // column-major 4×4
const I4: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a: M4, b: M4): M4 {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
const apply = (m: M4, x: number, y: number, z: number): [number, number, number] =>
  [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
const translate = (x: number, y: number, z: number): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
// 3D Tiles: glTF is Y-up, tiles are Z-up → rotate +90° about X: (x, y, z) → (x, −z, y)
const Y_UP_TO_Z_UP: M4 = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

function trs(n: any): M4 {
  if (Array.isArray(n.matrix)) return n.matrix;
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (qy * qy + qz * qz)) * sx, 2 * (qx * qy + qz * qw) * sx, 2 * (qx * qz - qy * qw) * sx, 0,
    2 * (qx * qy - qz * qw) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, 2 * (qy * qz + qx * qw) * sy, 0,
    2 * (qx * qz + qy * qw) * sz, 2 * (qy * qz - qx * qw) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/** ECEF positions of a GLB, with `tileM` the tile's transform chain. Null if unreadable/compressed. */
function glbPositions(buf: ArrayBuffer, tileM: M4, out: number[], budget: number, zUp = false): boolean {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) return false;               // 'glTF'
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
  const binStart = 20 + jsonLen + 8;
  if ((json.extensionsRequired ?? []).some((e: string) => /draco|meshopt|quantization/i.test(e))) return false;
  const rtc = json.extensions?.CESIUM_RTC?.center;
  const base = mul(mul(tileM, rtc ? translate(rtc[0], rtc[1], rtc[2]) : I4), zUp ? I4 : Y_UP_TO_Z_UP);
  const scene = json.scenes?.[json.scene ?? 0];
  let found = false;
  const visit = (ni: number, parent: M4) => {
    const node = json.nodes[ni];
    const m = mul(parent, trs(node));
    if (node.mesh != null) {
      for (const prim of json.meshes[node.mesh].primitives ?? []) {
        const acc = json.accessors[prim.attributes?.POSITION];
        if (!acc || acc.componentType !== 5126 || acc.sparse) continue;
        const bv = json.bufferViews[acc.bufferView];
        const stride = bv.byteStride || 12;
        const off = binStart + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
        const step = Math.max(1, Math.floor(acc.count / budget));
        for (let i = 0; i < acc.count; i += step) {
          const p = apply(m, dv.getFloat32(off + i * stride, true), dv.getFloat32(off + i * stride + 4, true), dv.getFloat32(off + i * stride + 8, true));
          out.push(p[0], p[1], p[2]);
        }
        found = true;
      }
    }
    for (const c of node.children ?? []) visit(c, m);
  };
  for (const ni of scene?.nodes ?? []) visit(ni, base);
  return found;
}

/** Positions of one content file (glb / b3dm / pnts). */
function contentPositions(buf: ArrayBuffer, tileM: M4, out: number[], budget: number, zUp = false): boolean {
  const dv = new DataView(buf);
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
  if (magic === 'glTF') return glbPositions(buf, tileM, out, budget, zUp);
  if (magic !== 'b3dm' && magic !== 'pnts') return false;
  const ftJson = dv.getUint32(12, true), ftBin = dv.getUint32(16, true), btJson = dv.getUint32(20, true), btBin = dv.getUint32(24, true);
  const ft = ftJson ? JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 28, ftJson))) : {};
  const rtc = ft.RTC_CENTER;
  const m = rtc ? mul(tileM, translate(rtc[0], rtc[1], rtc[2])) : tileM;
  if (magic === 'b3dm') return glbPositions(buf.slice(28 + ftJson + ftBin + btJson + btBin), m, out, budget, zUp);
  if (ft.POSITION == null) return false;                                 // quantized pnts: skip
  const off = 28 + ftJson + (ft.POSITION.byteOffset ?? 0);
  const count = ft.POINTS_LENGTH as number;
  const step = Math.max(1, Math.floor(count / budget));
  for (let i = 0; i < count; i += step) {
    // pnts positions are already Z-up
    const p = apply(m, dv.getFloat32(off + i * 12, true), dv.getFloat32(off + i * 12 + 4, true), dv.getFloat32(off + i * 12 + 8, true));
    out.push(p[0], p[1], p[2]);
  }
  return count > 0;
}

const colM = (t?: number[]): M4 => (Array.isArray(t) && t.length === 16 ? t : I4);

/**
 * Up to `maxFiles` content files from the top of the tree (breadth-first), each with its transform
 * chain. An implicit root's content is its level-0 tile; an external tileset is followed.
 */
async function topContents(url: string, maxFiles: number, signal?: AbortSignal) {
  // 3D Tiles 1.0 `asset.gltfUpAxis` (default Y) — a few legacy producers wrote Z-up glTF
  const found: { url: string; m: M4; zUp: boolean }[] = [];
  const queue: { tile: any; base: string; m: M4; zUp: boolean }[] = [];
  const ts = await (await fetch(url, { signal })).json();
  queue.push({ tile: ts.root, base: url, m: colM(ts.root.transform), zUp: ts.asset?.gltfUpAxis === 'Z' });
  while (queue.length && found.length < maxFiles) {
    const { tile, base, m, zUp } = queue.shift()!;
    let uri: string | undefined = tile.content?.uri ?? tile.content?.url;
    if (tile.implicitTiling && uri) uri = uri.replace('{level}', '0').replace('{x}', '0').replace('{y}', '0').replace('{z}', '0');
    if (uri) {
      const abs = new URL(uri, base).href;
      const au = new URL(abs);
      // a wrapper endpoint (/proxy?url=…) names the real resource in its `url` parameter
      if (/\.json$/i.test(au.pathname) || au.pathname.endsWith('/proxy') && /\.json$/i.test(au.searchParams.get('url')?.split('?')[0] ?? '')) {
        const ext = await (await fetch(abs, { signal })).json();
        queue.push({ tile: ext.root, base: abs, m: mul(m, colM(ext.root.transform)), zUp: ext.asset?.gltfUpAxis === 'Z' });
        continue;
      }
      found.push({ url: abs, m, zUp });
      if (found.length >= maxFiles) break;
      continue;                                  // the first content level is enough
    }
    for (const c of tile.implicitTiling ? [] : tile.children ?? []) queue.push({ tile: c, base, m: mul(m, colM(c.transform)), zUp });
  }
  return found;
}

/**
 * Ground samples of a tileset: its top content binned on a `grid`×`grid` horizontal grid; each bin
 * reports its 10th-percentile height (a robust "lowest") in ellipsoidal metres. Null when nothing
 * readable was found.
 */
export async function datasetGroundSamples(tilesetUrl: string, { grid = 12, budget = 60_000, signal }: { grid?: number; budget?: number; signal?: AbortSignal } = {}): Promise<GroundSample[] | null> {
  const files = await topContents(tilesetUrl, 4, signal);
  const pts: number[] = [];
  for (const f of files) {
    try {
      const buf = await (await fetch(f.url, { signal })).arrayBuffer();
      contentPositions(buf, f.m, pts, Math.ceil(budget / files.length), f.zUp);
    } catch { /* one unreadable tile is not fatal */ }
  }
  if (pts.length < 30) return null;

  // Local east/north frame at the centroid, for binning in metres.
  let cx = 0, cy = 0, cz = 0;
  const n = pts.length / 3;
  for (let i = 0; i < pts.length; i += 3) { cx += pts[i]; cy += pts[i + 1]; cz += pts[i + 2]; }
  cx /= n; cy /= n; cz /= n;
  const [lon0, lat0] = ecefToLlh(cx, cy, cz);
  const lo = (lon0 * Math.PI) / 180, la = (lat0 * Math.PI) / 180;
  const E = [-Math.sin(lo), Math.cos(lo), 0];
  const N = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
  const e = new Float64Array(n), no = new Float64Array(n);
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  for (let i = 0; i < n; i++) {
    const dx = pts[3 * i] - cx, dy = pts[3 * i + 1] - cy, dz = pts[3 * i + 2] - cz;
    e[i] = dx * E[0] + dy * E[1] + dz * E[2];
    no[i] = dx * N[0] + dy * N[1] + dz * N[2];
    minE = Math.min(minE, e[i]); maxE = Math.max(maxE, e[i]); minN = Math.min(minN, no[i]); maxN = Math.max(maxN, no[i]);
  }
  const bins = new Map<number, number[]>();
  const w = (maxE - minE) / grid || 1, hgt = (maxN - minN) / grid || 1;
  for (let i = 0; i < n; i++) {
    const bx = Math.min(grid - 1, Math.floor((e[i] - minE) / w)), by = Math.min(grid - 1, Math.floor((no[i] - minN) / hgt));
    const k = by * grid + bx;
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k)!.push(i);
  }
  const out: GroundSample[] = [];
  for (const idx of bins.values()) {
    if (idx.length < 3) continue;
    const hs = idx.map((i) => ({ i, h: ecefToLlh(pts[3 * i], pts[3 * i + 1], pts[3 * i + 2])[2] })).sort((a, b) => a.h - b.h);
    const pick = hs[Math.floor(0.1 * (hs.length - 1))];
    const [lon, lat, h] = ecefToLlh(pts[3 * pick.i], pts[3 * pick.i + 1], pts[3 * pick.i + 2]);
    out.push({ lon, lat, h, n: idx.length });
  }
  return out.length ? out : null;
}

/**
 * The Z offset that puts a dataset on the terrain: `terrain(sample) − ground(sample)` over all bins,
 * at the 70th percentile — bins on roofs or canopy give smaller (more negative) differences, bins
 * with below-ground noise larger ones, and most bins are ground.
 */
export function offsetFromSamples(samples: GroundSample[], terrain: (number | null)[]): { dz: number; used: number; spread: number } | null {
  const d = samples.map((s, i) => (terrain[i] == null || !Number.isFinite(terrain[i]!) ? NaN : terrain[i]! - s.h)).filter(Number.isFinite).sort((a, b) => a - b);
  if (d.length < 3) return null;
  return { dz: d[Math.floor(0.7 * (d.length - 1))], used: d.length, spread: d[d.length - 1] - d[0] };
}

export { llhToEcef };
