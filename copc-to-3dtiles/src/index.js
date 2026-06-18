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
import { Copc } from 'copc';

import { buildSubtreeBuffer, keyToCoords } from './subtreeBuilder.js';
import { writeTileGlb }                    from './glbWriter.js';
import { buildEcefTransform }              from './georef.js';

const SUBTREE_LEVELS = 3; // subtree covers levels d, d+1, d+2 (73 nodes max)

const [,, inputPath, outDir] = process.argv;
if (!inputPath || !outDir) {
  console.error('Usage: node src/index.js <input.copc.laz> <outDir>');
  process.exit(1);
}

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

async function convert() {
  await ensureDir(outDir);

  console.log(`Loading COPC: ${inputPath}`);
  const copc = await Copc.create(inputPath);
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
  console.log('Writing GLBs...');
  let done = 0;
  for (const [key, node] of nodeMap) {
    const { level, x, y, z } = keyToCoords(key);
    const tilePath = path.join(outDir, 'tiles', `${level}`, `${x}`, `${y}`, `${z}.glb`);
    const view = await Copc.loadPointDataView(inputPath, copc, node);
    await writeTileGlb(view, origin, tilePath);
    done++;
    if (done % 100 === 0) process.stdout.write(`\r  ${done}/${nodeMap.size}`);
  }
  console.log(`\r  ${done}/${nodeMap.size} tiles`);

  // ── Write subtrees ─────────────────────────────────────────────────────────
  // Subtree roots are nodes at levels 0, SUBTREE_LEVELS, 2*SUBTREE_LEVELS, …
  console.log('Writing subtrees...');
  let subtreeDone = 0;
  const subtreeRoots = new Set();
  // Always include the tileset root subtree at 0-0-0-0
  subtreeRoots.add('0-0-0-0');
  for (const key of nodeMap.keys()) {
    const { level, x, y, z } = keyToCoords(key);
    if (level % SUBTREE_LEVELS === 0) subtreeRoots.add(key);
  }

  for (const key of subtreeRoots) {
    const { level, x, y, z } = keyToCoords(key);
    const subtreePath = path.join(outDir, 'subtrees', `${level}`, `${x}`, `${y}`, `${z}.subtree`);
    await ensureDir(path.dirname(subtreePath));
    const buf = buildSubtreeBuffer(key, nodeMap, SUBTREE_LEVELS);
    await fs.writeFile(subtreePath, buf);
    subtreeDone++;
  }
  console.log(`  ${subtreeDone} subtrees`);

  // ── tileset.json ───────────────────────────────────────────────────────────
  const rootError = rootGeometricError(cube);
  const tileset = {
    asset: { version: '1.1' },
    geometricError: rootError,
    root: {
      // Center at (0,0,0) in local space — the ENU transform moves that to ECEF.
      // Half-extents stay in CRS units (metres for projected CRS).
      boundingVolume: { box: [
        0, 0, 0,
        (cube[3]-cube[0])/2, 0, 0,
        0, (cube[4]-cube[1])/2, 0,
        0, 0, (cube[5]-cube[2])/2,
      ]},
      refine: 'ADD',
      geometricError: rootError,
      implicitTiling: {
        subdivisionScheme: 'OCTREE',
        availableLevels: maxLevel + 1,
        subtreeLevels: SUBTREE_LEVELS,
        subtrees: { uri: 'subtrees/{level}/{x}/{y}/{z}.subtree' }
      },
      content: { uri: 'tiles/{level}/{x}/{y}/{z}.glb' }
    }
  };
  if (transform) tileset.root.transform = transform;

  await fs.writeFile(path.join(outDir, 'tileset.json'), JSON.stringify(tileset, null, 2));
  console.log(`\nDone → ${outDir}/tileset.json`);
  if (!hasGeoref) console.log('  (no CRS found — local coordinate output)');
}

convert().catch(e => { console.error(e); process.exit(1); });
