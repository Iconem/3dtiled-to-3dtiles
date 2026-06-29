/**
 * lcc-live.js — live **XGRIDS LCC → OGC 3D Tiles** middleware (on-the-fly, range-read tiles).
 *
 * LCC persists enough to build the tree WITHOUT decoding: `meta.lcc` carries the grid (`cellLengthX/Y`
 * + `boundingBox`) and `index.bin` packs each Unit's cell as x(low16)/y(high16) plus per-LOD
 * `{points, offset, size}` into `data.bin`. So we derive each Unit's box from its grid cell (X/Y) +
 * scene Z, and each tile range-reads just its `[offset,size)` slice of data.bin → SPZ-v2 splat GLB.
 *
 *   GET /lcc/tileset.json?url=<meta.lcc URL>
 *   GET /lcc/tile/<offset>_<size>_<points>.glb?url=<meta.lcc URL>   (run encoded in the name)
 *
 * Note: data.bin is a sibling of meta.lcc (named `data.bin`); `index.bin` likewise.
 */
import { decodeSplats } from '../lcc-to-3dtiles/src/lccDecode.js';
import { buildSplatTileGlb, computeBounds, CORS, lccGeoref } from '../core/index.js';

const ROOT_GE_FACTOR = 0.05, DEPTH_RATIO = 0.5;

// Right-handed source AABB → 3D Tiles Z-up box (RX +90°): centre (cx,cy,cz)→(cx,−cz,cy); halves y↔z.
function boundToZUpBox(min, max) {
  const cx=(min[0]+max[0])/2, cy=(min[1]+max[1])/2, cz=(min[2]+max[2])/2;
  const hx=Math.max((max[0]-min[0])/2,1e-4), hy=Math.max((max[1]-min[1])/2,1e-4), hz=Math.max((max[2]-min[2])/2,1e-4);
  return [cx, -cz, cy, hx,0,0, 0,hz,0, 0,0,hy];
}

async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
async function rangeGet(url, begin, length) {
  const r = await fetch(url, { headers: { Range: `bytes=${begin}-${begin + length - 1}` } });
  if (r.status !== 206 && r.status !== 200) throw new Error(`range ${url} → ${r.status} (server must support HTTP 206)`);
  return Buffer.from(await r.arrayBuffer());
}

// Per-URL context: meta.lcc + index.bin parsed into per-Unit grid boxes + per-LOD runs. Cached.
const ctxCache = new Map();
async function getCtx(url) {
  if (ctxCache.has(url)) return ctxCache.get(url);
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  const meta = JSON.parse((await fetchBuf(url)).toString('utf8'));
  const scaleAttr = (meta.attributes || []).find(a => a.name === 'scale');
  if (!scaleAttr) throw new Error('meta.lcc missing attributes.scale min/max');
  const indexBuf = await fetchBuf(base + 'index.bin');
  const { indexDataSize } = meta, levelsInIndex = (indexDataSize - 4) / 16;
  const numUnits = indexBuf.length / indexDataSize;
  const bb = meta.boundingBox, cellX = meta.cellLengthX, cellY = meta.cellLengthY;

  const units = [];                                       // { box, lods:[{level,pts,off,size}] }
  for (let u = 0; u < numUnits; u++) {
    const b = u * indexDataSize;
    const idx = indexBuf.readUInt32LE(b);
    const cx = idx & 0xFFFF, cy = (idx >>> 16) & 0xFFFF;
    const min = [bb.min[0] + cx*cellX, bb.min[1] + cy*cellY, bb.min[2]];
    const max = [min[0] + cellX, min[1] + cellY, bb.max[2]];
    const lods = [];
    for (let L = 0; L < levelsInIndex; L++) {
      const r = b + 4 + L*16;
      const pts = indexBuf.readUInt32LE(r), off = Number(indexBuf.readBigUInt64LE(r + 4)), size = indexBuf.readUInt32LE(r + 12);
      if (pts > 0 && size > 0) lods.push({ level: L, pts, off, size });
    }
    if (lods.length) units.push({ box: boundToZUpBox(min, max), lods });
  }
  const diag = Math.hypot(bb.max[0]-bb.min[0], bb.max[1]-bb.min[1], bb.max[2]-bb.min[2]) || 1;
  const transform = lccGeoref(meta, 'lcc-live');
  const ctx = { dataUrl: base + 'data.bin', units, scaleMin: scaleAttr.min, scaleMax: scaleAttr.max, sceneBox: boundToZUpBox(bb.min, bb.max), rootGE: diag * ROOT_GE_FACTOR, transform };
  ctxCache.set(url, ctx);
  console.log(`[lcc-live] ${url} → ${units.length} units, georef=${!!transform}${meta.epsg ? ' (EPSG:'+meta.epsg+')' : ''}`);
  return ctx;
}

