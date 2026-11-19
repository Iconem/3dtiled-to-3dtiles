// The streamed-SOG tree collapsed per LOD level (lodMeta.js): every splat of every level lands in exactly one tile,
// no tile of splittable nodes exceeds the budget, a merged tile names a node the live route finds again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseLodTree, lodNodeAt, lodRunsUnder, strayFreeBounds, sceneAnchor } from '../src/lodMeta.js';

/** A full binary tree `depth` deep; every leaf has `levels` runs, level L of 2^(levels-1-L)... reversed: level 0 the largest. */
function scene(depth, levels, base = 64) {
  let offset = new Array(levels).fill(0);
  const leaf = (x) => ({ bound: { min: [x, 0, 0], max: [x + 1, 1, 1] },
    lods: Object.fromEntries(Array.from({ length: levels }, (_, L) => { const count = base >> L; const run = { file: L, offset: offset[L], count }; offset[L] += count; return [L, run]; })) });
  const node = (d, x) => (d === 0 ? leaf(x) : (() => { const w = 2 ** (d - 1); const a = node(d - 1, x), b = node(d - 1, x + w); return { bound: { min: a.bound.min, max: b.bound.max }, children: [a, b] }; })());
  return { tree: node(depth, 0), lodLevels: levels };
}
const box = (min, max) => [...min, ...max];

test('every run of every level is in exactly one tile, and budgets hold', () => {
  const { tree, lodLevels } = scene(6, 4);            // 64 leaves; level 0: 64 splats a leaf, level 3: 8
  const budget = 200;
  const seen = [];
  const root = collapseLodTree(tree, lodLevels, budget, { box, content: (runs, path, level, stride = 1) => { seen.push({ runs, path, level, stride }); return { uri: `m${path}_${level}${stride > 1 ? `s${stride}` : ''}` }; } });
  for (let L = 0; L < lodLevels; L++) {
    const total = seen.filter((s) => s.level === L && s.stride === 1).reduce((n, s) => n + s.runs.reduce((m, r) => m + r.count, 0), 0);
    assert.equal(total, 64 * (64 >> L), `level ${L}`);
  }
  for (const s of seen) assert.ok(Math.ceil(s.runs.reduce((n, r) => n + r.count, 0) / s.stride) <= budget);
  // the coarsest level: 512 splats in all, so 4 tiles of 128 under a root that previews them, every 3rd splat (171 ≤ 200)
  assert.equal(root.content.uri, 'm_3s3');
  assert.equal(root.children.length, 4);
  assert.ok(root.children.every((c) => c.geometricError < root.geometricError), 'the preview refines into the level');
  // far fewer tiles than the 1:1 mapping (64 leaves × 4 levels + 63 interior)
  let tiles = 0; (function walk(t) { tiles++; (t.children ?? []).forEach(walk); })(root);
  assert.ok(tiles < 64 * 4, `${tiles} tiles`);
  // geometric errors never grow downwards
  (function walk(t) { for (const c of t.children ?? []) { assert.ok(c.geometricError <= t.geometricError + 1e-9); walk(c); } })(root);
});

test('a merged tile is found again from its path and level', () => {
  const { tree, lodLevels } = scene(5, 3);
  collapseLodTree(tree, lodLevels, 100, { box, content: (runs, path, level) => {
    assert.deepEqual(lodRunsUnder(lodNodeAt(tree, path), level), runs);
    return { uri: 'x' };
  } });
  assert.equal(lodNodeAt(tree, '9'), null);
});

test('neighbouring runs of one file are joined; a tree that fits is one chain', () => {
  const { tree, lodLevels } = scene(3, 2);
  const runs = lodRunsUnder(tree, 0);
  assert.deepEqual(runs, [{ file: 0, offset: 0, count: 8 * 64 }]);
  const root = collapseLodTree(tree, lodLevels, 1e9, { box, content: (r) => ({ uri: String(r.length) }) });
  assert.ok(root.content && root.children.length === 1 && !root.children[0].children);
});

// A scene with stray leaves: 31 leaves side by side along X, one unit each, and one leaf of floaters 1000 units wide.
function strayScene() {
  const { tree } = scene(5, 2);                       // 32 leaves, x from 0 to 32
  const far = lodNodeAt(tree, '11111');
  far.bound = { min: [31, -500, -500], max: [1031, 500, 500] };
  const grow = (n) => { if (!n.children) return n.bound; const bs = n.children.map(grow); n.bound = { min: [0, 1, 2].map((a) => Math.min(...bs.map((b) => b.min[a]))), max: [0, 1, 2].map((a) => Math.max(...bs.map((b) => b.max[a]))) }; return n.bound; };
  grow(tree);
  return { tree, far };
}

test('a stray leaf does not size the boxes above it', () => {
  const { tree, far } = strayScene();
  const bounds = strayFreeBounds(tree);
  assert.equal(bounds.isStray(far), true);
  assert.deepEqual(bounds(tree).max, [31, 1, 1], 'the root is the 31 leaves that are not stray');
  assert.equal(bounds(far).stray, true);
  const root = collapseLodTree(tree, 2, 1e9, { box, content: (r) => ({ uri: String(r.length) }) });
  assert.deepEqual(root.boundingVolume.box, [0, 0, 0, 31, 1, 1]);
  // its splats are still in the tile, unless they are dropped
  const all = lodRunsUnder(tree, 0).reduce((n, r) => n + r.count, 0);
  const kept = lodRunsUnder(tree, 0, [], bounds.isStray).reduce((n, r) => n + r.count, 0);
  assert.equal(all, 32 * 64);
  assert.equal(kept, 31 * 64);
  const seen = [];
  collapseLodTree(tree, 2, 1e9, { box, dropStrays: true, content: (runs, path, level) => { seen.push({ runs, level }); return { uri: 'x' }; } });
  assert.equal(seen.find((s) => s.level === 0).runs.reduce((n, r) => n + r.count, 0), 31 * 64);
});

test('a small tree has no strays, and the anchor is the median of the leaves', () => {
  const { tree } = scene(3, 2);                       // 8 leaves: under the minimum
  lodNodeAt(tree, '111').bound = { min: [7, -500, -500], max: [1007, 500, 500] };
  assert.equal(strayFreeBounds(tree).isStray(lodNodeAt(tree, '111')), false);
  const { tree: big } = strayScene();
  const { centre } = sceneAnchor(big);
  assert.ok(centre[0] > 14 && centre[0] < 17, `x median ${centre[0]}`);
  assert.equal(centre[1], 0.5);
});

test('a tile\'s error is at most 8 × the spacing of its splats', () => {
  // one leaf of 1 000 000 splats over a 100 × 100 × 1 slab: spacing 0.1, so an error of 0.8, not the 14 of its diagonal
  const leaf = (x) => ({ bound: { min: [x, 0, 0], max: [x + 100, 100, 1] }, lods: { 0: { file: 0, offset: 0, count: 2e6 }, 1: { file: 1, offset: 0, count: 1e6 } } });
  const a = leaf(0), b = leaf(100);
  const tree = { bound: { min: [0, 0, 0], max: [200, 100, 1] }, children: [a, b] };
  const root = collapseLodTree(tree, 2, 1e6, { box, content: () => ({ uri: 'x' }) });
  const coarse = root.children[0];
  assert.ok(Math.abs(coarse.geometricError - 0.8) < 1e-9, `got ${coarse.geometricError}`);
  assert.ok(root.geometricError >= coarse.geometricError);
  assert.ok(coarse.children.every((c) => c.geometricError <= coarse.geometricError));
});
