// A virtual point cloud (.vpc) as a mosaic of COPC streams: what is streamed, what is skipped and why, where each item is
// placed, and that the root is built from the .vpc alone. No network: inline fixtures and a loopback host.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { llhToEcef, httpStatusOf } from '../core/index.js';
import { resolveHref, kindOfHref, itemBounds, parseVpc, sortAmbiguous, isCopc, vpcToSet, sniffParam } from './vpc-live.js';
import { handleStream } from './stream-live.js';
import { handleAggregate } from './aggregate-live.js';

const quiet = (t) => { t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); };
const BASE = 'https://data.example.org/lidar/set/index.vpc';
const UTM32 = 'PROJCS["ETRS89 / UTM zone 32N",GEOGCS["ETRS89",DATUM["European_Terrestrial_Reference_System_1989",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",9],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","25832"]]';
// what PDAL writes for AHN: a WKT2 compound of a projected and a vertical CRS
const RD_NAP = 'COMPOUNDCRS["Amersfoort / RD New + NAP height",PROJCRS["Amersfoort / RD New",BASEGEOGCRS["Amersfoort",DATUM["Amersfoort",ELLIPSOID["Bessel 1841",6377397.155,299.1528128,LENGTHUNIT["metre",1]]],PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]],ID["EPSG",4289]],CONVERSION["RD New",METHOD["Oblique Stereographic",ID["EPSG",9809]],PARAMETER["Latitude of natural origin",52.1561605555556,ANGLEUNIT["degree",0.0174532925199433]],PARAMETER["Longitude of natural origin",5.38763888888889,ANGLEUNIT["degree",0.0174532925199433]],PARAMETER["Scale factor at natural origin",0.9999079,SCALEUNIT["unity",1]],PARAMETER["False easting",155000,LENGTHUNIT["metre",1]],PARAMETER["False northing",463000,LENGTHUNIT["metre",1]]],CS[Cartesian,2],AXIS["easting (X)",east,ORDER[1],LENGTHUNIT["metre",1]],AXIS["northing (Y)",north,ORDER[2],LENGTHUNIT["metre",1]],ID["EPSG",28992]],VERTCRS["NAP height",VDATUM["Normaal Amsterdams Peil"],CS[vertical,1],AXIS["gravity-related height (H)",up,LENGTHUNIT["metre",1]],ID["EPSG",5709]]]';

const item = (href, props = {}, extra = {}) => ({
  type: 'Feature', id: extra.id, bbox: extra.bbox, geometry: extra.geometry ?? null,
  properties: { 'pc:count': 1000, 'pc:type': 'lidar', ...props },
  assets: { data: { href, roles: ['data'] }, ...(extra.overview ? { overview: { href: extra.overview, roles: ['overview'] } } : {}) },
});
const utmItem = (href, x = 547000, extra = {}) => item(href, { 'proj:wkt2': UTM32, 'proj:bbox': [x, 5724000, 220, x + 1000, 5725000, 320] }, extra);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('hrefs: relative ones resolve against the .vpc, local paths are not readable', () => {
  assert.equal(resolveHref('./a.copc.laz', BASE).url, 'https://data.example.org/lidar/set/a.copc.laz');
  assert.equal(resolveHref('..\\tiles\\b.copc.laz', BASE).url, 'https://data.example.org/lidar/tiles/b.copc.laz');
  assert.equal(resolveHref('https://other.example/c.copc.laz', BASE).url, 'https://other.example/c.copc.laz');
  assert.equal(resolveHref('C:\\data\\d.copc.laz', BASE).reason, 'local path');
  assert.equal(resolveHref('\\\\nas\\share\\d.copc.laz', BASE).reason, 'local path');
  assert.match(resolveHref('file:///data/e.copc.laz', BASE).reason, /unsupported scheme \(file\)/);
  assert.match(resolveHref('s3://bucket/e.copc.laz', BASE).reason, /unsupported scheme \(s3\)/);
  assert.equal(resolveHref('./a.copc.laz', null).reason, 'local path');
  assert.equal(resolveHref('./a.copc.laz', 'C:/data/index.vpc').reason, 'local path');
  assert.equal(resolveHref(undefined, BASE).reason, 'no data href');
});

test('the file name says COPC, maybe COPC, or not', () => {
  assert.equal(kindOfHref('https://h/a.copc.laz?sig=1'), 'copc');
  assert.equal(kindOfHref('https://h/AHN5_C_124000_484000.COPC.LAZ'), 'copc');
  assert.equal(kindOfHref('https://h/a.laz'), 'laz');
  assert.equal(kindOfHref('https://h/a.las'), 'las');
  assert.equal(kindOfHref('https://h/set/ept.json'), 'ept');
  assert.equal(kindOfHref('https://h/a.txt'), null);
});

