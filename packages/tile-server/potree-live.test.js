import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { potreeTileset, potreeSubtree, potreeTile } from './potree-live.js';
import { parseSubtreeBuffer } from '../core/index.js';
import { loadPotree1 } from '../potree-to-3dtiles/src/potree1.js';

// A private fixture server requires a synthetic Azure container SAS query on every file, including range reads.
async function azureSasSource(t, files) {
  const requests = [];
  t.mock.method(console, 'log', () => {});
  const query = '?sv=2023-11-03&sr=c&sp=r&sig=synthetic%2Bsignature';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ path: url.pathname, query: url.search, range: req.headers.range });
    if (url.search !== query) { res.writeHead(403); res.end('signature required'); return; }
    const body = files[url.pathname];
    if (!body) { res.writeHead(404); res.end(); return; }
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]), end = Math.min(Number(range[2]), body.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${body.length}` });
      res.end(body.subarray(start, end + 1));
    } else { res.writeHead(200); res.end(body); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { root: `http://127.0.0.1:${server.address().port}/cloud/`, query, requests };
}

for (const version of ['1.7', '1.8']) {
  test(`Potree ${version} preserves Azure container SAS for metadata, hierarchy and point nodes`, async (t) => {
    const metadata = {
      version, octreeDir: 'data', hierarchyStepSize: 5, spacing: 1, scale: 0.01,
      boundingBox: { lx: 500000, ly: 0, lz: 0, ux: 500001, uy: 1, uz: 1 },
      pointAttributes: version === '1.7' ? ['POSITION_CARTESIAN', 'RGBA_PACKED']
        : [{ name: 'POSITION_CARTESIAN', size: 12 }, { name: 'RGBA_PACKED', size: 4 }],
    };
    const hierarchy = Buffer.alloc(5);
    hierarchy.writeUInt32LE(1, 1);
    const point = Buffer.alloc(16);
    point.writeUInt32LE(50, 0); point.writeUInt32LE(50, 4); point.writeUInt32LE(50, 8);
    point.set([255, 128, 64, 255], 12);
    const source = await azureSasSource(t, {
      '/cloud/cloud.js': Buffer.from(JSON.stringify(metadata)),
      '/cloud/data/r/r.hrc': hierarchy, '/cloud/data/r/r.bin': point,
    });
    const url = `${source.root}cloud.js${source.query}`;
    const tileset = await potreeTileset(url, { prefetch: 0, crs: 'EPSG:32631' });
    assert.equal(tileset.root.transform.length, 16);
    assert.deepEqual(tileset.root.extras.native.origin, [500000.5, 0.5, 0.5]);
    assert.ok((await potreeSubtree(url, '0-0-0-0')).length > 0);
    const tile = await potreeTile(url, '0-0-0-0');
    assert.equal(tile.subarray(0, 4).toString(), 'glTF');
    assert.deepEqual(source.requests.map(r => r.path), ['/cloud/cloud.js', '/cloud/data/r/r.hrc', '/cloud/data/r/r.bin']);
    assert.ok(source.requests.every(r => r.query === source.query));
  });
}

test('Potree 1.x: a leaf the hierarchy counts as 0 points is still streamed, as its file holds them', async (t) => {
  const metadata = {
    version: '1.8', octreeDir: 'data', hierarchyStepSize: 5, spacing: 1, scale: 0.01,
    boundingBox: { lx: 500000, ly: 0, lz: 0, ux: 500001, uy: 1, uz: 1 },
    pointAttributes: [{ name: 'POSITION_CARTESIAN', size: 12 }, { name: 'RGBA_PACKED', size: 4 }],
  };
  const hierarchy = Buffer.alloc(10);
  hierarchy[0] = 1; hierarchy.writeUInt32LE(1, 1);   // the root: one point, child 0
  hierarchy[5] = 0; hierarchy.writeUInt32LE(0, 6);   // child 0: no children, count 0
  const point = Buffer.alloc(16);
  point.set([255, 128, 64, 255], 12);
  const source = await azureSasSource(t, {
    '/cloud/cloud.js': Buffer.from(JSON.stringify(metadata)),
    '/cloud/data/r/r.hrc': hierarchy, '/cloud/data/r/r.bin': point, '/cloud/data/r/r0.bin': point,
  });
  const url = `${source.root}cloud.js${source.query}`;
  await potreeTileset(url, { prefetch: 0, crs: 'EPSG:32631' });
  const { contentBit } = parseSubtreeBuffer(await potreeSubtree(url, '0-0-0-0'));
  assert.equal(contentBit(1), 1, 'child 0 is available');
  const tile = await potreeTile(url, '1-0-0-0');
  assert.equal(tile.subarray(0, 4).toString(), 'glTF');
});

