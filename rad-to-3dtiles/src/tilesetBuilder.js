/**
 * tilesetBuilder.js  (rad-to-3dtiles)
 *
 * Builds a 3D Tiles 1.1 tileset.json from the RAD LoD node table.
 *
 * Uses EXPLICIT tiling (nested children[] arrays) because the RAD octree
 * uses variable fanout (base ~1.5, not strict power-of-2), which is
 * incompatible with 3DTILES_implicit_tiling's strict octree/quadtree.
 *
 * Refine: REPLACE — each RAD node stores DOWNSAMPLED REPRESENTATIVE splats
 * of its entire subtree. Children replace the parent's representation with
 * finer detail. This matches 3D Tiles REPLACE semantics.
 * (ADD would mean children add NEW content not present in the parent — wrong
 * for Gaussian splat LoD where the parent is a coarse approximation.)
 *
 * Geometric error: proportional to node.bounds.featureSize if available,
 * otherwise parent-halved. Each child must have strictly smaller error
 * than its parent.
 */

const GEOMETRIC_ERROR_SCALE    = 1.0;
const GEOMETRIC_ERROR_ROOT_DEFAULT = 1000;

/**
 * @param {object[]} nodes           BFS-ordered node array from buildNodeTable/collectNodes
 * @param {object}   [opts]
 * @param {string}   [opts.tileUriTemplate]  default: 'tiles/node_{index}.glb'
 * @param {number}   [opts.rootGeometricError]
 * @returns {object}  tileset JSON
 */
export function buildTileset(nodes, opts = {}) {
  const {
    tileUriTemplate    = 'tiles/node_{index}.glb',
    rootGeometricError = null,
    // geScale: global multiplier applied to every tile GE. Default 1 — raw
    //   featureSize GE is already the right magnitude (matches the reference
    //   3DGS-PLY-3DTiles-Converter). >1 over-refines (full detail everywhere).
    geScale = 1,
    // geLayer: layer-multiplier (reference `errorTargetLayerMultiplier`). Default 1.
    //   GE(d) = leafGE + (GE(d) − leafGE) × geLayer. 1 = natural halving per level.
    geLayer = 1,
  } = opts;

  if (!nodes.length) throw new Error('No nodes');

  // Index by nodeIndex for O(1) child lookup
  const byIndex = new Map(nodes.map(n => [n.nodeIndex, n]));

  // Assign depths via BFS from root
  const root = nodes.find(n => n.nodeIndex === 0) ?? nodes[0];
  assignDepths(root, byIndex);

  // Uniform-per-depth geometric error. Mirrors the 3DGS-PLY-3DTiles-Converter model
  // (geometric-error.js): every tile at a given LoD level shares one error, so
  // sibling tiles refine together. Per-NODE errors (each node's own featureSize)
  // vary within a level and make siblings pop in/out at different distances —
  // the cause of uneven tile selection. We anchor each level to the MEAN
  // featureSize at that depth (real splat size, like their leaf "sparsity + extent"
  // reference) and force it strictly decreasing with depth.
  const geByDepth = computeErrorByDepth(nodes);
  // Bake in the inspector's "Layer Multiplier" then "Geometric Error" scale.
  // Layer: GE(d) = leafGE + (GE(d) − leafGE) × geLayer  — stretches the depth range.
  // Scale: multiply every GE by geScale — raises the baseline to pixel-SSE units.
  applyGeModifiers(geByDepth, geScale, geLayer);
  const rootError = rootGeometricError
    ?? geByDepth.get(0)
    ?? geoError(root, null)
    ?? GEOMETRIC_ERROR_ROOT_DEFAULT;

  const visited = new Set(); // guard against cycles in malformed data

  function tile(node, parentError) {
    if (visited.has(node.nodeIndex)) return null;
    visited.add(node.nodeIndex);

    // Look up the level-uniform error for this node's depth.
    let error = geByDepth.get(node.depth);
    if (!(error > 0)) error = geoError(node, parentError); // fallback
    // Safety net for RAD's DAG-ish tree: a node can be emitted under a parent at
    // the same assigned depth (so equal error), which stalls REPLACE refinement.
    // Force a strict decrease on those rare edges (0 for Coit, ~3 for Tastier).
    if (parentError != null && error >= parentError) error = parentError * 0.5;
    const uri = tileUriTemplate.replace('{index}', node.nodeIndex ?? node.index);
    const t = {
      boundingVolume: boundingVolume(node), // own-splat AABB; expanded below to nest
      geometricError: error,
      refine: 'REPLACE',
      content: { uri }
    };

    // Prefer node.children[] (arbitrary list); fall back to childStart/childCount range.
    const childIds = node.children ?? (
      node.childCount > 0
        ? Array.from({ length: node.childCount }, (_, c) => node.childStart + c)
        : []
    );

    if (childIds.length > 0) {
      const children = childIds
        .map(id => byIndex.get(id))
        .filter(Boolean)
        .map(child => tile(child, error))
        .filter(Boolean);
      if (children.length) {
        t.children = children;
        // Nest: expand this tile's bounding volume to enclose every child box.
        // RAD's 1.5-fanout octree + the fact that splats are *shapes* (a merged
        // parent splat can be smaller than a child covering spatial outliers)
        // means per-node AABBs don't nest on their own — both CesiumJS and 3DTRJS
        // need parent ⊇ children for correct culling and SSE-based LoD selection.
        t.boundingVolume = { box: unionBoxes(t.boundingVolume.box, children) };
      }
    }

    return t;
  }

  const root3dt = tile(root, rootError * 2);
  const geSummary = [...geByDepth.entries()].map(([d, g]) => `${d}:${g.toFixed(3)}`).join(' ');
  console.log(`  [tileset] geometricError by depth → ${geSummary}`);

  // Root-node RX(180°) transform: flips the content upright in the tileset frame.
  // Applied only to the root — children inherit it automatically per the 3D Tiles spec.
  // Column-major 4×4 (glTF convention): RX(180°) = diag(1, −1, −1, 1).
  // This corrects the "up points down" artifact seen when loading RAD tilesets in
  // CesiumJS and 3DTilesRendererJS (the splat Y-up content comes out inverted after
  // the glTF→tileset-frame RX(+90°) the renderers apply).
  root3dt.transform = [
    1,  0,  0,  0,
    0, -1,  0,  0,
    0,  0, -1,  0,
    0,  0,  0,  1
  ];

  return {
    asset: { version: '1.1' },
    geometricError: rootError,
    root: root3dt
  };
}

