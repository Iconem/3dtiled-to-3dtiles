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
import { convertPlainLas }                 from './plainLas.js';
import { buildEcefTransform }              from './georef.js';
import { parallelMap, defaultConcurrency, keyToCoords, octreeSubCube, cubeToBox,
         buildExplicitTree, buildSubtreeBuffer, subtreeRootKeys } from '../../core/index.js';

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
 * Try to open as COPC. Returns the Copc instance, or null if the file is a plain
 * (non-COPC) LAS/LAZ — detected via copc's 'COPC info VLR is required' error.
 */
async function tryOpenCopc(filename) {
  try {
    return await Copc.create(filename);
  } catch (e) {
    if (/COPC info VLR is required/i.test(e?.message || '')) return null;
    throw e; // any other failure is a genuine error — surface it
  }
}

/** Uniform in-process entry: convert a COPC (or plain LAS/LAZ) file → 3D Tiles. */
export async function convert(inputPath, outDir, opts = {}) {
  if (!inputPath || !outDir) throw new Error('Usage: copc-to-3dtiles <input.copc.laz | .las/.laz> <outDir>');
  await ensureDir(outDir);

  console.log(`Loading COPC: ${inputPath}`);
  const copc = await tryOpenCopc(inputPath);

  if (!copc) {
    // Plain LAS/LAZ (no COPC octree) → single / flat POINTS tiling, no native LoD.
    await ensureDir(path.join(outDir, 'tiles'));
    return convertPlainLas(inputPath, outDir, buildEcefTransform, bboxToBox, defaultConcurrency());
  }

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
  const concurrency = defaultConcurrency();
  console.log(`Writing GLBs... (parallel: ${concurrency} lanes)`);
  const entries = [...nodeMap];
  let done = 0;
  await parallelMap(entries, async ([key, node]) => {
    const { level, x, y, z } = keyToCoords(key);
    const tilePath = path.join(outDir, 'tiles', `${level}`, `${x}`, `${y}`, `${z}.glb`);
    const view = await Copc.loadPointDataView(inputPath, copc, node);
    await writeTileGlb(view, origin, tilePath);
    done++;
    if (done % 100 === 0) process.stdout.write(`\r  ${done}/${nodeMap.size}`);
  }, { concurrency });
  console.log(`\r  ${done}/${nodeMap.size} tiles`);

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
  const pos = []; for (let i = 0; i < args.length; i++) { if (args[i].startsWith('--')) { if (args[i] === '--tiling') i++; continue; } pos.push(args[i]); }
  convert(pos[0], pos[1], { tiling: flag('tiling') }).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
