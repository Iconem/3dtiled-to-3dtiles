/**
 * mesh-tile.js — the CPU half of a live mesh tile (I3S, 3MX, OSGB): fetched bytes → GLB, with no network and no cached
 * context, so that it runs the same on the server's thread (i3s-live.js, threemx-live.js, osgb-live.js) and on a tile worker
 * (tile-tasks-mesh.js, behind TILED_WORKERS).
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { decodeDefaultGeometry, geodeticToEcef } from '../i3s-to-3dtiles/src/i3sParse.js';
import { decodeLepccRgb } from '../i3s-to-3dtiles/src/lepccDecode.js';
import { buildGlb } from '../i3s-to-3dtiles/src/glbBuild.js';
import { decodeCTM } from '../threemx-to-3dtiles/src/ctm-decode.js';
import { parseOsgb, osgbUnits } from '../osgb-to-3dtiles/src/osgb-reader.js';
import { osgbTexture } from '../osgb-to-3dtiles/src/osgb-image.js';

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


/**
 * One unit of an .osgb file (a PagedLOD's own mesh, or the meshes outside any: see osgbUnits) → GLB, or null when it
 * holds no triangles. One glTF primitive per osg::Geometry, its texture embedded: the JPEG/PNG file the exporter put in
 * the .osgb passes through untouched, DDS/S3TC and raw pixels are re-encoded (osgb-image.js).
 */
export async function osgbUnitGlb(bytes, unitIdx) {
  const unit = osgbUnits(parseOsgb(bytes))[unitIdx];
  if (!unit || !unit.meshes.length) return null;

  const doc = new Document();
  doc.getRoot().getAsset().generator = 'osgb-to-3dtiles';
  const buffer = doc.createBuffer();
  const mesh = doc.createMesh();
  const materials = new Map();                              // osg::Image → glTF material (a texture shared by meshes is written once)
  const plain = () => doc.createMaterial().setMetallicFactor(0).setRoughnessFactor(1);
  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);   // an OSG colour is a display value, a glTF factor is linear

  for (const g of unit.meshes) {
    const n = g.positions.length / 3;
    // OSG is Z-up, glTF Y-up: (x, y, z) → (x, z, −y), which a 3D Tiles client's own Y-up → Z-up rotation undoes, so the
    // mesh lands back in the frame the tile's bounding volume and the root transform are written in.
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < pos.length; i += 3) { pos[i] = g.positions[i]; pos[i + 1] = g.positions[i + 2]; pos[i + 2] = -g.positions[i + 1]; }
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(g.indices).setBuffer(buffer));
    if (g.normals) {
      const nor = new Float32Array(n * 3);
      for (let i = 0; i < nor.length; i += 3) {
        const x = g.normals[i], y = g.normals[i + 2], z = -g.normals[i + 1], l = Math.hypot(x, y, z) || 1;
        nor[i] = x / l; nor[i + 1] = y / l; nor[i + 2] = z / l;
      }
      if (nor.some((v) => v !== 0)) prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(nor).setBuffer(buffer));
    }
    if (g.colors) prim.setAttribute('COLOR_0', doc.createAccessor().setType('VEC4').setArray(g.colors).setNormalized(true).setBuffer(buffer));

    let material = g.image && g.uvs ? materials.get(g.image) : null;
    if (g.image && g.uvs && material === undefined) {
      const tex = osgbTexture(g.image);
      material = tex ? plain().setBaseColorTexture(doc.createTexture().setImage(new Uint8Array(tex.bytes.buffer, tex.bytes.byteOffset, tex.bytes.byteLength)).setMimeType(tex.mimeType)) : null;
      if (tex?.transcoded && tex.mimeType === 'image/png') material.setAlphaMode('MASK');   // re-encoded as PNG only when a pixel is transparent
      materials.set(g.image, material);
    }
    if (material) {
      // OpenGL's v = 0 is the bottom row of the picture, glTF's the top one
      const uv = new Float32Array(n * 2);
      for (let k = 0; k < uv.length; k += 2) { uv[k] = g.uvs[k]; uv[k + 1] = 1 - g.uvs[k + 1]; }
      prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(uv).setBuffer(buffer));
    }
    // An explicit matte material in every case: glTF's default one is fully metallic and renders black (see glbBuild.js).
    // An untextured mesh takes the diffuse colour of its OSG material (ContextCapture's grey for faces no photo saw).
    if (!material) {
      const d = g.diffuse && g.diffuse.some((v) => v !== 1) ? g.diffuse : null, key = d ? d.join() : 'plain';
      material = materials.get(key);
      if (!material) materials.set(key, material = d ? plain().setBaseColorFactor([toLinear(d[0]), toLinear(d[1]), toLinear(d[2]), d[3]]) : plain());
    }
    prim.setMaterial(material);
    mesh.addPrimitive(prim);
  }
  doc.createScene().addChild(doc.createNode().setMesh(mesh));
  return new NodeIO().writeBinary(doc);
}
