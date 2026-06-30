/**
 * dump-live.js — **generic 3D Tiles bbox crop / subsample extract**. Since every adapter here emits 3D
 * Tiles, the dumper ingests *3D Tiles* (any source — our /stream COPC/Potree/SOG/LCC/RAD/I3S outputs,
 * /bing, /threemx, or an external tileset) and branches by content type:
 *   • POINTS / splats  → LAS   (GET /dump/las)
 *   • TRIANGLES (mesh) → merged GLB (GET /dump/glb)
 *
 *   GET /dump/{las|glb}?url=<tileset.json>&bbox=<west,south,minH,east,north,maxH>[&maxGE=<m>][&maxDepth=N]
 *
 * `bbox` is GEOGRAPHIC (lon/lat degrees + ellipsoidal height m) — what you'd draw on the globe. Traversal
 * honours per-tile refine: **ADD** tiles contribute at every level down to `maxGE` (accumulate); **REPLACE**
 * tiles contribute only at the refinement frontier (GE ≤ maxGE or leaf). Explicit children + external
 * tileset refs (`content.uri` *.json) are followed. Each content GLB is decompressed (Draco/meshopt/KTX2),
 * its vertices transformed to ECEF via the tile transform chain (+ glTF Y-up→Z-up), and tested against the
 * bbox (ECEF→geodetic per vertex). LAS via core las-writer; hand to `pdal writers.copc`/`untwine` for
 * LAZ/COPC. (Implicit-subtree expansion + the in-viewer draw-bbox UI are the next increments.)
 */
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { crc32 } from 'node:zlib';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { readSpz, combine, writeSpz, writeSog, writeGlb, MemoryReadFileSystem, MemoryFileSystem } from '@playcanvas/splat-transform';
import { decompressGlb, LasWriter, lasHeaderBuffer, lasRecordBuffer, ecefToLlh, llhToEcef, enuFrame, CORS } from '../core/index.js';

// Optional ECEF→local-ENU projection (East/North/Up metres at the bbox centre). The default LAS is ECEF
// (EPSG:4978); &enu=1 gives a usable local metric frame instead of a global geocentric one.
function makeProject(bb, enu) {
  if (!enu) return { proj: (X, Y, Z) => [X, Y, Z], offset: llhToEcef((bb[0]+bb[3])/2, (bb[1]+bb[4])/2, (bb[2]+bb[5])/2) };
  const cLon = (bb[0]+bb[3])/2, cLat = (bb[1]+bb[4])/2, c = llhToEcef(cLon, cLat, (bb[2]+bb[5])/2);
  const { EAST: E, NORTH: N, UP: U } = enuFrame(cLon, cLat);
  return { proj: (X, Y, Z) => { const dx = X-c[0], dy = Y-c[1], dz = Z-c[2];
    return [dx*E[0]+dy*E[1]+dz*E[2], dx*N[0]+dy*N[1]+dz*N[2], dx*U[0]+dy*U[1]+dz*U[2]]; }, offset: [0, 0, 0] };
}

// Extract the raw SPZ blob from a splat tile GLB WITHOUT decoding it via gltf-transform (which can't
// read the required KHR_gaussian_splatting_compression_spz_2 extension). Manual GLB parse: JSON chunk →
// the primitive's spz bufferView → slice from the BIN chunk. Returns null if not an spz splat GLB.
function extractSpz(glb) {
  if (glb.length < 28 || glb.toString('latin1', 0, 4) !== 'glTF') return null;
  const jl = glb.readUInt32LE(12);
  let json; try { json = JSON.parse(glb.toString('utf8', 20, 20 + jl)); } catch { return null; }
  const ext = json.meshes?.[0]?.primitives?.[0]?.extensions?.KHR_gaussian_splatting?.extensions?.KHR_gaussian_splatting_compression_spz_2;
  if (!ext || ext.bufferView == null) return null;
  const bv = json.bufferViews?.[ext.bufferView]; if (!bv) return null;
  const binStart = 28 + jl;                                  // 12B header + JSON chunk(8B+jl) + BIN chunk header(8B)
  return glb.subarray(binStart + (bv.byteOffset || 0), binStart + (bv.byteOffset || 0) + bv.byteLength);
}

