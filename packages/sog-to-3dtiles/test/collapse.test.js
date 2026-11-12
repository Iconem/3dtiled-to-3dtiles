// The streamed-SOG tree collapsed per LOD level (lodMeta.js): every splat of every level lands in exactly one tile,
// no tile of splittable nodes exceeds the budget, a merged tile names a node the live route finds again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseLodTree, lodNodeAt, lodRunsUnder } from '../src/lodMeta.js';

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
  const root = collapseLodTree(tree, lodLevels, budget, { box, content: (runs, path, level) => { seen.push({ runs, path, level }); return { uri: `m${path}_${level}` }; } });
  for (let L = 0; L < lodLevels; L++) {
    const total = seen.filter((s) => s.level === L).reduce((n, s) => n + s.runs.reduce((m, r) => m + r.count, 0), 0);
    assert.equal(total, 64 * (64 >> L), `level ${L}`);
  }
  for (const s of seen) assert.ok(s.runs.reduce((n, r) => n + r.count, 0) <= budget);
  // the coarsest level: 512 splats in all, so 4 tiles of 128 under an empty root
  assert.equal(root.content, undefined);
  assert.equal(root.children.length, 4);
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
