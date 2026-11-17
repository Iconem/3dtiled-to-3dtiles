/**
 * samples.js (tilers) — tiny synthetic raw inputs for the one-stop tiler, written to a folder:
 *
 *   points.las            20 000 points on a hill 60 m wide, coloured by height. LAS 1.4, UTM 31N (EPSG:32631) near
 *                         Paris; the file carries no CRS record, so give the tools `--srs EPSG:32631`.
 *   splats.ply            3 000 Gaussian splats on a torus, in the PLY layout 3DGS trainers write, with spherical
 *                         harmonics of degree 1 (so a tool's harmonics option has something to keep). Z up, metres.
 *   mesh/mesh.obj         a 40 × 40 terrain grid (3 200 triangles) with normals and UVs, mesh.mtl and a 64 × 64 PNG.
 *   mesh.glb              the same terrain as one binary glTF, Y up as glTF wants, the texture inside.
 *   mesh.ply              the same terrain as a binary PLY mesh with vertex colours (no texture), Z up.
 *
 *   node packages/tilers/cli.js samples <folder>
 *
 * Nothing here is real data: the files are small enough to run every tool in seconds and to see that the chain
 * from raw file to streamed tiles works. Deterministic (a seeded generator), so two runs write the same bytes.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { lasHeaderBytes, writeLasRecord, LAS_HEADER_SIZE, LAS_RECORD_LEN } from '../core/las-format.js';

/** What the samples are, for whoever lists them: file (relative), what it is, and the options a tool needs for it. */
export const SAMPLES = [
  { file: 'points.las', kind: 'pointcloud', about: '20 000 points on a hill, UTM 31N: give the tools EPSG:32631' },
  { file: 'splats.ply', kind: 'splat', about: '3 000 Gaussian splats on a torus, with degree-1 harmonics' },
  { file: 'mesh/mesh.obj', kind: 'mesh', about: 'a textured terrain of 3 200 triangles, Z up, local coordinates' },
  { file: 'mesh.glb', kind: 'mesh', about: 'the same terrain as a binary glTF, Y up' },
  { file: 'mesh.ply', kind: 'mesh', about: 'the same terrain as a PLY mesh with vertex colours' },
];

/**
 * Write the samples into `dir` (created). Returns the files written, absolute.
 * @param {string} dir
 * @param {{points?:number, splats?:number}} [o]
 */
export function writeSamples(dir, o = {}) {
const nPoints = o.points ?? 20000, nSplats = o.splats ?? 3000;
fs.mkdirSync(path.join(dir, 'mesh'), { recursive: true });

let seed = 12345;                                   // mulberry32
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const hill = (x, y) => 12 * Math.exp(-(x * x + y * y) / 400) + 1.5 * Math.sin(x / 4) * Math.cos(y / 5);
const ramp = (t) => [Math.min(1, Math.max(0, 1.6 * t - 0.2)), Math.min(1, Math.max(0, 1 - Math.abs(2 * t - 1) * 0.9)), Math.min(1, Math.max(0, 0.9 - 1.4 * t))];

// ── points.las ───────────────────────────────────────────────────────────────────────────────────────────────────
{
  const n = Number(nPoints), origin = [448250, 5411950, 35], scale = [0.001, 0.001, 0.001];
  const buf = new Uint8Array(LAS_HEADER_SIZE + n * LAS_RECORD_LEN), view = new DataView(buf.buffer);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const x = (rnd() - 0.5) * 60, y = (rnd() - 0.5) * 60, z = hill(x, y) + (rnd() - 0.5) * 0.05;
    const p = [origin[0] + x, origin[1] + y, origin[2] + z], [r, g, b] = ramp((z + 2) / 15);
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
    writeLasRecord(view, LAS_HEADER_SIZE + i * LAS_RECORD_LEN, Math.round(x / scale[0]), Math.round(y / scale[1]), Math.round(z / scale[2]),
      Math.round(65535 * (z + 2) / 15), Math.round(r * 65535), Math.round(g * 65535), Math.round(b * 65535));
  }
  buf.set(lasHeaderBytes({ scale, offset: origin, count: n, bbox: { min, max } }), 0);
  fs.writeFileSync(path.join(dir, 'points.las'), buf);
}

