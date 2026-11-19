/**
 * lodMeta.js (sog-to-3dtiles) — what a streamed SOG's `lod-meta.json` says about its tree, shared by the offline
 * converter (index.js) and the live route (tile-server/sog-live.js).
 *
 * Geometric error of a leaf's LOD chain. The tree's own errors are anchored to the root bound's diagonal and halved at
 * every step down the tree (`geAt(depth)`); a LOD step divides it by √2 (`LEVEL_RATIO`): each level of a streamed SOG
 * is a 50 % decimation of the previous one, and halving the count on the surfaces splats cover grows their spacing by
 * √2, not 2. A `lod-meta.json` with `lodErrors: true`
 * (splat-transform 3.3 to 3.7 wrote them; 3.8 and later omit them, SuperSplat may write them) gives every leaf an
 * `errors` array, one value per LOD level, finite, non-negative and non-decreasing with the level, of which only the
 * relative magnitudes mean anything. When the leaf has them, its coarsest level keeps the geometric error of its depth
 * and each finer level takes its share of it: `ge(level) = geAt(depth) × errors[level] / errors[coarsest]`, so the
 * finest level, whose error is 0 as a rule, refines to geometric error 0, as a 3D Tiles leaf does. The √2 step stays
 * for a leaf without usable errors (missing, not numbers, or a coarsest error of 0).
 */

/** The ratio between the geometric errors of two consecutive LOD levels: a level holds half the previous one's splats. */
export const LEVEL_RATIO = Math.SQRT1_2;

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
    const value = usable ? geAt(depth) * (errors[level] / errors[maxL]) : geAt(depth) * Math.pow(LEVEL_RATIO, maxL - level);
    const v = Math.min(value, above);   // a child never refines at a larger error than its parent
    ge.set(level, v);
    above = v;
  }
  return ge;
}

// ── The scene's up axis ──────────────────────────────────────────────────────────────────────────────────────────────
//
// A tile's box is turned Y-up→Z-up the way a client turns its glTF content, and the root transform turns both back
// (RX −90°), so a client ends up in the scene's NATIVE frame: a native Z-up scene stands upright. `up` names the native
// axis that is up for the others: 'y' (a Blender-style export, Shramko's Lublin: the city lay on its side) or '-y' (a
// 3DGS training left in the COLMAP frame). Offline `--up`, live `&up=`.
export const UP_AXES = ['z', 'y', '-y'];
export const upParam = (v) => (UP_AXES.includes(v) ? v : 'z');
/** The root transform (column-major) for a scene whose native up axis is `up`. */
export function upTransform(up) {
  if (up === 'y') return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];      // RX(+90) · RX(−90): the client's own Y-up→Z-up is exact
  if (up === '-y') return [1,0,0,0, 0,-1,0,0, 0,0,-1,0, 0,0,0,1];   // RX(−90) · RX(−90) = RX(180)
  return [1,0,0,0, 0,0,-1,0, 0,1,0,0, 0,0,0,1];                     // RX(−90): Y→−Z, Z→Y, undoing the client's turn
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
const NODE_GE_FACTOR = 0.1;   // a tile's geometric error is at most its node's bound diagonal × this, ÷ √2 per level below the coarsest
// … and at most SPACING_GE_FACTOR × the spacing of its splats, √(largest face of its bound ÷ its splats): what a tile
// lacks next to its children is detail finer than that spacing, whatever its size. With the size rule alone a scene of
// few levels (funes.world's Pompeii: 2 levels, tiles 600 m across) refined to its finest level, 3 M splats, as soon as
// it was framed whole. At the usual 16 px error target a tile now refines when its splats stand 2 px apart.
const SPACING_GE_FACTOR = 8;

// ── Stray leaves ─────────────────────────────────────────────────────────────────────────────────────────────────────
//
// A 3DGS training leaves splats far from the scene: floaters, or a whole sky box (funes.world's Pompeii: a site 1.5 km
// across inside a 40 km cube of sky holding 18 % of its splats). The tree's bounds enclose them, so every box up the
// tree is the cube: a camera at the site is INSIDE every tile's box, where the screen-space error is infinite and the
// whole scene refines to its finest level at once, and a viewer frames the cube, not the site. The leaves of
// splat-transform's tree hold about as many splats each, so a leaf of strays is far larger than the others: a leaf is
// STRAY when its diagonal is over STRAY_FACTOR × the median leaf diagonal (weighted by splats). A tile's box is then the
// bound of the leaves under it that are not stray (its own bound when all are): the strays are still in its content,
// and drawn with it, but no longer size it. A tree of under STRAY_MIN_LEAVES leaves has no strays.
const STRAY_FACTOR = 4, STRAY_MIN_LEAVES = 16;
const diagonalOf = (b) => Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1e-3;
const leafSplats = (leaf) => Object.values(leaf.lods ?? {}).reduce((n, run) => n + (run.count ?? 0), 0);
function leavesOf(node, out = []) {
  if (node.children) { for (const ch of node.children) leavesOf(ch, out); return out; }
  out.push(node);
  return out;
}
/** The value of `items` (`[value, weight]` pairs) below which the share `q` of the weight lies. */
function weightedQuantile(items, q) {
  const sorted = items.filter(([, w]) => w > 0).sort((a, b) => a[0] - b[0]);
  if (!sorted.length) return NaN;
  const total = sorted.reduce((n, [, w]) => n + w, 0);
  let acc = 0;
  for (const [v, w] of sorted) { acc += w; if (acc >= q * total) return v; }
  return sorted[sorted.length - 1][0];
}

