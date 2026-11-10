/**
 * nexus-reader.js — a reader of Nexus multiresolution meshes (CNR-ISTI, the format of 3DHOP): `.nxs` as it is on disk
 * and `.nxz`, its compressed form. Written from the layout (the `Header`, `Node`, `Patch`, `Texture` structs of
 * src/common/dag.h and signature.h, and the JavaScript loader html/js/nexus.js of github.com/cnr-isti-vclab/nexus);
 * nothing of Nexus's own C++ (GPL) is in it. The compressed nodes of an `.nxz` are decoded by the MIT JavaScript
 * decoders the same project and Corto publish, vendored unchanged in ../vendor (see their headers).
 *
 * A file is, in order, little-endian, every offset a multiple of 256 bytes:
 *
 *   Header, 88 bytes   magic "Nxs " (0x4E787320) · version u32 · nvert u64 · nface u64 · Signature (36) · n_nodes u32 ·
 *                      n_patches u32 · n_textures u32 · sphere f32×4 (centre, radius)
 *   Signature, 36      vertex element: 8 × (type u8, count u8) for COORD, NORM, COLOR, TEX, DATA0‥3 · face element: the
 *                      same 8 for INDEX, NORM, COLOR, TEX, DATA0‥3 · flags u32 (1 PTEXTURE, 2 MECO, 4 CORTO, 8 DEEPZOOM)
 *   Node × n_nodes, 44 offset u32 (×256) · nvert u16 · nface u16 · error f32 · cone i16×4 · sphere f32×4 · tight_radius
 *                      f32 · first_patch u32.  The last node is a sink with no data: it ends the offsets and the patches.
 *   Patch × n_patches  node u32 (the finer node) · triangle_offset u32 (the END of this patch's run of triangles) ·
 *               12     texture u32 (0xffffffff: none). The patches of node i are [first_patch, nodes[i+1].first_patch).
 *   Texture × n_tex    offset u32 (×256) · matrix f32×16. Also ended by a sink entry when there are textures.
 *               68
 *   node data          per node at its offset: coords f32×3, then uvs f32×2 if TEX, normals i16×3 if NORM, colours
 *                      u8×4 if COLOR, then faces u16×3 (the vertex element's components, in that order; a compressed
 *                      file holds a Corto or meco stream instead, which decodes to the same arrays)
 *   texture data       per texture at its offset: one image file (JPEG, as nxsbuild writes it), padded
 *
 * The nodes form a DAG from coarse to fine: node 0 is the coarsest, a node's patches name finer nodes, a leaf's patches
 * name the sink. The roots are nodes 0 .. nroots−1, where nroots is the smallest index any patch names. `sphere` is
 * saturated (it holds every finer node's sphere), `tight_radius` is the node's own. `error` is in model units: the
 * viewer draws a node while error / (size of a pixel at its distance) is above its target.
 */

export const NEXUS_MAGIC = 0x4E787320;
export const NEXUS_PADDING = 256;
export const HEADER_BYTES = 88, NODE_BYTES = 44, PATCH_BYTES = 12, TEXTURE_BYTES = 68;
export const NO_TEXTURE = 0xffffffff;
export const FLAGS = { PTEXTURE: 1, MECO: 2, CORTO: 4, DEEPZOOM: 8 };

// Attribute types of signature.h: NONE, BYTE, UNSIGNED_BYTE, SHORT, UNSIGNED_SHORT, INT, UNSIGNED_INT, FLOAT, DOUBLE
const TYPE_BYTES = [0, 1, 1, 2, 2, 4, 4, 4, 8];
const TYPE_NAMES = ['none', 'i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'f32', 'f64'];
export const VERTEX_COMPONENTS = ['coord', 'normal', 'color', 'uv', 'data0', 'data1', 'data2', 'data3'];
export const FACE_COMPONENTS = ['index', 'normal', 'color', 'uv', 'data0', 'data1', 'data2', 'data3'];

const buf = (b) => (Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength));

function readElement(b, off, names) {
  const el = {};
  for (let i = 0; i < 8; i++) {
    const type = b[off + i * 2], count = b[off + i * 2 + 1];
    if (type && count) el[names[i]] = { type: TYPE_NAMES[type] || `type${type}`, count, bytes: TYPE_BYTES[type] * count };
  }
  return el;
}

