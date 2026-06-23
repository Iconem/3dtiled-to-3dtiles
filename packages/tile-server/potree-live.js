/**
 * potree-live.js — live **Potree 2.0 → OGC 3D Tiles** middleware (true online range-streaming).
 *
 * The same model as `/copc`, generalised to Potree's octree: NOTHING is pre-converted or fully
 * downloaded. We fetch `metadata.json` (tiny) + `hierarchy.bin` once to emit the 3D Tiles tree, then
 * each tile request HTTP-**range**-reads just that node's contiguous block from `octree.bin`, decodes
 * it, and returns a glTF POINTS GLB. The Potree octree maps ~1:1 onto the 3D Tiles tree.
 *
 *   GET /potree/tileset.json?url=<metadata.json URL>          → 3D Tiles 1.1 tileset (explicit, ADD)
 *   GET /potree/tile/<name>.glb?url=<metadata.json URL>       → that node's points as a POINTS GLB
 *
 * `url` points at the dataset's metadata.json; hierarchy.bin / octree.bin are resolved as siblings.
 * (Potree 1.x — cloud.js + per-node files — isn't range-served here; use `/convert?format=potree`.)
 */
import proj4 from 'proj4';
import { buildPointsGlb } from '../core/index.js';
import { preparePotree2Schema, parsePotree2Hierarchy, decodePotree2Node } from '../potree-to-3dtiles/src/potree2.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
const DEG = Math.PI / 180, A = 6378137.0, E2 = 0.00669437999014;

const llhToEcef = (lon, lat, h) => {
  const sLat = Math.sin(lat*DEG), cLat = Math.cos(lat*DEG), sLon = Math.sin(lon*DEG), cLon = Math.cos(lon*DEG);
  const N = A / Math.sqrt(1 - E2*sLat*sLat);
  return [(N+h)*cLat*cLon, (N+h)*cLat*sLon, (N*(1-E2)+h)*sLat];
};
// Column-major ENU→ECEF (columns East, North, Up, origin).
const enuMatrix = (lon, lat, cx, cy, cz) => {
  const sl = Math.sin(lon*DEG), cl = Math.cos(lon*DEG), sp = Math.sin(lat*DEG), cp = Math.cos(lat*DEG);
  return [-sl,cl,0,0, -sp*cl,-sp*sl,cp,0, cp*cl,cp*sl,sp,0, cx,cy,cz,1];
};

