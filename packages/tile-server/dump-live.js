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
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { decompressGlb, writeLasBuffer, ecefToLlh, CORS } from '../core/index.js';

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

// Walk a tileset tree; call onContent(absoluteGlbUrl, worldMatrix) for each content tile to harvest.
async function traverse(tilesetUrl, bb, maxGE, maxDepth, onContent) {
  const ts = JSON.parse((await fetchBuf(tilesetUrl)).toString('utf8'));
  const root = ts.root; if (!root) return;
  const recur = async (node, parentM, base, depth) => {
    if (!node || depth > maxDepth) return;
    const m = node.transform ? matMul(parentM, node.transform) : parentM;
    if (!tileIntersects(node, m, bb)) return;               // prune: skip subtrees outside the bbox
    const ge = node.geometricError ?? 0;
    const hasKids = (node.children && node.children.length) || (node.content && /\.json(\?|$)/i.test(node.content.uri || ''));
    const descend = ge > maxGE && hasKids;
    const refine = (node.refine || 'REPLACE').toUpperCase();
    const takeContent = node.content && !/\.json(\?|$)/i.test(node.content.uri || '') &&
      (refine === 'ADD' || !descend);                    // ADD: every level; REPLACE: frontier only
    if (takeContent) await onContent(absUrl(node.content.uri, base), m);
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

export async function handleDump(req, res, u) {
  if (!u.pathname.startsWith('/dump/')) return false;
  const kind = u.pathname === '/dump/las' ? 'las' : u.pathname === '/dump/glb' ? 'glb' : null;
  const url = u.searchParams.get('url');
  const bboxStr = u.searchParams.get('bbox');
  const maxGE = u.searchParams.has('maxGE') ? Number(u.searchParams.get('maxGE')) : 0;       // 0 = finest
  const maxDepth = u.searchParams.has('maxDepth') ? Number(u.searchParams.get('maxDepth')) : 99;
  if (!kind || !url || !bboxStr) {
    res.writeHead(400, CORS); res.end('GET /dump/{las|glb}?url=<tileset.json>&bbox=west,south,minH,east,north,maxH[&maxGE=m][&maxDepth=N]'); return true;
  }
  const bb = bboxStr.split(',').map(Number);
  if (bb.length !== 6 || bb.some(Number.isNaN)) { res.writeHead(400, CORS); res.end('bbox needs 6 numbers (deg,deg,m,deg,deg,m)'); return true; }

  try {
    const out = new Document();                          // for /dump/glb: merged mesh
    const outBuf = out.createBuffer();
    const outScene = out.createScene();
    const pts = [];                                       // for /dump/las
    let tiles = 0, prims = 0;

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
          if (kind === 'las') {                           // POINTS (and splats/centres) → LAS
            const col = prim.getAttribute('COLOR_0');
            for (let i = 0; i < n; i++) {
              const p = pos.getElement(i, [0,0,0]);
              const [X, Y, Z] = xform(M, p[0], p[1], p[2]);
              const [lon, lat, h] = ecefToLlh(X, Y, Z);
              if (!inBbox(lon, lat, h, bb)) continue;
              let r = 0, g = 0, b = 0;
              if (col) { const c = col.getElement(i, [0,0,0,1]); const s = col.getNormalized() ? 65535 : 257; r = (c[0]*s)|0; g = (c[1]*s)|0; b = (c[2]*s)|0; }
              pts.push({ x: X, y: Y, z: Z, r, g, b });     // ECEF (offset applied at write)
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

    if (kind === 'las') {
      const mn = [Infinity, Infinity, Infinity];
      for (const p of pts) { if (p.x < mn[0]) mn[0] = p.x; if (p.y < mn[1]) mn[1] = p.y; if (p.z < mn[2]) mn[2] = p.z; }
      const las = writeLasBuffer(pts, { scale: [0.001, 0.001, 0.001], offset: pts.length ? mn.map(Math.floor) : [0,0,0] });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="crop.las"',
        'X-Dump-Points': String(pts.length), 'X-Dump-Tiles': String(tiles), ...CORS });
      return void res.end(las);
    }
    const merged = Buffer.from(await io.writeBinary(out));
    res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Disposition': 'attachment; filename="crop.glb"',
      'X-Dump-Primitives': String(prims), 'X-Dump-Tiles': String(tiles), ...CORS });
    res.end(merged);
  } catch (e) {
    console.error('[dump-live]', e.message);
    if (!res.headersSent) { res.writeHead(500, CORS); res.end(e.message); } else res.end();
  }
  return true;
}
