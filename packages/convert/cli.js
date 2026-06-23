#!/usr/bin/env node
/**
 * 3dtiled — meta-converter CLI. Detects the input format and converts to 3D Tiles.
 *
 *   3dtiled <input> <outDir> [--format rad|sog|lcc|copc|potree|i3s]
 *           [--scale N] [--ge-scale N] [--ge-layer N] [--centroids-only] [-- <extra converter args>]
 *
 * --centroids-only: for splat formats (rad/sog/lcc), emit a glTF POINTS tileset of splat centroids
 *   instead of KHR_gaussian_splatting tiles — renderable by point-cloud-only 3D Tiles viewers.
 *
 * Detection covers: .rad · .copc.laz/.laz · streamed-SOG (lod-meta.json) · single SOG (meta.json+webp)
 * · LCC (meta.lcc/index.bin/data.bin) · Potree 2.0 (metadata.json+octree.bin) / 1.x (cloud.js)
 * · I3S (.slpk / 3dSceneLayer.json).
 */
import { convert, detectFormat, supportedFormats } from './index.js';

const rawArgv = process.argv.slice(2);
const sepIdx = rawArgv.indexOf('--');
const argv = sepIdx >= 0 ? rawArgv.slice(0, sepIdx) : rawArgv;
const extraArgs = sepIdx >= 0 ? rawArgv.slice(sepIdx + 1) : [];

const VALUE_FLAGS = new Set(['format', 'scale', 'ge-scale', 'ge-layer']);
function flag(name) { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; }

// positionals = tokens that aren't a --flag nor the value following a value-flag
const positionals = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { if (VALUE_FLAGS.has(a.slice(2))) i++; continue; }
  positionals.push(a);
}
const input = positionals[0];
const outDir = positionals[1];

if (!input || !outDir) {
  console.error(`Usage: 3dtiled <input> <outDir> [--format <fmt>] [--scale N] [--ge-scale N] [--ge-layer N] [--centroids-only] [-- extra args]
  formats: ${supportedFormats.join(', ')}`);
  process.exit(1);
}

(async () => {
  const format = flag('format') || await detectFormat(input);
  console.log(`[3dtiled] input: ${input}`);
  console.log(`[3dtiled] detected format: ${format ?? '(none — pass --format)'}`);
  if (!format) process.exit(2);
  const opts = {
    format,
    scale:   flag('scale')   != null ? Number(flag('scale'))   : undefined,
    geScale: flag('ge-scale')!= null ? Number(flag('ge-scale')): undefined,
    geLayer: flag('ge-layer')!= null ? Number(flag('ge-layer')): undefined,
    centroidsOnly: argv.includes('--centroids-only'),   // splat fmts → POINTS centroid tileset
    extraArgs,
  };
  await convert(input, outDir, opts);
  console.log(`[3dtiled] done → ${outDir}/tileset.json`);
})().catch(e => { console.error('[3dtiled] error:', e.message); process.exit(1); });
