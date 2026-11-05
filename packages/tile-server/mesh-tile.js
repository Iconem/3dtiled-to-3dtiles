/**
 * mesh-tile.js — the CPU half of a live mesh tile (I3S, 3MX): fetched bytes → GLB, with no network and no cached
 * context, so that it runs the same on the server's thread (i3s-live.js, threemx-live.js) and on a tile worker
 * (tile-tasks-mesh.js, behind TILED_WORKERS).
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { decodeDefaultGeometry, geodeticToEcef } from '../i3s-to-3dtiles/src/i3sParse.js';
import { decodeLepccRgb } from '../i3s-to-3dtiles/src/lepccDecode.js';
import { buildGlb } from '../i3s-to-3dtiles/src/glbBuild.js';
import { decodeCTM } from '../threemx-to-3dtiles/src/ctm-decode.js';

/**
 * One I3S node's geometry buffer → GLB bytes, or null when it holds no vertices.
 * @param buf the node's uncompressed geometry (DefaultGeometrySchema, or LEPCC for point clouds)
 * @param spec plain data from the layer's context: { schema, isGeographic, center (the node's OBB centre),
 *             originEcef, EAST, NORTH, UP (the shared ENU frame), isPoint, wantsRgb }
 * @param getTexture async () => { bytes, mimeType } | undefined — asked once the geometry is known to be there
 * @param getRgb async () => the node's LEPCC RGB attribute bytes, or null — asked only when the geometry has no colour
 */
export async function i3sNodeGlb(buf, spec, getTexture, getRgb) {
  const { originEcef, EAST, NORTH, UP } = spec;
  const toEnu = (e) => { const dx=e[0]-originEcef[0], dy=e[1]-originEcef[1], dz=e[2]-originEcef[2];
    return [dx*EAST[0]+dy*EAST[1]+dz*EAST[2], dx*NORTH[0]+dy*NORTH[1]+dz*NORTH[2], dx*UP[0]+dy*UP[1]+dz*UP[2]]; };
  const g = decodeDefaultGeometry(buf, spec.schema);
  if (!g.vertexCount) return null;

  let positions = g.position;
  let normals = g.normal;
  if (spec.isGeographic) {
    // Uncompressed DefaultGeometrySchema stores per-vertex offsets relative to the node OBB centre;
    // LEPCC (g.absolutePosition) decodes straight to absolute (lon, lat, height) — see
    // decodeDefaultGeometry's doc comment in i3sParse.js.
    const c = spec.center;
    positions = new Float32Array(g.vertexCount * 3);
    for (let i = 0; i < g.vertexCount; i++) {
      const lon = g.absolutePosition ? g.position[i*3]   : c[0] + g.position[i*3];
      const lat = g.absolutePosition ? g.position[i*3+1] : c[1] + g.position[i*3+1];
      const h   = g.absolutePosition ? g.position[i*3+2] : c[2] + g.position[i*3+2];
      const e = geodeticToEcef([lon, lat, h]);
      const u = toEnu(e);
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

  const texture = await getTexture();

  // PointCloud RGB: a separate per-node attribute resource, not part of DefaultGeometrySchema (mesh
  // layers' inline `g.color` already covers their case). `nodes/<res>/attributes/<key>` — NO trailing
  // `/0`/page segment (see lepccDecode.js's header comment: that extra segment is what silently 404'd
  // this for a while). Missing/undecodable per-node resource degrades to no color, not a crash — same
  // "gate, don't crash" philosophy as Draco/textures.
  let colors = g.color;
  if (!colors && spec.wantsRgb) {
    try {
      const rgbBuf = await getRgb();
      const rgb = rgbBuf && decodeLepccRgb(rgbBuf);
      if (rgb && rgb.vertexCount === g.vertexCount) colors = rgb.colors;
    } catch (e) { if (e.transient) throw e; /* no RGB for this node — render uncolored */ }
  }

  return buildGlb({ mode: spec.isPoint ? 'POINTS' : 'TRIANGLES', positions, normals, colors, uvs: g.uv0, texture });
}

// Parse a .3mxb → { nodes, payload:Map<resourceId,{format,data}> }.
export function parse3mxb(buf) {
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


// A 3MX node can carry MULTIPLE geometryBuffer resources (each its own CTM, optionally its own texture)
// — render one primitive per geometry. The texture is NOT in node.resources; the geometryBuffer's
// `texture` field references its textureBuffer id (resolved from the payload).
export async function threemxNodeGlb(bytes, nodeIdx) {
  const { nodes, payload } = parse3mxb(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
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
  return new NodeIO().writeBinary(doc);
}