/** The 88-byte header → { version, nvert, nface, signature, nodesCount, patchesCount, texturesCount, sphere, compressed, codec, vertexBytes, faceBytes }. */
export function parseNexusHeader(bytes) {
  const b = buf(bytes);
  if (b.length < HEADER_BYTES) throw new Error(`nexus: file too short for a header (${b.length} bytes)`);
  if (b.readUInt32LE(0) !== NEXUS_MAGIC) throw new Error('nexus: not a Nexus file (magic is not "Nxs ")');
  const vertex = readElement(b, 24, VERTEX_COMPONENTS), face = readElement(b, 40, FACE_COMPONENTS), flags = b.readUInt32LE(56);
  const sum = (el) => Object.values(el).reduce((s, a) => s + a.bytes, 0);
  const codec = flags & FLAGS.CORTO ? 'corto' : flags & FLAGS.MECO ? 'meco' : null;
  return {
    version: b.readUInt32LE(4),
    nvert: Number(b.readBigUInt64LE(8)), nface: Number(b.readBigUInt64LE(16)),
    signature: { vertex, face, flags },
    nodesCount: b.readUInt32LE(60), patchesCount: b.readUInt32LE(64), texturesCount: b.readUInt32LE(68),
    sphere: [b.readFloatLE(72), b.readFloatLE(76), b.readFloatLE(80), b.readFloatLE(84)],
    compressed: !!codec, codec, deepzoom: !!(flags & FLAGS.DEEPZOOM),
    vertexBytes: sum(vertex), faceBytes: sum(face),
  };
}

/** Bytes of the node, patch and texture tables that follow the header. */
export const indexBytes = (h) => h.nodesCount * NODE_BYTES + h.patchesCount * PATCH_BYTES + h.texturesCount * TEXTURE_BYTES;

/**
 * The tables after the header (`bytes` starts at file offset 88, or is the whole file with `fromStart`) →
 * { nodes, patches, textures, nroots }. nodes[i] = { offset (bytes), nvert, nface, error, sphere [x,y,z,r], tightRadius,
 * firstPatch, lastPatch, end (byte offset of the next node's data) }, the sink included (its nvert is 0); patches[p] =
 * { node, end, texture } (end: the triangle the patch's run stops before; texture −1 for none); textures[t] =
 * { offset, end, matrix }, the sink entry dropped.
 */
export function parseNexusIndex(h, bytes, { fromStart = false } = {}) {
  const b = buf(bytes);
  let off = fromStart ? HEADER_BYTES : 0;
  if (b.length < off + indexBytes(h)) throw new Error(`nexus: index truncated (${b.length} bytes, needs ${off + indexBytes(h)})`);
  const nodes = new Array(h.nodesCount);
  for (let i = 0; i < h.nodesCount; i++, off += NODE_BYTES) {
    nodes[i] = {
      offset: b.readUInt32LE(off) * NEXUS_PADDING, nvert: b.readUInt16LE(off + 4), nface: b.readUInt16LE(off + 6), error: b.readFloatLE(off + 8),
      sphere: [b.readFloatLE(off + 20), b.readFloatLE(off + 24), b.readFloatLE(off + 28), b.readFloatLE(off + 32)], tightRadius: b.readFloatLE(off + 36),
      firstPatch: b.readUInt32LE(off + 40), lastPatch: 0, end: 0,
    };
  }
  for (let i = 0; i + 1 < h.nodesCount; i++) { nodes[i].lastPatch = nodes[i + 1].firstPatch; nodes[i].end = nodes[i + 1].offset; }
  if (h.nodesCount) { const s = nodes[h.nodesCount - 1]; s.lastPatch = h.patchesCount; s.end = s.offset; }
  const patches = new Array(h.patchesCount);
  for (let p = 0; p < h.patchesCount; p++, off += PATCH_BYTES) {
    const tex = b.readUInt32LE(off + 8);
    patches[p] = { node: b.readUInt32LE(off), end: b.readUInt32LE(off + 4), texture: tex === NO_TEXTURE ? -1 : tex };
  }
  const textures = [];
  for (let t = 0; t < h.texturesCount; t++, off += TEXTURE_BYTES) {
    const matrix = new Array(16);
    for (let k = 0; k < 16; k++) matrix[k] = b.readFloatLE(off + 4 + k * 4);
    textures.push({ offset: b.readUInt32LE(off) * NEXUS_PADDING, end: 0, matrix });
  }
  for (let t = 0; t + 1 < textures.length; t++) textures[t].end = textures[t + 1].offset;
  if (textures.length) textures.pop();                     // the sink entry only ends the last texture
  let nroots = h.nodesCount;
  for (let i = 0; i < nroots; i++) for (let p = nodes[i].firstPatch; p < nodes[i].lastPatch; p++) if (patches[p].node < nroots) nroots = patches[p].node;
  return { nodes, patches, textures, nroots: Math.max(nroots, 1) };
}

/** Header and index of a whole file (or of its first 88 + indexBytes bytes). */
export function parseNexus(bytes) {
  const header = parseNexusHeader(bytes);
  return { header, ...parseNexusIndex(header, bytes, { fromStart: true }) };
}