/**
 * A function giving a node's bound without its stray leaves: `{ min, max, stray }`, `stray` true when every leaf under
 * the node is stray (the bound is then the node's own).
 * @param {object} tree  `lod-meta.json`'s `tree`
 * @returns {((node:object) => {min:number[], max:number[], stray:boolean}) & { isStray:(leaf:object) => boolean }}
 *   `isStray`: is this leaf a stray one
 */
export function strayFreeBounds(tree) {
  const leaves = leavesOf(tree);
  const stray = new Set();
  if (leaves.length >= STRAY_MIN_LEAVES) {
    const limit = STRAY_FACTOR * weightedQuantile(leaves.map((l) => [diagonalOf(l.bound), leafSplats(l)]), 0.5);
    for (const l of leaves) if (diagonalOf(l.bound) > limit) stray.add(l);
    if (stray.size === leaves.length) stray.clear();
  }
  const memo = new WeakMap();
  const of = (node) => {
    let b = memo.get(node);
    if (b) return b;
    if (!node.children) b = { min: node.bound.min, max: node.bound.max, stray: stray.has(node) };
    else {
      const kept = node.children.map(of).filter((c) => !c.stray);
      b = kept.length
        ? { min: [0, 1, 2].map((a) => Math.min(...kept.map((c) => c.min[a]))), max: [0, 1, 2].map((a) => Math.max(...kept.map((c) => c.max[a]))), stray: false }
        : { min: node.bound.min, max: node.bound.max, stray: true };
    }
    memo.set(node, b);
    return b;
  };
  of.isStray = (leaf) => stray.has(leaf);
  return of;
}

/**
 * Where a scene stands, read off its tree: the median of its leaves' centres (weighted by splats, strays left out) on
 * each native axis, and `low`, the height a tenth of them lie under on each axis and its opposite, a stand-in for the
 * ground under whichever axis is up. Used to anchor a scene placed on the globe (`&center=1`).
 * @returns {{ centre:number[], low:number[], high:number[] }}
 */
export function sceneAnchor(tree) {
  const bounds = strayFreeBounds(tree);
  const leaves = leavesOf(tree).filter((l) => !bounds(l).stray);
  const axis = (a, q) => weightedQuantile(leaves.map((l) => [(l.bound.min[a] + l.bound.max[a]) / 2, leafSplats(l)]), q);
  return { centre: [0, 1, 2].map((a) => axis(a, 0.5)), low: [0, 1, 2].map((a) => axis(a, 0.1)), high: [0, 1, 2].map((a) => axis(a, 0.9)) };
}

/** The node at `path` (one child index per character, '' the root), or null. */
export function lodNodeAt(tree, path) {
  let node = tree;
  for (const ch of path) { node = node?.children?.[Number(ch)]; if (!node) return null; }
  return node;
}

/**
 * The runs `{ file, offset, count }` of LOD `level` under a node, in leaf order, neighbours in one file joined.
 * `skip`: leaves left out (the stray ones, when a scene is served without them).
 */
