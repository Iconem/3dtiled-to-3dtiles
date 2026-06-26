/**
 * copc-live.js — live **COPC → OGC 3D Tiles** middleware (true online range-streaming).
 *
 * The original "TiTiler for 3D" endpoint, extracted from server.js so every streamed format is a
 * uniform `*-live.js` module (copc, potree, …) the `/stream` dispatcher can delegate to. Nothing is
 * pre-converted: range-read the COPC header + hierarchy to emit the tileset, then range-read just one
 * octree node's point block per tile request → glTF POINTS GLB. The COPC octree maps ~1:1 onto 3D Tiles.
 *
 *   GET /copc/tileset.json?url=<COPC_URL>          → 3D Tiles 1.1 tileset (explicit tree, ADD refine)
 *   GET /copc/tile/<D-X-Y-Z>.glb?url=<COPC_URL>    → that node's points as a POINTS GLB
 */
import { Copc, Getter } from 'copc';
import proj4 from 'proj4';
import { buildPointsGlb } from '../core/index.js';
import { keyToCoords } from '../copc-to-3dtiles/src/subtreeBuilder.js';

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

// Read the LASF_Projection/2112 WKT VLR via a range read (copc exposes offset+length, not bytes).
async function readWkt(getter, copc) {
  const vlr = (copc.vlrs ?? []).find(v => v.userId === 'LASF_Projection' && v.recordId === 2112);
  if (!vlr || !vlr.contentOffset || !vlr.contentLength) return null;
  const buf = await getter(vlr.contentOffset, vlr.contentOffset + vlr.contentLength);
  let raw = Buffer.from(buf).toString('utf8').replace(/\0/g, '').trim();
  if (raw.startsWith('COMPD_CS[')) {                       // strip vertical CRS; proj4 wants the 2D part
    const inner = raw.slice(raw.indexOf(',') + 1).trim();
    let depth = 0, end = 0;
    for (let i = 0; i < inner.length; i++) { if (inner[i]==='[') depth++; else if (inner[i]===']' && --depth===0) { end = i+1; break; } }
    if (end > 0) raw = inner.slice(0, end);
  }
  return raw || null;
}

// Per-URL context (COPC header + full node hierarchy + georef), cached.
const ctxCache = new Map();
async function getCtx(url) {
  if (ctxCache.has(url)) return ctxCache.get(url);
  const getter = Getter.http(url);
  // Cheap guard: every LAS/COPC file starts with "LASF". Without this, pointing /copc at a non-LAS
  // resource (e.g. a JSON metadata.json / meta.lcc by mistake) makes copc + laz-perf hang and can
  // abort the whole process. Fail fast with a clear error instead.
  const magic = Buffer.from(await getter(0, 4)).toString('latin1');
  if (magic !== 'LASF') throw new Error(`not a LAS/COPC file (got "${magic}" not "LASF") — is this the right URL for /copc?`);
  const copc = await Copc.create(getter);
  const nodeMap = new Map();
  const loadPage = async (ref) => {
    const { nodes, pages } = await Copc.loadHierarchyPage(getter, ref);
    for (const k of Object.keys(nodes)) nodeMap.set(k, nodes[k]);
    for (const k of Object.keys(pages)) if (pages[k]) await loadPage(pages[k]);
  };
  await loadPage(copc.info.rootHierarchyPage);
  const cube = copc.info.cube;
  const origin = [(cube[0]+cube[3])/2, (cube[1]+cube[4])/2, (cube[2]+cube[5])/2];
  let transform = null;
  try {
    const wkt = await readWkt(getter, copc);
    if (wkt) { const [lon, lat, h] = proj4(wkt, 'WGS84').forward(origin); const e = llhToEcef(lon, lat, h ?? origin[2]); transform = enuMatrix(lon, lat, e[0], e[1], e[2]); }
    else console.warn(`[copc-live] no WKT CRS in ${url} — local-origin (not geo-referenced)`);
  } catch (e) { console.warn('[copc-live] georef failed:', e.message); }
  const rootDiag = Math.hypot(cube[3]-cube[0], cube[4]-cube[1], cube[5]-cube[2]);
  const ctx = { getter, copc, nodeMap, origin, transform, rootDiag, cube };
  ctxCache.set(url, ctx);
  console.log(`[copc-live] ${url} → ${nodeMap.size} nodes, georef=${!!transform}`);
  return ctx;
}

