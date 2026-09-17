/**
 * dataset-ground.js — where is the ground of a dataset? Read from the dataset's OWN coarse geometry.
 *
 * Shared by the viewer's "snap to ground" (one loaded tileset) and /aggregate's `&snap=` (every dataset
 * of a mosaic, server-side), so both compute the same offset. Browser-safe: fetch + DataView only.
 *
 * Fetch the tileset's top content (the root tile, the implicit root's level-0 tile, or the first tiles
 * under a content-less root, following external tilesets), decode its positions (glb with node
 * transforms and CESIUM_RTC, b3dm with RTC_CENTER, float pnts; compressed content is skipped), and
 * bin them on a horizontal GRID × GRID grid: each bin's 10th-percentile height estimates the ground
 * there. The top content is a sparse, spatially uniform subsample (Potree/COPC root nodes, a mesh's
 * coarsest LOD), so 8 × 8 bins of a few hundred points each are both populated and robust; 3 × 3
 * mixes a building with its square, 16 × 16 leaves bins with a handful of points.
 */

const A = 6378137.0, E2 = 0.00669437999014, DEG = Math.PI / 180;
const ecefToLlh = (x, y, z) => {
  const b = A * Math.sqrt(1 - E2), ep2 = (A * A - b * b) / (b * b);
  const p = Math.hypot(x, y), th = Math.atan2(A * z, b * p);
  const lat = Math.atan2(z + ep2 * b * Math.sin(th) ** 3, p - E2 * A * Math.cos(th) ** 3);
  const N = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  return [Math.atan2(y, x) / DEG, lat / DEG, p / Math.cos(lat) - N];
};

export const GROUND_GRID = 8;

const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
const apply = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
// 3D Tiles: glTF is Y-up, tiles are Z-up → rotate +90° about X: (x, y, z) → (x, −z, y)
const Y_UP_TO_Z_UP = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
const colM = (t) => (Array.isArray(t) && t.length === 16 ? t : I4);

function trs(n) {
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

function glbPositions(buf, tileM, out, budget, zUp) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) return false;               // 'glTF'
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
  const binStart = 20 + jsonLen + 8;
  if ((json.extensionsRequired ?? []).some((e) => /draco|meshopt|quantization/i.test(e))) return false;
  const rtc = json.extensions?.CESIUM_RTC?.center;
  const base = mul(mul(tileM, rtc ? translate(rtc[0], rtc[1], rtc[2]) : I4), zUp ? I4 : Y_UP_TO_Z_UP);
  const scene = json.scenes?.[json.scene ?? 0];
  let found = false;
  const visit = (ni, parent) => {
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
          out.push(...apply(m, dv.getFloat32(off + i * stride, true), dv.getFloat32(off + i * stride + 4, true), dv.getFloat32(off + i * stride + 8, true)));
        }
        found = true;
      }
    }
    for (const c of node.children ?? []) visit(c, m);
  };
  for (const ni of scene?.nodes ?? []) visit(ni, base);
  return found;
}

function contentPositions(buf, tileM, out, budget, zUp) {
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
  const count = ft.POINTS_LENGTH;
  const step = Math.max(1, Math.floor(count / budget));
  for (let i = 0; i < count; i += step) {
    out.push(...apply(m, dv.getFloat32(off + i * 12, true), dv.getFloat32(off + i * 12 + 4, true), dv.getFloat32(off + i * 12 + 8, true)));
  }
  return count > 0;
}

const isJsonUrl = (abs) => {
  const u = new URL(abs);
  // a wrapper endpoint (/proxy?url=…) names the real resource in its `url` parameter
  return /\.json$/i.test(u.pathname) || (u.pathname.endsWith('/proxy') && /\.json$/i.test((u.searchParams.get('url') ?? '').split('?')[0]));
};

/** Up to `maxFiles` top content files, breadth-first, each with its transform chain and up axis. */
async function topContents(url, maxFiles, fetchFn, depth = 0) {
  const found = [];
  const ts = await (await fetchFn(url)).json();
  const queue = [{ tile: ts.root, base: url, m: colM(ts.root.transform), zUp: ts.asset?.gltfUpAxis === 'Z' }];
  while (queue.length && found.length < maxFiles) {
    const { tile, base, m, zUp } = queue.shift();
    let uri = tile.content?.uri ?? tile.content?.url;
    if (tile.implicitTiling && uri) uri = uri.replace('{level}', '0').replace('{x}', '0').replace('{y}', '0').replace('{z}', '0');
    if (uri) {
      const abs = new URL(uri, base).href;
      if (isJsonUrl(abs)) {
        const ext = await (await fetchFn(abs)).json();
        queue.push({ tile: ext.root, base: abs, m: mul(m, colM(ext.root.transform)), zUp: ext.asset?.gltfUpAxis === 'Z' });
        continue;
      }
      found.push({ url: abs, m, zUp });
      continue;                                  // the first content level is enough
    }
    for (const c of tile.implicitTiling ? [] : tile.children ?? []) queue.push({ tile: c, base, m: mul(m, colM(c.transform)), zUp });
  }
  return found;
}

/**
 * Ground samples of a tileset: [{ lon, lat, h, n }] — each bin's 10th-percentile point, ellipsoidal
 * heights. Null when nothing readable was found.
 */
export async function datasetGroundSamples(tilesetUrl, { grid = GROUND_GRID, budget = 60000, fetch: fetchFn = globalThis.fetch } = {}) {
  const files = await topContents(tilesetUrl, 4, fetchFn);
  const pts = [];
  for (const f of files) {
    try {
      const buf = await (await fetchFn(f.url)).arrayBuffer();
      contentPositions(buf, f.m, pts, Math.ceil(budget / files.length), f.zUp);
    } catch { /* one unreadable tile is not fatal */ }
  }
  if (pts.length < 30) return null;

  let cx = 0, cy = 0, cz = 0;
  const n = pts.length / 3;
  for (let i = 0; i < pts.length; i += 3) { cx += pts[i]; cy += pts[i + 1]; cz += pts[i + 2]; }
  cx /= n; cy /= n; cz /= n;
  const [lon0, lat0] = ecefToLlh(cx, cy, cz);
  const lo = lon0 * DEG, la = lat0 * DEG;
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
  const bins = new Map();
  const w = (maxE - minE) / grid || 1, hgt = (maxN - minN) / grid || 1;
  for (let i = 0; i < n; i++) {
    const bx = Math.min(grid - 1, Math.floor((e[i] - minE) / w)), by = Math.min(grid - 1, Math.floor((no[i] - minN) / hgt));
    const k = by * grid + bx;
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k).push(i);
  }
  const out = [];
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
 * The Z offset that puts a dataset on the terrain: the 70th percentile of `terrain − ground` over the
 * bins — bins on roofs or canopy give smaller differences, below-ground noise larger ones.
 */
export function offsetFromSamples(samples, terrain) {
  const d = samples.map((s, i) => (terrain[i] == null || !Number.isFinite(terrain[i]) ? NaN : terrain[i] - s.h)).filter(Number.isFinite).sort((a, b) => a - b);
  if (d.length < 3) return null;
  return { dz: d[Math.floor(0.7 * (d.length - 1))], used: d.length, spread: d[d.length - 1] - d[0] };
}
