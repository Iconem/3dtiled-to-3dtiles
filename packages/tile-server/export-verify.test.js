// verifyExport walks a finished folder as a client would; it must find what is really there and name what is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildPointsGlb } from '../core/index.js';
import http from 'node:http';
import { once } from 'node:events';
import { checkGlb, declaredPoints, sourceOfUrl, verifyExport } from './export-verify.js';
import { exportTileset } from './export-live.js';

const box = { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] };
const folder = async (t) => { const d = await mkdtemp(path.join(os.tmpdir(), 'verify-')); t.after(() => rm(d, { recursive: true, force: true })); return d; };
const glb = (n = 1) => buildPointsGlb(new Float32Array(n * 3), null, n);
const put = async (d, rel, body) => { await mkdir(path.dirname(path.join(d, rel)), { recursive: true }); await writeFile(path.join(d, rel), body); };

test('an explicit tree, through an external tileset, counts per level', async (t) => {
  const d = await folder(t);
  const tile = (uri, children) => ({ boundingVolume: box, geometricError: 1, content: { uri }, children });
  await put(d, 'tileset.json', JSON.stringify({ root: tile('tiles/a.glb', [tile('tiles/b.glb'), tile('tilesets/ext.json')]) }));
  await put(d, 'tilesets/ext.json', JSON.stringify({ root: tile('../tiles/c.glb', [tile('../tiles/d.glb')]) }));
  for (const f of ['a', 'b', 'c', 'd']) await put(d, `tiles/${f}.glb`, await glb());
  const v = await verifyExport(d);
  assert.deepEqual(v.levels, { 0: 1, 1: 2, 2: 1 });
  assert.equal(v.ok, true);
});

test('a missing or empty tile is named', async (t) => {
  const d = await folder(t);
  const tile = (uri, children) => ({ boundingVolume: box, geometricError: 1, content: { uri }, children });
  await put(d, 'tileset.json', JSON.stringify({ root: tile('a.glb', [tile('gone.glb'), tile('empty.glb')]) }));
  await put(d, 'a.glb', await glb());
  await put(d, 'empty.glb', '');
  const v = await verifyExport(d);
  assert.equal(v.ok, false);
  assert.deepEqual(v.missingFiles.sort(), ['empty.glb', 'gone.glb']);
});

test('implicit tiling follows subtree availability, and a missing subtree is named', async (t) => {
  const d = await folder(t);
  await put(d, 'tileset.json', JSON.stringify({ root: {
    boundingVolume: box, geometricError: 1, content: { uri: 't/{level}-{x}-{y}-{z}.glb' },
    implicitTiling: { subdivisionScheme: 'OCTREE', subtreeLevels: 2, availableLevels: 4, subtrees: { uri: 's/{level}-{x}-{y}-{z}.subtree' } },
  } }));
  // Level 0 and all 8 of level 1 have content; the only child subtree sits under morton index 3 of level 2.
  const bits = Buffer.alloc(8); bits[0] = 1 << 3;
  const json = JSON.stringify({
    buffers: [{ byteLength: 8 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 8 }],
    tileAvailability: { constant: 1 }, contentAvailability: [{ constant: 1 }], childSubtreeAvailability: { bitstream: 0 },
  }).padEnd(256);
  const head = Buffer.alloc(24); head.write('subt'); head.writeUInt32LE(1, 4); head.writeBigUInt64LE(BigInt(json.length), 8); head.writeBigUInt64LE(8n, 16);
  await put(d, 's/0-0-0-0.subtree', Buffer.concat([head, Buffer.from(json), bits]));
  await put(d, 't/0-0-0-0.glb', await glb());
  for (let i = 0; i < 8; i++) await put(d, `t/1-${(i >> 0) & 1}-${(i >> 1) & 1}-${(i >> 2) & 1}.glb`, await glb());
  const v = await verifyExport(d);
  assert.deepEqual(v.levels, { 0: 1, 1: 8 });
  assert.deepEqual(v.missingFiles, ['s/2-1-1-0.subtree']);
});