test('an item is placed from proj:bbox in its own CRS', () => {
  const b = itemBounds(utmItem('./a.copc.laz'));
  assert.equal(b.from, 'proj:bbox');
  // UTM 32N 547500 E, 5724500 N is 9.6869° E, 51.6694° N
  assert.ok(dist(b.sphere, llhToEcef(9.686875, 51.669443, 270)) < 5, `centre off by ${dist(b.sphere, llhToEcef(9.686875, 51.669443, 270))} m`);
  // the sphere reaches the corners of a 1000 × 1000 × 100 m box, and no further
  assert.ok(Math.abs(b.sphere[3] - Math.hypot(500, 500, 50)) < 2, `radius ${b.sphere[3]}`);
  // the geometric error is the diagonal of the octree cube a COPC of that tile has: the longest side × √3
  assert.ok(Math.abs(b.geometricError - 1000 * Math.sqrt(3)) < 2, `geometric error ${b.geometricError}`);
});

test('items of one VPC may each have their own CRS', () => {
  const de = itemBounds(utmItem('./de.copc.laz'));
  const nl = itemBounds(item('./nl.copc.laz', { 'proj:wkt2': RD_NAP, 'proj:bbox': [124000, 484000, -6.6, 125000, 485000, 32.8] }));
  const fr = itemBounds(item('./fr.copc.laz', { 'proj:epsg': 2154, 'proj:bbox': [648000, 6862000, 30, 649000, 6863000, 330] }));
  const geo = itemBounds(item('./geo.copc.laz', { 'proj:code': 'EPSG:4326', 'proj:bbox': [2.29, 48.85, 30, 2.30, 48.86, 330] }));
  for (const b of [de, nl, fr, geo]) assert.equal(b.from, 'proj:bbox');
  // RD New 124500, 484500 is in Amsterdam (the WKT2 compound is read through its horizontal part)
  assert.ok(dist(nl.sphere, llhToEcef(4.9413, 52.3476, 13)) < 300, `Amsterdam off by ${dist(nl.sphere, llhToEcef(4.9413, 52.3476, 13))} m`);
  // Lambert-93 648500, 6862500 is the Eiffel tower's tile
  assert.ok(dist(fr.sphere, llhToEcef(2.2945, 48.8584, 180)) < 600, `Paris off by ${dist(fr.sphere, llhToEcef(2.2945, 48.8584, 180))} m`);
  assert.ok(dist(geo.sphere, llhToEcef(2.295, 48.855, 180)) < 1);
  assert.ok(dist(de.sphere, nl.sphere) > 300000);
});

test('a 2D proj:bbox takes its heights from the WGS 84 bbox', () => {
  const b = itemBounds(item('./a.copc.laz', { 'proj:epsg': 25832, 'proj:bbox': [547000, 5724000, 548000, 5725000] }, { bbox: [9.68, 51.66, 222, 9.70, 51.68, 316] }));
  assert.equal(b.from, 'proj:bbox');
  const flat = itemBounds(item('./a.copc.laz', { 'proj:epsg': 25832, 'proj:bbox': [547000, 5724000, 548000, 5725000] }));
  assert.ok(dist(b.sphere, flat.sphere) > 250 && dist(b.sphere, flat.sphere) < 290);   // 269 m up, the middle of 222…316
});

test('without a native box, or with a CRS proj4 cannot read, the WGS 84 bbox places the item; then the geometry; then nothing', () => {
  const stac = [9.68, 51.66, 222, 9.70, 51.68, 316];
  const a = itemBounds(item('./a.copc.laz', {}, { bbox: stac }));
  assert.equal(a.from, 'bbox');
  assert.ok(dist(a.sphere, llhToEcef(9.69, 51.67, 269)) < 1);
  const unreadable = itemBounds(item('./a.copc.laz', { 'proj:wkt2': 'LOCAL_CS["site grid"]', 'proj:bbox': [0, 0, 0, 100, 100, 10] }, { bbox: stac }));
  assert.equal(unreadable.from, 'bbox');
  const ring = [[9.68, 51.66], [9.70, 51.66], [9.70, 51.68], [9.68, 51.68], [9.68, 51.66]];
  const g = itemBounds(item('./a.copc.laz', {}, { geometry: { type: 'Polygon', coordinates: [ring] } }));
  assert.equal(g.from, 'geometry');
  assert.ok(dist(g.sphere, llhToEcef(9.69, 51.67, 0)) < 1);
  assert.equal(itemBounds(item('./a.copc.laz')), null);
  assert.equal(itemBounds(item('./a.copc.laz', { 'proj:epsg': 25832, 'proj:bbox': [548000, 5724000, 0, 547000, 5725000, 10] })), null);   // min > max
});