export function lodRunsUnder(node, level, out = [], skip = null) {
  if (node.children) { for (const ch of node.children) lodRunsUnder(ch, level, out, skip); return out; }
  if (skip?.(node)) return out;
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
 * @param {{ box:(min:number[], max:number[]) => number[], content:(runs:object[], path:string, level:number, stride?:number) => object, dropStrays?:boolean }} make
 *   `box` a node's bound as a 3D Tiles box; `content` the tile content of a node's runs at a level, every `stride`-th
 *   splat of them when the root is a thinned preview (see below); `dropStrays`: the stray leaves (above) are left out
 *   of the tiles altogether, for a scene set on a globe, where a sky box hides the globe and the scene itself
 * @returns {object} the root tile (no transform)
 */
export function collapseLodTree(tree, lodLevels, budget, { box, content, dropStrays = false }) {
  const maxLevel = lodLevels - 1;
  const bounds = strayFreeBounds(tree);            // a tile's box and error come from its leaves that are not strays
  const skip = dropStrays ? bounds.isStray : null;
  const memo = new WeakMap();
  const counts = (node) => {                       // per-level splat counts under a node
    let c = memo.get(node);
    if (c) return c;
    c = {};
    if (node.children) for (const ch of node.children) for (const [L, n] of Object.entries(counts(ch))) c[L] = (c[L] ?? 0) + n;
    else if (!skip?.(node)) for (const [L, run] of Object.entries(node.lods ?? {})) c[L] = run.count;
    memo.set(node, c);
    return c;
  };
  const total = (node) => Object.values(counts(node)).reduce((a, b) => a + b, 0);
  const fits = (node, L) => !node.children || (counts(node)[L] ?? 0) <= budget;
  // [node, path] of the shallowest nodes under `node` that fit the budget at level L
  const emitters = (node, path, L) => (fits(node, L) ? [[node, path]]
    : node.children.flatMap((ch, i) => (total(ch) ? emitters(ch, path + i, L) : [])));
  const diagonal = (b) => Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1e-3;
  const spacing = (node, n) => {                   // of n splats spread over the largest face of the node's bound
    const b = bounds(node);
    const e = [0, 1, 2].map((a) => Math.max(b.max[a] - b.min[a], 1e-6)).sort((p, q) => q - p);
    return n > 0 ? Math.sqrt((e[0] * e[1]) / n) : Infinity;
  };
  const geOf = (node, L, stride = 1) => Math.min(
    diagonal(bounds(node)) * NODE_GE_FACTOR * Math.pow(LEVEL_RATIO, maxLevel - L) * Math.sqrt(stride),
    SPACING_GE_FACTOR * spacing(node, (counts(node)[String(L)] ?? 0) / stride));
  const tileAt = (node, path, L, above = Infinity) => {   // a node that fits the budget at level L; `above`: its parent's error
    const b = bounds(node);
    const tile = { boundingVolume: { box: box(b.min, b.max) }, geometricError: Math.min(geOf(node, L), above), refine: 'REPLACE' };
    const runs = lodRunsUnder(node, L, [], skip);
    if (runs.length) tile.content = content(runs, path, L);
    if (L > 0) {
      const kids = emitters(node, path, String(L - 1)).map(([ch, p]) => tileAt(ch, p, L - 1, tile.geometricError)).filter((t) => t.content || t.children?.length);
      if (kids.length) tile.children = kids;
    }
    return tile;
  };
  if (fits(tree, String(maxLevel))) return tileAt(tree, '', maxLevel);
  // The coarsest level alone is over the budget (Jastrzębia Góra, 106 M: 838 k splats, 14 tiles and 26 MB before a
  // first view): the root carries a PREVIEW of it, every stride-th splat so that it fits the budget, which the level's
  // own tiles replace. The runs are in leaf (Morton) order, so a stride is a spatially uniform subsample; the thinned
  // splats are enlarged by √stride (thinSplats) to keep covering the surface, and the root's error grows the same.
  const coarse = counts(tree)[String(maxLevel)] ?? 0;
  const stride = Math.max(2, Math.ceil(coarse / budget));
  const rootBound = bounds(tree);
  const root = { boundingVolume: { box: box(rootBound.min, rootBound.max) }, geometricError: geOf(tree, maxLevel, stride), refine: 'REPLACE' };
  root.children = emitters(tree, '', String(maxLevel)).map(([ch, p]) => tileAt(ch, p, maxLevel, root.geometricError));
  const runs = lodRunsUnder(tree, maxLevel, [], skip);
  if (runs.length) root.content = content(runs, '', maxLevel, stride);
  return root;
}

/** Several runs' spherical-harmonic bands end to end (`extractRange`'s `sh`); null when any run has none, a band any run lacks is dropped with those above it. */
export function concatSh(parts) {
  if (parts.some((p) => !p.sh)) return null;
  if (parts.length === 1) return parts[0].sh;
  const out = {};
  for (const key of ['sh1', 'sh2', 'sh3']) {
    if (parts.some((p) => !p.sh[key])) break;
    const col = new Float32Array(parts.reduce((n, p) => n + p.sh[key].length, 0));
    let o = 0;
    for (const p of parts) { col.set(p.sh[key], o); o += p.sh[key].length; }
    out[key] = col;
  }
  return out.sh1 ? out : null;
}

/**
 * Every `stride`-th splat of decoded arrays (`extractRange`'s shape: positions ×3, alphas ×1, rgb ×3, scales ×3 linear,
 * rotations ×4), scales × √stride so the thinned set still covers the surface. Returns [arrays, count].
 */
export function thinSplats(a, count, stride) {
  if (!(stride > 1)) return [a, count];
  const n = Math.ceil(count / stride), grow = Math.sqrt(stride), out = {};
  for (const [key, w] of [['positions', 3], ['alphas', 1], ['rgb', 3], ['scales', 3], ['rotations', 4]]) {
    if (!a[key]) { out[key] = null; continue; }
    const src = a[key], col = new Float32Array(n * w);
    for (let i = 0, j = 0; j < n; i += stride, j++) for (let k = 0; k < w; k++) col[j * w + k] = src[i * w + k];
    if (key === 'scales') for (let k = 0; k < col.length; k++) col[k] *= grow;
    out[key] = col;
  }
  if (a.sh) {                                   // the bands of the splats kept, as they are
    out.sh = {};
    for (const [key, src] of Object.entries(a.sh)) {
      const w = src.length / count, col = new Float32Array(n * w);
      for (let i = 0, j = 0; j < n; i += stride, j++) col.set(src.subarray(i * w, i * w + w), j * w);
      out.sh[key] = col;
    }
  }
  return [out, n];
}
