// Tile workers (TILED_WORKERS): the flag, the pool's behaviour when a task or a worker fails, and that a tile built
// on a worker is byte for byte the tile built on the caller's thread.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkerPool, tileWorkerCount, runTileTask, ownBytes } from '../core/index.js';
import { preparePotree2Schema } from '../potree-to-3dtiles/src/potree2.js';
import { convert as potreeConvert } from '../potree-to-3dtiles/src/index.js';
import { potreeTileTask } from './tile-tasks.js';

const WORKER = new URL('../core/task-worker.js', import.meta.url);
const TASKS = new URL('./tile-tasks.js', import.meta.url).href;

test('TILED_WORKERS: off unless asked, auto is capped, a number is taken as given', () => {
  for (const v of [null, '', '0', 'off', 'false', 'nonsense', '-2']) assert.equal(tileWorkerCount(v), 0, String(v));
  assert.equal(tileWorkerCount('3'), 3);
  assert.equal(tileWorkerCount(5), 5);
  const auto = tileWorkerCount('auto');
  assert.ok(auto >= 1 && auto <= 8);
});

test('a failing task rejects alone, and a worker that dies is replaced', async () => {
  const mod = 'data:text/javascript,' + encodeURIComponent(
    'export const inc = (a) => a + 1; export const boom = () => { throw new Error("bad tile"); }; export const die = () => process.exit(3);');
  const pool = new WorkerPool(WORKER, 2);
  try {
    assert.equal(await runTileTask(pool, mod, 'inc', 1), 2);
    await assert.rejects(runTileTask(pool, mod, 'boom'), /bad tile/);
    await assert.rejects(runTileTask(pool, mod, 'die'), /tile worker died/);
    assert.deepEqual(await Promise.all([1, 2, 3, 4].map((n) => runTileTask(pool, mod, 'inc', n))), [2, 3, 4, 5]);
    assert.equal(pool.workers.length, 2);
  } finally { await pool.destroy(); }
});

// One point at (500000.5, 0.5, 0.5), orange, intensity 7.
const P2_META = {
  version: '2.0', encoding: 'DEFAULT', spacing: 1, scale: [0.01, 0.01, 0.01], offset: [500000, 0, 0],
  boundingBox: { min: [500000, 0, 0], max: [500001, 1, 1] }, hierarchy: { firstChunkSize: 22 },
  attributes: [{ name: 'position', size: 12, numElements: 3 }, { name: 'rgba', size: 4, numElements: 4 }, { name: 'intensity', size: 2, numElements: 1 }],
};
const p2Point = () => {
  const b = Buffer.alloc(18);
  b.writeInt32LE(50, 0); b.writeInt32LE(50, 4); b.writeInt32LE(50, 8); b.set([255, 128, 64, 255], 12); b.writeUInt16LE(7, 16);
  return b;
};

test('a Potree tile built on a worker is the tile built on this thread (2.0 and 1.x)', async () => {
  const origin = [500000.5, 0.5, 0.5];
  const p1 = Buffer.alloc(16);
  p1.writeUInt32LE(50, 0); p1.writeUInt32LE(50, 4); p1.writeUInt32LE(50, 8); p1.set([255, 128, 64, 255], 12);
  const cases = [
    { kind: '2', raw: p2Point(), node: { numPoints: 1 }, meta: { scale: P2_META.scale, offset: P2_META.offset },
      schema: preparePotree2Schema(structuredClone(P2_META)), origin, attributes: 'Intensity' },
    { kind: '1', raw: p1, node: { name: 'r', box: { min: [500000, 0, 0], max: [500001, 1, 1] } }, origin,
      spec: { isLaz: false, pointSize: 16, posA: { offset: 0 }, colA: { offset: 12 }, intA: undefined, clsA: undefined, scale: [0.01, 0.01, 0.01], min: [500000, 0, 0] } },
  ];
  const pool = new WorkerPool(WORKER, 1);
  try {
    for (const c of cases) {
      const here = await potreeTileTask({ ...c, raw: ownBytes(c.raw) });
      const raw = ownBytes(c.raw);
      const there = await runTileTask(pool, TASKS, 'potreeTileTask', { ...c, raw }, [raw.buffer]);
      assert.equal(Buffer.from(here).subarray(0, 4).toString(), 'glTF');
      assert.ok(Buffer.from(here).equals(Buffer.from(there)), `kind ${c.kind}`);
      assert.equal(raw.byteLength, 0, 'the bytes were handed over, not copied');
    }
  } finally { await pool.destroy(); }
});

test('potree-to-3dtiles writes the same tileset with and without tile workers', async (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tile-workers-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'src');
  await fs.mkdir(src);
  const hierarchy = Buffer.alloc(22);
  hierarchy.writeUInt8(1, 0); hierarchy.writeUInt32LE(1, 2); hierarchy.writeBigUInt64LE(18n, 14);
  await fs.writeFile(path.join(src, 'metadata.json'), JSON.stringify(P2_META));
  await fs.writeFile(path.join(src, 'hierarchy.bin'), hierarchy);
  await fs.writeFile(path.join(src, 'octree.bin'), p2Point());
  const list = async (d) => (await fs.readdir(d, { recursive: true, withFileTypes: true })).filter((e) => e.isFile())
    .map((e) => path.relative(d, path.join(e.parentPath, e.name))).sort();
  await potreeConvert(src, path.join(dir, 'off'), { workers: 0 });
  await potreeConvert(src, path.join(dir, 'on'), { workers: 2 });
  const files = await list(path.join(dir, 'off'));
  assert.ok(files.some((f) => f.endsWith('.glb')));
  assert.deepEqual(await list(path.join(dir, 'on')), files);
  for (const f of files) assert.ok((await fs.readFile(path.join(dir, 'off', f))).equals(await fs.readFile(path.join(dir, 'on', f))), f);
});

test('a tile the workers had no memory for is built on this thread, one at a time; any other failure is thrown', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { runTileTaskOr, tileFallbacks } = await import('../core/index.js');
  const mod = 'data:text/javascript,' + encodeURIComponent(
    'export const die = () => process.exit(134); export const alloc = () => { throw new RangeError("Array buffer allocation failed"); };'
    + 'export const bad = () => { throw new Error("not a LAS chunk"); }; export const ok = (a) => a;');
  const pool = new WorkerPool(WORKER, 3);
  try {
    let running = 0, most = 0; const before = tileFallbacks.count;
    const fallback = (n) => async () => { most = Math.max(most, ++running); await new Promise((r) => setTimeout(r, 15)); running--; return `here ${n}`; };
    const out = await Promise.all([
      runTileTaskOr(pool, mod, 'die', null, undefined, fallback(1)),
      runTileTaskOr(pool, mod, 'alloc', null, undefined, fallback(2)),
      runTileTaskOr(pool, mod, 'die', null, undefined, fallback(3)),
      runTileTaskOr(pool, mod, 'ok', 'there', undefined, fallback(4)),
    ]);
    assert.deepEqual(out, ['here 1', 'here 2', 'here 3', 'there']);
    assert.equal(most, 1, 'fallbacks never run beside each other');
    assert.equal(tileFallbacks.count - before, 3);
    await assert.rejects(runTileTaskOr(pool, mod, 'bad', null, undefined, fallback(5)), /not a LAS chunk/);
    assert.equal(await runTileTaskOr(pool, mod, 'ok', 7, undefined, fallback(6)), 7, 'the pool is whole again');
  } finally { await pool.destroy(); }
});
