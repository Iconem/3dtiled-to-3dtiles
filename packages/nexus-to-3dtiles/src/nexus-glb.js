/**
 * nexus-glb.js — one Nexus node → a GLB, with glTF-Transform. No network and no cached context, so that it runs the
 * same in the offline converter, on the live server's thread (tile-server/nexus-live.js) and on a tile worker
 * (tile-server/tile-tasks-mesh.js).
 *
 * Vertices are written as the file has them (the model frame is Y up, as glTF is: see nexus-tileset.js). Normals are
 * the file's int16 unit vectors made float; colours the file's RGBA bytes as a normalized COLOR_0, left out when the
 * node is textured, as the Nexus viewer draws the texture alone then. A node's triangles are grouped by patch, and a
 * patch names a texture, so there is one primitive per run of patches with the same texture (most nodes have one),
 * the texture embedded as the file holds it (JPEG). Nexus's v axis points up the image, glTF's down: v → 1 − v.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { decodeNode, textureImage } from './nexus-reader.js';

/**
 * @param index     parseNexus()'s result
 * @param i         node index
 * @param nodeBytes the node's byte range of the file
 * @param textures  Map<textureIndex, Buffer> of the raw image bytes of the textures the node's patches name (as stored)
 * @returns Uint8Array GLB, or null when the node has no triangles
 */
export async function nexusNodeGlb(index, i, nodeBytes, textures = new Map()) {
  const node = index.nodes[i];
  if (!node.nface) return null;
  const g = await decodeNode(index, i, nodeBytes);
  const nv = node.nvert;

  const doc = new Document();
  doc.getRoot().getAsset().generator = 'nexus-to-3dtiles';
  const buffer = doc.createBuffer();
  const mesh = doc.createMesh();
  const position = doc.createAccessor().setType('VEC3').setArray(g.positions instanceof Float32Array ? g.positions : new Float32Array(g.positions)).setBuffer(buffer);
  let normal = null, color = null, uv = null;
  if (g.normals) {
    const n = new Float32Array(nv * 3);
    for (let k = 0; k < n.length; k += 3) {
      const x = g.normals[k], y = g.normals[k + 1], z = g.normals[k + 2], l = Math.hypot(x, y, z) || 1;
      n[k] = x / l; n[k + 1] = y / l; n[k + 2] = z / l;
    }
    if (n.some((v) => v !== 0)) normal = doc.createAccessor().setType('VEC3').setArray(n).setBuffer(buffer);
  }
  const textured = !!g.uvs && textures.size > 0;
  if (g.colors && !textured) color = doc.createAccessor().setType('VEC4').setArray(new Uint8Array(g.colors.buffer, g.colors.byteOffset, nv * 4)).setNormalized(true).setBuffer(buffer);
  if (textured) {
    const t = new Float32Array(nv * 2);
    for (let k = 0; k < t.length; k += 2) { t[k] = g.uvs[k]; t[k + 1] = 1 - g.uvs[k + 1]; }
    uv = doc.createAccessor().setType('VEC2').setArray(t).setBuffer(buffer);
  }

  const plain = () => doc.createMaterial().setMetallicFactor(0).setRoughnessFactor(1);   // glTF's default material is metallic and renders black
  const materials = new Map();                                      // texture index (−1: none) → material
  const materialOf = (tex) => {
    let m = materials.get(tex);
    if (m) return m;
    m = plain();
    const raw = tex >= 0 ? textures.get(tex) : null;
    if (raw && uv) {
      const img = textureImage(raw);
      m.setBaseColorTexture(doc.createTexture().setImage(new Uint8Array(img.bytes.buffer, img.bytes.byteOffset, img.bytes.byteLength)).setMimeType(img.mimeType));
    }
    materials.set(tex, m);
    return m;
  };

  // one primitive per run of patches with the same texture
  const indices = g.indices;
  const runs = [];
  let start = 0;
  for (let p = node.firstPatch; p < node.lastPatch; p++) {
    const pt = index.patches[p], end = Math.min(pt.end, node.nface);
    const last = runs[runs.length - 1];
    if (last && last.texture === pt.texture) last.end = end;
    else runs.push({ start, end, texture: pt.texture });
    start = end;
  }
  if (!runs.length) runs.push({ start: 0, end: node.nface, texture: -1 });
  for (const r of runs) {
    if (r.end <= r.start) continue;
    const sub = indices.subarray(r.start * 3, r.end * 3);
    const prim = doc.createPrimitive().setAttribute('POSITION', position)
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(sub instanceof Uint16Array ? new Uint16Array(sub) : new Uint32Array(sub)).setBuffer(buffer))
      .setMaterial(materialOf(textured ? r.texture : -1));
    if (normal) prim.setAttribute('NORMAL', normal);
    if (color) prim.setAttribute('COLOR_0', color);
    if (uv) prim.setAttribute('TEXCOORD_0', uv);
    mesh.addPrimitive(prim);
  }
  if (!mesh.listPrimitives().length) return null;
  doc.createScene().addChild(doc.createNode().setMesh(mesh));
  return new NodeIO().writeBinary(doc);
}
