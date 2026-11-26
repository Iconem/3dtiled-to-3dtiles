// A remote .3dtiles (SQLite) is read by byte ranges, a few pages per tile, never downloaded whole; a host that ignores
// Range is refused (sqlite-http.js, and the /3dtiles-self-contained handler on top).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { handleSelfContained } from './3dtiles-self-contained.js';
import { queryRemoteSqlite, closeRemoteSqlite } from './sqlite-http.js';

after(() => closeRemoteSqlite());

// 40 tiles of 60 KB each and a tileset.json: about 2.4 MB, 4096-byte pages (sql.js's default)
const TILES = Array.from({ length: 40 }, (_, i) => Buffer.from(Array.from({ length: 60_000 }, (_, j) => (i * 7 + j) % 251)));
const TILESET = { asset: { version: '1.1' }, geometricError: 10, root: { geometricError: 0, boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }, content: { uri: 'tiles/3.glb' } } };
async function makeDb() {
  const { default: initSqlJs } = await import('sql.js');
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE media (key TEXT PRIMARY KEY, content BLOB)');
  db.run('INSERT INTO media VALUES (?, ?)', ['tileset.json', new Uint8Array(Buffer.from(JSON.stringify(TILESET)))]);
  TILES.forEach((b, i) => db.run('INSERT INTO media VALUES (?, ?)', [`tiles/${i}.glb`, new Uint8Array(b)]));
  const out = Buffer.from(db.export());
  db.close();
  return out;
}
const FILE = await makeDb();

/** A host of the file at /a.3dtiles; `ignoreRange` answers every GET with the whole file, as a host without Range does,
 *  `honoured` ranges first if given. */
async function host(t, { ignoreRange = false, honoured = 0 } = {}) {
  const log = { requests: [], bytes: 0 };
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith('/a.3dtiles')) { res.writeHead(404); return res.end('nf'); }
    log.requests.push(req.headers.range || 'whole');
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (m && (!ignoreRange || log.requests.length <= honoured)) {
      const a = Number(m[1]), b = Math.min(Number(m[2]), FILE.length - 1);
      log.bytes += b - a + 1;
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${FILE.length}`, 'Content-Length': b - a + 1 });
      return res.end(FILE.subarray(a, b + 1));
    }
    res.writeHead(200, { 'Content-Length': FILE.length });
    res.end(FILE);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${server.address().port}`, log };
}

/** One GET of the /3dtiles-self-contained handler → { status, body }; a thrown error as the server answers it. */
function get(key, pkg) {
  return new Promise((resolve, reject) => {
    let status;
    const res = { headersSent: false, writeHead(s) { status = s; this.headersSent = true; }, end(b) { resolve({ status, body: Buffer.from(b ?? '') }); } };
    handleSelfContained({}, res, new URL(`http://x/3dtiles-self-contained/${key}?url=${encodeURIComponent(pkg)}`)).catch(reject);
  });
}

test('a remote .3dtiles is read by ranges: the tileset and a tile for a small part of the file', async (t) => {
  const h = await host(t);
  // a query (a presigned URL, a few KB long) passes SQLite's own URI parsing and file name limits
  const pkg = `${h.base}/a.3dtiles?token=x%2Fy&X-Amz-Signature=${'a1'.repeat(1200)}`;
  const ts = await get('tileset.json', pkg);
  assert.equal(ts.status, 200);
  assert.equal(JSON.parse(ts.body).root.content.uri, `/3dtiles-self-contained/tiles/3.glb?url=${encodeURIComponent(pkg)}`);
  const tile = await get('tiles/3.glb', pkg);
  assert.equal(tile.status, 200);
  assert.ok(tile.body.equals(TILES[3]), 'the tile, byte for byte');
  assert.ok(h.log.requests.every((r) => /^bytes=\d+-\d+$/.test(r)), `only plain ranges: ${h.log.requests}`);
  assert.ok(h.log.bytes < FILE.length / 8, `read ${h.log.bytes} bytes of ${FILE.length}`);
  assert.equal((await get('tiles/none.glb', pkg)).status, 404);
  // in parallel, on the connections, each its own bytes
  const many = await Promise.all([10, 20, 30, 39].map((i) => get(`tiles/${i}.glb`, pkg)));
  many.forEach((r, k) => assert.ok(r.body.equals(TILES[[10, 20, 30, 39][k]]), `tile ${[10, 20, 30, 39][k]}`));
  assert.ok(h.log.bytes < FILE.length / 2, `read ${h.log.bytes} bytes of ${FILE.length} for six tiles of forty`);
});

test('a host that ignores Range is refused, not downloaded', async (t) => {
  const h = await host(t, { ignoreRange: true });
  await assert.rejects(queryRemoteSqlite(`${h.base}/a.3dtiles`, 'SELECT content FROM media WHERE key = ?', ['tileset.json']),
    (e) => e.rangeIgnored === true && /ignores Range/.test(e.message));
  assert.ok(!h.log.requests.includes('whole'), 'no request without a range');
});

test('a host that stops honouring Range after the first read is refused by the page reads too', async (t) => {
  const h = await host(t, { ignoreRange: true, honoured: 1 });
  await assert.rejects(queryRemoteSqlite(`${h.base}/a.3dtiles?late`, 'SELECT content FROM media WHERE key = ?', ['tileset.json']));
  assert.ok(h.log.requests.length > 1 && !h.log.requests.includes('whole'), `${h.log.requests}`);
});

test('a file the host lacks is a 404, one that is not SQLite is refused', async (t) => {
  const h = await host(t);
  await assert.rejects(queryRemoteSqlite(`${h.base}/missing.3dtiles`, 'SELECT 1'), (e) => e.status === 404);
  const notSqlite = http.createServer((req, res) => { const b = Buffer.alloc(4096, 1); res.writeHead(206, { 'Content-Range': `bytes 0-99/4096` }); res.end(b.subarray(0, 100)); });
  notSqlite.listen(0, '127.0.0.1');
  await once(notSqlite, 'listening');
  t.after(() => new Promise((r) => { notSqlite.close(r); notSqlite.closeAllConnections(); }));
  await assert.rejects(queryRemoteSqlite(`http://127.0.0.1:${notSqlite.address().port}/b.3dtiles`, 'SELECT 1'), /not an SQLite file/);
});
