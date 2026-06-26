/**
 * potree-live.js — live **Potree → OGC 3D Tiles** middleware (true online, build-on-the-fly).
 *
 * The same model as `/copc`, generalised to Potree's octree: NOTHING is pre-converted or fully
 * downloaded. The hierarchy is fetched to emit the 3D Tiles tree, then each tile request fetches just
 * that node's data, decodes it, and returns a glTF POINTS GLB. Handles BOTH:
 *   • Potree 2.0 (metadata.json + hierarchy.bin + octree.bin) — one HTTP **range** read of octree.bin
 *     per tile (true range-streaming).
 *   • Potree 1.x (cloud.js + .hrc + per-node .bin/.laz) — one whole-file fetch per node (the nodes
 *     ARE the files), via the shared loadPotree1 reader with an injected fetch source.
 *
 *   GET /potree/tileset.json?url=<metadata.json | cloud.js URL>
 *   GET /potree/tile/<name>.glb?url=<…>                       → that node's points as a POINTS GLB
 */
import proj4 from 'proj4';
import { buildPointsGlb, coordsToKey, buildSubtreeBuffer } from '../core/index.js';
import { preparePotree2Schema, parsePotree2Hierarchy, decodePotree2Node } from '../potree-to-3dtiles/src/potree2.js';
import { loadPotree1 } from '../potree-to-3dtiles/src/potree1.js';

const SUBTREE_LEVELS = 3;
// Spatial octree (level,x,y,z) of a node from its box vs root box (exact ints — robust to Potree's
// octant-bit convention). Same derivation the offline converter uses for implicit tiling.
function coordsOfBox(box, rootBox, depth) {
  const cells = 2 ** depth;
  const idx = k => { const span = (rootBox.max[k] - rootBox.min[k]) / cells; return span > 0 ? Math.min(cells - 1, Math.max(0, Math.round((box.min[k] - rootBox.min[k]) / span))) : 0; };
  return { level: depth, x: idx(0), y: idx(1), z: idx(2) };
}

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

const georef = (origin, crs) => {
  if (!crs) return null;
  try { const [lon, lat, h] = proj4(crs, 'WGS84').forward(origin); const e = llhToEcef(lon, lat, h ?? origin[2]); return enuMatrix(lon, lat, e[0], e[1], e[2]); }
  catch (e) { console.warn('[potree-live] georef failed:', e.message); return null; }
};
const finishCtx = (nodes, rootBox, crs, spacingMeta, readTile) => {
  const origin = [0,1,2].map(k => (rootBox.min[k] + rootBox.max[k]) / 2);
  const rootDiag = Math.hypot(rootBox.max[0]-rootBox.min[0], rootBox.max[1]-rootBox.min[1], rootBox.max[2]-rootBox.min[2]);
  // Spatial coord index for implicit tiling: coordKey "level-x-y-z" → node name; availability set.
  const byCoord = new Map(), avail = new Set();
  let maxLevel = 0;
  for (const [name, node] of nodes) {
    if (!(node.numPoints > 0)) continue;
    const { level, x, y, z } = coordsOfBox(node.box, rootBox, node.depth);
    const key = coordsToKey(level, x, y, z);
    byCoord.set(key, name); avail.add(key);
    if (level > maxLevel) maxLevel = level;
  }
  return { nodes, rootBox, origin, transform: georef(origin, crs), rootDiag, spacing: spacingMeta || rootDiag / 128, readTile, byCoord, avail, maxLevel };
};

// Per-URL context (hierarchy + georef + a readTile(name) closure), cached. 2.0 → range reads of
// octree.bin; 1.x → whole-file fetch per node through loadPotree1's injectable reader.
const ctxCache = new Map();
async function getCtx(url) {
  if (ctxCache.has(url)) return ctxCache.get(url);
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  let ctx;

  if (/cloud\.js(\?|$)/i.test(url)) {                       // ── Potree 1.x ──
    const src = await loadPotree1('', { read: rel => fetchFull(base + rel) });
    const readTile = name => src.readNode(src.nodes.get(name));
    ctx = finishCtx(src.nodes, src.rootBox, src.crs, src.spacing, readTile);
    console.log(`[potree-live] (1.x) ${url} → ${src.nodes.size} nodes, georef=${!!ctx.transform}`);
  } else {                                                  // ── Potree 2.0 ──
    const meta = JSON.parse((await fetchFull(url)).toString('utf8'));
    if ((meta.version || '').toString()[0] !== '2') console.warn(`[potree-live] ${url}: metadata.version=${meta.version} — expected 2.x`);
    const schema = preparePotree2Schema(meta);
    const { nodes, rootBox } = parsePotree2Hierarchy(meta, await fetchFull(base + 'hierarchy.bin'));
    const octreeUrl = base + 'octree.bin';
    const readTile = async name => { const n = nodes.get(name); if (!n || !n.byteSize) return null; return decodePotree2Node(meta, schema, n, await rangeGet(octreeUrl, n.byteOffset, n.byteSize)); };
    ctx = finishCtx(nodes, rootBox, meta.projection || meta.crs || meta.wkt || null, meta.spacing, readTile);
    console.log(`[potree-live] (2.0) ${url} → ${nodes.size} nodes, georef=${!!ctx.transform}`);
  }
  ctxCache.set(url, ctx);
  return ctx;
}