const IDENT = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
// 3D Tiles glTF content is Y-up; Cesium applies RX(+90): (x,y,z)→(x,−z,y). Bake it so our ECEF matches.
const YUP_ZUP = [1,0,0,0, 0,0,1,0, 0,-1,0,0, 0,0,0,1];
function matMul(a, b) {                       // column-major 4×4, returns a·b
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    o[c*4+r] = a[r]*b[c*4] + a[4+r]*b[c*4+1] + a[8+r]*b[c*4+2] + a[12+r]*b[c*4+3];
  return o;
}
const xform = (m, x, y, z) => [m[0]*x+m[4]*y+m[8]*z+m[12], m[1]*x+m[5]*y+m[9]*z+m[13], m[2]*x+m[6]*y+m[10]*z+m[14]];

const fetchBuf = (u) => fetch(u).then(r => { if (!r.ok) throw new Error(`fetch ${u} → ${r.status}`); return r.arrayBuffer(); }).then(a => Buffer.from(a));
const absUrl = (uri, base) => /^https?:/i.test(uri) ? uri : new URL(uri, base).href;
const inBbox = (lon, lat, h, bb) => lon >= bb[0] && lon <= bb[3] && lat >= bb[1] && lat <= bb[4] && h >= bb[2] && h <= bb[5];
const overlap = (mn, mx, bb) => mx[0] >= bb[0] && mn[0] <= bb[3] && mx[1] >= bb[1] && mn[1] <= bb[4] && mx[2] >= bb[2] && mn[2] <= bb[5];
const R2D = 180 / Math.PI;

// Does a tile's bounding volume (geographic, after its world transform `m`) intersect the bbox?
// Essential pruning — without it we'd walk the whole globe. Handles `region` (cartographic) + `box`.
function tileIntersects(node, m, bb) {
  const bv = node.boundingVolume; if (!bv) return true;     // no bv → can't prune, descend
  if (bv.region) {
    const [w, s, e, n, mnh, mxh] = bv.region;
    return overlap([w * R2D, s * R2D, mnh], [e * R2D, n * R2D, mxh], bb);
  }
  if (bv.box) {
    const c = bv.box, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let sx = -1; sx <= 1; sx += 2) for (let sy = -1; sy <= 1; sy += 2) for (let sz = -1; sz <= 1; sz += 2) {
      const lx = c[0] + sx*c[3] + sy*c[6] + sz*c[9], ly = c[1] + sx*c[4] + sy*c[7] + sz*c[10], lz = c[2] + sx*c[5] + sy*c[8] + sz*c[11];
      const w = xform(m, lx, ly, lz), ll = ecefToLlh(w[0], w[1], w[2]);
      for (let k = 0; k < 3; k++) { if (ll[k] < mn[k]) mn[k] = ll[k]; if (ll[k] > mx[k]) mx[k] = ll[k]; }
    }
    return overlap(mn, mx, bb);
  }
  return true;
}

