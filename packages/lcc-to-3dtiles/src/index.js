#!/usr/bin/env node
/**
 * lcc-to-3dtiles
 *
 * Converts an XGRIDS LCC (Lixel CyberColor) dataset (meta.lcc + Index.bin + Data.bin
 * [+ Shcoef.bin]) to OGC 3D Tiles 1.1 with KHR_gaussian_splatting_compression_spz_2 GLB tiles.
 *
 *   node src/index.js <lcc-dir | meta.lcc> <outDir>
 *
 * LCC organises splats as a grid of Units (one per partition cell, x/y packed in the index),
 * each holding `totalLevel` LODs (LOD0 = finest, most splats; higher = coarser). We map each
 * Unit to a REPLACE chain of tiles coarsest→finest under a single root, decode each LOD run
 * from Data.bin (32 B/splat, see lccDecode.js), and re-encode to SPZ-v2 GLB (shared encoder).
 *
 * SH (Shcoef.bin, Quality files) is NOT yet emitted — DC only, like the other converters.
 * License note: LCC is XGRIDS' format — see docs-references/lcc-format.md (attribution required).
 */

import fs   from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { decodeSplats } from './lccDecode.js';
// Shared, parallel-friendly encoder from 3dtiles-convert-core (async gzip) + bounded-concurrency map.
// (Relative path during the monorepo migration; becomes `3dtiles-convert-core` once lcc moves to packages/.)
import { buildSplatTileGlb, computeBounds, parallelMap, defaultConcurrency, lccGeoref } from '../../core/index.js';

const ROOT_GE_FACTOR = 0.05;   // root GE = sceneDiagonal × this (matches sog/reference magnitude)
const DEPTH_RATIO    = 0.5;    // GE halves per LOD step down

const ensureDir = d => fs.mkdir(d, { recursive: true });

// Right-handed source → Z-up tileset box (RX+90°): centre (cx,cy,cz)→(cx,−cz,cy); halves y↔z.
function boundToZUpBox(b) {
  return [b.cx, -b.cz, b.cy, b.hx,0,0, 0,b.hz,0, 0,0,b.hy];
}

