// What every source format owes a client, tested on all of them: a read that fails once is retried, a read that keeps failing
// is an error and not an empty answer, a file the source lacks is a 404, and a healed host works again.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSource, fetchSourceRange, httpStatusOf, hostLimit, memoizeAsync, buildSubtreeBuffer } from '../core/index.js';
import { handleStream } from './stream-live.js';
import { exportTileset } from './export-live.js';

const quiet = (t) => { t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); };

/** A host serving `files` (path → Buffer | object), honouring Range unless `noRange`. `fail(path, req)` may answer with a status instead. */
async function host(t, files, { fail, noRange } = {}) {
  const hits = {};
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    hits[p] = (hits[p] ?? 0) + 1;
    const status = fail?.(p, req, hits[p]);
    if (status) { res.writeHead(status); return res.end('{"error":"not data"}'); }
    let body = files[p];
    if (body === undefined) { res.writeHead(404); return res.end(); }
    if (!Buffer.isBuffer(body)) body = Buffer.from(JSON.stringify(body));
    const m = !noRange && req.headers.range?.match(/bytes=(\d+)-(\d+)/);
    if (m) {
      const [b, e] = [Number(m[1]), Math.min(Number(m[2]), body.length - 1)];
      res.writeHead(206, { 'Content-Range': `bytes ${b}-${e}/${body.length}` });
      return res.end(body.subarray(b, e + 1));
    }
    res.end(body);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${server.address().port}`, hits };
}

/** The /stream route behind the same error mapping as server.js. */
async function streamServer(t) {
  const server = http.createServer(async (req, res) => {
    try { if (!await handleStream(req, res, new URL(req.url, 'http://x'))) { res.writeHead(404); res.end(); } }
    catch (e) { res.writeHead(httpStatusOf(e)); res.end(String(e.message)); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const get = async (url) => { const r = await fetch(url); return { status: r.status, body: Buffer.from(await r.arrayBuffer()) }; };

// ── the read layer ───────────────────────────────────────────────────────────────────────────────

test('a source read retries a 503 and a 429, and gets the file', async (t) => {
  quiet(t);
  for (const status of [503, 429]) {
    const h = await host(t, { '/f': Buffer.from('data') }, { fail: (p, q, n) => (n === 1 ? status : 0) });
    assert.equal((await fetchSource(`${h.base}/f`)).toString(), 'data');
    assert.equal(h.hits['/f'], 2);
  }
});

test('a source read does not retry a 404, and marks what a retry might fix', async (t) => {
  quiet(t);
  const h = await host(t, {}, { fail: (p) => (p === '/busy' ? 503 : 0) });
  await assert.rejects(fetchSource(`${h.base}/none`), (e) => e.status === 404 && !e.transient);
  assert.equal(h.hits['/none'], 1);
  await assert.rejects(fetchSource(`${h.base}/busy`), (e) => e.status === 503 && e.transient);
  assert.equal(h.hits['/busy'], 3);
});

test('a dropped connection is retried like a 503', async (t) => {
  quiet(t);
  let n = 0;
  const server = http.createServer((req, res) => { if (++n === 1) return req.socket.destroy(); res.end('data'); }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  assert.equal((await fetchSource(`http://127.0.0.1:${server.address().port}/f`)).toString(), 'data');
});

test('a range read returns the bytes asked for, from a host that ignores Range too', async (t) => {
  const h = await host(t, { '/f': Buffer.from('0123456789') }, { noRange: true });
  assert.equal((await fetchSourceRange(`${h.base}/f`, 3, 4)).toString(), '3456');
});