// ── implicit tiling (OCTREE/QUADTREE subtrees) expansion ─────────────────────────
function parseSubtree(buf) {
  if (buf.toString('latin1', 0, 4) !== 'subt') return null;
  const jl = Number(buf.readBigUInt64LE(8));
  const j = JSON.parse(buf.toString('utf8', 24, 24 + jl));
  const bin = buf.subarray(24 + jl + ((8 - (jl % 8)) % 8)), bv = j.bufferViews || [];
  const v = (i) => i == null ? null : bin.subarray(bv[i].byteOffset, bv[i].byteOffset + bv[i].byteLength);
  return { tile: { b: v(j.tileAvailability?.bitstream), c: j.tileAvailability?.constant },
           content: { b: v(j.contentAvailability?.[0]?.bitstream), c: j.contentAvailability?.[0]?.constant } };
}
const bit = (a, i) => a && a.b ? ((a.b[i >> 3] >> (i & 7)) & 1) : (a && a.c ? 1 : 0);
const morton = (dims, co) => { let m = 0; for (let i = 0; i < 16; i++) for (let d = 0; d < dims; d++) m |= ((co[d] >> i) & 1) << (dims * i + d); return m; };
const subst = (tpl, l, x, y, z) => tpl.replace(/\{level\}/g, l).replace(/\{x\}/g, x).replace(/\{y\}/g, y).replace(/\{z\}/g, z);
// axis-aligned sub-box of `rootBox` at implicit coord (level,x,y[,z]).
function cellBox(rootBox, level, x, y, z, dims) {
  const n = 2 ** level, hx = rootBox[3], hy = rootBox[7], hz = rootBox[11];
  const sx = 2*hx/n, sy = 2*hy/n, sz = 2*hz/n;
  const ccx = rootBox[0]-hx + (x+0.5)*sx, ccy = rootBox[1]-hy + (y+0.5)*sy, ccz = dims === 3 ? rootBox[2]-hz + (z+0.5)*sz : rootBox[2];
  return [ccx, ccy, ccz, sx/2,0,0, 0,sy/2,0, 0,0, dims === 3 ? sz/2 : hz];
}
async function expandImplicit(node, worldM, base, bb, maxGE, maxDepth, onContent) {
  const it = node.implicitTiling, dims = it.subdivisionScheme === 'OCTREE' ? 3 : 2, SL = it.subtreeLevels;
  const rootGE = node.geometricError ?? 0, rootBox = node.boundingVolume?.box, contentTpl = node.content?.uri, subTpl = it.subtrees?.uri;
  if (!rootBox || !contentTpl || !subTpl) return;
  const add = (node.refine || 'REPLACE').toUpperCase() === 'ADD', cells = (2 ** dims), cache = new Map();
  const getSub = async (l, x, y, z) => { const k = `${l}-${x}-${y}-${z}`; if (cache.has(k)) return cache.get(k);
    let s = null; try { s = parseSubtree(await fetchBuf(absUrl(subst(subTpl, l, x, y, z), base))); } catch {} cache.set(k, s); return s; };
  const walk = async (level, x, y, z) => {
    if (level > maxDepth) return;
    const sroot = Math.floor(level / SL) * SL, d = level - sroot;
    const sub = await getSub(sroot, x >> d, y >> d, dims === 3 ? z >> d : 0); if (!sub) return;
    const lx = x & ((1 << d) - 1), ly = y & ((1 << d) - 1), lz = dims === 3 ? z & ((1 << d) - 1) : 0;
    const tIdx = (cells ** d - 1) / (cells - 1) + morton(dims, dims === 3 ? [lx, ly, lz] : [lx, ly]);
    if (!bit(sub.tile, tIdx)) return;
    const box = cellBox(rootBox, level, x, y, z, dims);
    if (!tileIntersects({ boundingVolume: { box } }, worldM, bb)) return;
    const descend = rootGE / 2 ** level > maxGE && level < maxDepth;
    if (bit(sub.content, tIdx) && (add || !descend)) await onContent(absUrl(subst(contentTpl, level, x, y, z), base), worldM, { boundingVolume: { box } });
    if (!descend) return;
    for (let i = 0; i < cells; i++) await walk(level + 1, x*2 + (i&1), y*2 + ((i>>1)&1), dims === 3 ? z*2 + ((i>>2)&1) : 0);
  };
  await walk(0, 0, 0, 0);
}