const subCube = (cube, level, x, y, z) => {
  const n = 2**level, dx = (cube[3]-cube[0])/n, dy = (cube[4]-cube[1])/n, dz = (cube[5]-cube[2])/n;
  return [cube[0]+x*dx, cube[1]+y*dy, cube[2]+z*dz, cube[0]+(x+1)*dx, cube[1]+(y+1)*dy, cube[2]+(z+1)*dz];
};

// Explicit 3D Tiles tree from the COPC hierarchy. Boxes = octree sub-cube relative to the origin.
function buildTileset(ctx, urlParam) {
  const { nodeMap, origin, transform, rootDiag, cube } = ctx;
  const enc = encodeURIComponent(urlParam);
  const tileFor = (key) => {
    const { level, x, y, z } = keyToCoords(key);
    const sc = subCube(cube, level, x, y, z);
    const c = [(sc[0]+sc[3])/2-origin[0], (sc[1]+sc[4])/2-origin[1], (sc[2]+sc[5])/2-origin[2]];
    const h = [Math.max((sc[3]-sc[0])/2,0.01), Math.max((sc[4]-sc[1])/2,0.01), Math.max((sc[5]-sc[2])/2,0.01)];
    const node = nodeMap.get(key);
    const tile = { boundingVolume: { box: [c[0],c[1],c[2], h[0],0,0, 0,h[1],0, 0,0,h[2]] }, geometricError: rootDiag / (2**level), refine: 'ADD' };
    if (node && node.pointCount > 0) tile.content = { uri: `tile/${key}.glb?url=${enc}` };
    const kids = [];
    for (let i = 0; i < 8; i++) {
      const ck = `${level+1}-${2*x+(i&1)}-${2*y+((i>>1)&1)}-${2*z+((i>>2)&1)}`;
      if (nodeMap.has(ck)) kids.push(tileFor(ck));
    }
    if (kids.length) tile.children = kids;
    return tile;
  };
  const root = tileFor('0-0-0-0');
  if (transform) root.transform = transform;
  return { asset: { version: '1.1' }, geometricError: rootDiag, root, extensionsUsed: ['3DTILES_content_gltf'] };
}

async function serveTileGlb(ctx, key) {
  const node = ctx.nodeMap.get(key);
  if (!node || !node.pointCount) return null;
  const view = await Copc.loadPointDataView(ctx.getter, ctx.copc, node);
  const n = view.pointCount, [ox, oy, oz] = ctx.origin;
  const gx = view.getter('X'), gy = view.getter('Y'), gz = view.getter('Z');
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { pos[i*3] = gx(i)-ox; pos[i*3+1] = gy(i)-oy; pos[i*3+2] = gz(i)-oz; }
  const d = view.dimensions; let colors = null;
  if (d.Red && d.Green && d.Blue) {
    const gr = view.getter('Red'), gg = view.getter('Green'), gb = view.getter('Blue'), s = d.Red.size === 2 ? 1/65535 : 1/255;
    colors = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { colors[i*4]=gr(i)*s; colors[i*4+1]=gg(i)*s; colors[i*4+2]=gb(i)*s; colors[i*4+3]=1; }
  }
  return Buffer.from(await buildPointsGlb(pos, colors, n));   // core applies the (E,U,−N) Y-up swizzle
}

// Pure builders the /stream dispatcher reuses.
export const copcTileRe = /^[0-9]+-[0-9]+-[0-9]+-[0-9]+$/;
export async function copcTileset(url) { return buildTileset(await getCtx(url), url); }
export async function copcTile(url, key) { return serveTileGlb(await getCtx(url), key); }

/** Try to handle a /copc/* request. Returns true iff it owned the response. */
export async function handleCopc(req, res, u) {
  if (!u.pathname.startsWith('/copc/')) return false;
  const url = u.searchParams.get('url');
  if (!url) { res.writeHead(400, CORS); res.end('missing ?url=<COPC url>'); return true; }

  if (u.pathname === '/copc/tileset.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(await copcTileset(url)));
    return true;
  }
  const m = u.pathname.match(/^\/copc\/tile\/(\d+-\d+-\d+-\d+)\.glb$/);
  if (m) {
    const glb = await copcTile(url, m[1]);
    if (!glb) { res.writeHead(404, CORS); res.end('no such node'); return true; }
    res.writeHead(200, { 'Content-Type': 'model/gltf-binary', ...CORS });
    res.end(glb);
    return true;
  }
  res.writeHead(404, CORS); res.end('not found');
  return true;
}
