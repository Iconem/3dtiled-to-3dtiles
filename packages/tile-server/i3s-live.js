/**
 * i3s-live.js — live **I3S → OGC 3D Tiles** streaming middleware (on-the-fly serving).
 *
 * "v2", built on the loaders.gl SDK for robust I3S/SLPK access (@loaders.gl/i3s SLPK archive +
 * scene-layer/nodepage parsing), reusing this repo's proven I3S geometry decoder + ENU placement.
 *
 * Like the other streaming adapters, the tree is built from metadata only:
 *   tileset.json  → read 3dSceneLayer.json + all nodepages (node OBBs + children + mesh refs).
 *                   Each node's bounding box comes from its OBB (no geometry decode). Content URIs
 *                   route back to our /tile endpoint. One shared ENU→ECEF root transform.
 *   tile/<i>.glb  → fetch ONE node's uncompressed DefaultGeometrySchema buffer, decode it, place
 *                   vertices in the shared ENU frame, and build a glTF (TRIANGLES / POINTS) on demand.
 *
 * Two source modes (auto-detected from the URL):
 *   • REST / extracted-SLPK dir — url = …/3dSceneLayer.json[.gz]; resources fetched file-by-file
 *     (best for large layers like NYC — we never pull the whole dataset).
 *   • SLPK archive             — url = ….slpk; the zip is fetched once and read via loaders.gl.
 *
 * Scope matches the offline draft: uncompressed geometry only (Draco/LEPCC gated out), no textures.
 *
 *   GET /i3s/tileset.json?url=<3dSceneLayer.json | .slpk URL>
 *   GET /i3s/tile/<nodeIndex>.glb?url=<same URL>
 */
import zlib from 'node:zlib';
import { parseSLPKArchive } from '@loaders.gl/i3s';
import { DataViewReadableFile } from '@loaders.gl/zip';
import { decodeDefaultGeometry, geodeticToEcef, obbToBox } from '../i3s-to-3dtiles/src/i3sParse.js';
import { buildGlb } from '../i3s-to-3dtiles/src/glbBuild.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
const MESH_TYPES  = new Set(['IntegratedMesh', '3DObject']);
const POINT_TYPES = new Set(['PointCloud']);

const gunzipIfNeeded = (buf) => (buf[0] === 0x1f && buf[1] === 0x8b) ? zlib.gunzipSync(buf) : buf;

async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Build a uniform getFile(relPath) → Buffer (gunzipped) over either an SLPK archive or HTTP base dir.
async function makeFileReader(url) {
  if (/\.slpk(\?|$)/i.test(url)) {
    const buf = await fetchBuf(url);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const archive = await parseSLPKArchive(new DataViewReadableFile(new DataView(ab)), undefined, 'slpk');
    return async (rel) => {
      let last;
      for (const mode of ['raw', 'http']) {
        try {
          const f = await archive.getFile(rel, mode);
          const bytes = f instanceof ArrayBuffer ? new Uint8Array(f) : new Uint8Array(await f.arrayBuffer());
          return gunzipIfNeeded(Buffer.from(bytes));
        } catch (e) { last = e; }
      }
      throw new Error(`SLPK getFile ${rel}: ${last?.message}`);
    };
  }
  // REST / extracted dir: url points at 3dSceneLayer.json[.gz]; resolve siblings relative to its dir.
  // NOTE: a static host with SPA fallback (Vite) answers missing paths with 200 + index.html instead
  // of 404, so we must reject HTML and prefer the .gz variant (extracted SLPKs store resources gzip'd).
  const base = url.replace(/\/[^/]*$/, '/');
  return async (rel) => {
    for (const cand of [rel + '.gz', rel]) {
      const r = await fetch(base + cand);
      if (!r.ok) continue;
      // A static host with SPA fallback (Vite) answers a missing path with 200 + index.html.
      // Detect that via Content-Type only — NOT by sniffing the first byte: binary geometry can
      // legitimately start with 0x3C (e.g. vertexCount 66108 = 0x1023C → first LE byte 0x3C).
      if ((r.headers.get('content-type') || '').includes('text/html')) continue;
      return gunzipIfNeeded(Buffer.from(await r.arrayBuffer()));
    }
    throw new Error(`HTTP getFile ${rel} (nor .gz) under ${base}`);
  };
}

