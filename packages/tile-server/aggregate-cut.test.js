// The nesting of a country-sized regular grid, and the depth cut that keeps its root small: groups past
// `cut` levels become external tilesets (&cell=<key>), the cut is a view of the one tree, and every
// dataset is reached exactly once through it. No network: bounds are baked (`known`), as a VPC's are.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAggregate, parseCut, cutTree, subtreeOf, subtreeTileset, datasetsBelow } from './aggregate-live.js';
import { llhToEcef } from '../core/index.js';

/** An n × n grid of 1 km tiles around Luxembourg (lon 6.1°, lat 49.6°), as /aggregate sees a VPC: bounds baked, nothing fetched. */
function grid(n) {
  const urls = [], known = {};
  const dLon = 1000 / (111320 * Math.cos(49.6 * Math.PI / 180)), dLat = 1000 / 111320;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const url = `https://h/tiles/${i}_${j}.json`;
    const [x, y, z] = llhToEcef(6.1 + i * dLon, 49.6 + j * dLat, 300);
    urls.push(url);
    known[url] = { sphere: [x, y, z, Math.hypot(500, 500, 50)], geometricError: 1000 * Math.sqrt(3) };
  }
  return { urls, known };
}
const leavesOf = (t) => { const out = []; (function walk(n) { if (!n.children) { if (n.content?.uri) out.push(n); return; } for (const c of n.children) walk(c); })(t); return out; };
const groupsOf = (t) => { const out = []; (function walk(n, d) { if (!n.children) return; out.push({ node: n, depth: d }); for (const c of n.children) walk(c, d + 1); })(t, 0); return out; };
const isExternal = (t) => !t.children && /[?&]cell=/.test(t.content?.uri ?? '');
const uriFor = (key) => `https://s/aggregate/tileset.json?set=x&cell=${encodeURIComponent(key)}`;

test('cut=: auto cuts from 1 024 datasets, numbers are depths, 0 is none', () => {
  assert.equal(parseCut(null, 1000), 0);
  assert.equal(parseCut('auto', 1024), 4);
  assert.equal(parseCut(undefined, 337206), 4);
  assert.equal(parseCut('0', 337206), 0);
  assert.equal(parseCut('off', 337206), 0);
  assert.equal(parseCut('3', 10), 3);
  assert.equal(parseCut('2.7', 10), 2);
  assert.equal(parseCut('-1', 5000), 4);
  assert.equal(parseCut('bogus', 5000), 4);
});

test('a regular 1 km grid nests as a path-compressed quadtree: 4-way above, 3 × 5 tiles in the deepest cells', async () => {
  const { urls, known } = grid(48);                                 // 2 304 tiles, 48 × 48 km
  const ts = await buildAggregate(urls, { nest: 'geodetic', known });
  assert.equal(ts.asset.extras.datasets, 2304);
  assert.equal(leavesOf(ts.root).length, 2304);
  const groups = groupsOf(ts.root);
  for (const { node } of groups) {
    const sub = node.children.filter((c) => c.children), here = node.children.filter((c) => !c.children);
    // a group holds the four quadrants of its cell at most, plus the datasets whose own cell it is
    assert.ok(sub.length <= 4, `${node.extras.cell.key}: ${sub.length} sub-groups`);
    // the deepest cell that is 4× a 1 km tile is 3.2 × 4.9 km here: at most 4 × 5 tile centres
    assert.ok(here.length <= 20, `${node.extras.cell.key}: ${here.length} datasets in one cell`);
    // a parent's geometric error exceeds every child's
    for (const c of node.children) assert.ok(node.geometricError > c.geometricError);
  }
  const x = ts.asset.extras.nesting;
  assert.equal(x.scheme, 'geodetic');
  assert.ok(x.depth >= 4 && x.groups > 100, JSON.stringify(x));
});

test('below the threshold nothing changes: the cut is the same tree object', async () => {
  const { urls, known } = grid(10);                                 // 100 tiles
  const ts = await buildAggregate(urls, { nest: 'geodetic', known });
  const depth = parseCut('auto', ts.asset.extras.datasets);
  assert.equal(depth, 0);
  const { root, externals } = cutTree(ts.root, depth, uriFor);
  assert.equal(externals, 0);
  assert.equal(root, ts.root);
});

test('the cut turns groups past the depth into childless external tiles, and leaves the tree it came from whole', async () => {
  const { urls, known } = grid(48);
  const ts = await buildAggregate(urls, { nest: 'geodetic', known });
  const before = JSON.stringify(ts);
  const { root, externals } = cutTree(ts.root, 2, uriFor);
  assert.ok(externals > 0);
  assert.equal(JSON.stringify(ts), before);                        // the cached tree is untouched
  const exts = [];
  (function walk(t, d) {
    if (isExternal(t)) {
      exts.push(t);
      assert.ok(d >= 2, `external at depth ${d}`);
      assert.equal(t.content.uri, uriFor(t.extras.cell.key));
      assert.ok(t.extras.datasets >= 8);
      assert.equal(t.children, undefined);                         // the spec: a tile with an external tileset has no children
      return;
    }
    if (!t.children) return;
    // a group left inline past the cut is a small one
    if (d >= 2) assert.ok(datasetsBelow(t) < 8, `inline group at depth ${d} with ${datasetsBelow(t)} datasets`);
    for (const c of t.children) walk(c, d + 1);
  })(root, 0);
  assert.equal(exts.length, externals);
  // nothing under the cut is deeper than needed: the served root is a small fraction of the tree
  assert.ok(JSON.stringify(root).length < before.length / 5, `${JSON.stringify(root).length} of ${before.length} bytes`);
});

test('every dataset is reached exactly once through the cut root and its subtrees, cut again the same way', async () => {
  const { urls, known } = grid(48);
  const ts = await buildAggregate(urls, { nest: 'geodetic', known });
  const seen = new Map();
  let tilesets = 0, maxHops = 0;
  const visit = (tileset, hops) => {
    tilesets++;
    maxHops = Math.max(maxHops, hops);
    (function walk(t) {
      if (isExternal(t)) {
        const key = new URL(t.content.uri).searchParams.get('cell');
        const node = subtreeOf(ts.root, key);
        assert.ok(node, `no group ${key}`);
        const sub = subtreeTileset(ts, node, 2, uriFor, key);
        // the parent's external tile and the subtree's root agree on volume, error and count
        assert.deepEqual(sub.root.boundingVolume, t.boundingVolume);
        assert.equal(sub.root.geometricError, t.geometricError);
        assert.equal(sub.geometricError, 2 * t.geometricError);
        assert.equal(sub.asset.extras.cell, key);
        assert.equal(sub.asset.extras.datasets, t.extras.datasets);
        visit(sub, hops + 1);
        return;
      }
      if (!t.children) { seen.set(t.content.uri, (seen.get(t.content.uri) ?? 0) + 1); return; }
      for (const c of t.children) walk(c);
    })(tileset.root);
  };
  visit({ ...ts, root: cutTree(ts.root, 2, uriFor).root }, 0);
  assert.equal(seen.size, 2304);
  assert.ok([...seen.values()].every((n) => n === 1));
  assert.ok(tilesets > 1 && maxHops >= 2, `${tilesets} tilesets, ${maxHops} hops`);
  assert.equal(subtreeOf(ts.root, 'nowhere'), null);
});
