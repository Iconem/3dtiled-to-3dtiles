/**
 * lcc2.js (lcc-to-3dtiles) — offline **XGRIDS LCC2 → OGC 3D Tiles**: a `*.lcc2` manifest beside its `data/3dgs/*.sog`
 * chunks → tileset.json + one SPZ-v2 GLB per node run.
 *
 * The tree is the live adapter's (lcc2Manifest.js: node → tile, boxes from the manifest, nothing decoded for it). The
 * tiles are written by streamed SOG's chunk task (sog-to-3dtiles/src/tile-task.js), an LCC2 chunk being a bundled SOG:
 * each chunk is decoded once and every tile cut from it is a row range of that one table.
 */
import fs from 'fs/promises';
import path from 'path';
import { defaultConcurrency, convertTiles } from '../../core/index.js';
import { sogChunkToFiles } from '../../sog-to-3dtiles/src/tile-task.js';
import { parseLcc2, lcc2Tileset } from './lcc2Manifest.js';

const TILE_TASK = new URL('../../sog-to-3dtiles/src/tile-task.js', import.meta.url).href;

/** The manifest of `input` (a `*.lcc2` file, or a directory holding one), or null when it is not an LCC2 scene. */
export async function lcc2ManifestPath(input) {
  if (/\.lcc2$/i.test(input)) return input;
  const stat = await fs.stat(input).catch(() => null);
  if (!stat?.isDirectory()) return null;
  const name = (await fs.readdir(input)).find((f) => f.toLowerCase().endsWith('.lcc2'));
  return name ? path.join(input, name) : null;
}

/** Convert an LCC2 scene (its manifest, or the directory holding it) → 3D Tiles in `outDir`. */
export async function convertLcc2(input, outDir, opts = {}) {
  const inPath = await lcc2ManifestPath(input);
  if (!inPath) throw new Error(`no *.lcc2 manifest at ${input}`);
  const dir = path.dirname(inPath);
  const manifest = parseLcc2(await fs.readFile(inPath, 'utf8'));
  const centroids = !!opts.centroidsOnly;
  const { tileset, runs } = lcc2Tileset(manifest, (run) => `tiles/${run.file}_${run.start}_${run.count}.glb`, { centroids, tag: 'lcc2-offline' });
  console.log(`LCC2: ${(manifest.totalSplats / 1e6).toFixed(2)}M splats, ${manifest.totalLevels} LODs, ${runs.length} tiles in ${new Set(runs.map((r) => r.file)).size} chunks`);
  const t0 = Date.now();
  await fs.mkdir(path.join(outDir, 'tiles'), { recursive: true });

  // The unit of work is the chunk, as for streamed SOG: decoded once, its tiles encoded in lanes; biggest chunks first.
  const byFile = new Map();
  for (const run of runs) { if (!byFile.has(run.file)) byFile.set(run.file, []); byFile.get(run.file).push(run); }
  const chunks = [...byFile].map(([file, list]) => ({
    metaPath: path.join(dir, manifest.files[file]), outDir, centroids,
    tiles: list.map(({ uri, start, count }) => ({ uri, offset: start, count })),
  })).sort((a, b) => b.tiles.reduce((n, t) => n + t.count, 0) - a.tiles.reduce((n, t) => n + t.count, 0));
  const lanes = defaultConcurrency();
  let tilesWritten = 0, chunksDone = 0;
  await convertTiles(chunks, {
    module: TILE_TASK, fn: 'sogChunkToFiles', workers: opts.workers, concurrency: 1,
    task: (chunk) => ({ ...chunk, concurrency: 2 }),
    here: (chunk) => sogChunkToFiles({ ...chunk, concurrency: lanes }),
    onResult: (_chunk, n) => { tilesWritten += n; chunksDone++; process.stdout.write(`\r  ${chunksDone}/${chunks.length} chunks, ${tilesWritten} tiles`); },
  });
  process.stdout.write('\n');

  await fs.writeFile(path.join(outDir, 'tileset.json'), JSON.stringify(tileset, null, 2));
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`Done → ${outDir}/tileset.json  (${tilesWritten} ${centroids ? 'POINTS centroid' : 'SPZ splat'} tiles)`);
  console.log(`  Actual time: ${elapsed < 60 ? elapsed.toFixed(1) + 's' : (elapsed / 60).toFixed(1) + ' min'}`);
  return { format: 'lcc2', outDir, tiles: tilesWritten };
}