function buildTileset(ctx, urlParam, centroids = false) {
  const enc = encodeURIComponent(urlParam);
  const geAt = d => ctx.rootGE * Math.pow(DEPTH_RATIO, d);
  const children = [];
  for (const unit of ctx.units) {
    const maxL = unit.lods[unit.lods.length - 1].level;
    let child = null;                                     // nest coarsest (outer) → finest (inner), REPLACE
    for (const { level, pts, off, size } of unit.lods) {  // ascending level (0 = finest)
      const tile = { boundingVolume: { box: unit.box }, geometricError: geAt(maxL - level), refine: 'REPLACE', content: { uri: `tile/${off}_${size}_${pts}.glb?url=${enc}` } };
      if (child) tile.children = [child];
      child = tile;
    }
    children.push(child);
  }
  const root = { boundingVolume: { box: ctx.sceneBox }, geometricError: ctx.rootGE * 2, refine: 'REPLACE', children };
  if (ctx.transform) root.transform = ctx.transform;        // ENU→ECEF placement from meta.lcc epsg+offset
  const ts = { asset: { version: '1.1' }, geometricError: ctx.rootGE * 2, root, extensionsUsed: ['3DTILES_content_gltf'] };
  // centroids mode emits glTF POINTS tiles → do NOT advertise the gaussian-splatting extension.
  if (!centroids) ts.extensions = { '3DTILES_content_gltf': {
    extensionsUsed: ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
    extensionsRequired: ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
  }};
  return ts;
}

async function serveTileGlb(ctx, off, size, pts, centroids = false) {
  const buf = await rangeGet(ctx.dataUrl, off, size);
  const { positions, alphas, rgb, scales, rotations } = decodeSplats(buf, 0, pts, ctx.scaleMin, ctx.scaleMax);
  const bounds = computeBounds(positions, pts);
  return Buffer.from(await buildSplatTileGlb({ positions, alphas, rgb, scales, rotations }, pts, bounds, centroids));
}

// Pure builders for the /stream dispatcher.
export const lccTileRe = /^\d+_\d+_\d+$/;
// hierarchy/prefetch are no-ops (LCC's unit grid lives in one index.bin — monolithic flat index,
// cache=none ≡ cache=hierarchy; cache=full routes to /convert). `centroids` → POINTS preview.
export async function lccTileset(url, opts = {}) { return buildTileset(await getCtx(url), url, opts.centroids); }
export async function lccTile(url, key, opts = {}) { const [o, s, p] = key.split('_').map(Number); return serveTileGlb(await getCtx(url), o, s, p, opts.centroids); }

/** Try to handle a /lcc/* request. Returns true iff it owned the response. */
export async function handleLcc(req, res, u) {
  if (!u.pathname.startsWith('/lcc/')) return false;
  const url = u.searchParams.get('url');
  if (!url) { res.writeHead(400, CORS); res.end('missing ?url=<meta.lcc URL>'); return true; }

  if (u.pathname === '/lcc/tileset.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(await lccTileset(url)));
    return true;
  }
  const m = u.pathname.match(/^\/lcc\/tile\/(\d+_\d+_\d+)\.glb$/);
  if (m) {
    const glb = await lccTile(url, m[1]);
    if (!glb) { res.writeHead(404, CORS); res.end('no such run'); return true; }
    res.writeHead(200, { 'Content-Type': 'model/gltf-binary', ...CORS });
    res.end(glb);
    return true;
  }
  res.writeHead(404, CORS); res.end('not found');
  return true;
}
