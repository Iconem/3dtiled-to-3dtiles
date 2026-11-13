/**
 * nexus-tileset.js — a Nexus index → a 3D Tiles tileset, shared by the offline converter (index.js) and the live adapter
 * (tile-server/nexus-live.js), which differ only in the content URIs.
 *
 * A Nexus file is a DAG, not a tree: a finer node is named by the patches of several coarser nodes (gargoyle: 171 of
 * 187 nodes have more than one parent, up to 10). The viewer draws a node while its error is above the target, and a
 * coarser node draws only the patches whose finer node is not drawn, so a node is on screen once whatever the number
 * of its parents. 3D Tiles has no such thing: a tile has one parent, and `REPLACE` swaps the parent's content for
 * all of its children. Two mappings are offered.
 *
 * `dag: 'levels'` (the default) cuts the DAG by level. Each level of a Nexus file is a complete mesh of the whole
 * model at one resolution, partitioned into nodes (nxsbuild simplifies level by level), so showing all the nodes of
 * one level and none of another has no crack and no overlap. The tree is a chain of contentless level tiles
 * L0 → L1 → …, and under Lk every node of level k as a tile with content. All the tiles that must switch together
 * (the nodes of level k, and L(k+1)) are given the SAME bounding volume (the model's sphere) and the SAME geometric
 * error (8 × the largest node error of level k, see geScale below), so a client decides them in the same frame. A
 * node tile disappears when refined through one empty child (no content, no children); the last level's nodes are
 * leaves. Each node tile carries its own sphere as `content.boundingVolume`, which is what a client culls by, so a
 * close view still loads and draws only the nodes in front of the camera. What is lost against Nexus is the
 * distance-dependent choice of level across one model: the level is the same for the near and the far side, as it is
 * for any single-mesh LOD, which is what Nexus models are (an object, a few million triangles).
 *
 * `dag: 'paths'` keeps the DAG's own edges and writes a shared node under each of its parents, so the tree holds
 * one tile per root-to-node path and the same GLB is referenced from each. The level is then chosen per node by
 * distance, as in Nexus, but a node reached by several refined parents is drawn once per path and, when only one
 * parent is refined, the fine node overlaps the other parent's coarse patch. It is only reasonable for a shallow
 * DAG: the paths are 5 for the 5-node gargoyle sample, 130 for the 28-node shell, 2 322 for the 85-node dragon and
 * 25 202 for the 187-node gargoyle (nexusStats().paths), which is why it is not the default.
 *
 * Frames: a Nexus model is in its own frame, Y up as the viewer and MeshLab have it, and glTF is Y up too, so a
 * node's vertices are written as they are (nexus-glb.js). A 3D Tiles client turns glTF content Y-up to the tile
 * frame's Z-up, (x, y, z) → (x, −z, y), so the spheres are written in that frame; the tileset carries no transform
 * (a Nexus file has no georeference), and &lon=&lat= placement composes on top as for the other local formats.
 *
 * geometricError: Nexus draws a node while error / (the size of a pixel at the node's distance) is under its target,
 * 2 px by default; a 3D Tiles client refines while geometricError / pixel size is over its maximum screen-space error,
 * 16 px by default. The same metric, so geometricError = (16 / 2) × error reproduces Nexus's refinement; `geScale`
 * (default 8) is that factor.
 */
import { nodeChildren, nexusStats } from './nexus-reader.js';

export const DAG_MODES = ['levels', 'paths'];
export const DEFAULT_GE_SCALE = 8;
/** By paths, the most tiles a tree may hold (the bust's DAG has 76 million root-to-node paths): past it the call throws, naming dag=levels. */
export const MAX_PATH_TILES = 200_000;

const num = (v) => Number(v.toPrecision(9));
/** A sphere of the model frame → the tile frame: (x, y, z) → (x, −z, y). */
export const tileSphere = (s) => [num(s[0]), num(-s[2]), num(s[1]), num(Math.max(s[3], 1e-6))];

/** The smallest sphere holding spheres a and b ([x, y, z, r]). */
export function unionSphere(a, b) {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  if (d + b[3] <= a[3]) return a;
  if (d + a[3] <= b[3]) return b;
  const r = (d + a[3] + b[3]) / 2, t = (r - a[3]) / d;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, r];
}

/** A node's own sphere (centre, tight_radius: what Nexus culls by), or its saturated one (holding every finer node's). */
export const nodeSphere = (n, tight) => (tight ? [n.sphere[0], n.sphere[1], n.sphere[2], n.tightRadius || n.sphere[3]] : n.sphere);