// Walk a tileset tree; call onContent(absoluteGlbUrl, worldMatrix) for each content tile to harvest.
async function traverse(tilesetUrl, bb, maxGE, maxDepth, onContent) {
  const ts = JSON.parse((await fetchBuf(tilesetUrl)).toString('utf8'));
  const root = ts.root; if (!root) return;
  const recur = async (node, parentM, base, depth) => {
    if (!node || depth > maxDepth) return;
    const m = node.transform ? matMul(parentM, node.transform) : parentM;
    if (!tileIntersects(node, m, bb)) return;               // prune: skip subtrees outside the bbox
    if (node.implicitTiling) return expandImplicit(node, m, base, bb, maxGE, maxDepth, onContent);   // implicit subtree walk
    const ge = node.geometricError ?? 0;
    const isJsonContent = node.content && /\.json(\?|$)/i.test(node.content.uri || '');
    const hasContent = node.content && !isJsonContent;
    const hasKids = (node.children && node.children.length) || isJsonContent;
    // Descend while finer than maxGE, OR while this branch hasn't hit content yet (Bing/sparse trees have
    // content-less coarse tiles — without this, a coarse maxGE stops above the content and yields nothing).
    const descend = hasKids && (ge > maxGE || !hasContent);
    const refine = (node.refine || 'REPLACE').toUpperCase();
    const takeContent = hasContent && (refine === 'ADD' || !descend);  // ADD: every level; REPLACE: frontier
    if (takeContent) await onContent(absUrl(node.content.uri, base), m, node);
    if (!descend) return;
    // external tileset ref as content → recurse into it
    if (node.content && /\.json(\?|$)/i.test(node.content.uri || '')) {
      const childUrl = absUrl(node.content.uri, base);
      const cts = JSON.parse((await fetchBuf(childUrl)).toString('utf8'));
      if (cts.root) await recur(cts.root, m, childUrl, depth + 1);
    }
    for (const c of node.children || []) await recur(c, m, base, depth + 1);
  };
  await recur(root, IDENT, tilesetUrl, 0);
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

// Iterate every in-bbox point (any POSITION accessor) of the cropped region, calling async cb(X,Y,Z,r,g,b)
// in ECEF. Used by the disk-free 2-pass LAS stream (pass 1 counts, pass 2 streams) — fully out-of-core.
async function forEachPoint(url, bb, maxGE, maxDepth, cb) {
  await traverse(url, bb, maxGE, maxDepth, async (glbUrl, worldM) => {
    let glb; try { glb = (await decompressGlb(await fetchBuf(glbUrl), {})).glb; } catch { return; }
    let doc; try { doc = await io.readBinary(new Uint8Array(glb)); } catch { return; }
    for (const mesh of doc.getRoot().listMeshes()) {
      const node = doc.getRoot().listNodes().find(nd => nd.getMesh() === mesh);
      const M = matMul(matMul(worldM, YUP_ZUP), node ? node.getWorldMatrix() : IDENT);
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION'); if (!pos) continue;
        const col = prim.getAttribute('COLOR_0'), n = pos.getCount();
        for (let i = 0; i < n; i++) {
          const p = pos.getElement(i, [0, 0, 0]); const [X, Y, Z] = xform(M, p[0], p[1], p[2]);
          const [lon, lat, h] = ecefToLlh(X, Y, Z); if (!inBbox(lon, lat, h, bb)) continue;
          let r = 0, g = 0, b = 0;
          if (col) { const c = col.getElement(i, [0, 0, 0, 1]), s = col.getNormalized() ? 65535 : 257; r = (c[0]*s)|0; g = (c[1]*s)|0; b = (c[2]*s)|0; }
          await cb(X, Y, Z, r, g, b);
        }
      }
    }
  });
}
// write a chunk respecting backpressure (so the response buffer can't grow unbounded → stays out-of-core)
const writeChunk = (res, buf) => res.write(buf) ? Promise.resolve() : new Promise(r => res.once('drain', r));

// Minimal STORE-mode (no compression) streaming ZIP → response. Each entry's data is fully in hand
// before add() (one tile at a time → out-of-core), so crc/size go in the local header (no descriptors).
// 32-bit (zip32) — fine for crops; zip64 for >4 GB is future. GLBs are already compressed, so store is ideal.
function zipStreamer(res) {
  const entries = []; let offset = 0;
  const w = async (buf) => { await writeChunk(res, buf); offset += buf.length; };
  return {
    async add(name, data) {
      const nameBuf = Buffer.from(name, 'utf8'), crc = crc32(data) >>> 0, size = data.length, localOffset = offset;
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(0, 6);     // sig, ver, flags+method(store)
      lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(size, 18); lh.writeUInt32LE(size, 22);
      lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
      await w(lh); await w(nameBuf); await w(data);
      entries.push({ nameBuf, crc, size, localOffset });
    },
    async end() {
      const cdStart = offset;
      for (const e of entries) {
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(0, 8);
        c.writeUInt32LE(0, 12); c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.size, 20); c.writeUInt32LE(e.size, 24);
        c.writeUInt16LE(e.nameBuf.length, 28); c.writeUInt32LE(0, 30); c.writeUInt32LE(0, 34); c.writeUInt32LE(0, 38); c.writeUInt32LE(e.localOffset, 42);
        await w(c); await w(e.nameBuf);
      }
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
      eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
      eocd.writeUInt32LE(offset - cdStart, 12); eocd.writeUInt32LE(cdStart, 16); eocd.writeUInt16LE(0, 20);
      await w(eocd); res.end();
    },
  };
}