test('Potree 1.x: a chunk read that failed is an error to retry, a chunk that is not there is an empty branch', async () => {
  const cloud = {
    version: '1.8', octreeDir: 'data', hierarchyStepSize: 1, spacing: 1, scale: 0.01,
    boundingBox: { lx: 0, ly: 0, lz: 0, ux: 1, uy: 1, uz: 1 },
    pointAttributes: [{ name: 'POSITION_CARTESIAN', size: 12 }],
  };
  const root = Buffer.alloc(5);
  root[0] = 0b11; root.writeUInt32LE(1, 1);          // the root, with children 0 and 1, each a chunk of its own
  let child = () => { throw Object.assign(new Error('503'), { status: 503 }); };
  const read = async (rel) => {
    if (rel === 'cloud.js') return Buffer.from(JSON.stringify(cloud));
    if (rel.endsWith('/r.hrc')) return root;
    if (rel.endsWith('/r0.hrc')) return child();
    throw Object.assign(new Error('404'), { status: 404 });
  };
  const src = await loadPotree1('', { read, lazy: true });
  const boundary = await src.loadChunk('r', src.boxOf('r'));
  assert.deepEqual(boundary.map((b) => b.name), ['r0', 'r1']);
  await assert.rejects(src.loadChunk('r0', src.boxOf('r0')), /503/);
  assert.deepEqual(await src.loadChunk('r1', src.boxOf('r1')), []);
  child = () => Buffer.alloc(5);
  assert.deepEqual(await src.loadChunk('r0', src.boxOf('r0')), []);
  assert.ok(src.nodes.has('r0'));
});

// Level 1 of a subtree: Potree's octant numbers are not its morton indices, so count them.
const childrenOf = (buf) => { const { contentBit } = parseSubtreeBuffer(buf); let n = 0; for (let i = 1; i <= 8; i++) n += contentBit(i); return n; };

