/**
 * samples.js (tilers) — tiny synthetic raw inputs for the one-stop tiler, written to a folder:
 *
 *   points.las            20 000 points on a hill 60 m wide, coloured by height. LAS 1.4, UTM 31N (EPSG:32631) near
 *                         Paris; the file carries no CRS record, so give the tools `--srs EPSG:32631`.
 *   splats.ply            3 000 Gaussian splats on a torus, in the PLY layout 3DGS trainers write, with spherical
 *                         harmonics of degree 1 (so a tool's harmonics option has something to keep). Z up, metres.
 *   mesh/mesh.obj         a 40 × 40 terrain grid (3 200 triangles) with normals and UVs, mesh.mtl and a 64 × 64 PNG.
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
  fs.writeFileSync(path.join(dir, 'mesh', 'mesh.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

return ['points.las', 'splats.ply', 'mesh/mesh.obj', 'mesh/mesh.mtl', 'mesh/mesh.png'].map((f) => path.resolve(dir, f));
}