/**
 * Mean featureSize per tree depth, forced strictly decreasing with depth so
 * REPLACE refinement converges. Uniform-per-depth = sibling tiles refine together.
 */
function computeErrorByDepth(nodes) {
  const sum = new Map(), cnt = new Map();
  let maxDepth = 0;
  for (const n of nodes) {
    if (typeof n.depth !== 'number') continue;
    if (n.depth > maxDepth) maxDepth = n.depth;
    const f = (typeof n.geometricError === 'number' && n.geometricError > 0) ? n.geometricError : null;
    if (f == null) continue;
    sum.set(n.depth, (sum.get(n.depth) || 0) + f);
    cnt.set(n.depth, (cnt.get(n.depth) || 0) + 1);
  }
  const byDepth = new Map();
  let prev = Infinity;
  for (let d = 0; d <= maxDepth; d++) {
    let g = cnt.get(d) ? sum.get(d) / cnt.get(d) : prev * 0.5;
    if (!(g < prev)) g = prev * 0.5; // enforce strict decrease across levels
    byDepth.set(d, g);
    prev = g;
  }
  return byDepth;
}

/**
 * Bake the inspector's Layer Multiplier and Geometric Error scale into geByDepth.
 * Layer stretch: GE(d) = leafGE + (GE(d) − leafGE) × layerMult
 * Global scale:  GE(d) *= geScale
 * Applied in-place so the root error and all child errors stay consistent.
 */
function applyGeModifiers(geByDepth, geScale, geLayer) {
  if (geScale === 1 && geLayer === 1) return;
  const maxDepth = Math.max(...geByDepth.keys());
  const leafGE   = geByDepth.get(maxDepth) ?? 0;
  for (const [d, g] of geByDepth) {
    const stretched = leafGE + (g - leafGE) * geLayer;
    geByDepth.set(d, stretched * geScale);
  }
}

