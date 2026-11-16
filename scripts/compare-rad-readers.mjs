// Our RAD reader against Spark's own (packages/rad-to-3dtiles/src/sparkRad.js), chunk by chunk, on a real file.
//   node scripts/compare-rad-readers.mjs <rad url or path> [chunks=6]
// Reads the header and a spread of chunks by range, decodes each with both, and prints the largest difference per
// column, the decode time of each, and what Spark returns that ours does not read (spherical harmonics).
import { open } from 'node:fs/promises';
import { parseRadHeader } from '../packages/rad-to-3dtiles/src/radHeader.js';
import { decodeChunkColumns } from '../packages/rad-to-3dtiles/src/index.js';
import { sparkRadHeader, sparkDecodeChunk } from '../packages/rad-to-3dtiles/src/sparkRad.js';

const [src, nArg] = process.argv.slice(2);
const isUrl = /^https?:/.test(src);
async function range(offset, length) {
  if (isUrl) {
    const r = await fetch(src, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (r.status !== 206) throw new Error(`range request answered ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  const fh = await open(src, 'r');
  try { const b = Buffer.alloc(length); const { bytesRead } = await fh.read(b, 0, length, offset); return b.subarray(0, bytesRead); } finally { await fh.close(); }
}

let head = await range(0, 1 << 20);
let need = 8 + head.readUInt32LE(4) + 8;
if (head.length < need) head = await range(0, need);
const ours = parseRadHeader(head);
const spark = sparkRadHeader(head);
const chunks = ours.header.chunks;
console.log(JSON.stringify({ splats: ours.header.count, chunks: chunks.length, chunkSize: ours.header.chunkSize, maxSh: ours.header.maxSh ?? 0, lodTree: !!ours.header.lodTree,
  headerAgrees: spark.chunksStart === ours.payloadBase && spark.meta.count === ours.header.count && spark.meta.chunks.length === chunks.length }));

const n = Math.min(+(nArg || 6), chunks.length);
const pick = [...new Set(Array.from({ length: n }, (_, i) => Math.round(i * (chunks.length - 1) / Math.max(1, n - 1))))];
const maxDiff = (a, b) => { let m = 0; if (!a || !b) return a || b ? Infinity : 0; if (a.length !== b.length) return Infinity; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d; } return m; };
// a quaternion and its negative are the same rotation
const quatDiff = (a, b) => { let m = 0; if (!a || !b || a.length !== b.length) return Infinity; for (let i = 0; i < a.length; i += 4) { let d1 = 0, d2 = 0; for (let k = 0; k < 4; k++) { d1 = Math.max(d1, Math.abs(a[i + k] - b[i + k])); d2 = Math.max(d2, Math.abs(a[i + k] + b[i + k])); } m = Math.max(m, Math.min(d1, d2)); } return m; };

const worst = { center: 0, opacity: 0, rgb: 0, scaleRel: 0, quat: 0 }; let tOurs = 0, tSpark = 0, splats = 0; const sh = {};
for (const ci of pick) {
  const c = chunks[ci];
  const bytes = await range(ours.payloadBase + c.offset, c.bytes);
  let t = performance.now(); const a = decodeChunkColumns(bytes, { offset: 0, bytes: c.bytes }, 0); tOurs += performance.now() - t;
  t = performance.now(); const b = sparkDecodeChunk(bytes); tSpark += performance.now() - t;
  if (a.count !== b.count) { console.log(JSON.stringify({ chunk: ci, countOurs: a.count, countSpark: b.count })); continue; }
  splats += a.count;
  let scaleRel = 0;
  if (a.scales && b.scale) for (let i = 0; i < a.scales.length; i++) { const d = Math.abs(a.scales[i] - b.scale[i]) / Math.max(1e-12, Math.abs(b.scale[i])); if (d > scaleRel) scaleRel = d; }
  const d = { center: maxDiff(a.positions, b.center), opacity: maxDiff(a.alphaRaw, b.opacity), rgb: maxDiff(a.rgb, b.rgb), scaleRel, quat: quatDiff(a.rotations, b.quat) };
  for (const k in worst) worst[k] = Math.max(worst[k], d[k]);
  for (const k of ['sh1', 'sh2', 'sh3', 'sh1Codes', 'sh2Codes', 'sh3Codes', 'shLabels']) if (b[k]) sh[k] = (sh[k] || 0) + b[k].length;
  console.log(JSON.stringify({ chunk: ci, count: a.count, lodOpacity: a.lodOpacity, ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, +v.toExponential(2)])) }));
}
console.log(JSON.stringify({ chunksCompared: pick.length, splats, worst: Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, +v.toExponential(2)])),
  ms: { ours: Math.round(tOurs), spark: Math.round(tSpark), sparkOverOurs: +(tSpark / tOurs).toFixed(2) }, sparkOnly: sh }));