export async function handleDump(req, res, u) {
  if (!u.pathname.startsWith('/dump/')) return false;
  const kind = { '/dump/las': 'las', '/dump/glb': 'glb', '/dump/copc': 'copc', '/dump/tileset': 'tileset', '/dump/zip': 'zip', '/dump/splat': 'splat' }[u.pathname] || null;
  const url = u.searchParams.get('url');
  const bboxStr = u.searchParams.get('bbox');
  const maxGE = u.searchParams.has('maxGE') ? Number(u.searchParams.get('maxGE')) : 0;       // 0 = finest
  const maxDepth = u.searchParams.has('maxDepth') ? Number(u.searchParams.get('maxDepth')) : 99;
  if (!kind || !url || !bboxStr) {
    res.writeHead(400, CORS); res.end('GET /dump/{las|copc|glb|tileset}?url=<tileset.json>&bbox=west,south,minH,east,north,maxH[&maxGE=m][&maxDepth=N]'); return true;
  }
  const bb = bboxStr.split(',').map(Number);
  if (bb.length !== 6 || bb.some(Number.isNaN)) { res.writeHead(400, CORS); res.end('bbox needs 6 numbers (deg,deg,m,deg,deg,m)'); return true; }

  // tileset mode: no decode/merge — emit a filtered 3D Tiles tileset referencing only the in-bbox tiles
  // (each leaf keeps its world transform + points at the original tile GLB). Works for splats too.
  if (kind === 'tileset') {
    try {
      const children = [];
      await traverse(url, bb, maxGE, maxDepth, async (glbUrl, worldM, node) => {
        const box = node?.boundingVolume?.box || [0,0,0, 1,0,0, 0,1,0, 0,0,1];
        children.push({ transform: Array.from(worldM), boundingVolume: { box }, geometricError: 0, refine: 'ADD', content: { uri: glbUrl } });
      });
      const ts = { asset: { version: '1.1' }, geometricError: 1e7,
        root: { boundingVolume: { region: [bb[0]/R2D, bb[1]/R2D, bb[3]/R2D, bb[4]/R2D, bb[2], bb[5]] }, geometricError: 1e7, refine: 'ADD', children } };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="crop-tileset.json"',
        'X-Dump-Tiles': String(children.length), 'Access-Control-Expose-Headers': 'X-Dump-Tiles', ...CORS });
      res.end(JSON.stringify(ts)); return true;
    } catch (e) { console.error('[dump-live]', e.message); res.writeHead(500, CORS); res.end(e.message); return true; }
  }

  // splat mode: merge in-bbox SPLAT tiles into ONE supersplat-ingestable file (.spz/.sog) via PlayCanvas
  // splat-transform — extract each tile's SPZ blob (no gltf-transform decode), readSpz → DataTable,
  // combine, writeSpz/writeSog. Tile-level crop (tiles share the dataset frame, so no per-splat transform).
  if (kind === 'splat') {
    try {
      const fmt = ['sog', 'glb', 'ply'].includes(u.searchParams.get('format')) ? u.searchParams.get('format') : 'spz';
      const clip = u.searchParams.get('clip') === '1' || u.searchParams.get('clip') === 'true';   // per-splat-centroid clip
      const dts = [];
      await traverse(url, bb, maxGE, maxDepth, async (glbUrl, worldM) => {
        let glb; try { glb = await fetchBuf(glbUrl); } catch { return; }
        const spz = extractSpz(glb); if (!spz) return;
        const rfs = new MemoryReadFileSystem(); rfs.set('t.spz', new Uint8Array(spz));
        let dt; try { dt = await readSpz(await rfs.createSource('t.spz')); } catch (e) { return void console.warn('[dump-live] readSpz:', e.message); }
        if (clip) {                                       // drop splats whose centroid is outside the bbox
          // EXPERIMENTAL: readSpz returns a per-tile dt.transform that this does NOT yet compose, so the
          // placement is off and it under-clips. Opt-in (&clip=1, default off) until the frame is validated.
          const xs = dt.getColumnByName('x')?.data, ys = dt.getColumnByName('y')?.data, zs = dt.getColumnByName('z')?.data;
          if (xs && ys && zs) {
            const keep = [];
            for (let i = 0; i < dt.numRows; i++) { const [X, Y, Z] = xform(worldM, xs[i], ys[i], zs[i]); const [lon, lat, h] = ecefToLlh(X, Y, Z); if (inBbox(lon, lat, h, bb)) keep.push(i); }
            dt = dt.clone({ rows: keep });
          }
        }
        dts.push(dt);
      });
      if (!dts.length) { res.writeHead(404, CORS); res.end('no splat tiles in bbox (is this a splat source?)'); return true; }
      const merged = combine(dts);
      const mfs = new MemoryFileSystem(), name = `crop.${fmt === 'glb' ? 'glb' : fmt}`;
      if (fmt === 'sog') await writeSog({ filename: name, dataTable: merged }, mfs);
      else if (fmt === 'glb') await writeGlb({ filename: name, dataTable: merged }, mfs);   // KHR_gaussian_splatting GLB
      else await writeSpz({ filename: name, dataTable: merged }, mfs);
      const out = mfs.results.get(name);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"`,
        'X-Dump-Tiles': String(dts.length), 'X-Dump-Splats': String(merged.numRows), 'Access-Control-Expose-Headers': 'X-Dump-Tiles,X-Dump-Splats', ...CORS });
      res.end(Buffer.from(out.buffer || out)); return true;
    } catch (e) { console.error('[dump-live]', e.message); if (!res.headersSent) { res.writeHead(500, CORS); res.end(e.message); } else res.end(); return true; }
  }

  // zip mode: out-of-core single-download bundle — stream each in-bbox tile GLB (one at a time) + a
  // self-contained tileset.json into a STORE-mode zip. Works for mesh/splat/points; no decode/merge.
  if (kind === 'zip') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="crop.zip"', ...CORS });
      const zip = zipStreamer(res); const children = []; let i = 0;
      await traverse(url, bb, maxGE, maxDepth, async (glbUrl, worldM, node) => {
        const name = `tiles/tile_${i++}.glb`;
        try { await zip.add(name, await fetchBuf(glbUrl)); } catch { return; }   // one tile in RAM at a time
        children.push({ transform: Array.from(worldM), boundingVolume: { box: node?.boundingVolume?.box || [0,0,0, 1,0,0, 0,1,0, 0,0,1] }, geometricError: 0, refine: 'ADD', content: { uri: name } });
      });
      const ts = { asset: { version: '1.1' }, geometricError: 1e7,
        root: { boundingVolume: { region: [bb[0]/R2D, bb[1]/R2D, bb[3]/R2D, bb[4]/R2D, bb[2], bb[5]] }, geometricError: 1e7, refine: 'ADD', children } };
      await zip.add('tileset.json', Buffer.from(JSON.stringify(ts)));
      await zip.end();
      return true;
    } catch (e) { console.error('[dump-live]', e.message); if (!res.headersSent) { res.writeHead(500, CORS); res.end(e.message); } else res.end(); return true; }
  }

  // Disk-free out-of-core LAS: 2-pass (pass 1 counts + bbox for the header, pass 2 streams records).
  // No temp file, O(1) RAM — at the cost of traversing/decoding tiles twice. (?stream=1 on /dump/las)
  if (kind === 'las' && (u.searchParams.get('stream') === '1' || u.searchParams.get('stream') === 'true')) {
    try {
      const scale = [0.001, 0.001, 0.001], { proj, offset } = makeProject(bb, u.searchParams.has('enu'));
      let count = 0; const mn = [Infinity,Infinity,Infinity], mx = [-Infinity,-Infinity,-Infinity];
      await forEachPoint(url, bb, maxGE, maxDepth, (X, Y, Z) => { const [px,py,pz]=proj(X,Y,Z); count++; if(px<mn[0])mn[0]=px; if(py<mn[1])mn[1]=py; if(pz<mn[2])mn[2]=pz; if(px>mx[0])mx[0]=px; if(py>mx[1])mx[1]=py; if(pz>mx[2])mx[2]=pz; });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="crop.las"',
        'X-Dump-Points': String(count), 'Access-Control-Expose-Headers': 'X-Dump-Points', ...CORS });
      res.write(lasHeaderBuffer({ scale, offset, count, bbox: count ? { min: mn, max: mx } : null }));
      let chunk = [];                                     // batch ~8k records per write
      await forEachPoint(url, bb, maxGE, maxDepth, async (X, Y, Z, r, g, b) => {
        chunk.push(lasRecordBuffer(...proj(X, Y, Z), { r, g, b }, scale, offset));
        if (chunk.length >= 8192) { await writeChunk(res, Buffer.concat(chunk)); chunk = []; }
      });
      if (chunk.length) await writeChunk(res, Buffer.concat(chunk));
      res.end(); return true;
    } catch (e) { console.error('[dump-live]', e.message); if (!res.headersSent) { res.writeHead(500, CORS); res.end(e.message); } else res.end(); return true; }
  }

  try {
    const out = new Document();                          // for /dump/glb: merged mesh (in-memory)
    const outBuf = out.createBuffer();
    const outScene = out.createScene();
    let tiles = 0, prims = 0, points = 0;

    // ── OUT-OF-CORE LAS: stream points to a temp file via LasWriter (O(1) RAM — header back-patched on
    // close, never holds all points). ECEF offset = bbox centre so quantized int32 stays in range.
    const wantLas = kind === 'las' || kind === 'copc';
    const { proj, offset: lasOffset } = makeProject(bb, u.searchParams.has('enu'));
    let lasw = null, tmp = null;
    if (wantLas) {
      tmp = join(tmpdir(), `dump-${Date.now()}-${Math.floor(performance.now())}.las`);
      lasw = new LasWriter(tmp, { scale: [0.001, 0.001, 0.001], offset: lasOffset });
      await lasw.open();
    }

    await traverse(url, bb, maxGE, maxDepth, async (glbUrl, worldM) => {
      let glb; try { glb = (await decompressGlb(await fetchBuf(glbUrl), {})).glb; } catch { return; }
      let doc; try { doc = await io.readBinary(new Uint8Array(glb)); } catch { return; }
      tiles++;
      for (const mesh of doc.getRoot().listMeshes()) {
        // node matrix for this mesh (first referencing node) × tile world × Y-up→Z-up
        const node = doc.getRoot().listNodes().find(n => n.getMesh() === mesh);
        const nodeM = node ? node.getWorldMatrix() : IDENT;
        const M = matMul(matMul(worldM, YUP_ZUP), nodeM);
        for (const prim of mesh.listPrimitives()) {
          const pos = prim.getAttribute('POSITION'); if (!pos) continue;
          const mode = prim.getMode();                    // 0=POINTS, 4=TRIANGLES
          const n = pos.getCount();
          if (wantLas) {                                  // POINTS (and splats/centres) → streamed LAS
            const col = prim.getAttribute('COLOR_0');
            for (let i = 0; i < n; i++) {
              const p = pos.getElement(i, [0,0,0]);
              const [X, Y, Z] = xform(M, p[0], p[1], p[2]);
              const [lon, lat, h] = ecefToLlh(X, Y, Z);
              if (!inBbox(lon, lat, h, bb)) continue;
              let r = 0, g = 0, b = 0;
              if (col) { const c = col.getElement(i, [0,0,0,1]); const s = col.getNormalized() ? 65535 : 257; r = (c[0]*s)|0; g = (c[1]*s)|0; b = (c[2]*s)|0; }
              await lasw.writePoint(...proj(X, Y, Z), { r, g, b });  // ECEF or ENU (proj); offset applied internally
              points++;
            }
            prims++;
          } else if (mode === 4 || mode === undefined) {  // TRIANGLES → merged GLB (keep in ECEF)
            // clone the primitive's vertices transformed to ECEF; keep UV + material/texture.
            const posArr = new Float32Array(n * 3); let any = false;
            for (let i = 0; i < n; i++) { const p = pos.getElement(i, [0,0,0]); const w = xform(M, p[0], p[1], p[2]);
              const [lon, lat, h] = ecefToLlh(w[0], w[1], w[2]); if (inBbox(lon, lat, h, bb)) any = true;
              posArr[i*3]=w[0]; posArr[i*3+1]=w[1]; posArr[i*3+2]=w[2]; }
            if (!any) continue;                            // primitive entirely outside bbox
            const np = out.createPrimitive().setMode(4)
              .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(posArr).setBuffer(outBuf));
            const idx = prim.getIndices(); if (idx) np.setIndices(out.createAccessor().setType('SCALAR').setArray(Uint32Array.from(idx.getArray())).setBuffer(outBuf));
            const uv = prim.getAttribute('TEXCOORD_0');
            const mat = prim.getMaterial();
            if (uv && mat?.getBaseColorTexture()) {
              np.setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(Float32Array.from(uv.getArray())).setBuffer(outBuf));
              const srcTex = mat.getBaseColorTexture();
              const tex = out.createTexture().setImage(srcTex.getImage()).setMimeType(srcTex.getMimeType() || 'image/jpeg');
              np.setMaterial(out.createMaterial().setBaseColorTexture(tex).setMetallicFactor(0).setRoughnessFactor(1));
            }
            outScene.addChild(out.createNode().setMesh(out.createMesh().addPrimitive(np)));
            prims++;
          }
        }
      }
    });

    if (wantLas) {
      await lasw.close();                                  // back-patch header (count + bbox)
      const hdr = { 'X-Dump-Points': String(points), 'X-Dump-Tiles': String(tiles), 'Access-Control-Expose-Headers': 'X-Dump-Points,X-Dump-Tiles,X-Dump-Primitives', ...CORS };
      if (kind === 'las') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="crop.las"', ...hdr });
        const stream = createReadStream(tmp); stream.pipe(res); stream.on('close', () => unlink(tmp).catch(() => {}));
        return true;
      }
      // copc: shell out to pdal (needs the LAS on disk anyway) → COPC LAZ, then stream it.
      const copc = tmp.replace(/\.las$/, '.copc.laz');
      const cleanup = () => { unlink(tmp).catch(() => {}); unlink(copc).catch(() => {}); };
      const p = spawn(process.env.PDAL_BIN || 'pdal', ['translate', tmp, copc], { stdio: ['ignore', 'ignore', 'pipe'] });
      let perr = '';
      p.stderr.on('data', d => { perr += d; });
      p.on('error', () => { cleanup(); if (!res.headersSent) { res.writeHead(501, CORS); res.end('pdal not installed — /dump/copc needs PDAL on PATH. Use /dump/las and convert with `pdal translate crop.las out.copc.laz`.'); } });
      p.on('close', (code) => {
        if (code !== 0) { cleanup(); if (!res.headersSent) { res.writeHead(500, CORS); res.end('pdal failed: ' + perr.slice(0, 300)); } return; }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="crop.copc.laz"', ...hdr });
        const stream = createReadStream(copc); stream.pipe(res); stream.on('close', cleanup);
      });
      return true;
    }
    const merged = Buffer.from(await io.writeBinary(out));
    res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Disposition': 'attachment; filename="crop.glb"',
      'X-Dump-Primitives': String(prims), 'X-Dump-Tiles': String(tiles), 'Access-Control-Expose-Headers': 'X-Dump-Points,X-Dump-Tiles,X-Dump-Primitives', ...CORS });
    res.end(merged);
  } catch (e) {
    console.error('[dump-live]', e.message);
    if (!res.headersSent) { res.writeHead(500, CORS); res.end(e.message); } else res.end();
  }
  return true;
}
