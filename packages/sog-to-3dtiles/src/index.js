#!/usr/bin/env node
/**
 * sog-to-3dtiles
 *
 * Converts a PlayCanvas **Streamed SOG** dataset (lod-meta.json + per-chunk unbundled
 * SOG dirs) to OGC 3D Tiles 1.1 with KHR_gaussian_splatting_compression_spz_2 GLB tiles.
 *
 *   node src/index.js <scene-dir-or-lod-meta.json> <outDir> [--splat-budget N]   (0: one tile per leaf run)
 *
 * The streamed-SOG spatial tree is a binary k-d tree whose leaves hold one run of every LOD
 * level: a big scene (Shramko's 103 M-splat Lublin) has 31,668 leaves 15 levels deep, so the
 * coarsest level alone would be 31,668 tiles of ~50 splats under 14 empty levels, and a 3D Tiles
 * renderer refines all of them before it draws anything. The tree is therefore COLLAPSED per LOD
 * level with a splat budget (`splatBudget`, default 100 k, `--splat-budget` on the CLI):
 *   • for each level, the shallowest nodes whose splats of that level fit the budget become the
 *     tiles of that level; the content of such a tile is the concatenation of its leaves' runs
 *     (contiguous slices of the chunk files), re-encoded as one SPZ-v2 GLB
 *   • a tile of level L has as children the tiles of level L−1 under it (the node itself when
 *     it still fits, else its shallowest fitting descendants), refine REPLACE
 *   • interior nodes above the coarsest level's tiles are empty tiles with children
 * With the budget at 0 the old 1:1 mapping is used:
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
import { lodGeometricErrors, collapseLodTree, DEFAULT_SPLAT_BUDGET } from './lodMeta.js';
import { sogChunkToFiles } from './tile-task.js';

const TILE_TASK = new URL('./tile-task.js', import.meta.url).href;
// Shared, parallel-friendly encoder from core (async gzip on the libuv threadpool) +
// bounded-concurrency map — same import lcc uses. (Replaced the former local synchronous
// ./spzGlb.js, which was byte-identical and is now deleted.)
import { buildSplatTileGlb, computeBounds, defaultConcurrency, convertTiles, parallelMap } from '../../core/index.js';

// Geometric error: anchored to the ROOT bound diagonal and halved at every step down
// the tree (interior level AND each LOD-chain step), matching the reference
// 3DGS-PLY-3DTiles-Converter's `rootGE × samplingRatio^depth`. This stays bounded and
// strictly decreasing by construction — compounding a per-node ratio up a deep binary
// tree instead blows the root GE up to tens of thousands (→ refine-everything).
const ROOT_GE_FACTOR = 0.05;  // root geometricError = rootBoundDiagonal × this (reference ≈ 0.04)
const DEPTH_RATIO    = 0.5;   // GE multiplier per depth step (samplingRatePerLevel)
const TABLE_CACHE = 8;        // decoded chunk tables kept while merged tiles are written (~30 MB each)

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
    // Finest (level 0) first; nest each coarser level as its parent: halving per level, or the leaf's own `errors`
    // when lod-meta.json carries them (lodMeta.js).
    const ges = lodGeometricErrors(node, levels, depth, geAt, lod.lodErrors === true);
    let child = null, outerGe = 0;
    for (const level of levels) {
      const ge = ges.get(level);
      const uri = `tiles/node_${nextId++}.glb`;
      pending.push({ uri, run: node.lods[String(level)] });
      const tile = { boundingVolume: { box }, geometricError: ge, refine: 'REPLACE', content: { uri } };
      if (child) tile.children = [child];
      child = tile; outerGe = ge;
    }
    return { ge: outerGe, tile: child };
  }

  // ── Collapsed tree (splat budget): lodMeta.js, shared with the live route ──
  const budget = opts.splatBudget != null ? Number(opts.splatBudget) : DEFAULT_SPLAT_BUDGET;
  const merged = [];    // { uri, runs:[{file,offset,count}] }  (budget > 0)
  const collapsed = () => collapseLodTree(lod.tree, lodLevels, budget, {
    box: boundToZUpBox,
    content: (runs) => { const uri = `tiles/node_${nextId++}.glb`; merged.push({ uri, runs }); return { uri }; },
  });

  console.log(budget > 0 ? `Walking tree, collapsing to ≤ ${budget.toLocaleString()} splats per tile…` : 'Walking tree…');
  const root = budget > 0 ? { tile: collapsed() } : build(lod.tree, 0);

  // ── Phase 2 (collapsed): one GLB per merged tile, its runs cut from a small cache of decoded chunks ──
  // Tiles are written in order of their first chunk, so consecutive tiles share decoded chunks.
  let tilesWritten = 0;
  if (budget > 0) {
    console.log(`Writing ${merged.length} merged tiles from ${lod.filenames.length} chunks…`);
    merged.sort((a, b) => a.runs[0].file - b.runs[0].file || a.runs[0].offset - b.runs[0].offset);
    const cache = new Map();                        // fileIdx → Promise<DataTable>, insertion-ordered for eviction
    const tableOf = (fileIdx) => {
      if (!cache.has(fileIdx)) {
        cache.set(fileIdx, decodeChunk(path.join(sceneDir, lod.filenames[fileIdx])));
        while (cache.size > TABLE_CACHE) cache.delete(cache.keys().next().value);
      }
      return cache.get(fileIdx);
    };
    const concat = (parts, key) => {
      if (parts.some(p => !p[key])) return null;
      const n = parts.reduce((s, p) => s + p[key].length, 0), out = new Float32Array(n);
      let o = 0; for (const p of parts) { out.set(p[key], o); o += p[key].length; }
      return out;
    };
    await parallelMap(merged, async ({ uri, runs }) => {
      const parts = [];
      for (const r of runs) parts.push(extractRange(await tableOf(r.file), r.offset, r.count));   // sequential: chunk order
      const count = runs.reduce((s, r) => s + r.count, 0);
      const arrays = { positions: concat(parts, 'positions'), alphas: concat(parts, 'alphas'), rgb: concat(parts, 'rgb'),
                       scales: concat(parts, 'scales'), rotations: concat(parts, 'rotations') };
      const glb = await buildSplatTileGlb(arrays, count, computeBounds(arrays.positions, count), !!opts.centroidsOnly);
      await fs.writeFile(path.join(outDir, uri), glb);
      tilesWritten++;
      if (tilesWritten % 20 === 0 || tilesWritten === merged.length) process.stdout.write(`\r  ${tilesWritten}/${merged.length} tiles`);
    }, { concurrency: 2 });
    process.stdout.write('\n');
  }

  // ── Phase 2 (1:1 tree): write GLBs grouped by chunk file (decode once, release) ──
  const byFile = new Map();                       // fileIdx → [{uri, run}]
  for (const p of pending) {
    if (!byFile.has(p.run.file)) byFile.set(p.run.file, []);
    byFile.get(p.run.file).push(p);
  }
  if (pending.length) console.log(`Writing ${pending.length} tiles from ${byFile.size} chunks…`);
  // The unit of work is the chunk (tile-task.js): its WebP planes are decoded once, then every tile cut from it is
  // encoded and written. On this thread: one chunk at a time, its tiles in lanes, so memory stays bounded to one
  // decoded table. With tile workers (TILED_WORKERS, --workers, opts.workers): one chunk per worker at a time.
  const lanes = defaultConcurrency();
  let chunksDone = 0;
  // Biggest chunks first (by splat count): a chunk is one worker's unit of work, and a 4 000-tile chunk handed out last
  // would run alone at the end while the other workers sit idle.
  const chunks = [...byFile].map(([fileIdx, tasks]) => ({
    metaPath: path.join(sceneDir, lod.filenames[fileIdx]), outDir, centroids: !!opts.centroidsOnly,
    tiles: tasks.map(({ uri, run }) => ({ uri, offset: run.offset, count: run.count })),
  })).sort((a, b) => b.tiles.reduce((n, t) => n + t.count, 0) - a.tiles.reduce((n, t) => n + t.count, 0));
  if (chunks.length) await convertTiles(chunks, {
    module: TILE_TASK, fn: 'sogChunkToFiles', workers: opts.workers, concurrency: 1,
    task: (chunk) => ({ ...chunk, concurrency: 2 }),
    here: (chunk) => sogChunkToFiles({ ...chunk, concurrency: lanes }),
    onResult: (_chunk, n) => { tilesWritten += n; chunksDone++; process.stdout.write(`\r  ${chunksDone}/${byFile.size} chunks, ${tilesWritten} tiles`); },
  });
  if (chunks.length) process.stdout.write('\n');

  // Optional environment SOG → one always-coarse child so it streams in early.
  if (lod.environment) {
    try {
      const envMeta = path.join(sceneDir, lod.environment);
      const table = await decodeChunk(envMeta);
      const n = table.numRows;
      const { positions, alphas, rgb, scales, rotations } = extractRange(table, 0, n);
      const bounds = computeBounds(positions, n);
      const glb = await buildSplatTileGlb({ positions, alphas, rgb, scales, rotations }, n, bounds, opts.centroidsOnly);
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

  // SOG (PlayCanvas Y-up) → 3D Tiles (Z-up): RX(−90°) root transform (col-major).
  // col0=X→X, col1=Y→−Z, col2=Z→Y. Bounding volumes already use boundToZUpBox.
  root.tile.transform = [1,0,0,0, 0,0,-1,0, 0,1,0,0, 0,0,0,1];

  const tileset = {
    asset: { version: '1.1' },
    geometricError: root.tile.geometricError,
    root: root.tile,
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
  console.log(`\nDone → ${outDir}/tileset.json  (${tilesWritten} ${opts.centroidsOnly ? 'POINTS centroid' : 'SPZ splat'} tiles)`);
  console.log(`  Actual time: ${elapsed < 60 ? elapsed.toFixed(1)+'s' : (elapsed/60).toFixed(1)+' min'}`);
  return { format: 'sog', outDir, tiles: tilesWritten };
}

// ── CLI shim: run only when invoked directly (not when imported by the meta-converter) ──
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const argv = process.argv.slice(2), a = [];
  let splatBudget;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--splat-budget') splatBudget = Number(argv[++i]);
    else if (!argv[i].startsWith('--')) a.push(argv[i]);
  }
  convert(a[0], a[1], { splatBudget }).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
