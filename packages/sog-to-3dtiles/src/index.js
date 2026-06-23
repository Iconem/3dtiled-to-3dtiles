#!/usr/bin/env node
/**
 * sog-to-3dtiles
 *
 * Converts a PlayCanvas **Streamed SOG** dataset (lod-meta.json + per-chunk unbundled
 * SOG dirs) to OGC 3D Tiles 1.1 with KHR_gaussian_splatting_compression_spz_2 GLB tiles.
 *
 *   node src/index.js <scene-dir-or-lod-meta.json> <outDir>
 *
 * The streamed-SOG spatial tree maps almost 1:1 onto a 3D Tiles HLOD tree:
 *   • interior SOG node → empty 3D Tiles tile (bounds + two children)
 *   • leaf SOG node     → a REPLACE chain of tiles, coarsest LOD level (highest index)
 *                         as ancestor down to level 0 (finest); each tile's content is
 *                         the decoded [offset,count) run of its chunk, re-encoded SPZ-v2.
 *
 * SOG decoding (WebP + dequant) is delegated to @playcanvas/splat-transform's readSog.
 */

import fs   from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { decodeChunk, extractRange } from './sogChunk.js';
// Shared, parallel-friendly encoder from core (async gzip on the libuv threadpool) +
// bounded-concurrency map — same import lcc uses. (Replaced the former local synchronous
// ./spzGlb.js, which was byte-identical and is now deleted.)
import { buildSpzBuffer, buildSpzGlb, computeBounds, parallelMap, defaultConcurrency } from '../../core/index.js';

// Geometric error: anchored to the ROOT bound diagonal and halved at every step down
// the tree (interior level AND each LOD-chain step), matching the reference
// 3DGS-PLY-3DTiles-Converter's `rootGE × samplingRatio^depth`. This stays bounded and
// strictly decreasing by construction — compounding a per-node ratio up a deep binary
// tree instead blows the root GE up to tens of thousands (→ refine-everything).
const ROOT_GE_FACTOR = 0.05;  // root geometricError = rootBoundDiagonal × this (reference ≈ 0.04)
const DEPTH_RATIO    = 0.5;   // GE multiplier per depth step (samplingRatePerLevel)

const ensureDir = d => fs.mkdir(d, { recursive: true });

// glTF Y-up → 3D Tiles Z-up box (RX +90°): centre (cx,cy,cz)→(cx,−cz,cy); half-extents y↔z.
function boundToZUpBox(min, max) {
  const cx=(min[0]+max[0])/2, cy=(min[1]+max[1])/2, cz=(min[2]+max[2])/2;
  const hx=Math.max((max[0]-min[0])/2,1e-4), hy=Math.max((max[1]-min[1])/2,1e-4), hz=Math.max((max[2]-min[2])/2,1e-4);
  return [cx, -cz, cy, hx,0,0, 0,hz,0, 0,0,hy];
}
function boundDiagonal(min, max) {
  const dx=max[0]-min[0], dy=max[1]-min[1], dz=max[2]-min[2];
  return Math.sqrt(dx*dx+dy*dy+dz*dz) || 1e-3;
}

