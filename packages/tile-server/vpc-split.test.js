// scripts/vpc-split.mjs: a VPC cut into a quadtree of VPC files under an item and a byte limit, a root whose
// items stand for the children, and the root parsed back by vpc-live as nested entries with bounds. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitVpc, summaryItem, featureBox, readCollection } from '../../scripts/vpc-split.mjs';
import { parseVpc } from './vpc-live.js';

const UTM32 = 'PROJCS["ETRS89 / UTM zone 32N",GEOGCS["ETRS89",DATUM["European_Terrestrial_Reference_System_1989",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",9],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","25832"]]';

/** An n × m grid of 1 km tiles as copc-to-vpc writes them (WGS 84 bbox and geometry, proj:bbox in UTM 32). */
function grid(n, m, { epsg = false, from = 0 } = {}) {
  const features = [];
  const dLon = 1000 / (111320 * Math.cos(51.6 * Math.PI / 180)), dLat = 1000 / 111320;
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    const lon = 9.6 + i * dLon, lat = 51.6 + j * dLat, x = 540000 + i * 1000, y = 5720000 + j * 1000;
    features.push({
      type: 'Feature', stac_version: '1.0.0', id: `t_${i + from}_${j}`,
      geometry: { type: 'Polygon', coordinates: [[[lon, lat], [lon + dLon, lat], [lon + dLon, lat + dLat], [lon, lat + dLat], [lon, lat]]] },
      bbox: [lon, lat, 200 + j, lon + dLon, lat + dLat, 300 + i],
      properties: { datetime: `2024-01-${String(1 + (i + j) % 28).padStart(2, '0')}T00:00:00Z`, 'pc:count': 1000 + i, 'pc:type': 'lidar',
        'proj:bbox': [x, y, 200 + j, x + 1000, y + 1000, 300 + i], ...(epsg ? { 'proj:epsg': 25832 } : { 'proj:wkt2': UTM32 }) },
      links: [], assets: { data: { href: `./tiles/t_${i + from}_${j}.copc.laz`, roles: ['data'] } },
    });
  }
  return { type: 'FeatureCollection', features };
}
const idsOf = (fc) => fc.features.map((f) => f.id);

test('the union of items: WGS 84 and native boxes, counts, dates, and one CRS or none', () => {
  const g = grid(3, 2, { epsg: true });
  const s = summaryItem(g.features, { id: 'x', href: './x/0.vpc.gz', items: 6 });
  assert.deepEqual(s.bbox.map((v) => +v.toFixed(3)), [9.6, 51.6, 200, 9.643, 51.618, 302]);
  assert.deepEqual(s.properties['proj:bbox'], [540000, 5720000, 200, 543000, 5722000, 302]);
  assert.equal(s.properties['proj:epsg'], 25832);
  assert.deepEqual([s.properties['pc:count'], s.properties['pc:type'], s.properties['vpc:items']], [6 * 1000 + 2 * (0 + 1 + 2), 'vpc', 6]);
  assert.deepEqual([s.properties.start_datetime, s.properties.datetime], ['2024-01-01T00:00:00Z', '2024-01-04T00:00:00Z']);
  assert.equal(s.assets.data.href, './x/0.vpc.gz');
  assert.equal(s.geometry.coordinates[0].length, 5);
  // two CRSs among the items: no native box, the WGS 84 one stays
  const mixed = { features: [...grid(1, 1).features, ...grid(1, 1, { epsg: true, from: 5 }).features] };
  const m = summaryItem(mixed.features, { id: 'm', href: './m.vpc', items: 2 });
  assert.equal(m.properties['proj:bbox'], undefined);
  assert.equal(m.properties['proj:wkt2'], undefined);
  assert.ok(m.bbox);
  assert.deepEqual(featureBox({ bbox: [1, 2, 3, 4] }), [1, 2, 0, 3, 4, 0]);
  assert.deepEqual(featureBox({ geometry: { type: 'Point', coordinates: [5, 6, 7] } }), [5, 6, 7, 5, 6, 7]);
  assert.equal(featureBox({}), null);
});

test('a VPC under the limits is not split: the root is the document itself', () => {
  const g = grid(10, 10);
  const { root, files, stats } = splitVpc(g, { maxItems: 2048, maxBytes: 2e6 });
  assert.equal(files.size, 0);
  assert.deepEqual(idsOf(root), idsOf(g));
  assert.deepEqual([stats.leaves, stats.rootItems], [1, 100]);
});