test('reads to one host are capped, however many are asked for', async (t) => {
  let active = 0, peak = 0;
  const server = http.createServer((req, res) => { peak = Math.max(peak, ++active); setTimeout(() => { active--; res.end('x'); }, 20); }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  await Promise.all(Array.from({ length: 200 }, (_, i) => fetchSource(`http://127.0.0.1:${server.address().port}/${i}`)));
  assert.ok(peak <= 32, `peak ${peak}`);
});

test('a host that fails under load is given fewer requests at a time, and gets them back as reads pass', async (t) => {
  quiet(t);
  let active = 0, peak = 0, failures = 0;
  const server = http.createServer((req, res) => {
    peak = Math.max(peak, ++active);
    setTimeout(() => { active--; if (req.url.startsWith('/busy') && Math.random() < 0.5) { failures++; res.writeHead(503); return res.end(); } res.end('x'); }, 5);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const host = `127.0.0.1:${server.address().port}`;
  assert.equal(hostLimit(host), 32);
  await Promise.allSettled(Array.from({ length: 120 }, (_, i) => fetchSource(`http://${host}/busy/${i}`)));
  assert.ok(failures > 0);
  assert.ok(hostLimit(host) < 32, `cap ${hostLimit(host)} after failures`);
  assert.ok(hostLimit(host) >= 4);
  const lowered = hostLimit(host);
  peak = 0;
  await Promise.all(Array.from({ length: 200 }, (_, i) => fetchSource(`http://${host}/ok/${i}`)));
  assert.ok(hostLimit(host) > lowered, `cap ${hostLimit(host)} climbed back from ${lowered}`);
});

test('a failed build is not remembered for ever', async () => {
  let calls = 0;
  const load = memoizeAsync(async () => { if (++calls === 1) throw new Error('hung up'); return 'ok'; }, { failureTtlMs: 5 });
  await assert.rejects(load('k'));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await load('k'), 'ok');
});

test('every format reads its source through the shared layer', async () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  for (const f of ['copc-live', 'potree-live', 'sog-live', 'lcc-live', 'lcc2-live', 'rad-live', 'i3s-live', 'threemx-live', 'geosplats-live', 'remote-zip', 'range-getter', '3dtiles-self-contained', 'export-live']) {
    const code = (await readFile(path.join(dir, `${f}.js`), 'utf8')).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.ok(!/(^|[^.\w])fetch\(/m.test(code), `${f}.js calls fetch itself`);
  }
});

// ── the formats ──────────────────────────────────────────────────────────────────────────────────

const box = { min: [0, 0, 0], max: [1, 1, 1] };
const lcc = (points) => {
  const index = Buffer.alloc(4 + 16);                      // one unit, one level
  index.writeUInt32LE(points, 4); index.writeBigUInt64LE(32n, 8); index.writeUInt32LE(points * 32, 16);
  return {
    '/meta.lcc': { attributes: [{ name: 'scale', min: [0, 0, 0], max: [1, 1, 1] }], indexDataSize: 20, cellLengthX: 1, cellLengthY: 1, boundingBox: box },
    '/index.bin': index,
    '/data.bin': Buffer.alloc(32 + points * 32, 1),
  };
};
const threemxb = (nodes) => {
  const json = Buffer.from(JSON.stringify({ nodes, resources: [] }));
  const head = Buffer.alloc(9); head.write('3MXBO', 'latin1'); head.writeUInt32LE(json.length, 5);
  return Buffer.concat([head, json]);
};
const i3sNode = (index, children = []) => ({ index, obb: { center: [0, 0, 0], halfSize: [1, 1, 1], quaternion: [0, 0, 0, 1] }, children, mesh: { geometry: { resource: index } } });
const i3sLayer = { layerType: 'IntegratedMesh', nodePages: { nodesPerPage: 2 }, geometryDefinitions: [{ geometryBuffers: [{ offset: 8 }] }], store: { version: '2.0' } };

// format → its smallest source: the file a tileset read needs, and the one a tile read needs
const FORMATS = {
  sog: { files: { '/lod-meta.json': { filenames: ['a/meta.json'], tree: { bound: box, lods: { 0: { file: 0, offset: 0, count: 1 } } } } }, root: '/lod-meta.json', tile: '0_0_1', tileFile: '/a/meta.json' },
  lcc: { files: lcc(2), root: '/meta.lcc', tile: '32_64_2', tileFile: '/data.bin' },
  lcc2: { files: { '/a.lcc2': { totalLevels: 1, root: { boundingBox: box, splatFiles: ['data/3dgs/a.sog'], child: { 0: { boundingBox: box, data: { '3dgs': { name: 0, start: 0, count: 1 } } } } } } }, root: '/a.lcc2', tile: '0_0_1', tileFile: '/data/3dgs/a.sog' },
  threemx: { files: { '/root.3mxb': threemxb([{ bbMin: [0, 0, 0], bbMax: [1, 1, 1], maxScreenDiameter: 1, children: [], resources: ['g'] }]) }, root: '/root.3mxb', tile: `${encodeURIComponent('root.3mxb')}__0`, tileFile: '/root.3mxb', sharedFile: true },
  i3s: { files: { '/3dSceneLayer.json': i3sLayer, '/nodepages/0.json': { nodes: [i3sNode(0)] } }, root: '/3dSceneLayer.json', tile: '0', tileFile: '/nodes/0/geometries/0.bin', probeFiles: ['/nodes/0/geometries/0.bin.gz'] },
  copc: { root: '/a.copc.laz', files: { '/a.copc.laz': Buffer.alloc(16) } },
  potree: { root: '/metadata.json', files: { '/metadata.json': {} } },
  rad: { root: '/a.rad', files: { '/a.rad': Buffer.alloc(16) } },
};

for (const [fmt, { files, root }] of Object.entries(FORMATS)) {
  test(`${fmt}: a tileset whose first file keeps failing is an error, never an empty answer`, async (t) => {
    quiet(t);
    const h = await host(t, files, { fail: (p) => (p === root ? 503 : 0) });
    const s = await streamServer(t);
    const r = await get(`${s}/stream/tileset.json?format=${fmt}&url=${encodeURIComponent(h.base + root)}`);
    assert.equal(r.status, 502);
    assert.equal(h.hits[root], 3, 'three tries');
  });
  test(`${fmt}: a source that is not there is a 404`, async (t) => {
    quiet(t);
    const h = await host(t, {});
    const s = await streamServer(t);
    assert.equal((await get(`${s}/stream/tileset.json?format=${fmt}&url=${encodeURIComponent(h.base + root)}`)).status, 404);
  });
}

for (const [fmt, { files, root, tile, tileFile, sharedFile }] of Object.entries(FORMATS)) {
  if (!tile) continue;
  test(`${fmt}: a tileset read survives each file failing once`, async (t) => {
    quiet(t);
    const h = await host(t, files, { fail: (p, q, n) => (n === 1 ? 503 : 0) });
    const s = await streamServer(t);
    const r = await get(`${s}/stream/tileset.json?format=${fmt}&url=${encodeURIComponent(h.base + root)}`);
    assert.equal(r.status, 200);
    assert.ok(JSON.parse(r.body).root);
  });
  if (sharedFile) continue;
  test(`${fmt}: a tile whose data keeps failing is an error, never an empty tile`, async (t) => {
    quiet(t);
    let down = true;
    const h = await host(t, files, { fail: (p) => (down && p.startsWith(path.posix.dirname(tileFile)) && p !== root ? 503 : 0) });
    const s = await streamServer(t);
    const q = `format=${fmt}&url=${encodeURIComponent(h.base + root)}`;
    down = false;                                          // the tree first: LCC reads index.bin beside data.bin
    assert.equal((await get(`${s}/stream/tileset.json?${q}`)).status, 200);
    down = true;
    assert.equal((await get(`${s}/stream/tile/${tile}.glb?${q}`)).status, 502);
  });
}

test('lcc: a tile is cut from the right bytes on a host that ignores Range', async (t) => {
  quiet(t);
  const f = lcc(2);
  f['/data.bin'] = Buffer.concat([Buffer.alloc(32, 9), Buffer.alloc(64, 1)]);
  const [ranged, plain] = [await host(t, f), await host(t, f, { noRange: true })];
  const s = await streamServer(t);
  const tile = async (h) => (await get(`${s}/stream/tile/32_64_2.glb?format=lcc&url=${encodeURIComponent(`${h.base}/meta.lcc`)}`));
  assert.equal(Buffer.compare((await tile(ranged)).body, (await tile(plain)).body), 0);
});

test('i3s: a node page that fails does not end the pages, and the next read picks up from it', async (t) => {
  quiet(t);
  let down = true;
  const pages = { '/nodepages/0.json': { nodes: [i3sNode(0, [1, 2]), i3sNode(1)] }, '/nodepages/1.json': { nodes: [i3sNode(2, [3]), i3sNode(3)] }, '/nodepages/2.json': { nodes: [i3sNode(4)] } };
  const h = await host(t, { '/3dSceneLayer.json': i3sLayer, ...pages }, { fail: (p) => (down && p.includes('nodepages/1.json') ? 503 : 0) });
  const s = await streamServer(t);
  const q = `format=i3s&url=${encodeURIComponent(`${h.base}/3dSceneLayer.json`)}`;
  assert.equal((await get(`${s}/stream/tileset.json?${q}`)).status, 502, 'not a tree without the page');
  down = false;
  const ts = JSON.parse((await get(`${s}/stream/tileset.json?${q}`)).body);
  const count = (n) => 1 + (n.children ?? []).reduce((a, c) => a + count(c), 0);
  assert.equal(count(ts.root), 4);
  assert.equal(ts.asset.extras, undefined);
});

test('i3s: a node the source really lacks is an empty tile, not an error', async (t) => {
  quiet(t);
  const h = await host(t, FORMATS.i3s.files);
  const s = await streamServer(t);
  const r = await get(`${s}/stream/tile/0.glb?format=i3s&url=${encodeURIComponent(`${h.base}/3dSceneLayer.json`)}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.toString('latin1', 0, 4), 'glTF');
});

// ── the export over any of them ──────────────────────────────────────────────────────────────────

const tmp = async (t) => { const d = await mkdtemp(path.join(tmpdir(), 'contract-')); t.after(() => rm(d, { recursive: true, force: true })); return d; };
const tileset = (extras, uri) => ({ asset: { version: '1.1', ...(extras ? { extras } : {}) }, geometricError: 1, root: { boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }, geometricError: 0, refine: 'ADD', ...(uri ? { content: { uri } } : {}) } });

test('an export asks again for a tree its server says is still partial', async (t) => {
  quiet(t);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/t.glb') return res.end(Buffer.alloc(8));
    res.end(JSON.stringify(u.searchParams.get('cache') === 'hierarchy' ? tileset(null, 't.glb') : tileset({ hierarchyIncomplete: true })));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const r = await exportTileset(`http://127.0.0.1:${server.address().port}/tileset.json`, await tmp(t), { verify: 'off' });
  assert.equal(r.tilesWritten, 1);
});

test('an export of a mosaic that lost a child says so, and stops unless told to carry on', async (t) => {
  quiet(t);
  const h = await host(t, { '/tileset.json': tileset({ failed: [{ url: 'http://dead/x', error: 'fetch failed' }] }, 't.glb'), '/t.glb': Buffer.alloc(8) });
  await assert.rejects(exportTileset(`${h.base}/tileset.json`, await tmp(t), { verify: 'off' }), /could not be read/);
  const r = await exportTileset(`${h.base}/tileset.json`, await tmp(t), { verify: 'off', hierarchyErrors: 'warn' });
  assert.equal(r.hierarchyFailures.length, 1);
  assert.equal(r.tilesWritten, 1);
});

test('an export that keeps implicit tiling downloads tiles while it is still reading the tree, and says how far it is', async (t) => {
  quiet(t);
  // Two subtrees of two levels each; the deeper one is held back until the first tile has been asked for.
  const avail = new Set(['0-0-0-0', '1-0-0-0', '2-0-0-0', '3-0-0-0']);
  const files = {
    '/tileset.json': { asset: { version: '1.1' }, geometricError: 4, root: {
      boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }, geometricError: 2, refine: 'ADD',
      content: { uri: 'tiles/{level}-{x}-{y}-{z}.glb' },
      implicitTiling: { subdivisionScheme: 'OCTREE', subtreeLevels: 2, availableLevels: 4, subtrees: { uri: 'sub/{level}-{x}-{y}-{z}.subtree' } },
    } },
    '/sub/0-0-0-0.subtree': buildSubtreeBuffer('0-0-0-0', avail, 2),
    '/sub/2-0-0-0.subtree': buildSubtreeBuffer('2-0-0-0', avail, 2),
    ...Object.fromEntries([...avail].map((k) => [`/tiles/${k}.glb`, Buffer.from(k)])),
  };
  let tileBeforeTreeRead = false;
  const hits = {};
  const server = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    hits[p] = (hits[p] ?? 0) + 1;
    if (p === '/sub/2-0-0-0.subtree') {
      for (let i = 0; i < 40 && !hits['/tiles/0-0-0-0.glb']; i++) await new Promise((r) => setTimeout(r, 50));
      tileBeforeTreeRead = !!hits['/tiles/0-0-0-0.glb'];
    }
    const body = files[p];
    if (body === undefined) { res.writeHead(404); return res.end(); }
    res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const reading = [];
  const out = await tmp(t);
  const r = await exportTileset(`http://127.0.0.1:${server.address().port}/tileset.json`, out, { verify: 'off', keepImplicit: true,
    onProgress: (p) => { if (p.stepLabel === 'Reading the tree') reading.push(p); } });
  assert.ok(tileBeforeTreeRead, 'the first tile was downloaded while the second subtree was still being read');
  assert.ok(reading.some((p) => p.stepDone >= 1 && p.tilesDiscovered > 0), 'the tree step counts the subtrees read and the files found');
  assert.equal(r.tilesWritten, 6, 'two subtrees and four tiles');
  assert.equal(r.implicitKept, 1);
  const ts = JSON.parse(await readFile(path.join(out, 'tileset.json'), 'utf8'));
  assert.match(ts.root.implicitTiling.subtrees.uri, /^implicit\/[0-9a-f]+\/subtrees\/\{level\}-\{x\}-\{y\}-\{z\}\.subtree$/);
  for (const k of avail) await readFile(path.join(out, 'implicit', ts.root.implicitTiling.subtrees.uri.split('/')[1], 'tiles', `${k}.glb`));
});