/** The children of node i (the finer nodes its patches name), the sink left out, each once. */
export function nodeChildren(index, i) {
  const n = index.nodes[i], sink = index.nodes.length - 1, out = [];
  for (let p = n.firstPatch; p < n.lastPatch; p++) { const c = index.patches[p].node; if (c !== sink && !out.includes(c)) out.push(c); }
  return out;
}

/** The textures node i's patches use, each once. */
export function nodeTextures(index, i) {
  const n = index.nodes[i], out = [];
  for (let p = n.firstPatch; p < n.lastPatch; p++) { const t = index.patches[p].texture; if (t >= 0 && !out.includes(t)) out.push(t); }
  return out;
}

/** The byte range of node i's data in the file: [begin, end). A compressed node's range is its stream. */
export function nodeRange(index, i) {
  const n = index.nodes[i];
  return { begin: n.offset, end: n.end, length: n.end - n.offset };
}

// ── node data ──────────────────────────────────────────────────────────────────────────────────────────────────

const f32 = (b, off, n) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = b.readFloatLE(off + i * 4); return a; };
const i16 = (b, off, n) => { const a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = b.readInt16LE(off + i * 2); return a; };
const u16 = (b, off, n) => { const a = new Uint16Array(n); for (let i = 0; i < n; i++) a[i] = b.readUInt16LE(off + i * 2); return a; };

/** An uncompressed node's bytes (coords, uvs, normals, colours, faces) → { positions, uvs?, normals?, colors?, indices }. */
export function decodeRawNode(header, node, bytes) {
  const b = buf(bytes), v = header.signature.vertex, nv = node.nvert, nf = node.nface;
  const need = nv * header.vertexBytes + nf * header.faceBytes;
  if (b.length < need) throw new Error(`nexus: node data truncated (${b.length} bytes, needs ${need})`);
  let off = 0;
  const out = { positions: f32(b, off, nv * 3) }; off += nv * 12;
  if (v.uv) { out.uvs = f32(b, off, nv * 2); off += nv * v.uv.bytes; }
  if (v.normal) { out.normals = i16(b, off, nv * 3); off += nv * v.normal.bytes; }
  if (v.color) { out.colors = Buffer.from(b.subarray(off, off + nv * 4)); off += nv * v.color.bytes; }
  for (const k of ['data0', 'data1', 'data2', 'data3']) if (v[k]) off += nv * v[k].bytes;
  out.indices = nf ? u16(b, off, nf * 3) : new Uint16Array(0);
  return out;
}

/** A Corto stream (an .nxz node, flag CORTO) → the same arrays. */
export async function decodeCortoNode(header, node, bytes) {
  const { CortoDecoder } = await import('../vendor/corto.js');
  const b = buf(bytes);
  // the decoder reads a DataView and a Uint32Array over the ArrayBuffer itself: give it a copy that starts at 0 and
  // is padded to a multiple of 4
  const ab = new ArrayBuffer((b.length + 3) & ~3);
  new Uint8Array(ab).set(b);
  const dec = new CortoDecoder(ab);
  if (!dec.attributes) throw new Error('nexus: node is not a Corto stream');
  if (dec.attributes.normal) dec.attributes.normal.type = 3;          // INT16, as the viewer asks (short_normals)
  if (dec.attributes.color) dec.attributes.color.outcomponents = 4;   // RGBA (rgba_colors)
  const g = dec.decode();
  if (g.nvert !== node.nvert || g.nface !== node.nface) throw new Error(`nexus: Corto stream holds ${g.nvert} vertices / ${g.nface} faces, the node table says ${node.nvert} / ${node.nface}`);
  const out = { positions: g.position, indices: g.index || new Uint16Array(0) };
  if (g.uv) out.uvs = g.uv;
  if (g.normal) out.normals = g.normal;
  if (g.color) out.colors = Buffer.from(g.color.buffer, g.color.byteOffset, node.nvert * 4);
  return out;
}

/** A meco stream (an .nxz node of the older kind, flag MECO) → the same arrays, through the uncompressed layout it decodes to. */
export async function decodeMecoNode(header, node, bytes, patchEnds) {
  const { MeshCoder } = await import('../vendor/meco.js');
  const v = header.signature.vertex, b = buf(bytes);
  const ab = new ArrayBuffer((b.length + 7) & ~7);                   // its bit stream swaps u32 pairs in place: a padded copy
  new Uint8Array(ab).set(b);
  const sig = { texcoords: v.uv ? 1 : 0, normals: v.normal ? 1 : 0, colors: v.color ? 1 : 0, indices: header.signature.face.index ? 1 : 0 };
  const raw = new MeshCoder(sig, { nvert: node.nvert, nface: node.nface }, patchEnds).decode(ab);
  return decodeRawNode(header, node, Buffer.from(raw));
}