// ── Per-URL context (cached): scene layer + flattened node table + ENU frame ───────────────────

const ctxCache = new Map();
async function getCtx(url) {
  if (ctxCache.has(url)) return ctxCache.get(url);

  const getFile = await makeFileReader(url);
  const sl = JSON.parse((await getFile('3dSceneLayer.json')).toString('utf8'));

  const layerType = sl.layerType;
  if (!MESH_TYPES.has(layerType) && !POINT_TYPES.has(layerType))
    throw new Error(`I3S layerType "${layerType}" not supported (mesh/point only)`);

  // Pick the uncompressed geometry buffer; gate out Draco-only / LEPCC.
  const defs = sl.geometryDefinitions || [];
  let uncompressedBufferIndex = -1, hasDraco = false;
  for (const d of defs) {
    const bufs = d.geometryBuffers || [];
    for (let i = 0; i < bufs.length; i++) {
      if (bufs[i].compressedAttributes) hasDraco = true;
      else if (uncompressedBufferIndex < 0) uncompressedBufferIndex = i;
    }
    if (uncompressedBufferIndex >= 0) break;
  }
  const schemaEnc = sl.store?.defaultGeometrySchema?.encoding;
  if (uncompressedBufferIndex < 0 && hasDraco)
    throw new Error('I3S layer is Draco-only — not supported (no Draco decoder in this adapter).');
  if (typeof schemaEnc === 'string' && schemaEnc.toLowerCase().startsWith('lepcc'))
    throw new Error('I3S PointCloud uses LEPCC-compressed positions — not supported.');

  const nodesPerPage = sl.nodePages?.nodesPerPage ?? sl.store?.index?.nodesPerPage ?? 64;
  const schema = sl.store?.defaultGeometrySchema || null;
  const sr = sl.spatialReference || sl.store?.spatialReference;
  const isGeographic = (sr?.latestWkid === 4326 || sr?.wkid === 4326);

  // Flatten all node pages into one array indexed by global node index.
  const nodes = [];
  for (let page = 0; ; page++) {
    let pg;
    try { pg = JSON.parse((await getFile(`nodepages/${page}.json`)).toString('utf8')); }
    catch { break; }
    for (const n of pg.nodes) { if (Number.isInteger(n.index)) nodes[n.index] = n; else nodes.push(n); }
    if (pg.nodes.length < nodesPerPage) break;
  }
  if (!nodes.length) throw new Error('No node pages (nodepages/0.json). Legacy 3dNodeIndexDocument not supported.');

  // Shared ENU frame at the root OBB centre (geometry + boxes stored in ENU metres; only the root
  // tile carries the ENU→ECEF transform — descendants inherit it, mirroring the offline converter).
  const originGeo  = isGeographic ? nodes[0].obb.center : [0, 0, 0];
  const originEcef = geodeticToEcef(originGeo);
  const lon0 = originGeo[0]*Math.PI/180, lat0 = originGeo[1]*Math.PI/180;
  const sLon=Math.sin(lon0), cLon=Math.cos(lon0), sLat=Math.sin(lat0), cLat=Math.cos(lat0);
  const EAST=[-sLon,cLon,0], NORTH=[-sLat*cLon,-sLat*sLon,cLat], UP=[cLat*cLon,cLat*sLon,sLat];
  const toEnu = (e) => { const dx=e[0]-originEcef[0], dy=e[1]-originEcef[1], dz=e[2]-originEcef[2];
    return [dx*EAST[0]+dy*EAST[1]+dz*EAST[2], dx*NORTH[0]+dy*NORTH[1]+dz*NORTH[2], dx*UP[0]+dy*UP[1]+dz*UP[2]]; };

  const ctx = {
    getFile, nodes, schema, isGeographic, layerType,
    isPoint: POINT_TYPES.has(layerType),
    bufIdx: uncompressedBufferIndex >= 0 ? uncompressedBufferIndex : 0,
    originEcef, EAST, NORTH, UP, toEnu,
  };
  ctxCache.set(url, ctx);
  console.log(`[i3s-live] ${url} → ${layerType} v${sl.store?.version}, ${nodes.length} nodes (${isGeographic ? 'WGS84' : 'local'})`);
  return ctx;
}

