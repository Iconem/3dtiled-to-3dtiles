/**
 * glbBuild.js  (i3s-to-3dtiles)
 *
 * The binary glTF 2.0 (.glb) of one mesh or point tile, written with glTF-Transform like the other converters' tiles
 * (it was a hand-written GLB container until 2026-11: same content, but nothing glTF-Transform offers could be
 * applied to it). Used for I3S nodes (offline and live) and for the Bing 3D globe's tiles:
 *   - TRIANGLES (mode 4): POSITION [+ NORMAL] [+ COLOR_0] [+ TEXCOORD_0 + baseColorTexture],
 *     non-indexed (I3S geometry is a flat per-attribute vertex array; we draw it as a triangle soup).
 *   - POINTS    (mode 0): POSITION [+ COLOR_0].
 * No Draco — that path is gated out in index.js/i3s-live.js. The texture image (JPEG/PNG bytes,
 * already the raw file — no re-encode) is embedded as-is; DDS/KTX2/Basis-encoded textures are gated
 * out by the caller before reaching here (no decoder in this adapter, same as Draco geometry).
 * Vertices are written in a node-LOCAL frame; the 3D Tiles tile transform places them in ECEF.
 */
import { Document, NodeIO, VertexLayout } from '@gltf-transform/core';

// One bufferView per attribute, as the hand-written container had. glTF-Transform copies vertex data element by
// element either way, which makes it about twice as slow to write as that container was on these tiles (a
// megabyte and more each); tile workers are what makes up for it.
const io = new NodeIO().setVertexLayout(VertexLayout.SEPARATE);

/**
 * @param {Object} g  { mode:'TRIANGLES'|'POINTS', positions:Float32Array(3N) (LOCAL),
 *                       normals?:Float32Array(3N), colors?:Uint8Array(4N), uvs?:Float32Array(2N),
 *                       texture?:{bytes:Uint8Array, mimeType:'image/jpeg'|'image/png'} }
 * @returns {Promise<Buffer>} the GLB
 */
export async function buildGlb(g) {
  const N = g.positions.length / 3;
  const doc = new Document();
  doc.getRoot().getAsset().generator = 'i3s-to-3dtiles';
  const buffer = doc.createBuffer();
  const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  // glTF-Transform keeps the array it is given: a view over a larger buffer (a Node Buffer slice) is handed as its own typed array
  const f32 = (a) => (a instanceof Float32Array ? a : new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4));
  const u8 = (a) => (a instanceof Uint8Array && a.constructor === Uint8Array ? a : new Uint8Array(a.buffer, a.byteOffset, a.byteLength));

  const prim = doc.createPrimitive().setMode(g.mode === 'POINTS' ? 0 : 4)
    .setAttribute('POSITION', accessor('VEC3', f32(g.positions)));   // min/max are written from the data
  if (g.normals) prim.setAttribute('NORMAL', accessor('VEC3', f32(g.normals)));
  if (g.colors) prim.setAttribute('COLOR_0', accessor('VEC4', u8(g.colors)).setNormalized(true));
  // TEXCOORD_0 (only meaningful alongside a texture, but harmless to emit alone)
  const hasUv = !!(g.uvs && g.uvs.length === N * 2);
  if (hasUv) prim.setAttribute('TEXCOORD_0', accessor('VEC2', f32(g.uvs)));

  // Always an EXPLICIT material — for BOTH mesh and point tiles. A primitive with no `material`
  // falls back to glTF's spec-mandated default (metallicFactor:1, roughnessFactor:1) — a fully metallic
  // surface that renders pure black without an environment/IBL map. That default was silently landing on
  // every node whose texture fetch failed (i3s-live.js's own "SceneServer returns fake-200 JSON errors
  // intermittently" case) or whose format has no raster decoder — the "wrong material, all black" bug.
  // A matte (metallicFactor:0) material with no texture still shows COLOR_0 vertex colors / plain white.
  // POINTS tiles need it too (found 2026-07-06, LEPCC-RGB point clouds): without a material, COLOR_0
  // decoded correctly but rendered flat black, as there was nothing for a renderer to multiply it against.
  const material = doc.createMaterial().setMetallicFactor(0).setRoughnessFactor(1);
  // Embedded base-color texture: the image bytes untouched (already a browser-native JPEG/PNG).
  if (g.texture && hasUv) material.setBaseColorTexture(doc.createTexture().setImage(u8(g.texture.bytes)).setMimeType(g.texture.mimeType));
  prim.setMaterial(material);

  doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)));
  const glb = await io.writeBinary(doc);
  return Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength);
}
