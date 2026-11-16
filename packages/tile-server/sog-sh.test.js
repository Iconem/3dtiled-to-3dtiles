// Spherical harmonics from SOG chunks (streamed SOG, LCC2): the chunk's `shN_*` planes are read only when asked, the
// bands come out in the tile writer's layout, the tile read back by another SPZ reader holds what the chunk held, and
// merging or thinning runs keeps each splat's coefficients with it.
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { readSpz, MemoryReadFileSystem, createChunkDataPool, materializeToDataTable } from '@playcanvas/splat-transform';
import { buildSplatTileGlb, computeBounds, shParam } from '../core/index.js';
import { decodeChunk, extractRange, shBands, restColumns } from '../sog-to-3dtiles/src/sogChunk.js';
import { sogMetaFiles } from '../sog-to-3dtiles/src/sogBundle.js';
import { thinSplats, concatSh } from '../sog-to-3dtiles/src/lodMeta.js';
import { sogChunkColumns } from './splat-tile.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sog-to-3dtiles', 'test', 'fixtures');

/** A table of `n` rows whose f_rest_c column holds c + row / 1000: every value says where it came from. */
function fakeTable(n, perChannel) {
  const cols = {};
  for (let c = 0; c < perChannel * 3; c++) cols[`f_rest_${c}`] = { data: Float32Array.from({ length: n }, (_, i) => c + i / 1000) };
  return { numRows: n, getColumnByName: (name) => cols[name] };
}

/** The SPZ payload of a tile GLB, read by splat-transform. */
async function tileTable(glb) {
  const b = Buffer.from(glb), jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.toString('utf8', 20, 20 + jsonLen));
  const view = json.bufferViews[0], bin = 20 + jsonLen + 8;
  const pool = createChunkDataPool(), fs = new MemoryReadFileSystem();
  fs.set('t.spz', new Uint8Array(b.subarray(bin + (view.byteOffset || 0), bin + (view.byteOffset || 0) + view.byteLength)));
  const src = await readSpz(await fs.createSource('t.spz'), pool);
  const table = await materializeToDataTable(src, pool); await src.close?.();
  return table;
}

test('the sh option is a degree 0..3, anything else 0', () => {
  assert.deepEqual(['1', 3, '2.9', 7, -1, 'x', undefined, null, ''].map(shParam), [1, 3, 2, 3, 0, 0, 0, 0, 0]);
});

test('bands: PLY columns (per channel) become per coefficient, RGB together, cut at the degree asked', () => {
  const t = fakeTable(4, 15);                                             // degree 3: 15 coefficients a channel
  assert.equal(shBands(t, 0, 4, 0), null);
  const one = shBands(t, 1, 2, 1);
  assert.deepEqual(Object.keys(one), ['sh1']);
  // rows 1 and 2; coefficient k of channel ch is column ch*15 + k
  const want = [];
  for (const row of [1, 2]) for (let k = 0; k < 3; k++) for (let ch = 0; ch < 3; ch++) want.push(Math.fround(ch * 15 + k + row / 1000));
  assert.deepEqual([...one.sh1], want);
  const all = shBands(t, 0, 4, 3);
  assert.deepEqual([all.sh1.length, all.sh2.length, all.sh3.length], [4 * 9, 4 * 15, 4 * 21]);
  assert.equal(all.sh2[0], 3);                                            // row 0, 4th coefficient, red: column 3
  assert.equal(all.sh2[1], 15 + 3);                                       // green
  assert.equal(all.sh3[2 * 21 + 6 * 3 + 2], Math.fround(30 + 8 + 6 + 2 / 1000));   // row 2, coefficient 14, blue
  assert.deepEqual(Object.keys(shBands(fakeTable(2, 3), 0, 2, 3)), ['sh1'], 'capped by what the table holds');
  assert.equal(shBands(fakeTable(2, 0), 0, 2, 3), null);
});

