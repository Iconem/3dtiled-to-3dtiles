#!/usr/bin/env node
/**
 * copc-to-3dtiles
 *
 * Converts a COPC .copc.laz file to OGC 3D Tiles 1.1 with implicit octree tiling.
 * Reuses COPC's existing octree hierarchy verbatim — no re-tiling.
 *
 * Usage:
 *   node src/index.js <input.copc.laz> <outDir>
 *
 * Output:
 *   <outDir>/tileset.json
 *   <outDir>/tiles/<level>/<x>/<y>/<z>.glb
 *   <outDir>/subtrees/<level>/<x>/<y>/<z>.subtree
 */

import fs   from 'fs/promises';
import path  from 'path';
import { fileURLToPath } from 'node:url';
import { Copc, Las, Getter } from 'copc';

import { writeTileGlb }                    from './glbWriter.js';
import { buildEcefTransform }              from './georef.js';
import { defaultConcurrency, convertTiles, keyToCoords, octreeSubCube, cubeToBox,
         buildExplicitTree, buildSubtreeBuffer, subtreeRootKeys } from '../../core/index.js';

const TILE_TASK = new URL('./tile-task.js', import.meta.url).href;   // what a tile worker runs
const SUBTREE_LEVELS = 3; // subtree covers levels d, d+1, d+2 (73 nodes max)

const ensureDir = d => fs.mkdir(d, { recursive: true });

/** [minX,minY,minZ,maxX,maxY,maxZ] → 3D Tiles box (centre + 3 half-axis vectors) */
function bboxToBox(cube) {
  const [x0, y0, z0, x1, y1, z1] = cube;
  const cx = (x0+x1)/2, cy = (y0+y1)/2, cz = (z0+z1)/2;
  const hx = (x1-x0)/2, hy = (y1-y0)/2, hz = (z1-z0)/2;
  return [cx, cy, cz, hx, 0, 0, 0, hy, 0, 0, 0, hz];
}

/** COPC nodes subdivide the root cube strictly, so each node's bbox is derivable. */
function nodeBbox(rootCube, level, x, y, z) {
  const [x0, y0, z0, x1, y1, z1] = rootCube;
  const n = Math.pow(2, level);
  const dx = (x1-x0)/n, dy = (y1-y0)/n, dz = (z1-z0)/n;
  return [x0+x*dx, y0+y*dy, z0+z*dz, x0+(x+1)*dx, y0+(y+1)*dy, z0+(z+1)*dz];
}

/** Geometric error halves per level, starting from root bounding diagonal. */
function rootGeometricError(cube) {
  const [x0,y0,z0,x1,y1,z1] = cube;
  return Math.sqrt((x1-x0)**2 + (y1-y0)**2 + (z1-z0)**2);
}

async function loadAllNodes(filename, copc) {
  const nodeMap = new Map();
  const stack = [copc.info.rootHierarchyPage];
  while (stack.length) {
    const page = stack.pop();
    const { nodes, pages } = await Copc.loadHierarchyPage(filename, page);
    for (const [key, node] of Object.entries(nodes)) nodeMap.set(key, node);
    stack.push(...Object.values(pages));
  }
  return nodeMap;
}

/**
 * Open as COPC. A LAS/LAZ file with no COPC octree is refused: it has no tiling to convert, and this toolbox converts
 * tilings, it does not build them. (It used to be cut into flat sibling tiles of 2 million points with no levels of
 * detail, untested and unusable past a few million points; removed 2026-11-06.)
 */
async function openCopc(filename) {
  try {
    return await Copc.create(filename);
  } catch (e) {
    if (/COPC info VLR is required/i.test(e?.message || ''))
      throw new Error(`${filename} is a plain LAS/LAZ file, not a COPC: it has no octree to convert. Build one first, e.g. \`pdal translate in.laz out.copc.laz\` or untwine, then convert the .copc.laz.`);
    throw e;
  }
}

