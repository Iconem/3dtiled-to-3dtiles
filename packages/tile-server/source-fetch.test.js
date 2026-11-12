// core/source-fetch.js: a host whose answers fetch refuses (obsolete header line folding, as pdmap.pland.gov.hk sends) is
// read with Node's lenient client from the first failure on; and core/zip.js over such a host and over a file.
// The fixture folds a header like that host does and also puts a control character in it: undici's parser has come to
// tolerate the folding (Node 22.22, undici 6.24) but refuses the control character on every version, while Node's own
// client with `insecureHTTPParser` reads both, so the fallback is exercised whatever Node runs the tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetchSource, fetchSourceRange, isLenientHost, openZip, writeZip } from '../core/index.js';

const quiet = (t) => { t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); };

/** A raw HTTP/1.1 server that folds a long header over two lines (with a control character in it) and honours Range. */
async function foldedServer(t, files) {
  let requests = 0;
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buf.slice(0, end); buf = buf.slice(end + 4);
      requests++;
      const [, , p] = /^(\w+) (\S+)/.exec(head), range = /\r\nRange: bytes=(\d*)-(\d*)/i.exec(head);
      const body = files[decodeURIComponent(p.split('?')[0].slice(1))];
      const folded = 'Content-Security-Policy: default-src \'none\';\r\n\t\timg-src \'self\' data:;\x01\r\n';
      if (!body) { sock.write(`HTTP/1.1 404 Not Found\r\n${folded}Content-Length: 0\r\nConnection: close\r\n\r\n`); return; }
      if (range) {
        const a = range[1] === '' ? Math.max(0, body.length - Number(range[2])) : Number(range[1]);
        const b = range[1] === '' ? body.length - 1 : range[2] === '' ? body.length - 1 : Math.min(Number(range[2]), body.length - 1);
        const part = body.subarray(a, b + 1);
        sock.write(`HTTP/1.1 206 Partial Content\r\n${folded}Accept-Ranges: bytes\r\nContent-Range: bytes ${a}-${b}/${body.length}\r\nContent-Length: ${part.length}\r\nConnection: close\r\n\r\n`);
        sock.end(part);
      } else { sock.write(`HTTP/1.1 200 OK\r\n${folded}Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`); sock.end(body); }
    });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => server.close(r)));
  return { base: `http://127.0.0.1:${server.address().port}`, host: `127.0.0.1:${server.address().port}`, count: () => requests };
}

test('source-fetch: a host that folds its headers is read with the lenient client, from the first failure on', async (t) => {
  quiet(t);
  const h = await foldedServer(t, { 'a.bin': Buffer.from('hello, folded world') });
  assert.equal(isLenientHost(h.host), false);
  assert.equal((await fetchSource(`${h.base}/a.bin`)).toString(), 'hello, folded world');
  assert.equal(isLenientHost(h.host), true);
  assert.equal(h.count(), 2, 'one refused answer, one lenient read');
  assert.equal((await fetchSourceRange(`${h.base}/a.bin`, 7, 6)).toString(), 'folded');
  assert.equal(h.count(), 3, 'read the lenient way at once');
  await assert.rejects(fetchSource(`${h.base}/none.bin`), (e) => e.status === 404);
});

const MEMBERS = { 'tile/': Buffer.alloc(0), 'tile/metadata.xml': Buffer.from('<SRS>EPSG:2326</SRS>'), 'tile/Data/root.osgb': Buffer.from('OSGB'.repeat(5000)), 'tile/Data/leaf.osgb': Buffer.alloc(300, 7) };

test('zip: members by name over range requests, deflated and stored, from a folded host and from a file', async (t) => {
  quiet(t);
  for (const store of [false, true]) {
    const bytes = writeZip(MEMBERS, { store });
    const h = await foldedServer(t, { 'tile.zip': bytes });
    const zip = await openZip(`${h.base}/tile.zip`);
    assert.deepEqual([zip.size, zip.names], [bytes.length, Object.keys(MEMBERS)]);
    assert.equal(zip.entries.get('tile/Data/root.osgb').method, store ? 0 : 8);
    assert.equal((await zip.read('tile/Data/root.osgb')).toString(), 'OSGB'.repeat(5000));
    assert.deepEqual([...(await zip.read('tile/Data/leaf.osgb')).subarray(0, 3)], [7, 7, 7]);
    assert.equal(await zip.read('tile/'), null, 'a folder entry');
    assert.equal(await zip.read('tile/Data/none.osgb'), null, 'a name the archive lacks');
    assert.equal(h.count(), 2 + 2, 'the tail (refused, then lenient) holds the central directory of a small archive; then one request per member read');
    const dir = await mkdtemp(path.join(tmpdir(), 'zip-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(path.join(dir, 't.zip'), bytes);
    const local = await openZip(path.join(dir, 't.zip'));
    assert.equal((await local.read('tile/metadata.xml')).toString(), '<SRS>EPSG:2326</SRS>');
    await local.close();
  }
});