test('a grid is cut into leaves under the item limit, each item in exactly one leaf, the root listing every leaf with its union', () => {
  const g = grid(70, 70);                                          // 4 900 tiles
  const { root, files, stats } = splitVpc(g, { maxItems: 512, maxBytes: 50e6, name: 'country', ext: '.vpc.gz' });
  assert.equal(stats.items, 4900);
  assert.ok(files.size >= 10 && files.size === stats.leaves, `${files.size} files, ${stats.leaves} leaves`);
  assert.equal(stats.levels, 0);                                  // the root lists the leaves directly
  const seen = new Map();
  for (const [key, fc] of files) {
    assert.match(key, /^[0-3]+$/);
    assert.ok(fc.features.length <= 512 && fc.features.length > 0, `${key}: ${fc.features.length}`);
    assert.deepEqual(fc.links, [{ rel: 'parent', href: '../country.vpc.gz', type: 'application/geo+json' }]);
    for (const f of fc.features) seen.set(f.id, (seen.get(f.id) ?? 0) + 1);
  }
  assert.equal(seen.size, 4900);
  assert.ok([...seen.values()].every((n) => n === 1));
  // the root: one item per leaf, pointing at the child file in both forms, whose counts add up
  assert.equal(root.features.length, files.size);
  assert.equal(root.links.filter((l) => l.rel === 'child').length, files.size);
  for (const f of root.features) {
    const key = /^\.\/country\/([0-3]+)\.vpc\.gz$/.exec(f.assets.data.href)?.[1];
    assert.ok(key && files.has(key), f.assets.data.href);
    assert.equal(f.properties['vpc:items'], files.get(key).features.length);
    assert.equal(f.properties['pc:count'], files.get(key).features.reduce((n, x) => n + x.properties['pc:count'], 0));
    assert.equal(f.properties['pc:type'], 'vpc');
    assert.ok(root.links.some((l) => l.rel === 'child' && l.href === f.assets.data.href));
    // the union encloses every item of the child
    const [x0, y0, , x1, y1] = f.properties['proj:bbox'];
    for (const x of files.get(key).features) { const b = x.properties['proj:bbox']; assert.ok(b[0] >= x0 && b[1] >= y0 && b[3] <= x1 && b[4] <= y1); }
  }
  // what vpc-live makes of the root: nested entries, every one with baked bounds
  const p = parseVpc(root, 'https://h/sets/country.vpc.gz');
  assert.equal(p.nested, files.size);
  assert.ok(p.entries.every((e) => e.format === 'vpc' && e.boundsFrom === 'proj:bbox' && e.url.startsWith('https://h/sets/country/')));
  assert.equal(p.skipped.length, 0);
});