/** Uniform in-process entry: convert a COPC file → 3D Tiles. */
export async function convert(inputPath, outDir, opts = {}) {
  if (!inputPath || !outDir) throw new Error('Usage: copc-to-3dtiles <input.copc.laz> <outDir>');
  await ensureDir(outDir);

  console.log(`Loading COPC: ${inputPath}`);
  const copc = await openCopc(inputPath);

  const { cube } = copc.info;

  console.log('Loading hierarchy...');
  const nodeMap = await loadAllNodes(inputPath, copc);
  let maxLevel = 0;
  for (const key of nodeMap.keys()) {
    const { level } = keyToCoords(key);
    if (level > maxLevel) maxLevel = level;
  }
  console.log(`  ${nodeMap.size} nodes, max level ${maxLevel}`);

  // Georef
  const origin = [(cube[0]+cube[3])/2, (cube[1]+cube[4])/2, (cube[2]+cube[5])/2];
  const { transform, hasGeoref } = await buildEcefTransform(copc, inputPath, origin);

  // ── Write GLB tiles ────────────────────────────────────────────────────────
  // All tiles subtract the same global origin so they share one local frame.
  // The root ENU transform maps (0,0,0) → ECEF origin, so tile positions must
  // be relative to that same origin — NOT each tile's own center.
  // Parallel per-node: COPC supports per-node range reads, so each task reads,
  // decodes and writes one node's points independently. Bounded concurrency keeps
  // at most N nodes' point arrays alive at once → memory stays bounded.
  // With tile workers (TILED_WORKERS, or opts.workers) each node is read, decoded and written on a worker thread:
  // the LAZ decode and the glTF encode are what a lane spends its time on, and one thread runs them one at a time.
  // core's convertTiles is that loop, the same one every converter uses.
  const entries = [...nodeMap];
  const tilePathOf = (key) => { const { level, x, y, z } = keyToCoords(key); return path.join(outDir, 'tiles', `${level}`, `${x}`, `${y}`, `${z}.glb`); };
  console.log('Writing GLBs...');
  const { workers } = await convertTiles(entries, {
    module: TILE_TASK, fn: 'copcNodeToFile', workers: opts.workers,
    task: ([key, node]) => ({ input: inputPath, header: copc.header, eb: copc.eb, node, origin, tilePath: tilePathOf(key) }),
    here: async ([key, node]) => writeTileGlb(await Copc.loadPointDataView(inputPath, copc, node), origin, tilePathOf(key)),
    onProgress: (d, t) => { if (d % 100 === 0 || d === t) process.stdout.write(`\r  ${d}/${t}`); },
  });
  console.log(`\r  ${nodeMap.size}/${nodeMap.size} tiles (${workers ? `${workers} worker threads` : `${defaultConcurrency()} lanes`})`);

  const rootError = rootGeometricError(cube);
  const tiling = opts.tiling === 'explicit' ? 'explicit' : 'implicit';
  let tileset;

  if (tiling === 'explicit') {
    // ── Explicit nested tree (no subtrees): each node carries its own box + content URI. ──
    // Boxes are relative to `origin`; the root ENU transform maps origin → ECEF (same as implicit).
    const root = buildExplicitTree('0-0-0-0', {
      exists: k => nodeMap.has(k),
      boxOf: k => { const { level, x, y, z } = keyToCoords(k); return cubeToBox(octreeSubCube(cube, level, x, y, z), origin); },
      geometricErrorOf: k => rootError / 2 ** keyToCoords(k).level,
      contentUriOf: k => { if (!nodeMap.has(k)) return null; const { level, x, y, z } = keyToCoords(k); return `tiles/${level}/${x}/${y}/${z}.glb`; },
      refine: 'ADD',
    });
    if (transform) root.transform = transform;
    tileset = { asset: { version: '1.1' }, geometricError: rootError, root };
    console.log('  explicit tree (no subtrees)');
  } else {
    // ── Implicit octree (subtree files). Subtree roots: every node at level % SUBTREE_LEVELS === 0. ──
    console.log('Writing subtrees...');
    let subtreeDone = 0;
    for (const key of subtreeRootKeys(nodeMap, maxLevel, SUBTREE_LEVELS)) {
      const { level, x, y, z } = keyToCoords(key);
      const subtreePath = path.join(outDir, 'subtrees', `${level}`, `${x}`, `${y}`, `${z}.subtree`);
      await ensureDir(path.dirname(subtreePath));
      await fs.writeFile(subtreePath, buildSubtreeBuffer(key, nodeMap, SUBTREE_LEVELS));
      subtreeDone++;
    }
    console.log(`  ${subtreeDone} subtrees`);
    tileset = {
      asset: { version: '1.1' },
      geometricError: rootError,
      root: {
        boundingVolume: { box: [0,0,0, (cube[3]-cube[0])/2,0,0, 0,(cube[4]-cube[1])/2,0, 0,0,(cube[5]-cube[2])/2] },
        refine: 'ADD',
        geometricError: rootError,
        implicitTiling: { subdivisionScheme: 'OCTREE', availableLevels: maxLevel + 1, subtreeLevels: SUBTREE_LEVELS, subtrees: { uri: 'subtrees/{level}/{x}/{y}/{z}.subtree' } },
        content: { uri: 'tiles/{level}/{x}/{y}/{z}.glb' },
      },
    };
    if (transform) tileset.root.transform = transform;
  }

  await fs.writeFile(path.join(outDir, 'tileset.json'), JSON.stringify(tileset, null, 2));
  console.log(`\nDone → ${outDir}/tileset.json  (${tiling} tiling)`);
  if (!hasGeoref) console.log('  (no CRS found — local coordinate output)');
}

// ── CLI shim: run only when invoked directly (not when imported by the meta-converter) ──
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const flag = n => { const i = args.indexOf(`--${n}`); if (i >= 0) return args[i + 1]; const eq = args.find(a => a.startsWith(`--${n}=`)); return eq ? eq.slice(n.length + 3) : undefined; };
  const pos = []; for (let i = 0; i < args.length; i++) { if (args[i].startsWith('--')) { if (args[i] === '--tiling' || args[i] === '--workers') i++; continue; } pos.push(args[i]); }
  convert(pos[0], pos[1], { tiling: flag('tiling'), workers: flag('workers') }).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