test('a box over a country follows the ellipsoid', () => {
  // 600 × 600 km in Lambert-93: the corners of a flat box would leave its middle 14 km under the sphere's reach
  const b = itemBounds(item('./fr.copc.laz', { 'proj:epsg': 2154, 'proj:bbox': [400000, 6300000, 0, 1000000, 6900000, 1000] }));
  for (const [x, y] of [[400000, 6300000], [1000000, 6900000], [700000, 6600000], [700000, 6300000]]) {
    const p = itemBounds(item('./p.copc.laz', { 'proj:epsg': 2154, 'proj:bbox': [x, y, 0, x, y, 1000] })).sphere;
    assert.ok(dist(p, b.sphere) <= b.sphere[3], `(${x}, ${y}) is outside the sphere`);
  }
});

const MIXED = {
  type: 'FeatureCollection',
  features: [
    utmItem('./tiles/a.copc.laz', 547000, { id: 'tile-a', overview: './overview.copc.laz' }),
    utmItem('https://cdn.example.org/b.COPC.LAZ', 548000, { overview: './overview.copc.laz' }),
    item('./c.copc.laz', { 'proj:epsg': 2154, 'proj:bbox': [648000, 6862000, 30, 649000, 6863000, 330], datetime: '2024-03-27T00:00:00Z' }),
    item('./nobox.copc.laz'),                                   // no extent at all
    utmItem('./plain.las', 549000),
    utmItem('./maybe.laz', 550000),
    utmItem('./ept/ept.json', 551000),
    utmItem('D:\\lidar\\local.copc.laz', 552000),
    { type: 'Feature', properties: {}, assets: {} },            // no data asset
  ],
};

test('a VPC is parsed into streamable COPC entries, .laz items to check, and skipped items with a reason', () => {
  const p = parseVpc(MIXED, BASE);
  assert.equal(p.items, 9);
  assert.deepEqual(p.entries.map((e) => e.url), [
    'https://data.example.org/lidar/set/tiles/a.copc.laz', 'https://cdn.example.org/b.COPC.LAZ',
    'https://data.example.org/lidar/set/c.copc.laz', 'https://data.example.org/lidar/set/nobox.copc.laz']);
  assert.ok(p.entries.every((e) => e.format === 'copc'));
  assert.deepEqual(p.entries.map((e) => e.name), ['tile-a', 'b.COPC.LAZ', 'c.copc.laz', 'nobox.copc.laz']);
  assert.deepEqual(p.entries.map((e) => e.crs), ['EPSG:25832', 'EPSG:25832', 'EPSG:2154', undefined]);   // read from the WKT's own identifier too
  assert.equal(p.entries[2].date, '2024-03-27');
  assert.equal(p.entries[0].points, 1000);
  assert.deepEqual(p.entries.map((e) => !!e.bounds), [true, true, true, false]);
  assert.deepEqual(Object.keys(p.entries[0].bounds), ['sphere', 'geometricError']);
  assert.deepEqual(p.ambiguous.map((e) => e.url), ['https://data.example.org/lidar/set/maybe.laz']);
  assert.deepEqual(p.skipped.map((s) => s.reason), ['plain LAS (no levels of detail)', 'EPT (not supported)', 'local path', 'no data href']);
  assert.deepEqual(p.overviews, ['https://data.example.org/lidar/set/overview.copc.laz']);   // shared by two items, listed once
});

test('what is not a STAC ItemCollection is refused', () => {
  assert.throws(() => parseVpc({ type: 'Collection', links: [] }, BASE), (e) => e.status === 422 && /not a VPC/.test(e.message));
  assert.throws(() => parseVpc(null, BASE), (e) => e.status === 422);
});

test('the set reports what became of every item, and a VPC without COPC is an error that says why', () => {
  const p = parseVpc(MIXED, BASE);
  const { set, report } = vpcToSet(p, { copc: [], skipped: [{ href: p.ambiguous[0].url, reason: 'plain LAZ (no levels of detail)' }], sniffed: 1 }, { url: BASE });
  assert.equal(set.label, 'index.vpc');
  assert.equal(set.entries.length, 4);
  assert.deepEqual({ items: report.items, streamed: report.streamed, skipped: report.skipped, sniffed: report.sniffed }, { items: 9, streamed: 4, skipped: 5, sniffed: 1 });
  assert.deepEqual(report.skippedReasons, { 'plain LAS (no levels of detail)': 1, 'EPT (not supported)': 1, 'local path': 1, 'no data href': 1, 'plain LAZ (no levels of detail)': 1 });
  assert.deepEqual(report.boundsFrom, { 'proj:bbox': 3, probe: 1 });
  assert.equal(report.points, 4000);
  assert.ok(!JSON.stringify(set).includes('boundsFrom'));        // bookkeeping stays out of the manifest
  const plain = parseVpc({ type: 'FeatureCollection', features: [utmItem('./a.las'), utmItem('./b.las', 548000)] }, BASE);
  assert.throws(() => vpcToSet(plain), (e) => e.status === 422 && /no streamable COPC item/.test(e.message) && /2 × plain LAS/.test(e.message) && e.detail.vpc.skipped === 2);
});

