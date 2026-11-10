/**
 * nexus-to-3dtiles — Nexus multiresolution mesh (`.nxs`, `.nxz`; CNR-ISTI, 3DHOP) → OGC 3D Tiles 1.1, offline.
 *
 *   3dtiled <model.nxs|nxz> <outDir> --format nexus [--dag levels|paths] [--ge-scale 8] [--workers auto|N]
 *
 * One GLB per node (`tiles/node_<i>.glb`, nexus-glb.js) and a tileset.json over them (nexus-tileset.js, where the
 * DAG → tree mapping is explained). The file is read once into memory: a node's bytes and the textures its patches
 * name are sliced from it. `.nxz` nodes are decoded by the vendored MIT decoders (../vendor).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { convertTiles } from '../../core/index.js';
import { parseNexus, nodeRange, nodeTextures } from './nexus-reader.js';
import { nexusTileset, DEFAULT_GE_SCALE } from './nexus-tileset.js';
import { nexusNodeToFile } from './tile-task.js';

const TILE_TASK = new URL('./tile-task.js', import.meta.url).href;

/** The plain, structured-clone-able part of an index (what a tile worker needs). */
export const plainIndex = (index) => ({ header: index.header, nodes: index.nodes, patches: index.patches, textures: index.textures, nroots: index.nroots });

/**
 * @param input  path of a .nxs / .nxz file
 * @param outDir output directory (tileset.json + tiles/)
 * @param opts   { dag?: 'levels'|'paths', geScale?, workers? }
 */
export async function convert(input, outDir, opts = {}) {
  const t0 = performance.now();
  const bytes = await fs.readFile(input);
  const index = parseNexus(bytes);
  const { header } = index;
  const dag = opts.dag || 'levels', geScale = opts.geScale ?? DEFAULT_GE_SCALE;
  const { tileset, stats, tiles, mode } = nexusTileset(index, (i) => `tiles/node_${i}.glb`, { dag, geScale, tag: 'nexus' });
  console.log(`[nexus] ${path.basename(input)}: ${(bytes.length / 1e6).toFixed(1)} MB, version ${header.version}, ${header.codec ? `${header.codec}-compressed` : 'uncompressed'}, `
    + `${stats.nodes} nodes in ${stats.levels} levels (${stats.roots} root${stats.roots > 1 ? 's' : ''}, ${stats.leaves} leaves, ${stats.shared} shared, up to ${stats.maxParents} parents, ${stats.paths} paths), `
    + `${stats.vertices} vertices, ${stats.triangles} triangles (${stats.leafTriangles} at the finest level), ${stats.textures} texture${stats.textures === 1 ? '' : 's'}; `
    + `attributes: ${Object.keys(header.signature.vertex).join(' ')}`);
  if (!stats.errorsOk) console.warn(`[nexus] ${stats.errorUp} patches lead to a node with a larger error than its parent`);
  if (!stats.spheresOk) console.warn(`[nexus] ${stats.sphereOutside} patches lead to a node whose sphere is outside its parent's`);

  await fs.mkdir(path.join(outDir, 'tiles'), { recursive: true });
  const plain = plainIndex(index);
  const withGeometry = [];
  for (let i = 0; i < stats.nodes; i++) if (index.nodes[i].nface) withGeometry.push(i);
  const taskOf = (i) => {
    const r = nodeRange(index, i);
    const textures = nodeTextures(index, i).map((t) => { const tx = index.textures[t]; return [t, new Uint8Array(bytes.subarray(tx.offset, tx.end))]; });
    return { index: plain, i, nodeBytes: new Uint8Array(bytes.subarray(r.begin, r.end)), textures, outPath: path.join(outDir, `tiles/node_${i}.glb`) };
  };
  let written = 0, glbBytes = 0;
  const { workers } = await convertTiles(withGeometry, {
    module: TILE_TASK, fn: 'nexusNodeToFile', workers: opts.workers,
    task: taskOf, here: (i) => nexusNodeToFile(taskOf(i)),
    onResult: (i, r) => { if (r.written) { written++; glbBytes += r.bytes; } },
    onProgress: (d, t) => { if (d % 50 === 0 || d === t) process.stdout.write(`\r  ${d}/${t} nodes`); },
  });
  process.stdout.write(` (${workers ? `${workers} worker threads` : 'this thread'})\n`);
  await fs.writeFile(path.join(outDir, 'tileset.json'), JSON.stringify(tileset, null, 2));
  const elapsedMs = performance.now() - t0;
  console.log(`└─ done → ${outDir}/tileset.json  (${written} GLB tiles, ${(glbBytes / 1e6).toFixed(1)} MB, ${tiles} tiles with content in the tree by ${mode}, ${(elapsedMs / 1000).toFixed(1)} s)`);
  return { format: 'nexus', outDir, tiles, nodes: stats.nodes, written, glbBytes, mode, elapsedMs, stats: { ...stats, depth: undefined, parents: undefined } };
}

export { parseNexus, nexusTileset };
