// range-getter.js: reads of one URL issued together are merged into few requests, each caller given its own bytes; the
// getter a URL's readers share; the batching window; the counters.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { rangeGetter, sharedRangeGetter, readRange, rangeStats, resetRangeStats } from './range-getter.js';

const FILE = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));

/** A host of one file at /f that records the Range of every request, and answers /f-500 with a 500. */
async function host(t) {
  const ranges = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/f-500') { res.writeHead(500); return res.end('no'); }
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    ranges.push(`${m[1]}-${m[2]}`);
    const a = Number(m[1]), b = Math.min(Number(m[2]), FILE.length - 1);
    res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${FILE.length}` });
    res.end(FILE.subarray(a, b + 1));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}/f`, bad: `http://127.0.0.1:${server.address().port}/f-500`, ranges };
}
const same = (buf, begin, end) => Buffer.compare(Buffer.from(buf), FILE.subarray(begin, end)) === 0;

test('range-getter: reads of one tick are merged across gaps up to `gap`, capped at `maxBytes`, each given its own bytes', async (t) => {
  const h = await host(t);
  const get = rangeGetter(h.url, { gap: 1000, maxBytes: 100_000 });
  const reads = [[10, 20], [500, 1500], [1400, 1600], [2600, 2700], [5000, 5100], [120_000, 180_000], [200_000, 201_000]];
  const bufs = await Promise.all(reads.map(([a, b]) => get(a, b)));
  reads.forEach(([a, b], i) => assert.ok(same(bufs[i], a, b), `read ${a}-${b}`));
  // 10..2700 is one group (holes of 480, an overlap, 1000); 5000 is 2300 past it; the 60 KB read stands alone (it would
  // pass maxBytes with 200000, so does the last).
  assert.deepEqual(h.ranges, ['10-2699', '5000-5099', '120000-179999', '200000-200999']);
  await assert.rejects(get(5, 2), /Invalid range/);
});

test('range-getter: a merged request that fails rejects each of its reads with the host\'s error', async (t) => {
  const h = await host(t);
  const get = rangeGetter(h.bad);
  const results = await Promise.allSettled([get(0, 10), get(10, 20)]);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
  assert.equal(results[0].reason.status, 500);
  assert.equal(results[0].reason, results[1].reason, 'the same error');
});

test('range-getter: readers of one URL share a getter, so reads from different callers in one tick are one request; the counters', async (t) => {
  const h = await host(t);
  resetRangeStats();
  assert.equal(sharedRangeGetter(h.url), sharedRangeGetter(h.url));
  assert.notEqual(sharedRangeGetter(h.url), sharedRangeGetter(h.url, { gap: 1 }), 'other options, another getter');
  assert.notEqual(sharedRangeGetter(h.url), sharedRangeGetter(h.url + '?a=1'));
  // Three "tiles" each reading their own slice, as the adapters do, with nothing in common but the URL.
  const tile = (begin, length) => readRange(h.url, begin, length);
  const [a, b, c, z] = await Promise.all([tile(100, 100), tile(300, 100), tile(1000, 200), tile(5, 0)]);
  assert.ok(same(a, 100, 200) && same(b, 300, 400) && same(c, 1000, 1200) && z.length === 0);
  assert.deepEqual(h.ranges, ['100-1199']);
  assert.deepEqual(rangeStats, { reads: 3, requests: 1, bytesAsked: 400, bytesFetched: 1100 });
  await assert.rejects(readRange(h.url, -1, 5), /Invalid range/);
  // The next tick is the next request.
  assert.ok(same(await tile(2000, 10), 2000, 2010));
  assert.deepEqual(h.ranges, ['100-1199', '2000-2009']);
});

test('range-getter: a batching window merges reads issued a few milliseconds apart; without one, each tick is its own request', async (t) => {
  const h = await host(t);
  const later = (ms, fn) => new Promise((r) => setTimeout(() => r(fn()), ms));
  const windowed = sharedRangeGetter(h.url, { windowMs: 40 });
  const w = await Promise.all([windowed(0, 10), later(5, () => windowed(10, 20)), later(10, () => windowed(100, 110))]);
  assert.ok(same(w[0], 0, 10) && same(w[1], 10, 20) && same(w[2], 100, 110));
  assert.deepEqual(h.ranges, ['0-109'], 'one request for the three');
  h.ranges.length = 0;
  const immediate = sharedRangeGetter(h.url);
  await Promise.all([immediate(0, 10), later(5, () => immediate(10, 20))]);
  assert.deepEqual(h.ranges, ['0-9', '10-19']);
});
