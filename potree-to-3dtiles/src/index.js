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
import { loadPotree2 } from './potree2.js';
import { loadPotree1 } from './potree1.js';
import { writePointsGlb } from './glbWriter.js';

const argv = process.argv.slice(2);
const inDir = argv.find(a => !a.startsWith('--'));
const outDir = argv.filter(a => !a.startsWith('--'))[1];
if (!inDir || !outDir) { console.error('Usage: node src/index.js <potree-dir> <outDir>'); process.exit(1); }

async function convert() {
  const t0 = Date.now();
  const has = async f => !!(await fs.stat(path.join(inDir, f)).catch(() => null));
  const src = (await has('metadata.json')) ? await loadPotree2(inDir)
            : (await has('cloud.js'))      ? await loadPotree1(inDir)
            : null;
  if (!src) throw new Error('No metadata.json (Potree 2.0) or cloud.js (Potree 1.x) found in ' + inDir);

  const nodeCount = src.nodes.size;
  console.log(`Potree ${src.version}: ${nodeCount} octree nodes`);
  console.log(`  est ~${Math.ceil(nodeCount * 0.03)}s`);
  await fs.mkdir(path.join(outDir, 'tiles'), { recursive: true });

  const gc = [0,1,2].map(k => (src.rootBox.min[k] + src.rootBox.max[k]) / 2); // global centre
  const rootSpacing = src.spacing || (src.rootBox.max[0] - src.rootBox.min[0]) / 128;

  // Z-up box (dataset is Z-up) relative to global centre.
  const boxOf = (b) => {
    const c = [0,1,2].map(k => (b.min[k]+b.max[k])/2 - gc[k]);
    const h = [0,1,2].map(k => Math.max((b.max[k]-b.min[k])/2, 1e-4));
    return [c[0],c[1],c[2], h[0],0,0, 0,h[1],0, 0,0,h[2]];
  };

  let written = 0;
  async function buildTile(name) {
    const node = src.nodes.get(name);
    if (!node) return null;
    const tile = {
      boundingVolume: { box: boxOf(node.box) },
      geometricError: rootSpacing / Math.pow(2, node.depth),
      refine: 'ADD',
    };
    if (node.numPoints > 0) {
      const data = await src.readNode(node);
      if (data && data.count > 0) {
        const local = new Float32Array(data.count * 3);
        for (let i = 0; i < data.count; i++) {
          local[i*3]   = data.positions[i*3]   - gc[0];
          local[i*3+1] = data.positions[i*3+1] - gc[1];
          local[i*3+2] = data.positions[i*3+2] - gc[2];
        }
        const uri = `tiles/${name}.glb`;
        await writePointsGlb(local, data.colors, data.count, path.join(outDir, uri));
        tile.content = { uri };
        if (++written % 50 === 0) process.stdout.write(`\r  ${written} tiles`);
      }
    }
    const children = [];
    for (let c = 0; c < 8; c++) { const ch = await buildTile(name + c); if (ch) children.push(ch); }
    if (children.length) tile.children = children;
    return tile;
  }

  const root = await buildTile('r');
  process.stdout.write('\n');
  await src.close();

  const tileset = {
    asset: { version: '1.1' },
    geometricError: rootSpacing,
    root,
  };
  await fs.writeFile(path.join(outDir, 'tileset.json'), JSON.stringify(tileset, null, 2));
  const el = (Date.now() - t0) / 1000;
  console.log(`Done → ${outDir}/tileset.json  (${written} POINTS tiles, Potree ${src.version})`);
  console.log(`  Actual time: ${el < 60 ? el.toFixed(1)+'s' : (el/60).toFixed(1)+' min'}  (NOT geo-referenced — local origin)`);
  process.exit(0);
}

convert().catch(e => { console.error(e); process.exit(1); });