// A root chunk with two children, each a chunk of its own; `child` answers for child 1's .hrc.
async function twoChunkCloud(t, child) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const cloud = { version: '1.8', octreeDir: 'data', hierarchyStepSize: 1, spacing: 1, scale: 0.01,
    boundingBox: { lx: 500000, ly: 0, lz: 0, ux: 500001, uy: 1, uz: 1 }, pointAttributes: [{ name: 'POSITION_CARTESIAN', size: 12 }] };
  const record = (mask, count) => { const b = Buffer.alloc(5); b[0] = mask; b.writeUInt32LE(count, 1); return b; };
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path.endsWith('/cloud.js')) return res.end(JSON.stringify(cloud));
    if (path.endsWith('/r.hrc')) return res.end(record(0b11, 1));
    if (path.endsWith('/r0.hrc')) return res.end(record(0, 1));
    if (path.endsWith('/r1.hrc')) return child(res, record(0, 1));
    res.writeHead(404); res.end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}/cloud.js`;
}

test('Potree 1.x: a subtree waits for a chunk another request has in flight', async (t) => {
  const url = await twoChunkCloud(t, (res, body) => setTimeout(() => res.end(body), 200));
  await potreeTileset(url, { prefetch: 1, crs: 'EPSG:32631' });   // starts the same chunks in the background
  assert.equal(childrenOf(await potreeSubtree(url, '0-0-0-0')), 2, 'child 1 too, whose chunk was still in flight');
});

test('Potree 1.x: a subtree over a chunk that cannot be read fails, then works once it can', async (t) => {
  let ok = false;
  const url = await twoChunkCloud(t, (res, body) => { if (ok) return res.end(body); res.writeHead(503); res.end(); });
  await potreeTileset(url, { prefetch: 0, crs: 'EPSG:32631' });
  await assert.rejects(potreeSubtree(url, '0-0-0-0'), /503/);
  ok = true;
  assert.equal(childrenOf(await potreeSubtree(url, '0-0-0-0')), 2);
});

test('Potree 2 preserves Azure container SAS for hierarchy and octree range reads', async (t) => {
  const metadata = {
    version: '2.0', encoding: 'DEFAULT', spacing: 1,
    boundingBox: { min: [500000, 0, 0], max: [500001, 1, 1] },
    scale: [0.01, 0.01, 0.01], offset: [500000, 0, 0],
    hierarchy: { firstChunkSize: 22 },
    attributes: [{ name: 'position', size: 12, numElements: 3 }, { name: 'rgba', size: 4, numElements: 4 }],
  };
  const hierarchy = Buffer.alloc(22);
  hierarchy.writeUInt8(1, 0); hierarchy.writeUInt32LE(1, 2); hierarchy.writeBigUInt64LE(16n, 14);
  const point = Buffer.alloc(16);
  point.writeInt32LE(50, 0); point.writeInt32LE(50, 4); point.writeInt32LE(50, 8);
  point.set([255, 128, 64, 255], 12);
  const source = await azureSasSource(t, {
    '/cloud/metadata.json': Buffer.from(JSON.stringify(metadata)),
    '/cloud/hierarchy.bin': hierarchy, '/cloud/octree.bin': point,
  });
  const url = `${source.root}metadata.json${source.query}`;
  const tileset = await potreeTileset(url, { prefetch: 0, crs: 'EPSG:32631' });
  assert.equal(tileset.root.transform.length, 16);
  const tile = await potreeTile(url, '0-0-0-0');
  assert.equal(tile.subarray(0, 4).toString(), 'glTF');
  assert.deepEqual(source.requests.map(r => r.path), ['/cloud/metadata.json', '/cloud/hierarchy.bin', '/cloud/octree.bin']);
  assert.ok(source.requests.every(r => r.query === source.query));
  assert.equal(source.requests[1].range, 'bytes=0-21');
  assert.equal(source.requests[2].range, 'bytes=0-15');
});

// One point and one hierarchy record are enough to exercise the real adapter's HTTP reads.
function queryFixture(version, octreeDir = 'data') {
  const isV2 = version === '2.0';
  const metadata = isV2 ? {
    version, encoding: 'DEFAULT', spacing: 1,
    boundingBox: { min: [0, 0, 0], max: [1, 1, 1] },
    scale: [0.01, 0.01, 0.01], offset: [0, 0, 0],
    hierarchy: { firstChunkSize: 22 },
    attributes: [{ name: 'position', size: 12, numElements: 3 }],
  } : {
    version, octreeDir, hierarchyStepSize: 5, spacing: 1, scale: 0.01,
    boundingBox: { lx: 0, ly: 0, lz: 0, ux: 1, uy: 1, uz: 1 },
    pointAttributes: ['POSITION_CARTESIAN'],
  };
  const hierarchy = Buffer.alloc(isV2 ? 22 : 5);
  if (isV2) {
    hierarchy.writeUInt8(1, 0);
    hierarchy.writeUInt32LE(1, 2);
    hierarchy.writeBigUInt64LE(12n, 14);
  } else hierarchy.writeUInt32LE(1, 1);
  return { metadata, hierarchy, point: Buffer.alloc(12) };
}

const queryCases = [
  ['Azure container SAS', '?sv=2023-11-03&sr=c&sp=r&sig=fixture', true],
  ['Azure account SAS with blob object scope', '?sv=2023-11-03&ss=b&srt=o&sp=r&sig=fixture', true],
  ['Azure account SAS with combined service and resource scopes', '?sv=2023-11-03&ss=bqtf&srt=sco&sp=r&sig=fixture', true],
  ['S3 object signature stays on metadata', '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=fixture', false],
  ['generic query stays on metadata', '?token=metadata&download=1', false],
  ['blob SAS stays on metadata', '?sv=2023-11-03&sr=b&sp=r&sig=fixture', false],
  ['blob version SAS stays on metadata', '?sv=2023-11-03&sr=bv&sp=r&sig=fixture', false],
  ['blob snapshot SAS stays on metadata', '?sv=2023-11-03&sr=bs&sp=r&sig=fixture', false],
  ['directory SAS stays on metadata', '?sv=2023-11-03&sr=d&sdd=1&sp=r&sig=fixture', false],
  ['missing SAS version stays on metadata', '?sr=c&sig=fixture', false],
  ['empty SAS version stays on metadata', '?sv=&sr=c&sig=fixture', false],
  ['missing SAS signature stays on metadata', '?sv=2023-11-03&sr=c', false],
  ['empty SAS signature stays on metadata', '?sv=2023-11-03&sr=c&sig=', false],
  ['account SAS without blob service stays on metadata', '?sv=2023-11-03&ss=qtf&srt=o&sig=fixture', false],
  ['account SAS without object access stays on metadata', '?sv=2023-11-03&ss=b&srt=sc&sig=fixture', false],
  ['account SAS without resource scope stays on metadata', '?sv=2023-11-03&ss=b&sig=fixture', false],
  ['account SAS without service scope stays on metadata', '?sv=2023-11-03&srt=o&sig=fixture', false],
  ['blob scope cannot become account scope', '?sv=2023-11-03&sr=b&ss=b&srt=o&sig=fixture', false],
  ['unsigned public source', '', false],
];

for (const version of ['1.7', '2.0']) {
  for (const [index, [name, query, inherit]] of queryCases.entries()) {
    test(`Potree ${version}: ${name}`, async (t) => {
      const fixture = queryFixture(version);
      const isV2 = version === '2.0';
      const base = `http://fixture.invalid/query-policy/${version}/${index}/`;
      const metadataUrl = `${base}${isV2 ? 'metadata.json' : 'cloud.js'}${query}`;
      const siblingQuery = inherit ? query : '';
      const hierarchyUrl = `${base}${isV2 ? 'hierarchy.bin' : 'data/r/r.hrc'}${siblingQuery}`;
      const pointUrl = `${base}${isV2 ? 'octree.bin' : 'data/r/r.bin'}${siblingQuery}`;
      const requests = [];
      t.mock.method(console, 'log', () => {});
      t.mock.method(globalThis, 'fetch', async (url) => {
        requests.push(url);
        if (url === metadataUrl) return new Response(JSON.stringify(fixture.metadata));
        if (url === hierarchyUrl) return new Response(fixture.hierarchy, { status: isV2 ? 206 : 200 });
        if (url === pointUrl) return new Response(fixture.point, { status: isV2 ? 206 : 200 });
        return new Response(null, { status: 403 });
      });
      await potreeTileset(metadataUrl, { prefetch: 0 });
      assert.equal(parseSubtreeBuffer(await potreeSubtree(metadataUrl, '0-0-0-0')).contentBit(0), 1);
      assert.equal((await potreeTile(metadataUrl, '0-0-0-0')).subarray(0, 4).toString(), 'glTF');
      assert.deepEqual(requests, [metadataUrl, hierarchyUrl, pointUrl]);
    });
  }
}