// Explicit 3D Tiles tree from the Potree octree. Box = node AABB relative to the dataset origin
// (≈ ENU near the origin); geometric error = point spacing at that depth; ADD refine (children densify).
function buildTilesetExplicit(ctx, urlParam) {
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
    if (node.numPoints > 0) tile.content = { uri: `tile/${name}.glb?url=${enc}` };
    const kids = [];
    for (let c2 = 0; c2 < 8; c2++) { const ck = name + c2; if (nodes.has(ck)) kids.push(tileFor(ck)); }
    if (kids.length) tile.children = kids;
    return tile;
  };
  const root = tileFor('r');
  if (transform) root.transform = transform;
  return { asset: { version: '1.1' }, geometricError: rootDiag, root, extensionsUsed: ['3DTILES_content_gltf'] };
}

// Implicit octree: root box = full extent (centred at origin → 0); content/subtree templates use the
// "level-x-y-z" coord token; subtrees are built on the fly from the availability set.
function buildTilesetImplicit(ctx, urlParam) {
  const { rootBox, origin, transform, rootDiag, spacing, maxLevel } = ctx;
  const enc = encodeURIComponent(urlParam);
  const h = [0,1,2].map(k => Math.max((rootBox.max[k] - rootBox.min[k]) / 2, 0.01));
  const c = [0,1,2].map(k => (rootBox.min[k] + rootBox.max[k]) / 2 - origin[k]);   // = 0
  const root = {
    boundingVolume: { box: [c[0],c[1],c[2], h[0],0,0, 0,h[1],0, 0,0,h[2]] },
    refine: 'ADD', geometricError: spacing,
    implicitTiling: { subdivisionScheme: 'OCTREE', availableLevels: maxLevel + 1, subtreeLevels: SUBTREE_LEVELS, subtrees: { uri: `subtrees/{level}-{x}-{y}-{z}.subtree?url=${enc}` } },
    content: { uri: `tile/{level}-{x}-{y}-{z}.glb?url=${enc}` },
  };
  if (transform) root.transform = transform;
  return { asset: { version: '1.1' }, geometricError: rootDiag, root, extensionsUsed: ['3DTILES_content_gltf'] };
}

async function serveTileGlb(ctx, name) {
  const node = ctx.nodes.get(name);
  if (!node || !node.numPoints) return null;
  const data = await ctx.readTile(name);                    // 2.0: range read+decode; 1.x: per-node fetch+decode
  if (!data || !data.count) return null;
  const { positions, colors, count } = data;
  const [ox, oy, oz] = ctx.origin;                          // world → tile-local (float32-safe)
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) { pos[i*3]=positions[i*3]-ox; pos[i*3+1]=positions[i*3+1]-oy; pos[i*3+2]=positions[i*3+2]-oz; }
  return Buffer.from(await buildPointsGlb(pos, colors, count));   // core applies the (E,U,−N) Y-up swizzle
}

// Pure builders the /stream dispatcher reuses. Tile token is a Potree name (explicit, "r012") OR a
// "level-x-y-z" coord (implicit) — potreeTile resolves either.
export const potreeTileRe = /^([r0-7]+|\d+-\d+-\d+-\d+)$/;
export async function potreeTileset(url, opts = {}) {
  const ctx = await getCtx(url);
  return opts.tiling === 'explicit' ? buildTilesetExplicit(ctx, url) : buildTilesetImplicit(ctx, url);
}
export async function potreeTile(url, token) {
  const ctx = await getCtx(url);
  const name = /^[r0-7]+$/.test(token) ? token : ctx.byCoord.get(token);   // name or coord key
  return name ? serveTileGlb(ctx, name) : null;
}
export async function potreeSubtree(url, key) { return buildSubtreeBuffer(key, (await getCtx(url)).avail, SUBTREE_LEVELS); }

/** Try to handle a /potree/* request. Returns true iff it owned the response. */
export async function handlePotree(req, res, u) {
  if (!u.pathname.startsWith('/potree/')) return false;
  const url = u.searchParams.get('url');
  if (!url) { res.writeHead(400, CORS); res.end('missing ?url=<metadata.json URL>'); return true; }
  const ctx = await getCtx(url);

  if (u.pathname === '/potree/tileset.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(await potreeTileset(url, { tiling: u.searchParams.get('tiling') })));
    return true;
  }
  const m = u.pathname.match(/^\/potree\/tile\/([r0-7]+|\d+-\d+-\d+-\d+)\.glb$/);
  if (m) {
    const glb = await potreeTile(url, m[1]);
    if (!glb) { res.writeHead(404, CORS); res.end('no such node'); return true; }
    res.writeHead(200, { 'Content-Type': 'model/gltf-binary', ...CORS });
    res.end(glb);
    return true;
  }
  const s = u.pathname.match(/^\/potree\/subtrees\/(\d+-\d+-\d+-\d+)\.subtree$/);
  if (s) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', ...CORS });
    res.end(await potreeSubtree(url, s[1]));
    return true;
  }
  res.writeHead(404, CORS); res.end('not found');
  return true;
}
