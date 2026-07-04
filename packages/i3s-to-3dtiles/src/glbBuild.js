/**
 * glbBuild.js  (i3s-to-3dtiles)  — DRAFT, UNTESTED
 *
 * Minimal binary glTF 2.0 (.glb) writer for the I3S payloads this draft emits:
 *   - TRIANGLES (mode 4): POSITION [+ NORMAL] [+ COLOR_0] [+ TEXCOORD_0 + baseColorTexture],
 *     non-indexed (I3S geometry is a flat per-attribute vertex array; we draw it as a triangle soup).
 *   - POINTS    (mode 0): POSITION [+ COLOR_0].
 * No Draco — that path is gated out in index.js/i3s-live.js. The texture image (JPEG/PNG bytes,
 * already the raw file — no re-encode) is embedded as-is; DDS/KTX2/Basis-encoded textures are gated
 * out by the caller before reaching here (no decoder in this adapter, same as Draco/LEPCC geometry).
 * Vertices are written in a node-LOCAL frame; the 3D Tiles tile transform (from the node OBB centre)
 * places them in ECEF.
 */

const COMP = { F32: 5126, U8: 5121 };  // glTF componentType

function pad4(n) { return (n + 3) & ~3; }

/**
 * @param {Object} g  { mode:'TRIANGLES'|'POINTS', positions:Float32Array(3N) (LOCAL),
 *                       normals?:Float32Array(3N), colors?:Uint8Array(4N), uvs?:Float32Array(2N),
 *                       texture?:{bytes:Buffer, mimeType:'image/jpeg'|'image/png'} }
 */
export function buildGlb(g) {
  const N = g.positions.length / 3;
  const accessors = [];
  const bufferViews = [];
  const attributes = {};

  // bounds for POSITION accessor min/max (required by spec)
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < N; i++) for (let k = 0; k < 3; k++) {
    const v = g.positions[i * 3 + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v;
  }

  const addView = (data) => { bufferViews.push({ data }); return bufferViews.length - 1; };

  // POSITION
  attributes.POSITION = accessors.length;
  accessors.push({ bufferView: addView(Buffer.from(g.positions.buffer, g.positions.byteOffset, g.positions.byteLength)),
                   componentType: COMP.F32, count: N, type: 'VEC3', min: mn, max: mx });
  // NORMAL
  if (g.normals) {
    attributes.NORMAL = accessors.length;
    accessors.push({ bufferView: addView(Buffer.from(g.normals.buffer, g.normals.byteOffset, g.normals.byteLength)),
                     componentType: COMP.F32, count: N, type: 'VEC3' });
  }
  // COLOR_0 (normalized u8 vec4)
  if (g.colors) {
    attributes.COLOR_0 = accessors.length;
    accessors.push({ bufferView: addView(Buffer.from(g.colors.buffer, g.colors.byteOffset, g.colors.byteLength)),
                     componentType: COMP.U8, count: N, type: 'VEC4', normalized: true });
  }
  // TEXCOORD_0 (only meaningful alongside a texture, but harmless to emit alone)
  if (g.uvs && g.uvs.length === N * 2) {
    attributes.TEXCOORD_0 = accessors.length;
    accessors.push({ bufferView: addView(Buffer.from(g.uvs.buffer, g.uvs.byteOffset, g.uvs.byteLength)),
                     componentType: COMP.F32, count: N, type: 'VEC2' });
  }

  // Embedded base-color texture: image bytes (untouched — already a browser-native JPEG/PNG) as their
  // own bufferView, referenced by an image/texture/material trio.
  let imageViewIdx = -1;
  if (g.texture && attributes.TEXCOORD_0 !== undefined) {
    imageViewIdx = addView(g.texture.bytes);
  }

  // assemble single binary buffer + bufferView byteOffsets
  let offset = 0;
  const chunks = [];
  for (const bv of bufferViews) {
    bv.byteOffset = offset; bv.byteLength = bv.data.length; bv.buffer = 0;
    chunks.push(bv.data);
    const padded = pad4(bv.data.length);
    if (padded > bv.data.length) chunks.push(Buffer.alloc(padded - bv.data.length));
    // BUGFIX (2026-07-02): this was `offset = padded` — resetting to the CURRENT view's padded length
    // instead of accumulating, so every bufferView from the 3rd onward got the wrong byteOffset (silently
    // "worked" for 2-view outputs like POSITION+COLOR_0 point clouds, since offset-after-view-1 happens to
    // equal the correct cumulative sum there). With 3+ views (mesh POSITION+NORMAL+COLOR_0[+TEXCOORD_0+image])
    // COLOR_0 and everything after it pointed at the wrong bytes — root cause of "black/garbled textures".
    offset += padded;
  }
  const bin = Buffer.concat(chunks);

  const gltf = {
    asset: { version: '2.0', generator: 'i3s-to-3dtiles (draft)' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes, mode: g.mode === 'POINTS' ? 0 : 4, ...(g.mode !== 'POINTS' ? { material: 0 } : {}) }] }],
    accessors,
    bufferViews: bufferViews.map(bv => ({ buffer: 0, byteOffset: bv.byteOffset, byteLength: bv.byteLength })),
    buffers: [{ byteLength: bin.length }],
  };
  // Always emit an EXPLICIT material for mesh tiles, textured or not. A primitive with no `material`
  // falls back to glTF's spec-mandated default (metallicFactor:1, roughnessFactor:1) — a fully metallic
  // surface that renders pure black without an environment/IBL map. That default was silently landing on
  // every node whose texture fetch failed (i3s-live.js's own "SceneServer returns fake-200 JSON errors
  // intermittently" case) or whose format has no raster decoder — this is the "wrong material, all
  // black" bug, not a geometry/decode problem. A matte (metallicFactor:0) material with no texture still
  // shows COLOR_0 vertex colors / plain white instead of black metal.
  if (g.mode !== 'POINTS') {
    gltf.materials = [{ pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1, ...(imageViewIdx >= 0 ? { baseColorTexture: { index: 0 } } : {}) } }];
  }
  if (imageViewIdx >= 0) {
    gltf.images = [{ bufferView: imageViewIdx, mimeType: g.texture.mimeType }];
    gltf.textures = [{ source: 0 }];
  }

  // GLB container
  const json = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPad = Buffer.alloc(pad4(json.length) - json.length, 0x20);
  const binPad  = Buffer.alloc(pad4(bin.length) - bin.length, 0x00);
  const jsonChunk = Buffer.concat([json, jsonPad]);
  const binChunk  = Buffer.concat([bin, binPad]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);                                   // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const jsonHdr = Buffer.alloc(8); jsonHdr.writeUInt32LE(jsonChunk.length, 0); jsonHdr.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
  const binHdr  = Buffer.alloc(8); binHdr.writeUInt32LE(binChunk.length, 0);  binHdr.writeUInt32LE(0x004e4942, 4);  // 'BIN\0'
  return Buffer.concat([header, jsonHdr, jsonChunk, binHdr, binChunk]);
}
