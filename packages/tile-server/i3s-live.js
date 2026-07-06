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
 * Three source modes (auto-detected from the URL):
 *   • Live ArcGIS SceneServer  — url = …/SceneServer[/layers/<id>]; resources come from the REST API
 *     (`?f=json` for JSON, plain binary for geometry) — never a static `3dSceneLayer.json` file.
 *   • REST / extracted-SLPK dir — url = …/3dSceneLayer.json[.gz]; resources fetched file-by-file
 *     (best for large layers like NYC — we never pull the whole dataset).
 *   • SLPK archive             — url = ….slpk, OR any URL whose response is a zip regardless of its
 *     path (e.g. ArcGIS Online's `…/content/items/<id>/data` download endpoint has no `.slpk` in the
 *     URL at all — detected by sniffing the first bytes for the local PKZIP magic, or by a
 *     Content-Disposition filename ending `.slpk`). Read via loaders.gl over ranged HTTP GETs when the
 *     host honors Range (the common case) — only the ZIP central directory + whichever nodes/textures a
 *     request actually needs get fetched, not the whole archive; falls back to buffering it all only if
 *     Range isn't supported.
 *
 * Mesh geometry: uncompressed only (Draco gated out). PointCloud geometry: uncompressed OR
 * LEPCC-compressed (`encoding: "lepcc-xyz"`, decoded via ../i3s-to-3dtiles/src/lepccDecode.js, a JS
 * port of Esri's own github.com/Esri/lepcc). Textures ARE embedded when the node's material
 * references a raster (JPEG/PNG) format in `textureSetDefinitions` — DDS/KTX2/Basis-encoded textures
 * have no decoder here and are silently skipped (geometry still renders, untextured), same gating
 * philosophy as Draco.
 *
 *   GET /stream/tileset.json?format=i3s&url=<3dSceneLayer.json | .slpk | SceneServer URL>
 *   GET /stream/tile/<nodeIndex>.glb?format=i3s&url=<same URL>
 */
import zlib from 'node:zlib';
import { parseSLPKArchive } from '@loaders.gl/i3s';
import { DataViewReadableFile } from '@loaders.gl/zip';
import { decodeDefaultGeometry, geodeticToEcef, obbToBox } from '../i3s-to-3dtiles/src/i3sParse.js';
import { buildGlb } from '../i3s-to-3dtiles/src/glbBuild.js';
import { enuFrame, memoizeAsync } from '../core/index.js';

const MESH_TYPES  = new Set(['IntegratedMesh', '3DObject']);
const POINT_TYPES = new Set(['PointCloud']);

const gunzipIfNeeded = (buf) => (buf[0] === 0x1f && buf[1] === 0x8b) ? zlib.gunzipSync(buf) : buf;

async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// A live ArcGIS SceneServer (not a pre-extracted local mirror) uses REST resource paths + `?f=json`
// for JSON, not a static-file tree — `nodepages/<p>.json` doesn't exist as a URL; the real endpoint is
// `.../layers/<id>/nodepages/<p>?f=json`. Binary resources (geometry) drop both the `?f=json` and the
// `.bin`/`.json` suffix our generic `rel` naming carries. Verified live against a real ArcGIS-hosted
// IntegratedMesh SceneServer (root node + nodepages/0 both confirmed reachable this way).
function arcgisSceneServerReader(url) {
  const m = url.match(/^(.*\/SceneServer)(?:\/layers\/(\d+))?/i);
  const base = m[1], layerId = m[2] || '0';
  return async (rel) => {
    const isJson = rel.endsWith('.json');
    const restPath = rel === '3dSceneLayer.json' ? `layers/${layerId}` : `layers/${layerId}/${rel.replace(/\.(json|bin)$/, '')}`;
    const r = await fetch(`${base}/${restPath}${isJson ? '?f=json' : ''}`);
    if (!r.ok) throw new Error(`ArcGIS SceneServer getFile ${rel} → ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  };
}

// Does `url` look like an SLPK (zip) archive when the URL itself gives no clue, and does the host
// honor byte-range requests? A single tiny ranged GET answers both: ArcGIS Online's download endpoint
// answers with `Content-Disposition: attachment; filename="Foo.slpk"` and no `.slpk` anywhere in the
// URL path, so a pure extension check misses it — fall back to sniffing the local-file-header PKZIP
// magic (0x50 0x4B, "PK") in the first bytes. `Content-Range: bytes 0-3/<total>` on a real 206 gives
// the archive's total size AND proves range support, both needed for HttpRangeReadableFile below.
async function probeSlpk(url) {
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-3' } });
    if (!r.ok && r.status !== 206) return null;
    const cd = r.headers.get('content-disposition') || '';
    const b = Buffer.from(await r.arrayBuffer());
    const looksLikeSlpk = /\.slpk"?\s*$/i.test(cd) || (b.length >= 2 && b[0] === 0x50 && b[1] === 0x4b);
    if (!looksLikeSlpk) return null;
    const cr = r.headers.get('content-range');
    const total = cr && r.status === 206 ? Number(cr.split('/')[1]) : NaN;
    return { supportsRange: r.status === 206 && Number.isFinite(total), size: total };
  } catch { return null; }
}

// Minimal loaders.gl ReadableFile backed by ranged HTTP GETs instead of an in-memory buffer — lets
// parseSLPKArchive read only the ZIP central directory + whichever nodes/textures a request actually
// needs. Buffering the WHOLE archive first (the previous approach) meant even the very first
// tileset.json had to wait for a full download — verified against the live Rancho Mesh .slpk (286 MB):
// ~27s cold before any response at all, which is what "SLPK not resolving" looks like from a browser
// that gives up waiting. Same range-adapter philosophy as every other format here (COPC/LCC/etc).
class HttpRangeReadableFile {
  constructor(url, size) { this.url = url; this.size = size; this.bigsize = BigInt(size); }
  async close() {}
  async stat() { return { size: this.size, bigsize: this.bigsize, isDirectory: false }; }
  async read(start = 0, length) {
    const s = Number(start);
    const e = length != null ? s + Number(length) - 1 : this.size - 1;
    const r = await fetch(this.url, { headers: { Range: `bytes=${s}-${e}` } });
    if (!r.ok && r.status !== 206) throw new Error(`ranged fetch ${this.url} [${s}-${e}] → ${r.status}`);
    return r.arrayBuffer();
  }
}

// Build a uniform getFile(relPath) → Buffer (gunzipped) over an SLPK archive, a live ArcGIS SceneServer,
// or a plain HTTP base dir (extracted SLPK mirror).
async function makeFileReader(url) {
  if (/\/SceneServer(\/|$|\?)/i.test(url)) return arcgisSceneServerReader(url);
  const looksLikeJson = /\.json(\.gz)?(\?|$)/i.test(url);
  const looksLikeSlpkUrl = /\.slpk(\?|$)/i.test(url);
  const probe = !looksLikeJson ? await probeSlpk(url) : null;
  if (looksLikeSlpkUrl || probe) {
    // Prefer range reads (only pulls the ZIP central directory + whichever nodes/textures a request
    // actually needs); fall back to buffering the whole archive only if the host doesn't honor Range.
    let fileProvider;
    if (probe?.supportsRange) {
      fileProvider = new HttpRangeReadableFile(url, probe.size);
    } else {
      const buf = await fetchBuf(url);
      fileProvider = new DataViewReadableFile(new DataView(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
    }
    const archive = await parseSLPKArchive(fileProvider, undefined, 'slpk');
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

// memoizeAsync caches FAILURES too — a broken source (unreachable, unsupported layerType/LEPCC, ...)
// fails fast on retry instead of re-running the whole SLPK/SceneServer read every time (see cache.js).
const getCtx = memoizeAsync(async (url) => {
  const getFile = await makeFileReader(url);
  const sl = JSON.parse((await getFile('3dSceneLayer.json')).toString('utf8'));

  const layerType = sl.layerType;
  if (!MESH_TYPES.has(layerType) && !POINT_TYPES.has(layerType))
    throw new Error(`I3S layerType "${layerType}" not supported (mesh/point only)`);

  // Pick the uncompressed geometry buffer; gate out Draco-only (LEPCC point clouds are decoded via
  // lepccDecode.js — see decodeDefaultGeometry's dispatch on schema.encoding).
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
  if (uncompressedBufferIndex < 0 && hasDraco)
    throw new Error('I3S layer is Draco-only — not supported (no Draco decoder in this adapter).');

  // Texture lookup: materialDefinitions[].pbrMetallicRoughness.baseColorTexture.textureSetDefinitionId
  // → textureSetDefinitions[].formats[] (each a {name, format} — the SAME logical texture encoded
  // multiple ways, e.g. a plain "jpg" alongside a mipmapped "dds"). We only have a decoder for
  // browser-native raster formats (jpg/png) — pick that one, or null if the layer only ships
  // compressed variants (dds/ktx2/basis), matching the Draco/LEPCC "gate, don't crash" pattern.
  const materialDefs = sl.materialDefinitions || [];
  const textureSetDefs = sl.textureSetDefinitions || [];
  const RASTER_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
  function textureFormatFor(materialDefIdx) {
    const md = materialDefs[materialDefIdx];
    const tsId = md?.pbrMetallicRoughness?.baseColorTexture?.textureSetDefinitionId;
    if (tsId == null) return null;
    const formats = textureSetDefs[tsId]?.formats || [];
    const raster = formats.find(f => RASTER_EXT[f.format?.toLowerCase()]);
    return raster ? { name: raster.name, ext: raster.format.toLowerCase(), mimeType: RASTER_EXT[raster.format.toLowerCase()] } : null;
  }

  const nodesPerPage = sl.nodePages?.nodesPerPage ?? sl.store?.index?.nodesPerPage ?? 64;
  const schema = sl.store?.defaultGeometrySchema || null;
  const sr = sl.spatialReference || sl.store?.spatialReference;
  const isGeographic = (sr?.latestWkid === 4326 || sr?.wkid === 4326);

  // Load node pages: page 0 synchronously (fast cold start), then remaining pages in parallel background.
  const nodes = [];
  const addNodes = (pg) => { for (const n of pg.nodes) { if (Number.isInteger(n.index)) nodes[n.index] = n; else nodes.push(n); } };

  const pg0 = JSON.parse((await getFile('nodepages/0.json')).toString('utf8'));
  addNodes(pg0);
  if (!nodes.length) throw new Error('No node pages (nodepages/0.json). Legacy 3dNodeIndexDocument not supported.');
  let _allPagesLoaded = pg0.nodes.length < nodesPerPage;   // true if single page

  // Pull remaining pages in parallel batches in the background so the full explicit tree is ready —
  // always (2026-07-02: dropped the lazy on-demand-page mode; I3S has no persisted spatial index to make
  // a partial read meaningful, and node pages are cheap JSON metadata, not geometry, so eager cold start
  // is already fast). `i3sTileset` waits up to 3s for this before falling back to whatever's loaded.
  const _pagesDonePromise = _allPagesLoaded ? Promise.resolve() : (async () => {
    const BATCH = 8;
    let page = 1;
    while (true) {
      const results = await Promise.allSettled(
        Array.from({ length: BATCH }, (_, i) => page + i).map(p =>
          getFile(`nodepages/${p}.json`).then(b => ({ page: p, pg: JSON.parse(b.toString('utf8')) }))
        )
      );
      let done = false;
      for (let i = 0; i < results.length; i++) {
        // Some SceneServers answer a missing page with HTTP 200 + an ArcGIS error envelope
        // (`{error:{code:404,...}}`) instead of a real 404 — `getFile` sees that as success, so this
        // isn't caught by `.status !== 'fulfilled'`. Treat a page with no `.nodes` array the same as
        // end-of-pagination (verified against USGSNYC_2014_LiDAR, whose page 0 has exactly
        // nodesPerPage nodes, forcing this exact boundary case).
        if (results[i].status !== 'fulfilled' || !Array.isArray(results[i].value.pg.nodes)) { done = true; break; }
        addNodes(results[i].value.pg);
        if (results[i].value.pg.nodes.length < nodesPerPage) { done = true; break; }
      }
      page += BATCH;
      if (done) break;
    }
    _allPagesLoaded = true;
  })();

  // Shared ENU frame at the root OBB centre (geometry + boxes stored in ENU metres; only the root
  // tile carries the ENU→ECEF transform — descendants inherit it, mirroring the offline converter).
  const originGeo  = isGeographic ? nodes[0].obb.center : [0, 0, 0];
  const originEcef = geodeticToEcef(originGeo);
  const { EAST, NORTH, UP } = enuFrame(originGeo[0], originGeo[1]);
  const toEnu = (e) => { const dx=e[0]-originEcef[0], dy=e[1]-originEcef[1], dz=e[2]-originEcef[2];
    return [dx*EAST[0]+dy*EAST[1]+dz*EAST[2], dx*NORTH[0]+dy*NORTH[1]+dz*NORTH[2], dx*UP[0]+dy*UP[1]+dz*UP[2]]; };

  console.log(`[i3s-live] ${url} → ${layerType} v${sl.store?.version}, ${nodes.length} nodes from page 0 (${isGeographic ? 'WGS84' : 'local'})`
    + `${_allPagesLoaded ? '' : ' — loading remaining pages in background'}`);
  return {
    getFile, nodes, schema, isGeographic, layerType, textureFormatFor,
    isPoint: POINT_TYPES.has(layerType),
    bufIdx: uncompressedBufferIndex >= 0 ? uncompressedBufferIndex : 0,
    originEcef, EAST, NORTH, UP, toEnu,
    _pagesDonePromise, get _allPagesLoaded() { return _allPagesLoaded; },
  };
});

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
  let normals = g.normal;
  if (ctx.isGeographic) {
    // Uncompressed DefaultGeometrySchema stores per-vertex offsets relative to the node OBB centre;
    // LEPCC (g.absolutePosition) decodes straight to absolute (lon, lat, height) — see
    // decodeDefaultGeometry's doc comment in i3sParse.js.
    const c = node.obb.center;
    positions = new Float32Array(g.vertexCount * 3);
    for (let i = 0; i < g.vertexCount; i++) {
      const lon = g.absolutePosition ? g.position[i*3]   : c[0] + g.position[i*3];
      const lat = g.absolutePosition ? g.position[i*3+1] : c[1] + g.position[i*3+1];
      const h   = g.absolutePosition ? g.position[i*3+2] : c[2] + g.position[i*3+2];
      const e = geodeticToEcef([lon, lat, h]);
      const u = ctx.toEnu(e);
      positions[i*3] = u[0]; positions[i*3+1] = u[2]; positions[i*3+2] = -u[1]; // glTF (E, U, −N)
    }
    // Positions get the full geodetic→ECEF→ENU→glTF-axis remap above; normals are pure directions
    // already expressed in the SAME local (East, North, Up) tangent frame I3S stores position offsets
    // in (per-node, no earth-curvature correction needed at building/node scale) — they only need the
    // SAME final glTF-axis relabel, not the geographic reprojection.
    if (g.normal) {
      normals = new Float32Array(g.vertexCount * 3);
      for (let i = 0; i < g.vertexCount; i++) {
        normals[i*3] = g.normal[i*3]; normals[i*3+1] = g.normal[i*3+2]; normals[i*3+2] = -g.normal[i*3+1];
      }
    }
  }
  // Root-caused the "I3S mesh needs brightness ~2048 to look right" report against the real Rancho
  // Mesh dataset: its geometry buffer stores an all-ZERO normal for every vertex (verified — positions
  // decode to real, sane values from the SAME buffer, ruling out an offset/decode bug; this is a
  // genuine characteristic of this Drone2Map/photogrammetry export). A zero-length normal makes the
  // lighting dot product (N·L) zero for every light direction under ANY dynamic lighting model — only
  // a thin ambient/emissive sliver shows through, and cranking the app's own brightness multiplier just
  // amplifies that sliver rather than fixing the shading. glTF's own spec answer for "no usable
  // normals" is to OMIT the attribute entirely: a conformant loader (Cesium, three.js) then computes
  // correct flat per-face normals itself. Detect and drop degenerate all-zero normal data instead of
  // embedding it — the alternative (shading it "shadeless"/unlit) is also valid and already exposed as
  // a toggle in the sidebar, but per-face normals let real dynamic lighting work correctly too.
  if (normals && normals.every((v) => v === 0)) normals = undefined;

  // Texture: node.mesh.material.{definition,resource} — resource is the SAME per-node resource
  // bucket geometry uses, definition indexes materialDefinitions[] for the format lookup. Unlike
  // geometry (always literally `<n>.bin`), a texture's on-disk name convention differs by source mode:
  // a live ArcGIS SceneServer accepts the BARE name (`nodes/<res>/textures/0`, its REST layer strips
  // any `.bin`/`.json` suffix but otherwise serves whatever's asked); an SLPK archive has NO bare-name
  // alias at all (@loaders.gl's SLPKArchive only knows `.jpg`/`.png`/`.ktx`/… — verified: bare 404s,
  // `.jpg` succeeds), and an extracted-SLPK mirror keeps the same real on-disk filenames. Try bare
  // first (the common case), fall back to the real extension.
  let texture;
  const mat = node.mesh?.material;
  if (mat && mat.resource >= 0) {
    const fmt = ctx.textureFormatFor(mat.definition ?? 0);
    if (fmt) {
      // Some ArcGIS SceneServer CDN responses come back HTTP 200 with a JSON error BODY instead of a
      // real 404 (observed intermittently against the live Rancho Mesh service) — validate the magic
      // bytes before trusting either candidate, so a flaky/mismatched response falls through to
      // "untextured" instead of embedding `{"error":...}` as if it were image data.
      const isRaster = (b) => b && b.length > 4 && (
        (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||                          // JPEG
        (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47));          // PNG
      const base = `nodes/${mat.resource}/textures/${fmt.name}`;
      let bytes;
      for (const cand of [base, `${base}.${fmt.ext}`]) {
        try { const b = await ctx.getFile(cand); if (isRaster(b)) { bytes = b; break; } } catch { /* try next */ }
      }
      if (bytes) texture = { bytes, mimeType: fmt.mimeType };
    }
  }

  return Buffer.from(buildGlb({ mode: ctx.isPoint ? 'POINTS' : 'TRIANGLES', positions, normals, colors: g.color, uvs: g.uv0, texture }));
}

// Pure builders for the /stream dispatcher.
export const i3sTileRe = /^\d+$/;
export async function i3sTileset(url) {
  const ctx = await getCtx(url);
  // Wait up to 3 s for all node pages so the explicit tree is complete; page 0 is always ready, so a
  // huge layer still degrades to "root + whatever loaded so far" instead of failing outright.
  if (!ctx._allPagesLoaded) await Promise.race([ctx._pagesDonePromise, new Promise(r => setTimeout(r, 3000))]);
  return buildTileset(ctx, url);
}
export async function i3sTile(url, key) { return serveTileGlb(await getCtx(url), Number(key)); }

// Direct /i3s/* HTTP routes were removed 2026-07-02 — /stream/tileset.json?format=i3s&url=<…> already
// covers tileset serving. The lazy fragment continuation (/stream/i3s/node/<n>.json) and lazy tile mode
// (&lazy=1) were removed the same day: I3S has no persisted spatial index to make a partial read
// meaningful, and node pages are cheap JSON metadata (not geometry), so eager cold start is already
// fast — always explicit, matching the Potree 1.x `tiling=explicit` simplification. See CHANGELOG.
