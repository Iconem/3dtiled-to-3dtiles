/**
 * threemx-live.js — live **Bentley/Acute3D 3MX → OGC 3D Tiles** streaming middleware.
 *
 * 3MX is a named-node mesh-pyramid DAG (not an octree), so — like the I3S/RAD adapters — it's served as
 * **lazy external-tileset fragments keyed by file path**: one `.3mxb` → one tileset.json fragment, whose
 * child `.3mxb` references become external-tileset refs fetched as the camera refines in. Geometry is
 * **OpenCTM** (decoded via the vendored js-openctm) + **JPEG** textures (passthrough); each node's
 * textured mesh is assembled into a glTF with glTF-Transform.
 *
 *   GET /stream/tileset.json?url=<Scene.3mx | root.3mxb URL>&format=threemx
 *   GET /stream/threemx/node/<encRelPath>.json?url=<master>     (lazy fragment for a child .3mxb)
 *   GET /stream/tile/<encRelPath>__<nodeIdx>.glb?url=<master>&format=threemx
 *
 * Master `.3mx` JSON: layers[0] = { SRS, SRSOrigin, root }. `.3mxb`: "3MXBO" + uint32LE headerSize +
 * JSON header { nodes:[{bbMin,bbMax,maxScreenDiameter,children,resources}], resources:[{id,type,format,size}] }
 * + concatenated payload buffers (sliced by resource size, in order). Child paths are relative to the
 * containing `.3mxb`'s directory → remote-friendly (we URL-join against the master's base).
 */
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { georefFromCrs, memoizeAsync, fetchSource as fetchBuf } from '../core/index.js';
import { decodeCTM } from '../threemx-to-3dtiles/src/ctm-decode.js';

const CTM_RE = /__\d+$/;
const baseOf = (u) => u.slice(0, u.lastIndexOf('/') + 1);
const joinRel = (relDir, child) => path.posix.normalize(path.posix.join(relDir, child));

// ── per-URL context (master .3mx parse → base + root rel path + georef) ─────────
// memoizeAsync caches FAILURES too — a broken source fails fast on retry (see cache.js's own comment).
const getCtx = memoizeAsync(async (url) => {
  const base = baseOf(url);
  let rootRel, transform = null;
  if (/\.3mx(\?|$)/i.test(url)) {
    const master = JSON.parse((await fetchBuf(url)).toString('utf8'));
    const layer = (master.layers || [])[0] || {};
    rootRel = layer.root;
    const origin = layer.SRSOrigin || layer.offset;
    if (layer.SRS && Array.isArray(origin)) transform = georefFromCrs(origin, layer.SRS, 'threemx-live');
  } else {
    rootRel = path.posix.basename(url);        // pointed straight at a root .3mxb (no master / SRS)
  }
  console.log(`[threemx-live] ${url} → root=${rootRel}, georef=${!!transform}`);
  return { base, rootRel, transform };
});

// Parse a .3mxb → { nodes, payload:Map<resourceId,{format,data}> }.
function parse3mxb(buf) {
  if (buf.toString('latin1', 0, 5) !== '3MXBO') throw new Error('not a 3MXBO file');
  let hs = buf.readUInt32LE(5), jsonEnd = 9 + hs;
  if (jsonEnd > buf.length) {                  // some files (e.g. hand-authored roots) carry a bogus size
    const txt = buf.toString('latin1'); const s = txt.indexOf('{'); let d = 0, e = -1;
    for (let i = s; i < txt.length; i++) { const c = txt[i]; if (c === '{') d++; else if (c === '}' && --d === 0) { e = i; break; } }
    jsonEnd = e + 1;
  }
  const header = JSON.parse(buf.toString('utf8', 9, jsonEnd));
  const payload = new Map();
  let off = jsonEnd;
  // Each resource def carries id/type/format and, for geometryBuffer, a `texture` ref → its textureBuffer
  // id (the texture is NOT listed in node.resources, only referenced here). Keep all fields + the bytes.
  for (const r of header.resources || []) { payload.set(r.id, { id: r.id, type: r.type, format: r.format, texture: r.texture, data: r.size ? buf.subarray(off, off + r.size) : null }); off += (r.size || 0); }
  return { nodes: header.nodes || [], payload };
}

