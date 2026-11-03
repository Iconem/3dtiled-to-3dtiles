import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSubtreeBuffer, loadSubtree, parseSubtreeBuffer } from '../core/index.js';
import { buildExplicitFromUrl } from '../implicit-to-explicit/index.js';
import { collectStats } from './stats-live.js';
import { exportTileset } from './export-live.js';

// Two levels of subtrees over the same nodes, in the three encodings a tileset can use.
const NODES = new Set(['0-0-0-0', '1-0-0-0', '1-1-1-1', '2-0-0-0', '2-3-3-3']);
const BIN = { '0-0-0-0': buildSubtreeBuffer('0-0-0-0', NODES, 2), '2-0-0-0': buildSubtreeBuffer('2-0-0-0', NODES, 2), '2-3-3-3': buildSubtreeBuffer('2-3-3-3', NODES, 2) };

/** The same subtree as JSON, with its availability in an external .bin next to it. */
function asJson(key) {
  const b = BIN[key];
  const jsonLen = Number(b.readBigUInt64LE(8));
  const json = JSON.parse(b.toString('utf8', 24, 24 + jsonLen));
  json.buffers[0].uri = `${key}.bin`;
  return { json: JSON.stringify(json), bin: b.subarray(24 + jsonLen) };
}

const tilesetFor = (subtrees) => JSON.stringify({
  asset: { version: '1.1' }, geometricError: 100,
  root: {
    boundingVolume: { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] }, geometricError: 50, refine: 'REPLACE',
    content: { uri: 'tiles/{level}/{x}/{y}/{z}.glb' },
    implicitTiling: { subdivisionScheme: 'OCTREE', subtreeLevels: 2, availableLevels: 4, subtrees: { uri: subtrees } },
  },
});

async function serve(t, files) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    requests.push(p);
    const body = files[p] ?? (p.endsWith('.glb') ? 'glTF' : null);
    if (body == null) { res.writeHead(404); res.end(); return; }
    res.writeHead(200); res.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  t.mock.method(console, 'log', () => {});
  return { base: `http://127.0.0.1:${server.address().port}`, requests };
}

function binaryFiles() {
  const files = { '/b/tileset.json': tilesetFor('subtrees/{level}.{x}.{y}.{z}.subtree') };
  for (const [key, b] of Object.entries(BIN)) files[`/b/subtrees/${key.replaceAll('-', '.')}.subtree`] = b;
  return files;
}
function jsonFiles() {
  const files = { '/j/tileset.json': tilesetFor('subtrees/{level}/{x}/{y}/{z}/subtree.json') };
  for (const key of Object.keys(BIN)) {
    const { json, bin } = asJson(key);
    const dir = `/j/subtrees/${key.replaceAll('-', '/')}`;
    files[`${dir}/subtree.json`] = json;
    files[`${dir}/${key}.bin`] = bin;
  }
  return files;
}

test('a JSON subtree reads like the binary one, through its external buffer', async () => {
  const { json, bin } = asJson('0-0-0-0');
  const a = await loadSubtree(Buffer.from(json), async (uri) => { assert.equal(uri, '0-0-0-0.bin'); return bin; });
  const b = parseSubtreeBuffer(BIN['0-0-0-0']);
  for (let i = 0; i < 9; i++) { assert.equal(a.tileBit(i), b.tileBit(i)); assert.equal(a.contentBit(i), b.contentBit(i)); }
  for (let i = 0; i < 64; i++) assert.equal(a.childBit(i), b.childBit(i));
  assert.deepEqual(a.bufferUris, ['0-0-0-0.bin']);
});

test('a JSON subtree of constants needs no buffer', async () => {
  const s = await loadSubtree(Buffer.from(JSON.stringify({ tileAvailability: { constant: 1 }, contentAvailability: [{ constant: 0 }], childSubtreeAvailability: { constant: 0 } })),
    () => { throw new Error('nothing to fetch'); });
  assert.equal(s.tileBit(5), 1);
  assert.equal(s.contentBit(5), 0);
  assert.deepEqual(s.bufferUris, []);
});

test('bytes that are neither encoding are refused', async () => {
  await assert.rejects(loadSubtree(Buffer.from('<html>nope'), async () => null), /not a subtree/);
});

test('implicit-to-explicit and stats agree on binary and JSON subtrees', async (t) => {
  const { base } = await serve(t, { ...binaryFiles(), ...jsonFiles() });
  const b = await buildExplicitFromUrl(`${base}/b/tileset.json`);
  const j = await buildExplicitFromUrl(`${base}/j/tileset.json`);
  assert.deepEqual([...j.avail].sort(), [...b.avail].sort());
  assert.deepEqual([...j.content].sort(), [...b.content].sort());
  assert.deepEqual([...b.avail].sort(), [...NODES].sort());
  assert.equal(b.buffers.size, 0);
  assert.equal(j.buffers.size, 3);

  const sb = await collectStats(`${base}/b/tileset.json`);
  const sj = await collectStats(`${base}/j/tileset.json`);
  assert.equal(sj.totalNodes, sb.totalNodes);
  assert.ok(sj.totalNodes >= NODES.size);
});

test('an implicit export keeps JSON subtrees JSON, with their buffers beside them', async (t) => {
  const { base } = await serve(t, jsonFiles());
  const out = await mkdtemp(path.join(tmpdir(), 'subtree-json-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  await exportTileset(`${base}/j/tileset.json`, out, { keepImplicit: true });
  const ts = JSON.parse(await readFile(path.join(out, 'tileset.json'), 'utf8'));
  const tpl = ts.root.implicitTiling.subtrees.uri;
  assert.match(tpl, /\{level\}\/\{x\}\/\{y\}\/\{z\}\/subtree\.json$/);
  const rel = tpl.replace('{level}', 0).replace('{x}', 0).replace('{y}', 0).replace('{z}', 0);
  const json = await readFile(path.join(out, rel));
  const bin = await readFile(path.join(out, path.dirname(rel), '0-0-0-0.bin'));
  const s = parseSubtreeBuffer(json, [bin]);
  assert.equal(s.tileBit(0), 1);

  // and the folder reads back as a tileset
  const { base: copy } = await serve(t, await readFolderAsFiles(out));
  const again = await buildExplicitFromUrl(`${copy}/tileset.json`);
  assert.deepEqual([...again.avail].sort(), [...NODES].sort());
});

test('a binary implicit export is still flat .subtree files', async (t) => {
  const { base } = await serve(t, binaryFiles());
  const out = await mkdtemp(path.join(tmpdir(), 'subtree-bin-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  await exportTileset(`${base}/b/tileset.json`, out, { keepImplicit: true });
  const ts = JSON.parse(await readFile(path.join(out, 'tileset.json'), 'utf8'));
  assert.match(ts.root.implicitTiling.subtrees.uri, /\{level\}-\{x\}-\{y\}-\{z\}\.subtree$/);
});

async function readFolderAsFiles(dir) {
  const { readdir } = await import('node:fs/promises');
  const files = {};
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const abs = path.join(e.parentPath ?? e.path, e.name);
    files[`/${path.relative(dir, abs).replaceAll('\\', '/')}`] = await readFile(abs);
  }
  return files;
}