const onePointTree = async (d, points = [3, 4]) => {
  const tile = (uri, children) => ({ boundingVolume: box, geometricError: 1, content: { uri }, children });
  await put(d, 'tileset.json', JSON.stringify({ root: tile('a.glb', [tile('b.glb')]) }));
  await put(d, 'a.glb', await glb(points[0]));
  await put(d, 'b.glb', await glb(points[1]));
};

test('the points in the tile headers are compared with what a Potree source declares', async (t) => {
  const d = await folder(t), src = await folder(t);
  await onePointTree(d);
  await put(src, 'cloud.js', JSON.stringify({ points: 7 }));
  const same = await verifyExport(d, { source: { src, format: 'potree' } });
  assert.equal(same.points, 7);
  assert.deepEqual(same.pointsByLevel, { 0: 3, 1: 4 });
  assert.equal(same.source.ok, true);
  assert.equal(same.ok, true);

  // Every tile present and valid, three quarters of the points never listed: the case a walk of the folder cannot see.
  await put(src, 'cloud.js', JSON.stringify({ points: 28 }));
  const lost = await verifyExport(d, { source: { src: path.join(src, 'cloud.js') } });
  assert.equal(lost.missing, 0);
  assert.equal(lost.source.missing, 21);
  assert.equal(lost.ok, false);
  assert.match(lost.summary, /declares 28 points, 7 were exported: 75\.0% lost/);

  // A depth limit keeps part of the cloud on purpose.
  const capped = await verifyExport(d, { source: { src, format: 'potree' }, partial: true });
  assert.equal(capped.source.comparable, false);
  assert.equal(capped.ok, true);
});

test('a COPC source declares its total in the LAS header', async (t) => {
  const src = await folder(t), head = Buffer.alloc(375);
  head.write('LASF'); head[24] = 1; head[25] = 4; head.writeBigUInt64LE(1234567890123n, 247);
  await put(src, 'a.copc.laz', head);
  assert.deepEqual(await declaredPoints({ src: path.join(src, 'a.copc.laz') }), { format: 'copc', declared: 1234567890123, from: 'LAS header' });
});

test('a format with no declared total gets a count and no verdict', async (t) => {
  const d = await folder(t);
  await onePointTree(d);
  const v = await verifyExport(d, { source: { src: 'https://example.com/a.rad', format: 'rad' } });
  assert.equal(v.source.available, false);
  assert.equal(v.ok, true);
  assert.equal(v.points, 7);
});

test('only a server wrapper over one dataset has a source', () => {
  assert.deepEqual(sourceOfUrl('http://h/stream/tileset.json?format=potree&url=https%3A%2F%2Fx%2Fcloud.js'), { src: 'https://x/cloud.js', format: 'potree' });
  assert.equal(sourceOfUrl('http://h/aggregate/tileset.json?set=a'), null);
  assert.equal(sourceOfUrl('https://x/tileset.json?url=https%3A%2F%2Fy'), null);
});

test('a truncated tile or an error page saved as a tile is damaged, whichever the mode', async (t) => {
  const d = await folder(t);
  await onePointTree(d);
  const whole = await glb(3);
  await put(d, 'a.glb', whole.subarray(0, whole.length - 4));
  await put(d, 'b.glb', '<html>503</html>');
  const v = await verifyExport(d, { mode: 'counts' });
  assert.equal(v.ok, false);
  assert.equal(v.badTiles, 2);
});

test('reading a tile in full finds what its header cannot', async (t) => {
  const d = await folder(t);
  await onePointTree(d);
  // Same length, a position overwritten with NaN.
  const b = Buffer.from(await glb(4));
  const jsonLength = b.readUInt32LE(12);
  b.writeFloatLE(NaN, 20 + jsonLength + 8);
  assert.match(checkGlb(b), /not a finite number/);
  await put(d, 'b.glb', b);
  assert.equal((await verifyExport(d, { mode: 'counts' })).ok, true);
  const full = await verifyExport(d, { mode: 'full' });
  assert.equal(full.ok, false);
  assert.equal(full.deepChecked, 2);
  assert.equal(full.badFiles[0].file, 'b.glb');
  assert.equal((await verifyExport(d, { mode: 'sample' })).ok, false);
});