/** Node i's bytes (its range of the file) → arrays, by the file's codec. */
export async function decodeNode(index, i, bytes) {
  const { header } = index, node = index.nodes[i];
  if (header.codec === 'corto') return decodeCortoNode(header, node, bytes);
  if (header.codec === 'meco') {
    const ends = [];
    for (let p = node.firstPatch; p < node.lastPatch; p++) ends.push(index.patches[p].end);
    return decodeMecoNode(header, node, bytes, ends);
  }
  return decodeRawNode(header, node, bytes);
}

/** An image as stored (padded to 256 bytes): its bytes cut at the file's end and its MIME type. */
export function textureImage(bytes) {
  const b = buf(bytes);
  let end = b.length;
  while (end > 0 && b[end - 1] === 0) end--;                        // the padding is zeros
  if (b[0] === 0xff && b[1] === 0xd8) { const eoi = b.lastIndexOf(Buffer.from([0xff, 0xd9])); if (eoi > 0) end = eoi + 2; return { bytes: b.subarray(0, end), mimeType: 'image/jpeg' }; }
  if (b[0] === 0x89 && b[1] === 0x50) return { bytes: b.subarray(0, end), mimeType: 'image/png' };
  if (b.toString('latin1', 0, 4) === 'RIFF') return { bytes: b.subarray(0, end), mimeType: 'image/webp' };
  return { bytes: b.subarray(0, end), mimeType: 'image/jpeg' };
}

// ── statistics (for the docs, the tests and the CLI's log line) ──────────────────────────────────────────────────

/**
 * What the index says about a file: levels (the depth of each node below the roots), parents per node, the number
 * of root-to-node paths (the tiles a tree with every shared node under each of its parents would hold), the
 * vertices and triangles in all and at the leaves, and whether errors decrease and spheres nest.
 */
export function nexusStats(index) {
  const { nodes, patches, header } = index, n = nodes.length - 1, sink = n;
  const parents = new Uint32Array(n), depth = new Int32Array(n).fill(-1), paths = new Float64Array(n);
  for (let i = 0; i < index.nroots; i++) { depth[i] = 0; paths[i] = 1; }
  let nodeOrderOk = true, errorsOk = true, spheresOk = true, patchesOk = true, sphereOutside = 0, errorUp = 0, crossLevel = 0;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  // nodes are numbered coarse to fine, so one pass in order sees every parent before its children
  for (let i = 0; i < n; i++) {
    const nd = nodes[i];
    if (nd.lastPatch > nd.firstPatch && patches[nd.lastPatch - 1].end !== nd.nface) patchesOk = false;
    if (nd.lastPatch === nd.firstPatch && nd.nface) patchesOk = false;
    let prev = 0;
    for (let p = nd.firstPatch; p < nd.lastPatch; p++) {
      const pt = patches[p];
      if (pt.end < prev) patchesOk = false;
      prev = pt.end;
      if (pt.node === sink) continue;
      if (pt.node <= i) nodeOrderOk = false;
      const c = nodes[pt.node];
      parents[pt.node]++;
      if (depth[pt.node] >= 0 && depth[pt.node] !== depth[i] + 1) crossLevel++;   // a child with parents on two levels
      if (depth[i] >= 0 && depth[pt.node] < depth[i] + 1) depth[pt.node] = depth[i] + 1;
      paths[pt.node] += paths[i];
      if (c.error > nd.error) { errorsOk = false; errorUp++; }
      if (dist(c.sphere, nd.sphere) + c.sphere[3] > nd.sphere[3] * (1 + 1e-5) + 1e-6) { spheresOk = false; sphereOutside++; }
    }
  }
  let leaves = 0, leafVerts = 0, leafFaces = 0, verts = 0, faces = 0, shared = 0, maxParents = 0, levels = 0, pathsTotal = 0;
  for (let i = 0; i < n; i++) {
    const nd = nodes[i];
    verts += nd.nvert; faces += nd.nface; pathsTotal += paths[i];
    if (parents[i] > 1) shared++;
    maxParents = Math.max(maxParents, parents[i]);
    levels = Math.max(levels, depth[i] + 1);
    const leaf = nodeChildren(index, i).length === 0;
    if (leaf) { leaves++; leafVerts += nd.nvert; leafFaces += nd.nface; }
  }
  return {
    nodes: n, patches: patches.length, textures: index.textures.length, roots: index.nroots, levels, leaves,
    vertices: verts, triangles: faces, leafVertices: leafVerts, leafTriangles: leafFaces,
    headerVertices: header.nvert, headerTriangles: header.nface,
    shared, maxParents, paths: pathsTotal, nodeOrderOk, errorsOk, errorUp, spheresOk, sphereOutside, patchesOk,
    layeredOk: crossLevel === 0 && nodeOrderOk, crossLevel, depth, parents,
  };
}