// ── Bounding box from OBB (cheap pass — no geometry) ──────────────────────────────────────────
// Convert the node OBB to an axis-aligned box in the shared ENU frame by enclosing its 8 corners.
// (Enclosing AABB always contains whatever the OBB contains, so the box ⊇ mesh regardless of the
//  OBB orientation — avoids the offline draft's "rotated box doesn't contain mesh" pitfall.)
function obbToEnuBox(ctx, obb) {
  if (!ctx.isGeographic) {
    const c = obb.center, h = obb.halfSize;
    return [c[0], c[1], c[2], h[0],0,0, 0,h[1],0, 0,0,h[2]];
  }
  const e = obbToBox(obb, true); // [cx,cy,cz, ax(3), ay(3), az(3)] in ECEF
  const c = [e[0], e[1], e[2]], ax = [e[3],e[4],e[5]], ay = [e[6],e[7],e[8]], az = [e[9],e[10],e[11]];
  const min = [Infinity,Infinity,Infinity], max = [-Infinity,-Infinity,-Infinity];
  for (const sx of [-1,1]) for (const sy of [-1,1]) for (const sz of [-1,1]) {
    const corner = [ c[0]+sx*ax[0]+sy*ay[0]+sz*az[0], c[1]+sx*ax[1]+sy*ay[1]+sz*az[1], c[2]+sx*ax[2]+sy*ay[2]+sz*az[2] ];
    const u = ctx.toEnu(corner);
    for (let k=0;k<3;k++){ if(u[k]<min[k])min[k]=u[k]; if(u[k]>max[k])max[k]=u[k]; }
  }
  const cen=[0,1,2].map(k=>(min[k]+max[k])/2), hf=[0,1,2].map(k=>Math.max((max[k]-min[k])/2,0.5));
  return [cen[0],cen[1],cen[2], hf[0],0,0, 0,hf[1],0, 0,0,hf[2]];
}

const nodeHasGeometry = (n) => !!(n.mesh?.geometry) || Number.isInteger(n.resourceId);

function buildTileset(ctx, urlParam) {
  const enc = encodeURIComponent(urlParam);

  const buildTile = (idx, seen) => {
    const node = ctx.nodes[idx];
    if (!node || seen.has(idx)) return null;
    seen.add(idx);
    const box = obbToEnuBox(ctx, node.obb);
    const tile = { boundingVolume: { box }, geometricError: 0, refine: 'REPLACE' };
    if (nodeHasGeometry(node)) tile.content = { uri: `tile/${idx}.glb?url=${enc}` };
    const kids = [];
    for (const ci of (node.children || [])) { const c = buildTile(ci, seen); if (c) kids.push(c); }
    if (kids.length) tile.children = kids;
    // GE shrinks with depth: half the box diagonal for interior nodes, 0 at leaves.
    const diag = 2 * Math.hypot(box[3], box[7], box[11]);
    tile.geometricError = kids.length ? diag * 0.5 : 0;
    return tile;
  };

  const root = buildTile(0, new Set());
  if (!root) throw new Error('I3S root node (index 0) missing');
  if (ctx.isGeographic) {
    const { EAST:E, NORTH:N, UP:U, originEcef:o } = ctx;
    root.transform = [ E[0],E[1],E[2],0, N[0],N[1],N[2],0, U[0],U[1],U[2],0, o[0],o[1],o[2],1 ];
  }
  return {
    asset: { version: '1.1' },
    geometricError: root.geometricError || 1e6,
    root,
    extensionsUsed: ['3DTILES_content_gltf'],
  };
}