test('off skips the check', async (t) => {
  const v = await verifyExport(await folder(t), { mode: 'off' });
  assert.deepEqual(v, { mode: 'off', ok: true, skipped: true });
});

test('a tileset with no content at all does not pass, unless a depth limit explains it', async (t) => {
  const d = await folder(t);
  await put(d, 'tileset.json', JSON.stringify({ root: { boundingVolume: box, geometricError: 1 } }));
  assert.equal((await verifyExport(d)).ok, false);
  assert.equal((await verifyExport(d, { partial: true })).ok, true);
});

test('a Potree 1.4 cloud.js has no total, but its inline hierarchy gives one', async (t) => {
  const src = await folder(t);
  await put(src, 'cloud.js', JSON.stringify({ version: '1.4', hierarchy: [['r', 5], ['r0', 2]] }));
  assert.deepEqual(await declaredPoints({ src, format: 'potree' }), { format: 'potree', declared: 7, from: 'cloud.js hierarchy' });
});

// An implicit tileset whose only child subtree keeps failing, served as a plain host would.
async function implicitSource(t, childStatus) {
  const subtree = (children) => {
    const json = JSON.stringify({
      buffers: [{ byteLength: 8 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 8 }],
      tileAvailability: { constant: 1 }, contentAvailability: [{ constant: 1 }],
      childSubtreeAvailability: children ? { bitstream: 0 } : { constant: 0 },
    }).padEnd(256);
    const head = Buffer.alloc(24); head.write('subt'); head.writeUInt32LE(1, 4); head.writeBigUInt64LE(BigInt(json.length), 8); head.writeBigUInt64LE(8n, 16);
    const bits = Buffer.alloc(8); bits[0] = children ? 1 : 0;
    return Buffer.concat([head, Buffer.from(json), bits]);
  };
  const tile = await glb();
  const server = http.createServer((req, res) => {
    if (req.url === '/tileset.json') {
      res.end(JSON.stringify({ asset: { version: '1.1' }, geometricError: 1, root: { boundingVolume: box, geometricError: 1, refine: 'ADD',
        content: { uri: 't/{level}-{x}-{y}-{z}.glb' }, implicitTiling: { subdivisionScheme: 'OCTREE', subtreeLevels: 1, availableLevels: 2, subtrees: { uri: 's/{level}-{x}-{y}-{z}.subtree' } } } }));
    } else if (req.url === '/s/0-0-0-0.subtree') res.end(subtree(true));
    else if (req.url.startsWith('/s/')) { res.writeHead(childStatus); res.end(); }
    else if (req.url.startsWith('/t/')) res.end(tile);
    else { res.writeHead(404); res.end(); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}/tileset.json`;
}

test('a part of the hierarchy that cannot be read stops the export, or is listed with the flag', async (t) => {
  const url = await implicitSource(t, 503);
  await assert.rejects(exportTileset(url, await folder(t)), /Part of the hierarchy could not be read/);
  const r = await exportTileset(url, await folder(t), { hierarchyErrors: 'warn' });
  assert.equal(r.hierarchyFailures.length, 1);
  assert.match(r.verify.summary, /1 part of the hierarchy could not be read/);
});

test('a subtree the host says is not there is listed, and does not stop the export', async (t) => {
  const r = await exportTileset(await implicitSource(t, 404), await folder(t));
  assert.equal(r.hierarchyFailures.length, 1);
  assert.equal(r.hierarchyFailures[0].status, 404);
});

test('an export reports its steps, in order, for a bar in that many blocks', async (t) => {
  const seen = [];
  await exportTileset(await implicitSource(t, 404), await folder(t), { onProgress: (p) => { if (seen.at(-1) !== p.step) seen.push(p.step); assert.equal(p.steps, 3); } });
  assert.deepEqual(seen, [1, 2, 3]);
});