/** The header's sphere grown to hold every node's: a node's saturated sphere can reach past the model's (gargoyle: 92 of 187 do). */
export function enclosingSphere(index, tight = true) {
  let s = index.header.sphere;
  for (let i = 0; i + 1 < index.nodes.length; i++) s = unionSphere(s, nodeSphere(index.nodes[i], tight));
  return s;
}

/**
 * @param index   parseNexus()'s result
 * @param contentUri (nodeIndex) => the URI of that node's GLB
 * @param opts    { dag: 'levels' | 'paths', geScale, tag, maxPaths (by paths: the most tiles, default MAX_PATH_TILES) }
 * @returns { tileset, stats, tiles (count), mode }
 */
export function nexusTileset(index, contentUri, { dag = 'levels', geScale = DEFAULT_GE_SCALE, tag = 'nexus', maxPaths = MAX_PATH_TILES } = {}) {
  if (!DAG_MODES.includes(dag)) throw new Error(`${tag}: dag must be one of ${DAG_MODES.join(', ')}`);
  const stats = nexusStats(index);
  if (dag === 'paths' && stats.paths > maxPaths) throw new Error(`${tag}: by paths this DAG is ${stats.paths} tiles (${stats.nodes} nodes, up to ${stats.maxParents} parents each), more than ${maxPaths}: use dag=levels`);
  if (!stats.patchesOk) console.warn(`[${tag}] the patches of some nodes do not partition their triangles: the file is damaged or of a layout this reader does not know`);
  if (dag === 'levels' && !stats.layeredOk) { console.warn(`[${tag}] the DAG is not layered (${stats.crossLevel} patches skip a level): level cuts would leave holes, writing the tree by paths instead`); dag = 'paths'; }
  // levels: the tiles that switch together share one sphere, and a node's content is culled by its tight one; paths: a
  // tile must hold its children's, so the saturated spheres
  const model = enclosingSphere(index, dag === 'levels'), modelSphere = tileSphere(model);
  let tiles = 0;
  const nodeTile = (i, ge, tight) => {
    const n = index.nodes[i];
    tiles++;
    return { boundingVolume: { sphere: tileSphere(nodeSphere(n, tight)) }, geometricError: num(ge), refine: 'REPLACE', content: { uri: contentUri(i) } };
  };

  let root;
  if (dag === 'levels') {
    // the nodes of each level, and the error of the level: the largest of its nodes', scaled
    const levels = [];
    for (let i = 0; i < stats.nodes; i++) { const d = stats.depth[i]; (levels[d] = levels[d] || []).push(i); }
    const errorOf = (k) => num(Math.max(...levels[k].map((i) => index.nodes[i].error)) * geScale);
    const build = (k) => {
      const last = k === levels.length - 1, ge = last ? 0 : errorOf(k);
      const children = levels[k].map((i) => {
        const t = nodeTile(i, ge, true);
        // the level's timing comes from the model sphere; the node's own sphere stays on the content, for culling
        t.content.boundingVolume = t.boundingVolume;
        t.boundingVolume = { sphere: modelSphere };
        if (!last) t.children = [{ boundingVolume: { sphere: modelSphere }, geometricError: 0, refine: 'REPLACE' }];   // empty: the node vanishes when the level does
        return t;
      });
      if (!last) children.push(build(k + 1));
      return { boundingVolume: { sphere: modelSphere }, geometricError: k === 0 ? num(model[3] * 1e3 * geScale) : errorOf(k - 1), refine: 'REPLACE', children };
    };
    root = build(0);
    // One root node (the usual Nexus file): it IS the root tile, with the content, and level 1 hangs straight under it.
    // Through the contentless L0 and L1 a client that refines into a deep level has nothing to draw until that whole
    // level has loaded (3DTilesRendererJS showed the bust after 26 s, 72 nodes); with the content on the root it draws
    // the coarsest mesh from the first request and keeps it while the level loads. Same tree otherwise.
    if (levels[0].length === 1 && levels.length > 1) {
      const [n0, L1] = root.children;
      root = { ...n0, geometricError: L1.geometricError, children: L1.children };
    }
  } else {
    const build = (i) => {
      const kids = nodeChildren(index, i);
      const t = nodeTile(i, kids.length ? index.nodes[i].error * geScale : 0, false);
      if (kids.length) t.children = kids.map(build);
      return t;
    };
    const roots = [];
    for (let i = 0; i < index.nroots; i++) roots.push(build(i));
    root = roots.length === 1 ? roots[0] : { boundingVolume: { sphere: modelSphere }, geometricError: num(model[3] * 1e3 * geScale), refine: 'REPLACE', children: roots };
  }
  const tileset = { asset: { version: '1.1', generator: `${tag} (3dtiled-to-3dtiles)` }, geometricError: root.geometricError, root, extensionsUsed: ['3DTILES_content_gltf'] };
  return { tileset, stats, tiles, mode: dag };
}
