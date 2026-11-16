// Our RAD reader against Spark's own (rad-to-3dtiles/src/sparkRad.js: Spark's Rust decoder as WebAssembly), on a
// chunk built here in the file's layout. Real files are compared by scripts/compare-rad-readers.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { decodeChunkColumns } from '../rad-to-3dtiles/src/index.js';
import { sparkDecodeChunk } from '../rad-to-3dtiles/src/sparkRad.js';

const pad8 = (n) => Math.ceil(n / 8) * 8;

/** A `RADC` chunk of `n` splats: raw property bytes, deflated, behind the chunk's JSON header. */
function radChunk(n, { rgbMin = 0, rgbMax = 1 } = {}) {
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  // center, f32_lebytes: byte k of every value of dimension d together, so the floats are written then transposed
  const pos = new Float32Array(n * 3); for (let i = 0; i < pos.length; i++) pos[i] = (rnd() - 0.5) * 200;
  const pb = new Uint8Array(pos.buffer), center = new Uint8Array(n * 12);
  for (let d = 0; d < 3; d++) for (let k = 0; k < 4; k++) for (let i = 0; i < n; i++) center[(k * 3 + d) * n + i] = pb[(i * 3 + d) * 4 + k];
  // alpha, f16: half floats of 0..1 (0x0000..0x3c00 are 0..1, all finite)
  const alpha = new Uint8Array(n * 2); for (let i = 0; i < n; i++) new DataView(alpha.buffer).setUint16(i * 2, Math.floor(rnd() * 0x3c00), true);
  const bytes = (len) => { const b = new Uint8Array(len); for (let i = 0; i < len; i++) b[i] = Math.floor(rnd() * 256); return b; };
  const raw = { center, alpha, rgb: bytes(n * 3), scales: bytes(n * 3), orientation: bytes(n * 3) };
  const enc = { center: 'f32_lebytes', alpha: 'f16', rgb: 'r8_delta', scales: 'ln_0r8', orientation: 'oct88r8' };
  const parts = [], properties = []; let offset = 0;
  for (const [property, data] of Object.entries(raw)) {
    const z = deflateRawSync(data);
    properties.push({ offset, bytes: z.length, property, encoding: enc[property], compression: 'gz',
      ...(property === 'rgb' ? { min: rgbMin, max: rgbMax } : property === 'scales' ? { min: -12, max: 9 } : {}) });
    const padded = Buffer.alloc(pad8(z.length)); z.copy(padded); parts.push(padded); offset += padded.length;
  }
  const meta = Buffer.from(JSON.stringify({ version: 1, base: 0, count: n, payloadBytes: offset, maxSh: 0, lodTree: true,
    splatEncoding: { rgbMin, rgbMax, lnScaleMin: -12, lnScaleMax: 9, sh1Max: 1, sh2Max: 1, sh3Max: 1, lodOpacity: true }, properties }));
  const head = Buffer.alloc(pad8(8 + meta.length) + 8);
  head.write('RADC', 0, 'latin1'); head.writeUInt32LE(meta.length, 4); meta.copy(head, 8);
  head.writeBigUInt64LE(BigInt(offset), head.length - 8);
  return Buffer.concat([head, ...parts]);
}

const maxDiff = (a, b) => { assert.equal(a.length, b.length); let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

for (const [name, range] of [['colours in 0..1', {}], ['colours outside 0..1, as files with spherical harmonics store them', { rgbMin: -0.0147, rgbMax: 1.1445 }]]) {
  test(`RAD chunk: our reader and Spark's give the same splats (${name})`, () => {
    const chunk = radChunk(4000, range);
    const ours = decodeChunkColumns(chunk, { offset: 0, bytes: chunk.length }, 0);
    const spark = sparkDecodeChunk(chunk);
    assert.equal(ours.count, 4000); assert.equal(spark.count, 4000);
    assert.equal(ours.lodOpacity, true);
    assert.equal(maxDiff(ours.positions, spark.center), 0);
    assert.equal(maxDiff(ours.alphaRaw, spark.opacity), 0);
    assert.ok(maxDiff(ours.rgb, spark.rgb) < 1e-6);
    // byte 0 is a flat axis: Spark gives 0, ours a scale too small to matter (1e-10); the others agree to rounding
    let rel = 0;
    for (let i = 0; i < ours.scales.length; i++) {
      if (spark.scale[i] === 0) assert.ok(ours.scales[i] <= 1e-9);
      else rel = Math.max(rel, Math.abs(ours.scales[i] - spark.scale[i]) / spark.scale[i]);
    }
    assert.ok(rel < 1e-5, `scales differ by ${rel}`);
    let q = 0;   // a quaternion and its negative are one rotation
    for (let i = 0; i < ours.rotations.length; i += 4) { let d1 = 0, d2 = 0; for (let k = 0; k < 4; k++) { d1 = Math.max(d1, Math.abs(ours.rotations[i + k] - spark.quat[i + k])); d2 = Math.max(d2, Math.abs(ours.rotations[i + k] + spark.quat[i + k])); } q = Math.max(q, Math.min(d1, d2)); }
    assert.ok(q < 1e-5, `rotations differ by ${q}`);
    if (range.rgbMin != null) { let lo = Infinity, hi = -Infinity; for (const v of ours.rgb) { lo = Math.min(lo, v); hi = Math.max(hi, v); } assert.ok(lo < 0 && hi > 1, 'the stored range is applied'); }
  });
}

test("Spark's decoder refuses bytes that are not a chunk", () => {
  assert.throws(() => sparkDecodeChunk(Buffer.from('not a RAD chunk at all')), /magic/i);
});