/** Uniform in-process entry: convert an LCC dataset (dir or meta.lcc) → 3D Tiles. */
export async function convert(input, outDir, opts = {}) {
  if (!input || !outDir) throw new Error('Usage: lcc-to-3dtiles <lcc-dir | meta.lcc> <outDir>');
  let inPath = input;
  const stat = await fs.stat(inPath).catch(() => null);
  if (stat?.isDirectory()) {
    // meta file name is arbitrary; find a .lcc (else meta.lcc).
    const files = await fs.readdir(inPath);
    const metaName = files.find(f => f.toLowerCase().endsWith('.lcc')) || 'meta.lcc';
    inPath = path.join(inPath, metaName);
  }
  const dir  = path.dirname(inPath);
  const meta = JSON.parse(await fs.readFile(inPath, 'utf8'));
  const find = n => (meta.attributes || []).find(a => a.name === n);
  const scaleAttr = find('scale');
  if (!scaleAttr) throw new Error('meta.lcc missing attributes.scale min/max');

  const totalLevel = meta.totalLevel ?? (meta.splats?.length ?? 1);
  const indexDataSize = meta.indexDataSize;
  const levelsInIndex = (indexDataSize - 4) / 16;   // index u32 + per-LOD {pts u32, off u64, size u32}
  console.log(`LCC: ${((meta.totalSplats ?? 0)/1e6).toFixed(2)}M splats, ${totalLevel} LODs, indexDataSize ${indexDataSize} (${levelsInIndex} LOD records)`);

  const t0 = Date.now();
  const indexBuf = Buffer.from(await fs.readFile(path.join(dir, 'index.bin')));
  const dataBuf  = Buffer.from(await fs.readFile(path.join(dir, 'data.bin')));
  const numUnits = indexBuf.length / indexDataSize;
  console.log(`  ${numUnits} units; est ~${Math.ceil(numUnits * totalLevel * 0.05)}s`);
  await ensureDir(path.join(outDir, 'tiles'));

  // Scene bound diagonal for GE anchoring.
  const bb = meta.boundingBox;
  const diag = Math.hypot(bb.max[0]-bb.min[0], bb.max[1]-bb.min[1], bb.max[2]-bb.min[2]) || 1;
  const ROOT_GE = diag * ROOT_GE_FACTOR;
  const geAt = d => ROOT_GE * Math.pow(DEPTH_RATIO, d);

  // ── Phase 1 (sync): build the tile tree + collect per-tile encode tasks ──
  // Each task carries its tile object (box patched in phase 2 from the decoded AABB).
  let nextId = 0;
  const unitTiles = [];
  const tasks = [];   // { tile, off, pts }
  for (let u = 0; u < numUnits; u++) {
    const base = u * indexDataSize;
    const lods = [];
    for (let L = 0; L < levelsInIndex; L++) {
      const r = base + 4 + L * 16;
      const pts = indexBuf.readUInt32LE(r);
      const off = Number(indexBuf.readBigUInt64LE(r + 4));
      const size = indexBuf.readUInt32LE(r + 12);
      if (pts > 0 && size > 0) lods.push({ level: L, pts, off });
    }
    if (!lods.length) continue;
    const maxL = lods[lods.length - 1].level;
    let child = null;
    for (const { level, pts, off } of lods) {     // finest first; nest coarser as parent
      const tile = { boundingVolume: { box: null }, geometricError: geAt(maxL - level), refine: 'REPLACE', content: { uri: `tiles/node_${nextId++}.glb` } };
      tasks.push({ tile, off, pts });
      if (child) tile.children = [child];
      child = tile;
    }
    unitTiles.push(child);
  }

  // ── Phase 2 (parallel): decode → encode → gzip → write, bounded concurrency ──
  // gzip runs on the libuv threadpool (async), so `concurrency` tiles encode at once.
  let tilesWritten = 0;
  const concurrency = Math.min(defaultConcurrency(), 12);
  await parallelMap(tasks, async ({ tile, off, pts }) => {
    const { positions, alphas, rgb, scales, rotations } = decodeSplats(dataBuf, off, pts, scaleAttr.min, scaleAttr.max);
    const bounds = computeBounds(positions, pts);
    const glb = await buildSplatTileGlb({ positions, alphas, rgb, scales, rotations }, pts, bounds, opts.centroidsOnly);
    await fs.writeFile(path.join(outDir, tile.content.uri), glb);
    tile.boundingVolume.box = boundToZUpBox(bounds);
  }, { concurrency, onProgress: (d, t) => { tilesWritten = d; if (d % 20 === 0 || d === t) process.stdout.write(`\r  ${d}/${t} tiles (×${concurrency})`); } });
  process.stdout.write('\n');

  // Root: union of unit boxes, holds all unit chains. Empty content (grouping node).
  let mn = [Infinity,Infinity,Infinity], mx = [-Infinity,-Infinity,-Infinity];
  for (const t of unitTiles) {
    const b = t.boundingVolume.box;
    for (let k=0;k<3;k++){ const c=b[k], h=Math.abs(b[3+k*4]); if(c-h<mn[k])mn[k]=c-h; if(c+h>mx[k])mx[k]=c+h; }
  }
  const rootBox = [ (mn[0]+mx[0])/2,(mn[1]+mx[1])/2,(mn[2]+mx[2])/2,
                    (mx[0]-mn[0])/2,0,0, 0,(mx[1]-mn[1])/2,0, 0,0,(mx[2]-mn[2])/2 ];
  // Bake georef into the root transform (same source of truth as the live /lcc adapter — meta.epsg +
  // projected offset). Without this the prebuilt tileset sits at the local origin (the Guan_Temple
  // misalignment); null when the scene has no/unknown CRS (e.g. epsg 0 → stays local).
  const transform = lccGeoref(meta, 'lcc-offline');
  const tileset = {
    asset: { version: '1.1' },
    geometricError: ROOT_GE * 2,
    root: { boundingVolume: { box: rootBox }, geometricError: ROOT_GE * 2, refine: 'REPLACE',
            ...(transform ? { transform } : {}), children: unitTiles },
    // centroids mode emits plain glTF POINTS tiles → no splat-extension advertisement.
    ...(opts.centroidsOnly ? {} : {
      extensionsUsed: ['3DTILES_content_gltf'],
      extensions: { '3DTILES_content_gltf': {
        extensionsUsed:     ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
        extensionsRequired: ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
      }},
    }),
  };
  await fs.writeFile(path.join(outDir, 'tileset.json'), JSON.stringify(tileset, null, 2));
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`Done → ${outDir}/tileset.json  (${tilesWritten} ${opts.centroidsOnly ? 'POINTS centroid' : 'SPZ splat'} tiles, ${numUnits} units)`);
  console.log(`  Actual time: ${elapsed < 60 ? elapsed.toFixed(1)+'s' : (elapsed/60).toFixed(1)+' min'}`);
  return { format: 'lcc', outDir, tiles: tilesWritten };
}

// ── CLI shim: run only when invoked directly (not when imported by the meta-converter) ──
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = process.argv.slice(2).filter(x => !x.startsWith('--'));
  convert(a[0], a[1]).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
