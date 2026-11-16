// Spherical harmonics in splat tiles (core/spz-glb.js): what is written is what another SPZ reader gets back
// (PlayCanvas splat-transform), the degree follows the bands given, and without bands the tile is today's.
import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { readSpz, MemoryReadFileSystem, createChunkDataPool, materializeToDataTable } from '@playcanvas/splat-transform';
import { buildSpzBuffer, buildSplatTileGlb, computeBounds, shDegreeOf, SH_VALUES } from '../core/index.js';

const N = 500;
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
const arr = (n, f) => Float32Array.from({ length: n }, f);
const base = () => ({
  positions: arr(N * 3, () => (rnd() - 0.5) * 20), alphas: arr(N, () => rnd()), rgb: arr(N * 3, () => rnd()),
  scales: arr(N * 3, () => 0.01 + rnd() * 0.2), rotations: arr(N * 4, (_, i) => (i % 4 === 3 ? 1 : 0)),
});
const bands = () => ({ sh1: arr(N * 9, () => (rnd() - 0.5) * 1.6), sh2: arr(N * 15, () => (rnd() - 0.5) * 1.2), sh3: arr(N * 21, () => (rnd() - 0.5) * 0.8) });
const spz = (b, sh) => buildSpzBuffer(b.positions, b.alphas, b.rgb, b.scales, b.rotations, N, sh);

async function readBack(buf) {
  const pool = createChunkDataPool(), fs = new MemoryReadFileSystem();
  fs.set('t.spz', new Uint8Array(buf));
  const src = await readSpz(await fs.createSource('t.spz'), pool);
  const table = await materializeToDataTable(src, pool); await src.close?.();
  return table;
}

test('the degree written is the highest band given without a gap', async () => {
  const b = base(), sh = bands();
  assert.equal(shDegreeOf(null), 0);
  assert.equal(shDegreeOf({ sh1: sh.sh1 }), 1);
  assert.equal(shDegreeOf({ sh1: sh.sh1, sh2: sh.sh2, sh3: sh.sh3 }), 3);
  assert.equal(shDegreeOf({ sh2: sh.sh2 }), 0);                       // no degree 2 without degree 1
  assert.equal(shDegreeOf({ sh1: sh.sh1, sh3: sh.sh3 }), 1);
  for (const [given, degree] of [[null, 0], [{ sh1: sh.sh1 }, 1], [{ sh1: sh.sh1, sh2: sh.sh2 }, 2], [sh, 3]]) {
    const raw = gunzipSync(await spz(b, given));
    assert.equal(raw[12], degree);
    assert.equal(raw.length, 16 + N * (19 + SH_VALUES[degree]));
  }
});

test('without bands the payload is the degree-0 one, byte for byte', async () => {
  const b = base();
  assert.deepEqual(gunzipSync(await spz(b, null)), gunzipSync(await spz(b, {})));
  assert.deepEqual(gunzipSync(await spz(b, null)), gunzipSync(await buildSpzBuffer(b.positions, b.alphas, b.rgb, b.scales, b.rotations, N)));
});

for (const degree of [1, 2, 3]) {
  test(`degree ${degree}: another SPZ reader gets the coefficients back, within the format's rounding`, async () => {
    const b = base(), all = bands();
    const sh = { sh1: all.sh1, ...(degree >= 2 ? { sh2: all.sh2 } : {}), ...(degree >= 3 ? { sh3: all.sh3 } : {}) };
    const table = await readBack(await spz(b, sh));
    assert.equal(table.numRows, N);
    const K = [0, 3, 8, 15][degree];                                   // coefficients per channel
    // f_rest_* is the PLY order: all coefficients of red, then green, then blue. Ours: per coefficient, RGB together.
    const ours = (i, k, ch) => (k < 3 ? sh.sh1[i * 9 + k * 3 + ch] : k < 8 ? sh.sh2[i * 15 + (k - 3) * 3 + ch] : sh.sh3[i * 21 + (k - 8) * 3 + ch]);
    let worst1 = 0, worstN = 0;
    for (let ch = 0; ch < 3; ch++) for (let k = 0; k < K; k++) {
      const col = table.getColumnByName(`f_rest_${ch * K + k}`)?.data;
      assert.ok(col, `f_rest_${ch * K + k} is read`);
      for (let i = 0; i < N; i++) { const d = Math.abs(col[i] - Math.max(-1, Math.min(127 / 128, ours(i, k, ch)))); if (k < 3) worst1 = Math.max(worst1, d); else worstN = Math.max(worstN, d); }
    }
    assert.ok(worst1 <= 4.5 / 128, `degree 1 is kept on 5 bits: off by ${worst1}`);      // half a step of 8/128
    assert.ok(worstN <= 8.5 / 128, `degrees 2 and 3 on 4 bits: off by ${worstN}`);       // half a step of 16/128
    assert.equal(table.getColumnByName(`f_rest_${3 * K}`), undefined);
  });
}

test('the GLB declares the coefficients it holds', async () => {
  const b = base(), sh = bands();
  const json = (glb) => JSON.parse(Buffer.from(glb).toString('utf8', 20, 20 + Buffer.from(glb).readUInt32LE(12)));
  const attrs = (j) => Object.keys(j.meshes[0].primitives[0].attributes).filter((k) => /SH_DEGREE/.test(k));
  const bounds = computeBounds(b.positions, N);
  assert.deepEqual(attrs(json(await buildSplatTileGlb(b, N, bounds))), []);
  const two = json(await buildSplatTileGlb({ ...b, sh: { sh1: sh.sh1, sh2: sh.sh2 } }, N, bounds));
  assert.deepEqual(attrs(two), ['KHR_gaussian_splatting:SH_DEGREE_1_COEF_0', 'KHR_gaussian_splatting:SH_DEGREE_1_COEF_1', 'KHR_gaussian_splatting:SH_DEGREE_1_COEF_2',
    'KHR_gaussian_splatting:SH_DEGREE_2_COEF_0', 'KHR_gaussian_splatting:SH_DEGREE_2_COEF_1', 'KHR_gaussian_splatting:SH_DEGREE_2_COEF_2', 'KHR_gaussian_splatting:SH_DEGREE_2_COEF_3', 'KHR_gaussian_splatting:SH_DEGREE_2_COEF_4']);
  assert.equal(two.accessors.length, 4 + 8);
  for (const i of Object.values(two.meshes[0].primitives[0].attributes)) assert.ok(two.accessors[i], 'every attribute has its accessor');
});