/** Uniform in-process entry: convert a streamed-SOG scene (dir or lod-meta.json) → 3D Tiles. */
export async function convert(input, outDir, opts = {}) {
  if (!input || !outDir) throw new Error('Usage: sog-to-3dtiles <scene-dir | lod-meta.json> <outDir>');
  let inPath = input;
  // Resolve the index file.
  const stat = await fs.stat(inPath).catch(() => null);
  if (stat?.isDirectory()) inPath = path.join(inPath, 'lod-meta.json');
  const sceneDir = path.dirname(inPath);
  const lod = JSON.parse(await fs.readFile(inPath, 'utf8'));

  if (lod.version != null && lod.version > 1)
    throw new Error(`Unsupported Streamed SOG version ${lod.version} (this tool targets v1).`);

  const lodLevels = lod.lodLevels ?? (lod.counts?.length ?? 1);
  console.log(`Streamed SOG: ${((lod.count ?? 0)/1e6).toFixed(2)}M gaussians, ${lodLevels} LOD levels, ${lod.filenames.length} chunks`);
  // Rough estimate from past runs: ~2s per chunk decode (WebP) + ~3ms per tile write.
  // (skatepark 20 chunks/2k tiles ≈ 1 min; roman 131 chunks/38k tiles ≈ several min.)
  const t0 = Date.now();
  const estSec = lod.filenames.length * 2;
  console.log(`  Est. processing time: ~${estSec < 60 ? Math.ceil(estSec)+'s' : Math.ceil(estSec/60)+' min'}+ (rough; grows with tile count)`);

  await ensureDir(path.join(outDir, 'tiles'));

  let nextId = 0;
  const rootDiag = boundDiagonal(lod.tree.bound.min, lod.tree.bound.max);
  const ROOT_GE  = rootDiag * ROOT_GE_FACTOR;
  const geAt = (depth) => ROOT_GE * Math.pow(DEPTH_RATIO, depth);

  // ── Phase 1: walk the tree, build the 3D Tiles structure, collect content tasks ──
  // build() is synchronous — it assigns each leaf-LOD run a tile + uri and records a
  // pending {uri, run} task. The GLB bytes are written in phase 2, grouped by chunk
  // file, so each chunk SOG is decoded exactly ONCE and released — bounding memory to
  // one chunk DataTable at a time (caching all 131 chunks blew the JS heap).
  const pending = [];   // { uri, run:{file,offset,count} }

  function build(node, depth) {
    const box = boundToZUpBox(node.bound.min, node.bound.max);

    if (node.children) {                         // ── interior node ──
      const ge = geAt(depth);
      const kids = node.children.map(c => build(c, depth + 1));
      return { ge, tile: { boundingVolume: { box }, geometricError: ge, refine: 'REPLACE', children: kids.map(k => k.tile) } };
    }

    const levels = Object.keys(node.lods ?? {}).map(Number).sort((p, q) => p - q); // ascending: 0=finest
    if (!levels.length) { const ge = geAt(depth); return { ge, tile: { boundingVolume: { box }, geometricError: ge, refine: 'REPLACE' } }; }
    const maxL = levels[levels.length - 1];

    // Finest (level 0) first; nest each coarser level as its parent. chainDepth = depth + maxL − L.
    let child = null, outerGe = 0;
    for (const level of levels) {
      const ge = geAt(depth + (maxL - level));
      const uri = `tiles/node_${nextId++}.glb`;
      pending.push({ uri, run: node.lods[String(level)] });
      const tile = { boundingVolume: { box }, geometricError: ge, refine: 'REPLACE', content: { uri } };
      if (child) tile.children = [child];
      child = tile; outerGe = ge;
    }
    return { ge: outerGe, tile: child };
  }

  console.log('Walking tree…');
  const root = build(lod.tree, 0);

  // ── Phase 2: write GLBs grouped by chunk file (decode once, release) ──
  const byFile = new Map();                       // fileIdx → [{uri, run}]
  for (const p of pending) {
    if (!byFile.has(p.run.file)) byFile.set(p.run.file, []);
    byFile.get(p.run.file).push(p);
  }
  console.log(`Writing ${pending.length} tiles from ${byFile.size} chunks…`);
  const concurrency = defaultConcurrency();
  let tilesWritten = 0, chunksDone = 0;
  for (const [fileIdx, tasks] of byFile) {
    const table = await decodeChunk(path.join(sceneDir, lod.filenames[fileIdx]));
    // Fan this chunk's tiles through bounded-concurrency encode+write (async gzip runs
    // on the libuv threadpool). `table` stays alive only for this chunk, then is released
    // before the next decode — memory stays bounded to one chunk DataTable at a time.
    await parallelMap(tasks, async ({ uri, run }) => {
      const { positions, alphas, rgb, scales, rotations } = extractRange(table, run.offset, run.count);
      const bounds = computeBounds(positions, run.count);
      const spz = await buildSpzBuffer(positions, alphas, rgb, scales, rotations, run.count);
      const glb = buildSpzGlb(spz, run.count, bounds);
      await fs.writeFile(path.join(outDir, uri), glb);
      tilesWritten++;
    }, { concurrency });
    chunksDone++;
    process.stdout.write(`\r  ${chunksDone}/${byFile.size} chunks, ${tilesWritten} tiles`);
    // `table` goes out of scope next iteration; nothing retains it → GC can reclaim it.
  }
  process.stdout.write('\n');

  // Optional environment SOG → one always-coarse child so it streams in early.
  if (lod.environment) {
    try {
      const envMeta = path.join(sceneDir, lod.environment);
      const table = await decodeChunk(envMeta);
      const n = table.numRows;
      const { positions, alphas, rgb, scales, rotations } = extractRange(table, 0, n);
      const bounds = computeBounds(positions, n);
      const glb = buildSpzGlb(await buildSpzBuffer(positions, alphas, rgb, scales, rotations, n), n, bounds);
      const uri = `tiles/env.glb`;
      await fs.writeFile(path.join(outDir, uri), glb);
      const envBox = [bounds.cx, -bounds.cz, bounds.cy, bounds.hx,0,0, 0,bounds.hz,0, 0,0,bounds.hy];
      // Environment renders unconditionally → give it a huge GE so it's always selected.
      const envTile = { boundingVolume: { box: envBox }, geometricError: 1e9, refine: 'REPLACE', content: { uri } };
      // Wrap a new ADD root so the env is added alongside the refined spatial tree.
      const rootBox = root.tile.boundingVolume.box;
      root.tile = { boundingVolume: { box: rootBox }, geometricError: 1e9,
                    refine: 'ADD', children: [envTile, root.tile] };
      console.log('\n  + environment SOG attached');
    } catch (e) {
      console.warn('\n  ⚠ environment SOG skipped:', e.message);
    }
  }

  const tileset = {
    asset: { version: '1.1' },
    geometricError: root.tile.geometricError,
    root: root.tile,
    extensionsUsed: ['3DTILES_content_gltf'],
    extensions: { '3DTILES_content_gltf': {
      extensionsUsed:     ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
      extensionsRequired: ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
    }},
  };
  await fs.writeFile(path.join(outDir, 'tileset.json'), JSON.stringify(tileset, null, 2));
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`\nDone → ${outDir}/tileset.json  (${tilesWritten} GLB tiles, KHR_gaussian_splatting_compression_spz_2)`);
  console.log(`  Actual time: ${elapsed < 60 ? elapsed.toFixed(1)+'s' : (elapsed/60).toFixed(1)+' min'}`);
  return { format: 'sog', outDir, tiles: tilesWritten };
}

// ── CLI shim: run only when invoked directly (not when imported by the meta-converter) ──
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = process.argv.slice(2).filter(x => !x.startsWith('--'));
  convert(a[0], a[1]).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
