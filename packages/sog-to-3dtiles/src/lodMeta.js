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