// Minimal valid glTF 2.0 GLB with an empty scene — served when a node advertises content but its
// geometry is missing/empty, so renderers don't error on a 404 (they just draw nothing for it).
const EMPTY_GLB = (() => {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }] }), 'utf8');
  const pad = (4 - (json.length & 3)) & 3;
  const out = Buffer.allocUnsafe(12 + 8 + json.length + pad);
  let o = 0;
  out.writeUInt32LE(0x46546C67, o); o += 4; out.writeUInt32LE(2, o); o += 4; out.writeUInt32LE(out.length, o); o += 4;
  out.writeUInt32LE(json.length + pad, o); o += 4; out.writeUInt32LE(0x4E4F534A, o); o += 4;
  json.copy(out, o); o += json.length; out.fill(0x20, o, o + pad);
  return out;
})();

async function serveTileGlb(ctx, idx) {
  const node = ctx.nodes[idx];
  if (!node || !nodeHasGeometry(node)) return EMPTY_GLB;
  const res = node.mesh?.geometry ? node.mesh.geometry.resource : node.resourceId;

  let buf;
  try { buf = await ctx.getFile(`nodes/${res}/geometries/${ctx.bufIdx}.bin`); }
  catch { try { buf = await ctx.getFile(`geometries/${res}.bin`); } catch { return EMPTY_GLB; } }

  const g = decodeDefaultGeometry(buf, ctx.schema);
  if (!g.vertexCount) return EMPTY_GLB;

  let positions = g.position;
  if (ctx.isGeographic) {
    const c = node.obb.center;
    positions = new Float32Array(g.vertexCount * 3);
    for (let i = 0; i < g.vertexCount; i++) {
      const e = geodeticToEcef([c[0] + g.position[i*3], c[1] + g.position[i*3+1], c[2] + g.position[i*3+2]]);
      const u = ctx.toEnu(e);
      positions[i*3] = u[0]; positions[i*3+1] = u[2]; positions[i*3+2] = -u[1]; // glTF (E, U, −N)
    }
  }
  return Buffer.from(buildGlb({ mode: ctx.isPoint ? 'POINTS' : 'TRIANGLES', positions, normals: g.normal, colors: g.color }));
}

// Pure builders for the /stream dispatcher.
export const i3sTileRe = /^\d+$/;
export async function i3sTileset(url) { return buildTileset(await getCtx(url), url); }
export async function i3sTile(url, key) { return serveTileGlb(await getCtx(url), Number(key)); }

/** Try to handle a /i3s/* request. Returns true iff it owned the response. */
export async function handleI3s(req, res, u) {
  if (!u.pathname.startsWith('/i3s/')) return false;
  const url = u.searchParams.get('url');
  if (!url) { res.writeHead(400, CORS); res.end('missing ?url=<3dSceneLayer.json or .slpk URL>'); return true; }

  try {
    if (u.pathname === '/i3s/tileset.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(await i3sTileset(url)));
      return true;
    }
    const m = u.pathname.match(/^\/i3s\/tile\/(\d+)\.glb$/);
    if (m) {
      const glb = await i3sTile(url, m[1]);
      if (!glb) { res.writeHead(404, CORS); res.end('no such node / no geometry'); return true; }
      res.writeHead(200, { 'Content-Type': 'model/gltf-binary', ...CORS });
      res.end(glb);
      return true;
    }
    res.writeHead(404, CORS); res.end('not found');
  } catch (e) {
    console.error('[i3s-live]', e.message);
    if (!res.headersSent) { res.writeHead(500, CORS); res.end(e.message); }
    else res.end();
  }
  return true;
}
