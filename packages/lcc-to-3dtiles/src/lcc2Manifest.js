/**
 * lcc2Manifest.js (lcc-to-3dtiles) — an **XGRIDS LCC2** manifest (`*.lcc2`, JSON) → the 3D Tiles tree, with no splat
 * decoded. Shared by the live adapter (tile-server/lcc2-live.js) and the offline converter (lcc2.js).
 *
 * LCC2 keeps LCC's frame (right-handed, Z up, metres) and nothing else of its layout. Where LCC packs a flat grid of
 * units into index.bin and data.bin, an LCC2 manifest is a tree of nodes, each with an axis-aligned `boundingBox` and
 * a `data.3dgs` run `{ name, start, count }`: `count` splats from row `start` of chunk file `root.splatFiles[name]`
 * (a bundled `.sog`). A node at depth d holds its region at LOD `totalLevels − d` (0 = finest), so one tree level is
 * one whole LOD of the scene and a node's children replace it. That is a 3D Tiles REPLACE tree as it stands:
 *
 *   node            → tile, `boundingVolume.box` from the node's own boundingBox
 *   data.3dgs run   → the tile's content (the root has none: its only data is the environment chunk)
 *   child           → children
 *
 * Geometric error follows LCC and streamed SOG here: 5 % of the scene diagonal for the coarsest LOD (depth 1), halved
 * at every level below, doubled for the contentless root. Boxes and root transform are LCC's too (see lcc-live.js):
 * positions go into the tiles as stored, the box is turned from the source's Z-up to the glTF tile frame, and the root
 * transform turns the scene upright, or places it from `epsg` + `offset` when the manifest carries a known CRS.
 *
 * Not carried over: the environment chunk (`root.data.env`, a far shell of splats around the scene), the collision
 * meshes (`meshFiles`, `bvhFiles`) and `virtualLoD`, the settings of an extra LOD a renderer derives by itself.
 */
import { lccGeoref, LCC_LOCAL_UPRIGHT } from '../../core/index.js';

const ROOT_GE_FACTOR = 0.05, DEPTH_RATIO = 0.5;

// Right-handed Z-up source AABB → the tile-frame box (as lcc-live.js): centre (cx,cy,cz)→(cx,−cz,cy); halves y↔z.
function boundToZUpBox(min, max) {
  const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2, cz = (min[2] + max[2]) / 2;
  const hx = Math.max((max[0] - min[0]) / 2, 1e-4), hy = Math.max((max[1] - min[1]) / 2, 1e-4), hz = Math.max((max[2] - min[2]) / 2, 1e-4);
  return [cx, -cz, cy, hx, 0, 0, 0, hz, 0, 0, 0, hy];
}
const isBox = (b) => Array.isArray(b?.min) && Array.isArray(b?.max) && [...b.min, ...b.max].length === 6 && [...b.min, ...b.max].every(Number.isFinite);

// Some exporters leave a comma before a closing brace or bracket; strings are matched first so theirs are kept.
const stripTrailingCommas = (text) => text.replace(/"(?:[^"\\]|\\.)*"|,(\s*[}\]])/g, (m, close) => close ?? m);

/** A node's children, whether the manifest lists them as an array or as an object keyed by serial number. */
export const lcc2Children = (node) => (Array.isArray(node?.child) ? node.child : Object.values(node?.child ?? {})).filter((c) => c && typeof c === 'object');

/**
 * Parse a `*.lcc2` manifest → { meta, root, files, totalLevels, lodSplats, totalSplats, envFile }.
 * Accepts the field names of the earlier protocol too (`files`, `lod_level`, `lod_3dgs_info`, `total_splats`).
 */
export function parseLcc2(text) {
  let meta;
  try { meta = JSON.parse(text); }
  catch (e) { try { meta = JSON.parse(stripTrailingCommas(text)); } catch { throw new Error(`LCC2 manifest is not JSON: ${e.message}`); } }
  const root = meta?.root;
  const files = root?.splatFiles ?? root?.files;
  if (!root || typeof root !== 'object' || !Array.isArray(files)) throw new Error('not an LCC2 manifest: no root.splatFiles');
  if (!isBox(root.boundingBox)) throw new Error('LCC2 manifest: the root node has no boundingBox');
  const splatType = String(meta.splatType ?? '.sog').toLowerCase();
  if (splatType !== '.sog') throw new Error(`LCC2 chunks of type "${splatType}" are not supported yet (only .sog)`);
  const lodSplats = meta.lodSplats ?? (Array.isArray(meta.lod_3dgs_info) ? [...meta.lod_3dgs_info].reverse() : []);
  const env = root.data?.env?.name;
  return {
    meta, root, files: files.map((f) => String(f).replace(/\\/g, '/')),
    totalLevels: Number(meta.totalLevels ?? meta.lod_level) || 0, lodSplats, totalSplats: Number(meta.totalSplats ?? meta.total_splats) || 0,
    envFile: Number.isInteger(env) ? env : undefined,
  };
}

/**
 * The 3D Tiles tileset of a parsed manifest, and the runs its tiles are cut from.
 * @param {ReturnType<typeof parseLcc2>} manifest
 * @param {(run:{file:number,start:number,count:number,depth:number}) => string} contentUri  a tile's content uri
 * @param {{centroids?:boolean, tag?:string}} [opts]  `centroids`: the tiles are glTF POINTS, no splat extension advertised
 * @returns {{ tileset:object, runs:{file:number,start:number,count:number,depth:number,uri:string}[] }}
 */
export function lcc2Tileset(manifest, contentUri, { centroids = false, tag = 'lcc2' } = {}) {
  const { root, files, envFile, meta } = manifest;
  const bb = root.boundingBox;
  const rootGE = (Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) || 1) * ROOT_GE_FACTOR;
  const runs = [];
  const build = (node, depth, parentBox) => {
    const box = isBox(node.boundingBox) ? node.boundingBox : parentBox;
    const tile = { boundingVolume: { box: boundToZUpBox(box.min, box.max) }, geometricError: rootGE * 2 * Math.pow(DEPTH_RATIO, depth), refine: 'REPLACE' };
    const g = node.data?.['3dgs'];
    if (g && Number.isInteger(g.name) && g.name !== envFile) {
      if (!files[g.name]) throw new Error(`LCC2 manifest: node ${node.id ?? '?'} names chunk ${g.name}, root.splatFiles has ${files.length}`);
      if (!Number.isInteger(g.count)) throw new Error(`LCC2 manifest: node ${node.id ?? '?'} has no 3dgs.count`);
      if (g.count > 0) {
        const run = { file: g.name, start: g.start ?? 0, count: g.count, depth };
        run.uri = contentUri(run);
        runs.push(run);
        tile.content = { uri: run.uri };
      }
    }
    const kids = lcc2Children(node).map((c) => build(c, depth + 1, box));
    if (kids.length) tile.children = kids;
    return tile;
  };
  const tile = build(root, 0, bb);
  // `epsg` + `offset` place the scene as LCC's do; without a usable CRS (the Tunis sample has epsg 0) it is only stood upright.
  tile.transform = lccGeoref(meta, tag) || LCC_LOCAL_UPRIGHT;
  const tileset = { asset: { version: '1.1' }, geometricError: tile.geometricError, root: tile, extensionsUsed: ['3DTILES_content_gltf'] };
  if (!centroids) tileset.extensions = { '3DTILES_content_gltf': {
    extensionsUsed: ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
    extensionsRequired: ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
  } };
  return { tileset, runs };
}
