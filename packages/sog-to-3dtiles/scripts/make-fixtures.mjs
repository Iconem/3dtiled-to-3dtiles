#!/usr/bin/env node
/**
 * make-fixtures.mjs — the SOG test fixtures of test/fixtures, from one synthetic scene (test/scene.mjs: a seeded
 * cluster of 3 000 splats with one band of spherical harmonics) written by splat-transform's own CLI as:
 *   v2/meta.json, v3/meta.json          the scene as an unbundled SOG, version 2 and 3
 *   lod-v2/lod-meta.json, lod-v3/…      the scene as a streamed SOG of three LOD levels (the coarser two decimated),
 *                                       its chunk SOGs of each version
 *
 *   node scripts/make-fixtures.mjs [outDir]      (default: ../test/fixtures)
 *
 * Re-run it after a splat-transform upgrade that changes the encoders; the tests compare the two versions with each
 * other and with the scene, within tolerances, not with stored numbers, so a re-encode does not break them.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { writePly, MemoryFileSystem } from '@playcanvas/splat-transform';
import { sceneTable } from '../test/scene.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(process.argv[2] ?? path.join(here, '..', 'test', 'fixtures'));

await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'sog-fixtures-'));
const mem = new MemoryFileSystem();
await writePly({ plyData: { comments: ['synthetic fixture scene'], elements: [{ name: 'vertex', dataTable: sceneTable() }] }, filename: 'scene.ply' }, mem);
const ply = path.join(work, 'scene.ply');
await fs.writeFile(ply, Buffer.from(mem.results.get('scene.ply')));

const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve('@playcanvas/splat-transform')), '..', 'bin', 'cli.mjs');
const run = (args) => {
  const r = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`splat-transform ${args.join(' ')} failed (${r.status})`);
};
// Two coarser levels by decimation: merged gaussians owe more than opacity 1, which only SOG v3 can store (the v2
// scene clamps them), so the coarse chunks of lod-v3 are where `opacity.max` and `opacity_linear` show up.
const lod1 = path.join(work, 'lod1.ply'), lod2 = path.join(work, 'lod2.ply');
run([ply, '-d', '40%', lod1]);
run([lod1, '-d', '40%', lod2]);
for (const v of [2, 3]) {
  await fs.mkdir(path.join(outDir, `v${v}`), { recursive: true });
  run([ply, path.join(outDir, `v${v}`, 'meta.json'), '--sog-version', String(v), '--sh-palette-size', '256', '--max-workers', '0']);
  await fs.mkdir(path.join(outDir, `lod-v${v}`), { recursive: true });
  run([ply, '-l', '0', lod1, '-l', '1', lod2, '-l', '2', path.join(outDir, `lod-v${v}`, 'lod-meta.json'),
    '--sog-version', String(v), '--sh-palette-size', '256', '--max-workers', '0', '--lod-chunk-count', '1', '--lod-chunk-extent', '2', '--lod-chunk-min', '0']);
}
await fs.rm(work, { recursive: true, force: true });
console.log(`fixtures → ${outDir}`);