// 3D Tiles box [cx,cy,cz, hx,0,0, 0,hy,0, 0,0,hz] from bbMin/bbMax (3MX SRS-origin-relative coords).
const boxOf = (mn, mx) => {
  const c = [0, 1, 2].map(k => (mn[k] + mx[k]) / 2), h = [0, 1, 2].map(k => Math.max((mx[k] - mn[k]) / 2, 1e-3));
  return [c[0], c[1], c[2], h[0], 0, 0, 0, h[1], 0, 0, 0, h[2]];
};
const diagOf = (mn, mx) => Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
// maxScreenDiameter is screen-px-on-bounding-sphere; 0 = "always refine". Use bbox diagonal as a
// monotonic geometric error (children are smaller → naturally decreasing). Tunable.
const geOf = (node) => { const d = diagOf(node.bbMin, node.bbMax); return node.maxScreenDiameter > 0 ? d / node.maxScreenDiameter : d; };

// ── lazy fragment: one .3mxb → a tileset.json (its nodes as children; child .3mxb → external refs) ──
async function buildFragment(ctx, relPath, masterUrl, isRoot) {
  const enc = encodeURIComponent(masterUrl);
  const buf = await fetchBuf(ctx.base + relPath);
  const { nodes } = parse3mxb(buf);
  const relDir = path.posix.dirname(relPath);

  const tiles = nodes.map((node, i) => {
    const tile = { boundingVolume: { box: boxOf(node.bbMin, node.bbMax) }, geometricError: geOf(node), refine: 'REPLACE' };
    // Absolute (not relative "tile/…"): this tree can be embedded at /stream/tileset.json OR nested
    // under /stream/threemx/node/<n>.json, where a relative ref would resolve against the FRAGMENT's
    // own path (…/threemx/node/tile/…) instead of /stream/tile/… — same fix RAD/I3S needed pre-simplification.
    if ((node.resources || []).length) tile.content = { uri: `/stream/tile/${encodeURIComponent(relPath)}__${i}.glb?url=${enc}&format=threemx` };
    const kids = [];
    for (const childRel of node.children || []) {
      const cr = joinRel(relDir, childRel);
      // Absolute: this fragment can be embedded at /stream/tileset.json OR nested under
      // /stream/threemx/node/<n>.json, where a relative ref would resolve wrong.
      kids.push({ boundingVolume: { box: boxOf(node.bbMin, node.bbMax) }, geometricError: geOf(node) * 0.5, refine: 'REPLACE',
                  content: { uri: `/stream/threemx/node/${encodeURIComponent(cr)}.json?url=${enc}` } });
    }
    if (kids.length) tile.children = kids;
    return tile;
  });

  // Wrap this file's nodes under one root tile (union box) so the fragment has a single root.
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const n of nodes) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], n.bbMin[k]); mx[k] = Math.max(mx[k], n.bbMax[k]); }
  const root = { boundingVolume: { box: boxOf(mn, mx) }, geometricError: diagOf(mn, mx) * 2, refine: 'REPLACE', children: tiles };
  if (isRoot && ctx.transform) root.transform = ctx.transform;
  return { asset: { version: '1.1' }, geometricError: root.geometricError, root, extensionsUsed: ['3DTILES_content_gltf'] };
}

