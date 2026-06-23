#!/usr/bin/env node
/**
 * potree-to-3dtiles
 *
 * Converts a Potree octree point cloud → OGC 3D Tiles 1.1 (glTF POINTS tiles).
 * Auto-detects Potree **2.0** (metadata.json + hierarchy.bin + octree.bin) or
 * **1.x** (cloud.js + <octreeDir>/ .hrc + per-node .bin).
 *
 *   node src/index.js <potree-dir> <outDir>
 *
 * Octree → 3D Tiles tree (node 'r' + octant children); refine **ADD** (Potree children add
 * denser detail in sub-octants, like COPC); geometricError = point spacing per depth.
 * Points are emitted relative to the dataset centre (float32-safe); the output sits at the
 * local origin — NOT geo-referenced (add a root transform / ENU placement downstream).
 *
 * Status: 2.0 decode is authoritative (PotreeConverter / potree23dtiles); 1.x is best-effort.
 * Both UNTESTED here (no sample in repo) — validate against a real dataset.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { loadPotree2 } from './potree2.js';
import { loadPotree1 } from './potree1.js';
import { buildPointsGlb, parallelMap, defaultConcurrency } from '../../core/index.js';

/** Uniform in-process entry: convert a Potree 2.0 or 1.x octree → 3D Tiles POINTS. */
export async function convert(inDir, outDir, opts = {}) {
  if (!inDir || !outDir) throw new Error('Usage: potree-to-3dtiles <potree-dir> <outDir>');
  const t0 = Date.now();
  const has = async f => !!(await fs.stat(path.join(inDir, f)).catch(() => null));
  const src = (await has('metadata.json')) ? await loadPotree2(inDir)
            : (await has('cloud.js'))      ? await loadPotree1(inDir)
            : null;
  if (!src) throw new Error('No metadata.json (Potree 2.0) or cloud.js (Potree 1.x) found in ' + inDir);

  const nodeCount = src.nodes.size;
  console.log(`Potree ${src.version}: ${nodeCount} octree nodes`);
  console.log(`  est ~${Math.ceil(nodeCount * 0.03)}s (parallel: ${defaultConcurrency()} lanes)`);
  await fs.mkdir(path.join(outDir, 'tiles'), { recursive: true });

  const gc = [0,1,2].map(k => (src.rootBox.min[k] + src.rootBox.max[k]) / 2); // global centre
  const rootSpacing = src.spacing || (src.rootBox.max[0] - src.rootBox.min[0]) / 128;

  // Z-up box (dataset is Z-up) relative to global centre.
  const boxOf = (b) => {
    const c = [0,1,2].map(k => (b.min[k]+b.max[k])/2 - gc[k]);
    const h = [0,1,2].map(k => Math.max((b.max[k]-b.min[k])/2, 1e-4));
    return [c[0],c[1],c[2], h[0],0,0, 0,h[1],0, 0,0,h[2]];
  };

  // ── 1) Walk the octree to collect the node list (no point arrays held yet) ──
  // Memory stays bounded: we only collect node descriptors here; each node's
  // point arrays are decoded lazily inside the parallel task below and dropped
  // as soon as its GLB is written.
  const order = [];                 // node names in deterministic DFS order
  const childrenOf = new Map();     // name → [childNames] (only nodes that exist)
  (function walk(name) {
    const node = src.nodes.get(name);
    if (!node) return false;
    order.push(name);
    const kids = [];
    for (let c = 0; c < 8; c++) { if (walk(name + c)) kids.push(name + c); }
    childrenOf.set(name, kids);
    return true;
  })('r');

  if (!src.nodes.get('r')) {
    await src.close();
    throw new Error(
      `No tiles produced: 0 octree nodes were read from ${inDir}. ` +
      `For Potree 1.x this usually means an unsupported layout — e.g. an inline ` +
      `"hierarchy" array in cloud.js with flat data/<name>.bin files and no .hrc ` +
      `(stale 1.4), or LAZ-encoded nodes (pointAttributes:"LAZ") which this reader ` +
      `cannot decode. Refusing to write an invalid tileset with root:null.`
    );
  }

  // ── 2) Parallel per-node: decode → build POINTS GLB → write ─────────────────
  // Bounded concurrency keeps at most N nodes' point arrays alive at once.
  const concurrency = defaultConcurrency();
  let written = 0;
  const hasContent = new Set();     // names that produced a GLB
  await parallelMap(order, async (name) => {
    const node = src.nodes.get(name);
    if (!node || node.numPoints <= 0) return;
    const data = await src.readNode(node);
    if (!data || data.count <= 0) return;
    const local = new Float32Array(data.count * 3);
    for (let i = 0; i < data.count; i++) {
      local[i*3]   = data.positions[i*3]   - gc[0];
      local[i*3+1] = data.positions[i*3+1] - gc[1];
      local[i*3+2] = data.positions[i*3+2] - gc[2];
    }
    // buildPointsGlb applies the Y-up swizzle (E,U,−N) internally — pass (E,N,U).
    const glb = await buildPointsGlb(local, data.colors, data.count);
    await fs.writeFile(path.join(outDir, `tiles/${name}.glb`), glb);
    hasContent.add(name);
    if (++written % 50 === 0) process.stdout.write(`\r  ${written} tiles`);
  }, { concurrency });
  process.stdout.write(`\r  ${written} tiles\n`);

  // ── 3) Assemble the tileset tree from the collected hierarchy ───────────────
  function buildTile(name) {
    const node = src.nodes.get(name);
    const tile = {
      boundingVolume: { box: boxOf(node.box) },
      geometricError: rootSpacing / Math.pow(2, node.depth),
      refine: 'ADD',
    };
    if (hasContent.has(name)) tile.content = { uri: `tiles/${name}.glb` };
    const children = (childrenOf.get(name) || []).map(buildTile);
    if (children.length) tile.children = children;
    return tile;
  }
  const root = buildTile('r');
  await src.close();

  if (!root) {
    throw new Error(
      `No tiles produced: 0 octree nodes were read from ${inDir}. ` +
      `For Potree 1.x this usually means an unsupported layout — e.g. an inline ` +
      `"hierarchy" array in cloud.js with flat data/<name>.bin files and no .hrc ` +
      `(older 1.x), or LAZ-encoded nodes (pointAttributes:"LAZ") which this reader ` +
      `cannot decode. Refusing to write an invalid tileset with root:null.`
    );
  }

  const tileset = {
    asset: { version: '1.1' },
    geometricError: rootSpacing,
    root,
  };
  await fs.writeFile(path.join(outDir, 'tileset.json'), JSON.stringify(tileset, null, 2));
  const el = (Date.now() - t0) / 1000;
  console.log(`Done → ${outDir}/tileset.json  (${written} POINTS tiles, Potree ${src.version})`);
  console.log(`  Actual time: ${el < 60 ? el.toFixed(1)+'s' : (el/60).toFixed(1)+' min'}  (NOT geo-referenced — local origin)`);
  return { format: 'potree', outDir, tiles: written };
}

// ── CLI shim: run only when invoked directly (not when imported by the meta-converter) ──
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = process.argv.slice(2).filter(x => !x.startsWith('--'));
  convert(a[0], a[1]).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
