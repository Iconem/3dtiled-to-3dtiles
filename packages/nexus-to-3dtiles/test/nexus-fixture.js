/**
 * nexus-fixture.js — a minimal, uncompressed Nexus (`.nxs`) WRITER, for tests only: the tests must not need the network.
 * It writes the layout nexus-reader.js documents, from a description of the DAG:
 *
 *   encodeNxs({
 *     sphere: [x, y, z, r],                                   the model's sphere
 *     nodes: [{ positions: Float32Array, normals?: Int16Array, colors?: Uint8Array (RGBA), uvs?: Float32Array,
 *               indices: Uint16Array, error, sphere: [x, y, z, r], tightRadius?,
 *               patches: [{ node, end, texture? }] }, …],   node: a finer node's index, or 'sink'; end: triangles so far
 *     textures?: [Buffer, …],                                 image files (JPEG) by index
 *   })
 *
 * Every node must have the same attributes. The sink node and the sink texture entry are added here.
 */
import { NEXUS_MAGIC, NEXUS_PADDING, HEADER_BYTES, NODE_BYTES, PATCH_BYTES, TEXTURE_BYTES, NO_TEXTURE } from '../src/nexus-reader.js';

const pad = (n) => Math.ceil(n / NEXUS_PADDING) * NEXUS_PADDING;

export function encodeNxs({ sphere, nodes, textures = [] }) {
  const first = nodes[0] || {};
  const hasN = !!first.normals, hasC = !!first.colors, hasUv = !!first.uvs;
  const vbytes = 12 + (hasUv ? 8 : 0) + (hasN ? 6 : 0) + (hasC ? 4 : 0);
  const sink = nodes.length;
  const npatches = nodes.reduce((s, n) => s + n.patches.length, 0);
  const ntex = textures.length ? textures.length + 1 : 0;
  const indexEnd = HEADER_BYTES + (nodes.length + 1) * NODE_BYTES + npatches * PATCH_BYTES + ntex * TEXTURE_BYTES;

  // data layout: nodes then textures, each at a padded offset
  let off = pad(indexEnd);
  const nodeOff = [], texOff = [];
  for (const n of nodes) { nodeOff.push(off); off = pad(off + (n.positions.length / 3) * vbytes + n.indices.length * 2); }
  const sinkOff = off;
  for (const t of textures) { texOff.push(off); off = pad(off + t.length); }
  const total = off;

  const b = Buffer.alloc(total);
  let p = 0;
  const u8 = (v) => { b.writeUInt8(v, p); p += 1; };
  const u16 = (v) => { b.writeUInt16LE(v, p); p += 2; };
  const i16 = (v) => { b.writeInt16LE(v, p); p += 2; };
  const u32 = (v) => { b.writeUInt32LE(v >>> 0, p); p += 4; };
  const f32 = (v) => { b.writeFloatLE(v, p); p += 4; };
  const u64 = (v) => { b.writeBigUInt64LE(BigInt(v), p); p += 8; };

  // header
  u32(NEXUS_MAGIC); u32(2);
  u64(nodes.reduce((s, n) => s + n.positions.length / 3, 0)); u64(nodes.reduce((s, n) => s + n.indices.length / 3, 0));
  const attr = (type, count) => { u8(type); u8(count); };
  attr(7, 3); attr(hasN ? 3 : 0, hasN ? 3 : 0); attr(hasC ? 1 : 0, hasC ? 4 : 0); attr(hasUv ? 7 : 0, hasUv ? 2 : 0); for (let k = 4; k < 8; k++) attr(0, 0);   // vertex
  attr(4, 3); for (let k = 1; k < 8; k++) attr(0, 0);                                                                                    // face
  u32(0);                                                                                                                                 // flags: uncompressed
  u32(nodes.length + 1); u32(npatches); u32(ntex);
  for (const v of sphere) f32(v);
  // nodes
  let firstPatch = 0;
  nodes.forEach((n, i) => {
    u32(nodeOff[i] / NEXUS_PADDING); u16(n.positions.length / 3); u16(n.indices.length / 3); f32(n.error);
    for (let k = 0; k < 4; k++) i16(0);
    for (const v of n.sphere) f32(v);
    f32(n.tightRadius ?? n.sphere[3]); u32(firstPatch);
    firstPatch += n.patches.length;
  });
  u32(sinkOff / NEXUS_PADDING); u16(0); u16(0); f32(0); for (let k = 0; k < 4; k++) i16(0); for (let k = 0; k < 4; k++) f32(0); f32(0); u32(firstPatch);
  // patches
  for (const n of nodes) for (const pt of n.patches) { u32(pt.node === 'sink' ? sink : pt.node); u32(pt.end); u32(pt.texture == null || pt.texture < 0 ? NO_TEXTURE : pt.texture); }
  // textures
  if (ntex) {
    for (const o of texOff) { u32(o / NEXUS_PADDING); for (let k = 0; k < 16; k++) f32(0); }
    u32(total / NEXUS_PADDING); for (let k = 0; k < 16; k++) f32(0);
  }
  // node data
  nodes.forEach((n, i) => {
    p = nodeOff[i];
    for (const v of n.positions) f32(v);
    if (hasUv) for (const v of n.uvs) f32(v);
    if (hasN) for (const v of n.normals) i16(v);
    if (hasC) for (const v of n.colors) u8(v);
    for (const v of n.indices) u16(v);
  });
  textures.forEach((t, i) => { t.copy(b, texOff[i]); });
  return b;
}

/** A quad of two triangles at z, x0..x0+s, y0..y0+s: { positions, normals, colors, uvs, indices }. */
export function quad(x0, y0, s, z = 0) {
  return {
    positions: new Float32Array([x0, y0, z, x0 + s, y0, z, x0 + s, y0 + s, z, x0, y0 + s, z]),
    normals: new Int16Array([0, 0, 32767, 0, 0, 32767, 0, 0, 32767, 0, 0, 32767]),
    colors: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  };
}

/** Several quads merged into one node's arrays. */
export function merge(parts) {
  const cat = (key, T) => { const arrs = parts.map((q) => q[key]); const out = new T(arrs.reduce((s, a) => s + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
  const indices = new Uint16Array(parts.reduce((s, q) => s + q.indices.length, 0));
  let o = 0, base = 0;
  for (const q of parts) { for (const v of q.indices) indices[o++] = v + base; base += q.positions.length / 3; }
  return { positions: cat('positions', Float32Array), normals: cat('normals', Int16Array), colors: cat('colors', Uint8Array), uvs: cat('uvs', Float32Array), indices };
}