// ── splats.ply ───────────────────────────────────────────────────────────────────────────────────────────────────
{
  const n = Number(nSplats), SH_C0 = 0.28209479177387814;
  const props = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', ...Array.from({ length: 9 }, (_, i) => `f_rest_${i}`), 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n${props.map((p) => `property float ${p}`).join('\n')}\nend_header\n`;
  const body = new Float32Array(n * props.length);
  for (let i = 0; i < n; i++) {
    const u = rnd() * 2 * Math.PI, v = rnd() * 2 * Math.PI, R = 4, r = 1.3;
    const x = (R + r * Math.cos(v)) * Math.cos(u), y = (R + r * Math.cos(v)) * Math.sin(u), z = r * Math.sin(v) + 1.5;
    const [cr, cg, cb] = ramp(u / (2 * Math.PI)), o = i * props.length;
    body.set([x, y, z, 0, 0, 0, (cr - 0.5) / SH_C0, (cg - 0.5) / SH_C0, (cb - 0.5) / SH_C0], o);
    for (let k = 0; k < 9; k++) body[o + 9 + k] = (rnd() - 0.5) * 0.3;                      // degree-1 harmonics: a mild view-dependent tint
    body.set([2.2 /* opacity logit ≈ 0.9 */, Math.log(0.12), Math.log(0.12), Math.log(0.04), 1, 0, 0, 0], o + 18);
  }
  fs.writeFileSync(path.join(dir, 'splats.ply'), Buffer.concat([Buffer.from(header, 'ascii'), Buffer.from(body.buffer)]));
}