test('meta.json: the harmonics planes are named only when asked', async () => {
  const bytes = await readFile(path.join(FIX, 'v2', 'meta.json'));
  const without = sogMetaFiles(bytes), withSh = sogMetaFiles(bytes, true);
  assert.ok(withSh.names.includes('shN_centroids.webp') && withSh.names.includes('shN_labels.webp'));
  assert.deepEqual(without.names.filter((n) => /^shN/.test(n)), []);
  assert.equal(JSON.parse(Buffer.from(without.meta)).shN, undefined);
  assert.deepEqual(Buffer.from(withSh.meta), bytes, 'untouched when everything is kept');
});

for (const v of ['v2', 'v3']) {
  test(`SOG ${v} chunk: no harmonics unless asked; asked, the tile holds the chunk's coefficients`, async () => {
    const meta = path.join(FIX, v, 'meta.json');
    const plain = await decodeChunk(meta), full = await decodeChunk(meta, 3);
    assert.equal(restColumns(plain), 0);
    assert.equal(restColumns(full), 9, 'the fixture has one band');
    const n = full.numRows;
    const a0 = extractRange(plain, 0, n), a1 = extractRange(full, 0, n, 3);
    assert.equal(a0.sh, null);
    assert.equal(extractRange(full, 0, n).sh, null, 'not returned unless asked');
    assert.deepEqual(Object.keys(a1.sh), ['sh1']);
    for (const key of ['positions', 'alphas', 'rgb', 'scales', 'rotations']) assert.deepEqual(a1[key], a0[key], `${key} is the same with and without`);

    const bounds = computeBounds(a0.positions, n);
    const glb0 = await buildSplatTileGlb(a0, n, bounds), glb1 = await buildSplatTileGlb(a1, n, bounds);
    assert.ok(glb1.length > glb0.length);
    assert.equal(restColumns(await tileTable(glb0)), 0);
    const back = await tileTable(glb1);
    assert.equal(restColumns(back), 9);
    let worst = 0;
    for (let c = 0; c < 9; c++) {
      const src = full.getColumnByName(`f_rest_${c}`).data, got = back.getColumnByName(`f_rest_${c}`).data;
      for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(got[i] - Math.max(-1, Math.min(127 / 128, src[i]))));
    }
    assert.ok(worst <= 4.5 / 128, `degree 1 is kept on 5 bits: off by ${worst}`);

    // what a tile worker hands back: the same columns
    const dir = path.join(FIX, v), { meta: m, names } = sogMetaFiles(await readFile(meta), true);
    const files = { 'meta.json': m };
    for (const name of names) files[name] = new Uint8Array(await readFile(path.join(dir, name)));
    const cols = await sogChunkColumns(files, 1), none = await sogChunkColumns(files, 0);
    assert.equal(none.f_rest_0, undefined);
    assert.deepEqual(cols.f_rest_8, full.getColumnByName('f_rest_8').data);
  });
}

test('merged and thinned runs keep each splat with its coefficients', () => {
  const part = (first, n) => ({ sh: { sh1: Float32Array.from({ length: n * 9 }, (_, i) => first + Math.floor(i / 9)) } });
  const merged = concatSh([part(0, 3), part(10, 2)]);
  assert.deepEqual([...merged.sh1].filter((_, i) => i % 9 === 0), [0, 1, 2, 10, 11]);
  assert.equal(concatSh([part(0, 3), { sh: null }]), null, 'a run without harmonics: none for the tile');
  const positions = Float32Array.from({ length: 15 }, (_, i) => Math.floor(i / 3));
  const [thin, count] = thinSplats({ positions, alphas: null, rgb: null, scales: null, rotations: null, sh: merged }, 5, 2);
  assert.equal(count, 3);
  assert.deepEqual([...thin.positions].filter((_, i) => i % 3 === 0), [0, 2, 4]);
  assert.deepEqual([...thin.sh.sh1].filter((_, i) => i % 9 === 0), [0, 2, 11]);
  assert.equal(thin.sh.sh1.length, 27);
});