test('the byte limit splits further than the item limit, and a tiny item limit adds intermediate levels that still reach every item', () => {
  const g = grid(40, 40);                                          // 1 600 tiles of about 600 bytes
  const bytes = splitVpc(g, { maxItems: 2048, maxBytes: 100_000 });
  assert.ok(bytes.files.size > 8, `${bytes.files.size} files`);
  for (const fc of bytes.files.values()) assert.ok(JSON.stringify(fc).length <= 100_000 + 2_000);   // the wrapper and links are not counted to the byte
  // 1 600 items at 8 per file is 200 leaves: too many for one root of 8, so a tree of parents is written
  const deep = splitVpc(g, { maxItems: 8, maxBytes: 50e6, name: 'd', ext: '.vpc' });
  assert.ok(deep.stats.levels > 0 && deep.stats.depth >= 2, JSON.stringify(deep.stats));
  assert.ok(deep.root.features.length <= 8);
  const reached = new Set();
  const walk = (fc, depth) => {
    assert.ok(fc.features.length <= 8);
    for (const f of fc.features) {
      if (f.properties['pc:type'] === 'vpc') {
        // the root (beside the `d/` folder) says ./d/<key>, a file inside the folder says ./<key>: both resolve to d/<key>.vpc
        const key = (depth === 0 ? /^\.\/d\/([0-3]+)\.vpc$/ : /^\.\/([0-3]+)\.vpc$/).exec(f.assets.data.href)?.[1];
        assert.ok(deep.files.has(key), f.assets.data.href);
        const child = deep.files.get(key);
        assert.equal(f.properties['vpc:items'], (function count(x) { return x.features.reduce((n, y) => n + (y.properties['pc:type'] === 'vpc' ? count(deep.files.get(/([0-3]+)\.vpc$/.exec(y.assets.data.href)[1])) : 1), 0); })(child));
        walk(child, depth + 1);
      } else reached.add(f.id);
    }
  };
  walk(deep.root, 0);
  assert.equal(reached.size, 1600);
  // every href resolves, from the file that writes it, to the file it means (a nested child's parent link too)
  const at = (key) => (key === '' ? 'https://h/d.vpc' : `https://h/d/${key}.vpc`);
  for (const [key, fc] of [['', deep.root], ...deep.files]) {
    for (const f of fc.features) if (f.properties['pc:type'] === 'vpc') assert.ok(deep.files.has(/\/d\/([0-3]+)\.vpc$/.exec(new URL(f.assets.data.href, at(key)).href)?.[1]), `${key}: ${f.assets.data.href}`);
    for (const l of fc.links ?? []) if (l.rel === 'parent') { const up = new URL(l.href, at(key)).href; assert.ok(up === at('') || deep.files.has(/\/d\/([0-3]+)\.vpc$/.exec(up)?.[1]), `${key}: ${l.href}`); }
  }
  // --flat: every file a sibling, <name>.<key>, for a host without folders
  const flat = splitVpc(g, { maxItems: 8, maxBytes: 50e6, name: 'd', ext: '.vpc', flat: true });
  assert.equal(flat.files.size, deep.files.size);
  for (const [key, fc] of [['', flat.root], ...flat.files]) {
    for (const f of fc.features) if (f.properties['pc:type'] === 'vpc') assert.ok(flat.files.has(/^\.\/d\.([0-3]+)\.vpc$/.exec(f.assets.data.href)?.[1]), f.assets.data.href);
    for (const l of fc.links ?? []) if (l.rel === 'parent') assert.match(l.href, key.length <= 1 || !flat.files.has(key.slice(0, -1)) ? /^\.\/d(\.[0-3]+)?\.vpc$/ : /^\.\/d\.[0-3]+\.vpc$/);
  }
  assert.throws(() => splitVpc({ type: 'Feature' }), /not a VPC/);
});

test('items without a box ride along in the first quadrant and are never lost', () => {
  const g = grid(30, 30);
  for (let i = 0; i < 5; i++) g.features.push({ type: 'Feature', id: `nowhere_${i}`, geometry: null, properties: { 'pc:count': 1 }, assets: { data: { href: `./n${i}.copc.laz` } } });
  const { files } = splitVpc(g, { maxItems: 200, maxBytes: 50e6 });
  const ids = new Set([...files.values()].flatMap((fc) => fc.features.map((f) => f.id)));
  assert.equal(ids.size, 905);
  for (let i = 0; i < 5; i++) assert.ok(ids.has(`nowhere_${i}`));
});

test('a collection past the string cap is scanned feature by feature, braces and quotes inside strings and multi-byte text included, and reads as JSON.parse does', () => {
  const g = grid(6, 5);
  g.links = [{ rel: 'self', href: './g.vpc' }];
  g.features[3].properties.title = 'a "quoted" {brace} \ and ] bracket — été, 東京';
  g.features[7].properties.description = '}{][';
  for (const text of [JSON.stringify(g), JSON.stringify(g, null, 2)]) {
    const bytes = Buffer.from(text, 'utf8');
    const scanned = readCollection(bytes, 0);                 // cap 0: the scanning path on a small document
    assert.deepEqual(scanned, JSON.parse(text));
    assert.equal(scanned.features.length, 30);
    assert.deepEqual(scanned.links, g.links);
  }
  assert.deepEqual(readCollection(Buffer.from(JSON.stringify(g))), JSON.parse(JSON.stringify(g)));   // under the cap: one parse
  assert.throws(() => readCollection(Buffer.from('{"type":"FeatureCollection"}'), 0), /no "features"/);
  assert.throws(() => readCollection(Buffer.from('{"features":[1]}'), 0), /unexpected byte/);
});