// ── mesh/mesh.obj, mesh.mtl, mesh.png ────────────────────────────────────────────────────────────────────────────
{
  const N = 40, size = 60, lines = ['# synthetic terrain, Z up, metres', 'mtllib mesh.mtl', 'usemtl terrain'];
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) { const x = (i / N - 0.5) * size, y = (j / N - 0.5) * size; lines.push(`v ${x.toFixed(4)} ${y.toFixed(4)} ${hill(x, y).toFixed(4)}`); }
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) lines.push(`vt ${(i / N).toFixed(5)} ${(j / N).toFixed(5)}`);
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const x = (i / N - 0.5) * size, y = (j / N - 0.5) * size, e = 0.05;
    const dx = (hill(x + e, y) - hill(x - e, y)) / (2 * e), dy = (hill(x, y + e) - hill(x, y - e)) / (2 * e), l = Math.hypot(dx, dy, 1);
    lines.push(`vn ${(-dx / l).toFixed(5)} ${(-dy / l).toFixed(5)} ${(1 / l).toFixed(5)}`);
  }
  const id = (i, j) => j * (N + 1) + i + 1, f = (a, b, c) => lines.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}`);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { f(id(i, j), id(i + 1, j), id(i + 1, j + 1)); f(id(i, j), id(i + 1, j + 1), id(i, j + 1)); }
  fs.writeFileSync(path.join(dir, 'mesh', 'mesh.obj'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'mesh', 'mesh.mtl'), 'newmtl terrain\nKa 1 1 1\nKd 1 1 1\nKs 0 0 0\nd 1\nillum 1\nmap_Kd mesh.png\n');

  // a 64 × 64 RGB PNG: the height ramp with a grid drawn on it
  const W = 64, raw = Buffer.alloc(W * (1 + W * 3));
  for (let y = 0; y < W; y++) {
    raw[y * (1 + W * 3)] = 0;                                    // filter: none
    for (let x = 0; x < W; x++) {
      const px = (x / (W - 1) - 0.5) * size, py = ((W - 1 - y) / (W - 1) - 0.5) * size, grid = x % 8 === 0 || y % 8 === 0 ? 0.6 : 1;
      const c = ramp((hill(px, py) + 2) / 15), o = y * (1 + W * 3) + 1 + x * 3;
      raw[o] = c[0] * 255 * grid; raw[o + 1] = c[1] * 255 * grid; raw[o + 2] = c[2] * 255 * grid;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type, 'ascii'), data]), sum = Buffer.alloc(4); len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(td)); return Buffer.concat([len, td, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(path.join(dir, 'mesh', 'mesh.png'), png);

  // the same grid as arrays, for the two single-file meshes
  const V = (N + 1) * (N + 1), pos = new Float32Array(V * 3), nor = new Float32Array(V * 3), uv = new Float32Array(V * 2), col = new Uint8Array(V * 3), idx = new Uint16Array(N * N * 6);
  for (let j = 0, v = 0; j <= N; j++) for (let i = 0; i <= N; i++, v++) {
    const x = (i / N - 0.5) * size, y = (j / N - 0.5) * size, z = hill(x, y), e = 0.05;
    const dx = (hill(x + e, y) - hill(x - e, y)) / (2 * e), dy = (hill(x, y + e) - hill(x, y - e)) / (2 * e), l = Math.hypot(dx, dy, 1), c = ramp((z + 2) / 15);
    pos.set([x, y, z], v * 3); nor.set([-dx / l, -dy / l, 1 / l], v * 3); uv.set([i / N, 1 - j / N], v * 2); col.set(c.map((k) => Math.round(k * 255)), v * 3);
  }
  for (let j = 0, t = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = j * (N + 1) + i; idx.set([a, a + 1, a + N + 2, a, a + N + 2, a + N + 1], t); t += 6; }

  // mesh.ply: binary, vertex colours, triangles
  {
    const head = `ply\nformat binary_little_endian 1.0\ncomment synthetic terrain, Z up, metres\nelement vertex ${V}\nproperty float x\nproperty float y\nproperty float z\nproperty float nx\nproperty float ny\nproperty float nz\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face ${N * N * 2}\nproperty list uchar int vertex_indices\nend_header\n`;
    const vb = Buffer.alloc(V * 27), fb = Buffer.alloc(N * N * 2 * 13);
    for (let v = 0; v < V; v++) { for (let k = 0; k < 3; k++) { vb.writeFloatLE(pos[v * 3 + k], v * 27 + k * 4); vb.writeFloatLE(nor[v * 3 + k], v * 27 + 12 + k * 4); vb[v * 27 + 24 + k] = col[v * 3 + k]; } }
    for (let t = 0; t < N * N * 2; t++) { fb[t * 13] = 3; for (let k = 0; k < 3; k++) fb.writeInt32LE(idx[t * 3 + k], t * 13 + 1 + k * 4); }
    fs.writeFileSync(path.join(dir, 'mesh.ply'), Buffer.concat([Buffer.from(head, 'ascii'), vb, fb]));
  }

  // mesh.glb: glTF is Y up, so (x, y, z) becomes (x, z, -y); the PNG rides in the binary chunk
  {
    const yup = (a) => { const o = new Float32Array(a.length); for (let v = 0; v < a.length; v += 3) o.set([a[v], a[v + 2], -a[v + 1]], v); return o; };
    const parts = [yup(pos), yup(nor), uv, idx, png].map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)), views = [];
    let at = 0;
    const bin = Buffer.concat(parts.map((b) => { views.push({ buffer: 0, byteOffset: at, byteLength: b.length }); const pad = (4 - (b.length % 4)) % 4; at += b.length + pad; return Buffer.concat([b, Buffer.alloc(pad)]); }));
    const p3 = yup(pos), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < p3.length; v += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p3[v + k]); max[k] = Math.max(max[k], p3[v + k]); }
    const gltf = {
      asset: { version: '2.0', generator: '3dtiled tile samples' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'terrain' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } }],
      textures: [{ source: 0, sampler: 0 }], samplers: [{ magFilter: 9729, minFilter: 9987 }], images: [{ bufferView: 4, mimeType: 'image/png' }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: V, type: 'VEC3', min, max }, { bufferView: 1, componentType: 5126, count: V, type: 'VEC3' },
        { bufferView: 2, componentType: 5126, count: V, type: 'VEC2' }, { bufferView: 3, componentType: 5123, count: idx.length, type: 'SCALAR' },
      ],
      bufferViews: views.map((v, i) => (i < 3 ? { ...v, target: 34962 } : i === 3 ? { ...v, target: 34963 } : v)), buffers: [{ byteLength: bin.length }],
    };
    let json = Buffer.from(JSON.stringify(gltf)); json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
    const head = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
    head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
    jh.writeUInt32LE(json.length, 0); jh.write('JSON', 4); bh.writeUInt32LE(bin.length, 0); bh.write('BIN\0', 4);
    fs.writeFileSync(path.join(dir, 'mesh.glb'), Buffer.concat([head, jh, json, bh, bin]));
  }
}

return ['points.las', 'splats.ply', 'mesh/mesh.obj', 'mesh/mesh.mtl', 'mesh/mesh.png', 'mesh.glb', 'mesh.ply'].map((f) => path.resolve(dir, f));
}
