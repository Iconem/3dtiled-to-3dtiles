/**
 * octree.js — shared 3D Tiles octree tileset builders for the live adapters.
 *
 * COPC and Potree both emit a tiny implicit-OCTREE root whose only differences are the box, the
 * geometric errors, and the max level. One builder, parameterized, so the two adapters can't drift.
 * (Subtree buffers themselves come from core/tiling.js buildSubtreeBuffer.)
 */

/**
 * Implicit-OCTREE tileset: one root with an implicitTiling block + `{level}-{x}-{y}-{z}` content and
 * subtree templates. Subtrees are generated on the fly by the adapter from its availability set.
 * @param {object} o
 * @param {number[]} o.box                 12-number 3D Tiles box (relative to origin)
 * @param {number}   o.rootGeometricError  tileset.geometricError
 * @param {number}   o.contentGeometricError root tile geometricError
 * @param {number}   o.maxLevel            deepest available level (availableLevels = maxLevel+1)
 * @param {number}   o.subtreeLevels
 * @param {number[]=} o.transform          root ENU→ECEF transform (omitted if null)
 * @param {string}   o.urlParam            raw source URL (encoded into the templates)
 * @param {string=}  o.refine              'ADD' (default) | 'REPLACE'
 */
export function buildImplicitTileset({ box, rootGeometricError, contentGeometricError, maxLevel, subtreeLevels, transform, urlParam, refine = 'ADD' }) {
  const enc = encodeURIComponent(urlParam);
  const root = {
    boundingVolume: { box },
    refine, geometricError: contentGeometricError,
    implicitTiling: {
      subdivisionScheme: 'OCTREE', availableLevels: maxLevel + 1, subtreeLevels,
      subtrees: { uri: `subtrees/{level}-{x}-{y}-{z}.subtree?url=${enc}` },
    },
    content: { uri: `tile/{level}-{x}-{y}-{z}.glb?url=${enc}` },
  };
  if (transform) root.transform = transform;
  return { asset: { version: '1.1' }, geometricError: rootGeometricError, root, extensionsUsed: ['3DTILES_content_gltf'] };
}