const lasHead = (copc) => {
  const b = Buffer.alloc(589);
  b.write('LASF', 0, 'latin1');
  if (copc) { b.write('copc', 377, 'latin1'); b.writeUInt16LE(1, 393); } else { b.write('laszip encoded', 377, 'latin1'); b.writeUInt16LE(22204, 393); }
  return b;
};

test('a COPC is told from a plain LAZ by its first VLR', async () => {
  assert.equal(await isCopc('u', async () => lasHead(true)), true);
  assert.equal(await isCopc('u', async () => lasHead(false)), false);
  assert.equal(await isCopc('u', async () => Buffer.from('<html>not found</html>')), false);
});

test('.laz items: the first 16 are read, and the rest only if one of them is a COPC', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ url: `https://h/${i}.laz` }));
  let reads = 0;
  const none = await sortAmbiguous(many, 'auto', async () => { reads++; return false; });
  assert.equal(reads, 16);
  assert.deepEqual([none.copc.length, none.skipped.length, none.sniffed], [0, 40, 16]);
  assert.match(none.skipped[39].reason, /sniff=all/);
  reads = 0;
  const some = await sortAmbiguous(many, 'auto', async (u) => { reads++; return /\/(3|30)\.laz$/.test(u); });
  assert.equal(reads, 40);
  assert.deepEqual(some.copc.map((e) => e.url), ['https://h/3.laz', 'https://h/30.laz']);
  reads = 0;
  const all = await sortAmbiguous(many, 'all', async (u) => { reads++; return u.endsWith('/30.laz'); });
  assert.deepEqual([reads, all.copc.length], [40, 1]);
  reads = 0;
  const off = await sortAmbiguous(many, 'off', async () => { reads++; return true; });
  assert.deepEqual([reads, off.copc.length, off.skipped.length], [0, 0, 40]);
  const broken = await sortAmbiguous(many.slice(0, 2), 'auto', async () => { throw new Error('host down'); });
  assert.match(broken.skipped[0].reason, /unreadable/);
  assert.equal(sniffParam(null), 'auto'); assert.equal(sniffParam('0'), 'off'); assert.equal(sniffParam('all'), 'all');
});

// ── through /stream, against a loopback host ───────────────────────────────────────────────────