/** Axis-aligned min/max corners of a 3D-Tiles `box` array (axis-aligned only). */
function aabbOf(box) {
  const hx = Math.abs(box[3]), hy = Math.abs(box[7]), hz = Math.abs(box[11]);
  return {
    min: [box[0] - hx, box[1] - hy, box[2] - hz],
    max: [box[0] + hx, box[1] + hy, box[2] + hz],
  };
}

/** Union an own box with all child tile boxes → enclosing axis-aligned `box`. */
function unionBoxes(ownBox, childTiles) {
  const { min, max } = aabbOf(ownBox);
  for (const c of childTiles) {
    const a = aabbOf(c.boundingVolume.box);
    for (let k = 0; k < 3; k++) {
      if (a.min[k] < min[k]) min[k] = a.min[k];
      if (a.max[k] > max[k]) max[k] = a.max[k];
    }
  }
  const cx = (min[0]+max[0])/2, cy = (min[1]+max[1])/2, cz = (min[2]+max[2])/2;
  const hx = Math.max((max[0]-min[0])/2, 0.001);
  const hy = Math.max((max[1]-min[1])/2, 0.001);
  const hz = Math.max((max[2]-min[2])/2, 0.001);
  return [cx,cy,cz, hx,0,0, 0,hy,0, 0,0,hz];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function assignDepths(root, byIndex) {
  root.depth = 0;
  const seen  = new Set([root.nodeIndex]);
  const queue = [root];
  while (queue.length) {
    const n = queue.shift();
    const childIds = n.children ?? (
      n.childCount > 0
        ? Array.from({ length: n.childCount }, (_, c) => n.childStart + c)
        : []
    );
    for (const id of childIds) {
      if (seen.has(id)) continue;
      const child = byIndex.get(id);
      if (child) { seen.add(id); child.depth = n.depth + 1; queue.push(child); }
    }
  }
}

/**
 * bounds may be:
 *   [cx, cy, cz, hx, hy, hz]   — RAD header JSON (centre + half-extents)
 *   { cx, cy, cz, featureSize } — SparkJS forEachNode
 *   null                        — fallback to unit box
 *
 * Bounds are computed from the glTF (Y-up) splat positions, but a 3D Tiles tile's
 * boundingVolume lives in the TILESET frame, which is Z-up: both CesiumJS and
 * 3DTilesRendererJS rotate glTF content by RX(+90°) → (x, y, z) → (x, −z, y).
 * Without matching that here, the boxes appear rotated ~90° off the rendered
 * splats. So emit every box already rotated into the Z-up tileset frame.
 */
function yUpBoxToZUp(cx, cy, cz, hx, hy, hz) {
  // RX(+90°): centre (cx,cy,cz)→(cx,−cz,cy); axis-aligned half-extents permute y↔z.
  return [cx, -cz, cy, hx, 0, 0, 0, hz, 0, 0, 0, hy];
}

function boundingVolume(node) {
  const b = node.bounds;
  if (!b) return { box: [0,0,0, 1,0,0, 0,1,0, 0,0,1] };
  if (Array.isArray(b) && b.length >= 6) {
    const [cx,cy,cz,hx,hy,hz] = b;
    return { box: yUpBoxToZUp(cx, cy, cz, hx, hy, hz) };
  }
  if (typeof b === 'object' && 'cx' in b) {
    const h = b.featureSize ?? 1;
    return { box: yUpBoxToZUp(b.cx, b.cy, b.cz, h, h, h) };
  }
  return { box: [0,0,0, 1,0,0, 0,1,0, 0,0,1] };
}

function geoError(node, parentError) {
  // Preferred: the featureSize-based rendering error computed from the node's
  // actual splat scales (set by index.js as node.geometricError).
  if (typeof node.geometricError === 'number' && node.geometricError > 0) {
    return node.geometricError * GEOMETRIC_ERROR_SCALE;
  }
  // Fallbacks for callers that only supply bounds.
  const b = node.bounds;
  if (b && typeof b === 'object' && 'featureSize' in b) {
    return b.featureSize * GEOMETRIC_ERROR_SCALE;
  }
  if (Array.isArray(b) && b.length >= 6) {
    return Math.max(b[3], b[4], b[5]) * GEOMETRIC_ERROR_SCALE;
  }
  return parentError != null ? parentError / 2 : GEOMETRIC_ERROR_ROOT_DEFAULT;
}
