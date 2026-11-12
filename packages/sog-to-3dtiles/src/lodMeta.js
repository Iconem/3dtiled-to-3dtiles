/**
 * lodMeta.js (sog-to-3dtiles) — what a streamed SOG's `lod-meta.json` says about its tree, shared by the offline
 * converter (index.js) and the live route (tile-server/sog-live.js).
 *
 * Geometric error of a leaf's LOD chain. The tree's own errors are anchored to the root bound's diagonal and halved at
 * every step down, interior levels and LOD steps alike (`geAt(depth)`). A `lod-meta.json` with `lodErrors: true`
 * (splat-transform 3.3 to 3.7 wrote them; 3.8 and later omit them, SuperSplat may write them) gives every leaf an
 * `errors` array, one value per LOD level, finite, non-negative and non-decreasing with the level, of which only the
 * relative magnitudes mean anything. When the leaf has them, its coarsest level keeps the geometric error of its depth
 * and each finer level takes its share of it: `ge(level) = geAt(depth) × errors[level] / errors[coarsest]`, so the
 * finest level, whose error is 0 as a rule, refines to geometric error 0, as a 3D Tiles leaf does. The halving stays
 * for a leaf without usable errors (missing, not numbers, or a coarsest error of 0).
 */

/**
 * The geometric error of each LOD level of a leaf.
 * @param {{lods?:object, errors?:number[]}} node  the leaf
 * @param {number[]} levels  its LOD levels, ascending (0 = finest)
 * @param {number} depth  the leaf's depth in the tree
 * @param {(depth:number) => number} geAt  the tree's geometric error at a depth
 * @param {boolean} [lodErrors]  `lod-meta.json`'s `lodErrors`
 * @returns {Map<number, number>} level → geometric error
 */
export function lodGeometricErrors(node, levels, depth, geAt, lodErrors = false) {
  const maxL = levels[levels.length - 1];
  const errors = lodErrors && Array.isArray(node.errors) ? node.errors : null;
  const usable = errors && levels.every((l) => Number.isFinite(errors[l]) && errors[l] >= 0) && errors[maxL] > 0;
  const ge = new Map();
  let above = Infinity;
  for (let k = levels.length - 1; k >= 0; k--) {
    const level = levels[k];
    const value = usable ? geAt(depth) * (errors[level] / errors[maxL]) : geAt(depth + (maxL - level));
    const v = Math.min(value, above);   // a child never refines at a larger error than its parent
    ge.set(level, v);
    above = v;
  }
  return ge;
}

// ── The tree collapsed per LOD level with a splat budget ─────────────────────────────────────────────────────────────
//
// splat-transform's tree is a binary k-d tree whose LEAVES hold one run of every LOD level. Mapped 1:1, a big scene
// (Shramko's Lublin: 259 M splats at level 0, 31 668 leaves 15 deep, 13 levels) is 400 000 tiles, the coarsest level
// alone 31 668 tiles of ~50 splats under 14 empty levels: a 100 MB tileset.json, and a renderer that refines all of
// it before it draws anything. Collapsed, the tiles of a level are the SHALLOWEST nodes whose splats of that level fit
// the budget, each holding the runs of all its leaves; a tile of level L has as children the tiles of level L−1 under
// it. The same cap on the size of a root that /aggregate's depth cut and vpc-split.mjs put on a mosaic.

export const DEFAULT_SPLAT_BUDGET = 100_000;
const NODE_GE_FACTOR = 0.1;   // a tile's geometric error: its node's bound diagonal × this, halved per level below the coarsest
const LEVEL_RATIO = 0.5;

/** The node at `path` (one child index per character, '' the root), or null. */
export function lodNodeAt(tree, path) {
  let node = tree;
  for (const ch of path) { node = node?.children?.[Number(ch)]; if (!node) return null; }
  return node;
}

/** The runs `{ file, offset, count }` of LOD `level` under a node, in leaf order, neighbours in one file joined. */
export function lodRunsUnder(node, level, out = []) {
  if (node.children) { for (const ch of node.children) lodRunsUnder(ch, level, out); return out; }
  const run = node.lods?.[String(level)];
  if (!run?.count) return out;
  const last = out[out.length - 1];
  if (last && last.file === run.file && last.offset + last.count === run.offset) last.count += run.count;
  else out.push({ file: run.file, offset: run.offset, count: run.count });
  return out;
}

/**
 * The 3D Tiles tree of a streamed SOG, collapsed per LOD level.
 * @param {object} tree  `lod-meta.json`'s `tree`
 * @param {number} lodLevels  how many LOD levels the scene has
 * @param {number} budget  splats of one level a tile may hold (> 0)
 * @param {{ box:(min:number[], max:number[]) => number[], content:(runs:object[], path:string, level:number) => object }} make
 *   `box` a node's bound as a 3D Tiles box; `content` the tile content of a node's runs at a level
 * @returns {object} the root tile (no transform)
 */
export function collapseLodTree(tree, lodLevels, budget, { box, content }) {
  const maxLevel = lodLevels - 1;
  const memo = new WeakMap();
  const counts = (node) => {                       // per-level splat counts under a node
    let c = memo.get(node);
    if (c) return c;
    c = {};
    if (node.children) for (const ch of node.children) for (const [L, n] of Object.entries(counts(ch))) c[L] = (c[L] ?? 0) + n;
    else for (const [L, run] of Object.entries(node.lods ?? {})) c[L] = run.count;
    memo.set(node, c);
    return c;
  };
  const total = (node) => Object.values(counts(node)).reduce((a, b) => a + b, 0);
  const fits = (node, L) => !node.children || (counts(node)[L] ?? 0) <= budget;
  // [node, path] of the shallowest nodes under `node` that fit the budget at level L
  const emitters = (node, path, L) => (fits(node, L) ? [[node, path]]
    : node.children.flatMap((ch, i) => (total(ch) ? emitters(ch, path + i, L) : [])));
  const diagonal = (b) => Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1e-3;
  const geOf = (node, L) => diagonal(node.bound) * NODE_GE_FACTOR * Math.pow(LEVEL_RATIO, maxLevel - L);
  const tileAt = (node, path, L) => {              // a node that fits the budget at level L
    const tile = { boundingVolume: { box: box(node.bound.min, node.bound.max) }, geometricError: geOf(node, L), refine: 'REPLACE' };
    const runs = lodRunsUnder(node, L);
    if (runs.length) tile.content = content(runs, path, L);
    if (L > 0) {
      const kids = emitters(node, path, String(L - 1)).map(([ch, p]) => tileAt(ch, p, L - 1)).filter((t) => t.content || t.children?.length);
      if (kids.length) tile.children = kids;
    }
    return tile;
  };
  if (fits(tree, String(maxLevel))) return tileAt(tree, '', maxLevel);
  return { boundingVolume: { box: box(tree.bound.min, tree.bound.max) }, geometricError: geOf(tree, maxLevel), refine: 'REPLACE',
           children: emitters(tree, '', String(maxLevel)).map(([ch, p]) => tileAt(ch, p, maxLevel)) };
}