async function host(t, files) {
  const hits = {};
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    hits[p] = (hits[p] ?? 0) + 1;
    let body = files[p];
    if (body === undefined) { res.writeHead(404); return res.end(); }
    if (!Buffer.isBuffer(body)) body = Buffer.from(JSON.stringify(body));
    const m = req.headers.range?.match(/bytes=(\d+)-(\d+)/);
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
async function streamServer(t) {
  const server = http.createServer(async (req, res) => {
    // /stream, and /aggregate for the external tilesets a cut mosaic points back at (server.js routes both)
    try { const u = new URL(req.url, 'http://x'); if (!await handleStream(req, res, u) && !await handleAggregate(req, res, u)) { res.writeHead(404); res.end(); } }
    catch (e) { res.writeHead(httpStatusOf(e)); res.end(String(e.message)); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const leavesOf = (ts) => { const out = []; (function walk(n) { if (n.content?.uri) out.push(n); for (const c of n.children || []) walk(c); })(ts.root); return out; };

test('/stream?format=vpc serves one mosaic of COPC streams, built from the .vpc alone', async (t) => {
  quiet(t);
  // 12 tiles of 1 km in a row, one plain LAS and one local path among them
  const features = Array.from({ length: 12 }, (_, i) => utmItem(`./tiles/t${i}.copc.laz`, 540000 + i * 1000, { overview: './overview.copc.laz' }));
  features.push(utmItem('./tiles/plain.las', 560000), utmItem('/mnt/lidar/elsewhere.copc.laz'.replace('/mnt', 'file:///mnt'), 561000));
  const h = await host(t, { '/set/index.vpc': { type: 'FeatureCollection', features } });
  const s = await streamServer(t);
  const r = await fetch(`${s}/stream/tileset.json?url=${encodeURIComponent(`${h.base}/set/index.vpc`)}&cache=none&prefetch=0`);   // format detected from .vpc
  assert.equal(r.status, 200);
  assert.deepEqual([r.headers.get('x-vpc-items'), r.headers.get('x-vpc-streamed'), r.headers.get('x-vpc-skipped')], ['14', '12', '2']);
  assert.match(r.headers.get('x-vpc-skipped-reasons'), /1 plain LAS/);
  const ts = await r.json();
  const leaves = leavesOf(ts);
  assert.equal(leaves.length, 12);
  for (const lf of leaves) {
    const u = new URL(lf.content.uri);
    assert.equal(u.origin + u.pathname, `${s}/stream/tileset.json`);
    assert.equal(u.searchParams.get('format'), 'copc');
    assert.match(u.searchParams.get('url'), new RegExp(`^${h.base}/set/tiles/t\\d+\\.copc\\.laz$`));
    assert.equal(u.searchParams.get('crs'), 'EPSG:25832');
    assert.equal(u.searchParams.get('prefetch'), '0');
    assert.ok(Math.abs(lf.boundingVolume.sphere[3] - Math.hypot(500, 500, 50)) < 2);
    assert.ok(Math.hypot(...lf.boundingVolume.sphere.slice(0, 3)) > 6.3e6);
  }
  const x = ts.asset.extras;
  assert.equal(x.nesting.scheme, 'geodetic');                    // nested, not a flat list of 12
  assert.ok(x.nesting.groups >= 1);
  assert.deepEqual([x.build.childRoots, x.build.childRootsBaked, x.build.childRootsFetched], [12, 12, 0]);
  assert.deepEqual([x.vpc.items, x.vpc.streamed, x.vpc.skipped], [14, 12, 2]);
  assert.equal(x.vpc.skippedItems.length, 2);
  assert.equal(x.vpc.overviews.length, 1);
  assert.match(x.vpc.overviews[0].stream, /\/stream\/tileset\.json\?format=copc&url=.*overview\.copc\.laz/);
  // the whole point: the .vpc was the only file read, plus the overview's 375-byte header (which here is not there)
  assert.deepEqual(h.hits, { '/set/index.vpc': 1, '/set/overview.copc.laz': 1 });
  assert.match(x.vpc.overviewError, /overview\.copc\.laz: /);
  assert.equal(x.vpc.leafError, undefined);
  // a VPC has no tiles of its own
  assert.equal((await fetch(`${s}/stream/tile/0-0-0-0.glb?format=vpc&url=${encodeURIComponent(`${h.base}/set/index.vpc`)}`)).status, 404);
});

test('a gzipped .vpc of a country is read as is, and served cut into external tilesets that reach every item once', async (t) => {
  quiet(t);
  // 34 × 34 = 1 156 tiles of 1 km, past the 1 024 at which the cut starts
  const features = [];
  for (let i = 0; i < 34; i++) for (let j = 0; j < 34; j++) {
    features.push(item(`./tiles/t${i}_${j}.copc.laz`, { 'proj:wkt2': UTM32, 'proj:bbox': [540000 + i * 1000, 5724000 + j * 1000, 220, 541000 + i * 1000, 5725000 + j * 1000, 320] }));
  }
  const gz = gzipSync(JSON.stringify({ type: 'FeatureCollection', features }));
  assert.ok(gz.length < 100_000);
  const h = await host(t, { '/set/index.vpc.gz': gz });
  const s = await streamServer(t);
  const r = await fetch(`${s}/stream/tileset.json?url=${encodeURIComponent(`${h.base}/set/index.vpc.gz`)}&cache=none`);   // format detected from .vpc.gz
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-vpc-streamed'), '1156');
  const ts = await r.json();
  assert.equal(ts.asset.extras.datasets, 1156);
  assert.equal(ts.asset.extras.cut.depth, 4);
  assert.ok(ts.asset.extras.cut.externals > 0);
  assert.ok(leavesOf(ts).length < 1156);                            // the root no longer holds every item
  // follow every external tileset: each is this server's /aggregate with &vpc= and &cell=, never &set=
  const seen = new Set();
  let hops = 0;
  const follow = async (tileset, depth) => {
    hops = Math.max(hops, depth);
    for (const tile of (function all(n) { const out = [n]; for (const c of n.children || []) out.push(...all(c)); return out; })(tileset.root)) {
      if (!tile.content?.uri || tile.children) continue;
      const u = new URL(tile.content.uri);
      if (u.searchParams.has('cell')) {
        assert.equal(u.origin + u.pathname, `${s}/aggregate/tileset.json`);
        assert.equal(u.searchParams.get('vpc'), `${h.base}/set/index.vpc.gz`);
        assert.equal(u.searchParams.get('set'), null);
        const sr = await fetch(u.href);
        assert.equal(sr.status, 200);
        const sub = await sr.json();
        assert.equal(sub.asset.extras.cell, u.searchParams.get('cell'));
        assert.deepEqual(sub.root.boundingVolume, tile.boundingVolume);
        assert.equal(sub.root.geometricError, tile.geometricError);
        await follow(sub, depth + 1);
      } else {
        assert.ok(!seen.has(u.searchParams.get('url')), 'an item reached twice');
        seen.add(u.searchParams.get('url'));
      }
    }
  };
  await follow(ts, 0);
  assert.equal(seen.size, 1156);
  assert.ok(hops >= 1);
  assert.deepEqual(h.hits, { '/set/index.vpc.gz': 1 });            // one read of the .vpc.gz for the root and every subtree
  // &cut=0 serves the whole tree inline, as before the cut existed; an unknown cell is a 404
  const flat = await (await fetch(`${s}/stream/tileset.json?url=${encodeURIComponent(`${h.base}/set/index.vpc.gz`)}&cache=none&cut=0`)).json();
  assert.equal(leavesOf(flat).length, 1156);
  assert.equal(flat.asset.extras.cut, undefined);
  assert.equal((await fetch(`${s}/stream/tileset.json?url=${encodeURIComponent(`${h.base}/set/index.vpc.gz`)}&cache=none&cell=nowhere`)).status, 404);
});

test('/stream?format=vpc: a .laz item is read once to tell, a VPC of plain files is a 422, a missing one a 404', async (t) => {
  quiet(t);
  const h = await host(t, {
    '/a/index.vpc': { type: 'FeatureCollection', features: [utmItem('./real.laz', 540000), utmItem('./plain.laz', 541000)] },
    '/a/real.laz': lasHead(true), '/a/plain.laz': lasHead(false),
    '/b/index.vpc': { type: 'FeatureCollection', features: [utmItem('./x.las'), utmItem('./y.las', 548000)] },
    '/c/index.vpc': Buffer.from('<html>'),
  });
  const s = await streamServer(t);
  const q = (p, extra = '') => fetch(`${s}/stream/tileset.json?format=vpc&url=${encodeURIComponent(`${h.base}${p}`)}${extra}`);
  const a = await q('/a/index.vpc');
  assert.equal(a.status, 200);
  const ts = await a.json();
  assert.deepEqual(leavesOf(ts).map((l) => new URL(l.content.uri).searchParams.get('url')), [`${h.base}/a/real.laz`]);
  assert.deepEqual([ts.asset.extras.vpc.sniffed, ts.asset.extras.vpc.skipped], [2, 1]);
  assert.deepEqual([h.hits['/a/real.laz'], h.hits['/a/plain.laz']], [1, 1]);
  const b = await q('/b/index.vpc');
  assert.equal(b.status, 422);
  const err = await b.json();
  assert.match(err.error, /no streamable COPC item in this VPC \(2 items: 2 × plain LAS/);
  assert.equal(err.vpc.skipped, 2);
  assert.equal((await q('/c/index.vpc')).status, 422);
  assert.equal((await q('/none/index.vpc')).status, 404);
});

// ── nested VPCs: a root whose items are child .vpc files (scripts/vpc-split.mjs) ──────────────────

/** A LAS 1.4 header (375 bytes) saying `points` points over [x0, y0]–[x1, y1]: what planOverview reads of an overview. */
function lasHeader(points, [x0, y0, x1, y1]) {
  const b = Buffer.alloc(375);
  b.write('LASF', 0, 'latin1'); b[24] = 1; b[25] = 4; b.writeUInt16LE(375, 94);
  b.writeDoubleLE(x1, 179); b.writeDoubleLE(x0, 187); b.writeDoubleLE(y1, 195); b.writeDoubleLE(y0, 203);
  b.writeBigUInt64LE(BigInt(points), 247);
  return b;
}
const groupsOf = (ts) => { const out = []; (function walk(n) { if (n.children && !n.content) out.push(n); for (const c of n.children || []) walk(c); })(ts.root); return out; };

test('the overview is placed as a leaf beside the groups, and the files open at the error it leaves', async (t) => {
  quiet(t);
  // 12 tiles of 1 km², an overview of 3 M points over them: 2 m between its points, so a file is worth 2 m
  const features = Array.from({ length: 12 }, (_, i) => utmItem(`./tiles/t${i}.copc.laz`, 540000 + i * 1000, { overview: './overview.copc.laz' }));
  const h = await host(t, { '/set/index.vpc': { type: 'FeatureCollection', features }, '/set/overview.copc.laz': lasHeader(3_000_000, [540000, 5724000, 552000, 5725000]) });
  const s = await streamServer(t);
  const url = `${h.base}/set/index.vpc`;
  const ts = await (await fetch(`${s}/stream/tileset.json?url=${encodeURIComponent(url)}&cache=none`)).json();
  const leaves = leavesOf(ts);
  assert.equal(leaves.length, 13);
  const ov = leaves.find((l) => /overview\.copc\.laz/.test(l.content.uri));
  const files = leaves.filter((l) => l !== ov);
  assert.equal(files.length, 12);
  // every file leaf: 2 m, down from the 1 732 m its size says; the overview leaf: as large as the set
  for (const f of files) assert.equal(f.geometricError, 2);
  assert.ok(ov.geometricError > 6000 && ov.geometricError === ov.boundingVolume.sphere[3]);
  assert.equal(new URL(ov.content.uri).searchParams.get('crs'), 'EPSG:25832');
  // beside the groups: its parent is a group with at least one group among its children, refined with ADD
  const parent = groupsOf(ts).find((g) => g.children.includes(ov));
  assert.ok(parent && parent.refine === 'ADD' && parent.children.some((c) => c.children && !c.content));
  assert.ok(parent.geometricError > ov.geometricError);
  const x = ts.asset.extras.vpc;
  assert.deepEqual(x.overview, { url: `${h.base}/set/overview.copc.laz`, points: 3_000_000, spacing: 2, areaKm2: 12, placed: true });
  assert.deepEqual([x.leafError, x.areaKm2], [2, 12]);
  assert.deepEqual(h.hits, { '/set/index.vpc': 1, '/set/overview.copc.laz': 1 });
  // &overview=0: no overview leaf, the strict error is back; &leafError=50 is taken as given
  const off = await (await fetch(`${s}/stream/tileset.json?url=${encodeURIComponent(url)}&cache=none&overview=0`)).json();
  assert.equal(leavesOf(off).length, 12);
  assert.ok(leavesOf(off).every((l) => Math.abs(l.geometricError - 1000 * Math.sqrt(3)) < 1));
  assert.deepEqual([off.asset.extras.vpc.overview, off.asset.extras.vpc.leafError], [undefined, undefined]);
  const fifty = await (await fetch(`${s}/stream/tileset.json?url=${encodeURIComponent(url)}&cache=none&leafError=50`)).json();
  assert.ok(leavesOf(fifty).filter((l) => !/overview/.test(l.content.uri)).every((l) => l.geometricError === 50));
  assert.equal(leavesOf(fifty).length, 13);
  // a .vpc read once, the overview's header once, whatever the view
  assert.deepEqual(h.hits, { '/set/index.vpc': 1, '/set/overview.copc.laz': 1 });
});

test('a root-level overview link stands in for the assets a split root no longer has', () => {
  const doc = { type: 'FeatureCollection', features: [utmItem('./tiles/a.copc.laz')], links: [{ rel: 'overview', href: './overview.copc.laz' }] };
  assert.deepEqual(parseVpc(doc, BASE).overviews, ['https://data.example.org/lidar/set/overview.copc.laz']);
});

const childItem = (href, x0, x1, extra = {}) => ({
  type: 'Feature', id: extra.id ?? href, geometry: null,
  bbox: [9.5, 51.6, 200, 9.7, 51.7, 320],
  properties: { datetime: '2024-01-01T00:00:00Z', 'pc:count': 5000, 'pc:type': 'vpc', 'vpc:items': 5, 'proj:wkt2': UTM32, 'proj:bbox': [x0, 5724000, 220, x1, 5725000, 320], ...extra.props },
  links: [], assets: { data: { href, roles: ['data'], type: 'application/geo+json' } },
});

test('a nested VPC is parsed into vpc entries placed from their own proj:bbox, child links add what the items do not name', () => {
  const doc = {
    type: 'FeatureCollection',
    features: [
      childItem('./set/00.vpc.gz', 540000, 545000),
      childItem('./set/01.vpc', 545000, 550000),
      childItem('./set/02', 550000, 555000, { props: { 'pc:type': 'vpc' } }),   // no extension: the item says what it is
      utmItem('./tiles/t.copc.laz', 560000),
    ],
    links: [
      { rel: 'child', href: './set/00.vpc.gz', type: 'application/geo+json' },  // already an item
      { rel: 'child', href: './set/03.vpc.gz', type: 'application/geo+json' },  // not an item: placed by reading its mosaic root
      { rel: 'child', href: './set/readme.txt' },
      { rel: 'self', href: './index.vpc' },
    ],
  };
  const p = parseVpc(doc, BASE);
  assert.equal(p.nested, 4);
  assert.deepEqual(p.entries.map((e) => [e.format, e.url.replace(BASE.replace('index.vpc', ''), ''), e.boundsFrom]), [
    ['vpc', 'set/00.vpc.gz', 'proj:bbox'], ['vpc', 'set/01.vpc', 'proj:bbox'], ['vpc', 'set/02', 'proj:bbox'], ['copc', 'tiles/t.copc.laz', 'proj:bbox'], ['vpc', 'set/03.vpc.gz', 'probe'],
  ]);
  assert.equal(p.entries[0].points, 5000);
  assert.equal(p.entries[0].crs, undefined);                      // a child mosaic places its own files
  assert.ok(Math.abs(p.entries[0].bounds.geometricError - 5000 * Math.sqrt(3)) < 10);   // the cube's diagonal (UTM's scale factor adds 3.5 m)
  assert.deepEqual(p.skipped, [{ href: './set/readme.txt', reason: 'child link that is not a VPC' }]);
  const { report } = vpcToSet(p);
  assert.deepEqual([report.items, report.streamed, report.nested, report.points], [4, 5, 4, 16000]);
});

test('/stream?format=vpc serves a root of child VPCs from the root file alone; a leaf is the child\'s own mosaic', async (t) => {
  quiet(t);
  const tiles = (n, x) => Array.from({ length: n }, (_, i) => utmItem(`../tiles/${x + i * 1000}.copc.laz`, x + i * 1000));
  const h = await host(t, {
    '/set/index.vpc.gz': gzipSync(JSON.stringify({
      type: 'FeatureCollection',
      features: [childItem('./index/0.vpc.gz', 540000, 545000, { id: 'index-0' }), childItem('./index/1.vpc.gz', 545000, 550000, { id: 'index-1' })],
      links: [{ rel: 'child', href: './index/0.vpc.gz' }, { rel: 'child', href: './index/1.vpc.gz' }],
    })),
    '/set/index/0.vpc.gz': gzipSync(JSON.stringify({ type: 'FeatureCollection', features: tiles(5, 540000) })),
    '/set/index/1.vpc.gz': gzipSync(JSON.stringify({ type: 'FeatureCollection', features: tiles(5, 545000) })),
  });
  const s = await streamServer(t);
  const r = await fetch(`${s}/stream/tileset.json?url=${encodeURIComponent(`${h.base}/set/index.vpc.gz`)}&cache=none`);
  assert.equal(r.status, 200);
  assert.deepEqual([r.headers.get('x-vpc-items'), r.headers.get('x-vpc-streamed'), r.headers.get('x-vpc-skipped')], ['2', '2', '0']);
  const ts = await r.json();
  const leaves = leavesOf(ts);
  assert.equal(leaves.length, 2);
  for (const lf of leaves) {
    const u = new URL(lf.content.uri);
    assert.equal(u.origin + u.pathname, `${s}/stream/tileset.json`);
    assert.equal(u.searchParams.get('format'), 'vpc');
    assert.match(u.searchParams.get('url'), new RegExp(`^${h.base}/set/index/[01]\\.vpc\\.gz$`));
    assert.ok(Math.abs(lf.boundingVolume.sphere[3] - Math.hypot(2500, 500, 50)) < 3);
    // a child places no overview of its own (the root does, when it names one)
    assert.deepEqual([u.searchParams.get('overview'), u.searchParams.get('leafError')], ['0', null]);
  }
  assert.deepEqual([ts.asset.extras.vpc.nested, ts.asset.extras.build.childRootsFetched], [2, 0]);
  assert.deepEqual(h.hits, { '/set/index.vpc.gz': 1 });            // no child opened to build the root
  // the leaf: the child's mosaic, five COPC streams, the child file read once
  const sub = await (await fetch(leaves[0].content.uri)).json();
  const items = leavesOf(sub).map((l) => new URL(l.content.uri));
  assert.equal(items.length, 5);
  assert.ok(items.every((u) => u.searchParams.get('format') === 'copc' && /\/set\/tiles\/\d+\.copc\.laz$/.test(u.searchParams.get('url'))));
  assert.equal(Object.values(h.hits).reduce((a, b) => a + b), 2);
  // the child's mosaic holds what the parent's leaf promised, and its leaves lie inside that leaf's sphere
  assert.equal(sub.asset.extras.datasets, 5);
  const [cx, cy, cz, cr] = leaves[0].boundingVolume.sphere;
  // (a tile's own sphere pokes past the box corners the parent's sphere was fitted to: the points do not)
  for (const l of leavesOf(sub)) assert.ok(dist(l.boundingVolume.sphere, [cx, cy, cz]) + l.boundingVolume.sphere[3] < cr * 1.1);
  // index.json lists the two children as vpc rows
  const idx = await (await fetch(`${s}/aggregate/index.json?vpc=${encodeURIComponent(`${h.base}/set/index.vpc.gz`)}`)).json();
  assert.deepEqual(idx.datasets.map((d) => d.format).sort(), ['vpc', 'vpc']);
});