for (const [name, octreeDir] of [
  ['cross-origin children do not receive metadata SAS', 'http://assets.invalid/data'],
  // A source may expose its node paths through a query-based download endpoint.
  ['a child endpoint keeps its own query', 'http://fixture.invalid/download?token=child&path=data'],
]) {
  test(`Potree 1.7: ${name}`, async (t) => {
    const fixture = queryFixture('1.7', octreeDir);
    const metadataUrl = `http://fixture.invalid/${encodeURIComponent(name)}/cloud.js?sv=2023-11-03&sr=c&sig=parent`;
    const hierarchyUrl = `${octreeDir}/r/r.hrc`;
    const pointUrl = `${octreeDir}/r/r.bin`;
    const requests = [];
    t.mock.method(console, 'log', () => {});
    t.mock.method(globalThis, 'fetch', async (url) => {
      requests.push(url);
      if (url === metadataUrl) return new Response(JSON.stringify(fixture.metadata));
      if (url === hierarchyUrl) return new Response(fixture.hierarchy);
      if (url === pointUrl) return new Response(fixture.point);
      return new Response(null, { status: 403 });
    });
    await potreeTileset(metadataUrl, { prefetch: 0 });
    await potreeSubtree(metadataUrl, '0-0-0-0');
    assert.equal((await potreeTile(metadataUrl, '0-0-0-0')).subarray(0, 4).toString(), 'glTF');
    assert.deepEqual(requests, [metadataUrl, hierarchyUrl, pointUrl]);
  });
}