// ── per-node textured GLB (OpenCTM → glTF + JPEG/PNG baseColor) ──────────────────
// A 3MX node can carry MULTIPLE geometryBuffer resources (each its own CTM, optionally its own texture)
// — render one primitive per geometry. The texture is NOT in node.resources; the geometryBuffer's
// `texture` field references its textureBuffer id (resolved from the payload).
async function buildNodeGlb(ctx, relPath, nodeIdx) {
  const { nodes, payload } = parse3mxb(await fetchBuf(ctx.base + relPath));
  const node = nodes[nodeIdx];
  if (!node) return null;

  const doc = new Document();
  const buffer = doc.createBuffer();
  const mesh = doc.createMesh();
  const texCache = new Map();                               // textureBuffer id → glTF Texture (dedup)
  let primCount = 0;

  for (const id of node.resources || []) {
    const r = payload.get(id);
    if (!r || r.format !== 'ctm' || !r.data) continue;      // geometryBuffer only
    const g = decodeCTM(r.data);
    // 3MX mesh verts are SRS Z-up (E,N,U) relative to SRSOrigin, but 3D Tiles glTF content is Y-up
    // (Cesium auto-rotates +Y→+Z). Swizzle (E,N,U)→(E,U,−N) so after that rotation the mesh lands back
    // in the (E,N,U) frame the root ENU transform + bounding box expect (else it sits 90° vertical).
    const srcPos = g.positions instanceof Float32Array ? g.positions : new Float32Array(g.positions);
    const swPos = new Float32Array(srcPos.length);
    for (let i = 0; i < srcPos.length; i += 3) { swPos[i] = srcPos[i]; swPos[i + 1] = srcPos[i + 2]; swPos[i + 2] = -srcPos[i + 1]; }
    const pos = doc.createAccessor().setType('VEC3').setArray(swPos).setBuffer(buffer);
    const idx = doc.createAccessor().setType('SCALAR').setArray(g.indices instanceof Uint32Array ? g.indices : new Uint32Array(g.indices)).setBuffer(buffer);
    const prim = doc.createPrimitive().setAttribute('POSITION', pos).setIndices(idx);

    // texture: follow the geometryBuffer's `texture` ref → its textureBuffer resource (jpg/png).
    const texRes = r.texture ? payload.get(r.texture) : null;
    if (g.uvs && texRes && texRes.data && (texRes.format === 'jpg' || texRes.format === 'png')) {
      // 3MX/OpenCTM UVs use a bottom-left origin (V up); glTF uses top-left (V down) → flip V (v→1−v),
      // else textures map upside-down / mis-indexed vs the Bentley viewer.
      const srcUv = g.uvs instanceof Float32Array ? g.uvs : new Float32Array(g.uvs);
      const flipUv = new Float32Array(srcUv.length);
      for (let k = 0; k < srcUv.length; k += 2) { flipUv[k] = srcUv[k]; flipUv[k + 1] = 1 - srcUv[k + 1]; }
      const uv = doc.createAccessor().setType('VEC2').setArray(flipUv).setBuffer(buffer);
      prim.setAttribute('TEXCOORD_0', uv);
      let tex = texCache.get(r.texture);
      if (!tex) {
        tex = doc.createTexture().setImage(texRes.data instanceof Uint8Array ? texRes.data : new Uint8Array(texRes.data))
          .setMimeType(texRes.format === 'png' ? 'image/png' : 'image/jpeg');
        texCache.set(r.texture, tex);
      }
      prim.setMaterial(doc.createMaterial().setBaseColorTexture(tex).setMetallicFactor(0).setRoughnessFactor(1));
    }
    mesh.addPrimitive(prim);
    primCount++;
  }
  if (!primCount) return null;
  doc.createScene().addChild(doc.createNode().setMesh(mesh));
  return Buffer.from(await new NodeIO().writeBinary(doc));
}

// Pure builders for the /stream dispatcher.
export const threemxTileRe = /^.+__\d+$/;                    // <encodeURIComponent(relPath)>__<nodeIdx>
export async function threemxTileset(url) { const ctx = await getCtx(url); return buildFragment(ctx, ctx.rootRel, url, true); }
export async function threemxTile(url, key) {
  const us = key.lastIndexOf('__');
  return buildNodeGlb(await getCtx(url), decodeURIComponent(key.slice(0, us)), Number(key.slice(us + 2)));
}
// Lazy fragment continuation for a child .3mxb — 3MX is an arbitrary DAG (no persisted spatial index
// like RAD/I3S had), so unlike those two this genuinely can't collapse to "always eager": discovering
// the tree at all means fetching every .3mxb, which for a real city-scale model is the whole point of
// only doing it as the camera refines in. Called from stream-live.js's /stream/threemx/node/<path>.json.
export async function threemxNode(url, relPath) { return buildFragment(await getCtx(url), relPath, url, false); }

// Direct /threemx/* HTTP routes were removed 2026-07-02 — /stream/tileset.json?format=threemx&url=<…>
// (+ /stream/tile/…) now covers tileset/tile serving; the lazy node-fragment continuation moved to
// /stream/threemx/node/<path>.json (handled in stream-live.js). See CHANGELOG.