async function fetchFull(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
// One contiguous range read from octree.bin (the per-tile fetch — this is the streaming core).
async function rangeGet(url, begin, length) {
  const r = await fetch(url, { headers: { Range: `bytes=${begin}-${begin + length - 1}` } });
  if (r.status !== 206 && r.status !== 200) throw new Error(`range ${url} → ${r.status} (server must support HTTP 206)`);
  return Buffer.from(await r.arrayBuffer());
}

// Per-URL context (metadata + hierarchy + georef), cached. Hierarchy is fetched whole (small vs
// octree.bin) to emit the explicit tree — exactly like /copc loads the full COPC hierarchy.
const ctxCache = new Map();
async function getCtx(metaUrl) {
  if (ctxCache.has(metaUrl)) return ctxCache.get(metaUrl);
  const base = metaUrl.slice(0, metaUrl.lastIndexOf('/') + 1);
  const meta = JSON.parse((await fetchFull(metaUrl)).toString('utf8'));
  if ((meta.version || '').toString()[0] !== '2') console.warn(`[potree-live] ${metaUrl}: metadata.version=${meta.version} — expected 2.x`);
  const schema = preparePotree2Schema(meta);
  const hierBuf = await fetchFull(base + 'hierarchy.bin');
  const { nodes, rootBox } = parsePotree2Hierarchy(meta, hierBuf);
  const origin = [0,1,2].map(k => (rootBox.min[k] + rootBox.max[k]) / 2);

  let transform = null;
  const crs = meta.projection || meta.crs || meta.wkt || null;
  try {
    if (crs) { const [lon, lat, h] = proj4(crs, 'WGS84').forward(origin); const e = llhToEcef(lon, lat, h ?? origin[2]); transform = enuMatrix(lon, lat, e[0], e[1], e[2]); }
    else console.warn(`[potree-live] no CRS in ${metaUrl} — local-origin (not geo-referenced)`);
  } catch (e) { console.warn('[potree-live] georef failed:', e.message); }

  const rootDiag = Math.hypot(rootBox.max[0]-rootBox.min[0], rootBox.max[1]-rootBox.min[1], rootBox.max[2]-rootBox.min[2]);
  const spacing = meta.spacing || rootDiag / 128;
  const ctx = { meta, schema, nodes, origin, transform, rootDiag, spacing, octreeUrl: base + 'octree.bin' };
  ctxCache.set(metaUrl, ctx);
  console.log(`[potree-live] ${metaUrl} → ${nodes.size} nodes, georef=${!!transform}`);
  return ctx;
}

// Explicit 3D Tiles tree from the Potree octree. Box = node AABB relative to the dataset origin
// (≈ ENU near the origin); geometric error = point spacing at that depth; ADD refine (children densify).
function buildTileset(ctx, urlParam) {
  const { nodes, origin, transform, rootDiag, spacing } = ctx;
  const enc = encodeURIComponent(urlParam);
  const tileFor = (name) => {
    const node = nodes.get(name);
    const b = node.box;
    const c = [0,1,2].map(k => (b.min[k] + b.max[k]) / 2 - origin[k]);
    const h = [0,1,2].map(k => Math.max((b.max[k] - b.min[k]) / 2, 0.01));
    const tile = {
      boundingVolume: { box: [c[0],c[1],c[2], h[0],0,0, 0,h[1],0, 0,0,h[2]] },
      geometricError: spacing / (2 ** node.depth),
      refine: 'ADD',
    };
    if (node.numPoints > 0 && node.byteSize > 0) tile.content = { uri: `tile/${name}.glb?url=${enc}` };
    const kids = [];
    for (let c2 = 0; c2 < 8; c2++) { const ck = name + c2; if (nodes.has(ck)) kids.push(tileFor(ck)); }
    if (kids.length) tile.children = kids;
    return tile;
  };
  const root = tileFor('r');
  if (transform) root.transform = transform;
  return { asset: { version: '1.1' }, geometricError: rootDiag, root, extensionsUsed: ['3DTILES_content_gltf'] };
}

async function serveTileGlb(ctx, name) {
  const node = ctx.nodes.get(name);
  if (!node || !node.numPoints || !node.byteSize) return null;
  const raw = await rangeGet(ctx.octreeUrl, node.byteOffset, node.byteSize);
  const { positions, colors, count } = decodePotree2Node(ctx.meta, ctx.schema, node, raw);
  const [ox, oy, oz] = ctx.origin;                          // world → tile-local (float32-safe)
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) { pos[i*3]=positions[i*3]-ox; pos[i*3+1]=positions[i*3+1]-oy; pos[i*3+2]=positions[i*3+2]-oz; }
  return Buffer.from(await buildPointsGlb(pos, colors, count));   // core applies the (E,U,−N) Y-up swizzle
}

/** Try to handle a /potree/* request. Returns true iff it owned the response. */
export async function handlePotree(req, res, u) {
  if (!u.pathname.startsWith('/potree/')) return false;
  const url = u.searchParams.get('url');
  if (!url) { res.writeHead(400, CORS); res.end('missing ?url=<metadata.json URL>'); return true; }
  const ctx = await getCtx(url);

  if (u.pathname === '/potree/tileset.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(buildTileset(ctx, url)));
    return true;
  }
  const m = u.pathname.match(/^\/potree\/tile\/([r0-7]+)\.glb$/);
  if (m) {
    const glb = await serveTileGlb(ctx, m[1]);
    if (!glb) { res.writeHead(404, CORS); res.end('no such node'); return true; }
    res.writeHead(200, { 'Content-Type': 'model/gltf-binary', ...CORS });
    res.end(glb);
    return true;
  }
  res.writeHead(404, CORS); res.end('not found');
  return true;
}
