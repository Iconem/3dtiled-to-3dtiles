// benchmark-converters.mjs — reproducible conversion benchmark over the repo's own converters.
//
//   node scripts/benchmark-converters.mjs [--only potree,sog,…] [--out benchmark-results]
//
// For each (small, public) dataset: mirror the remote source locally ONCE (download timed
// separately — cached across runs under .bench-cache), then time the offline convert() and walk the
// output (tile count, bytes). Prints a markdown table and writes a dated JSON to benchmark-results/.
//
// This is the "neutral benchmark first step" from the TODO doc's fastest-tiler note: it measures OUR
// converters on pinned datasets so changes are comparable run-over-run. External tilers
// (PotreeConverter 2.0, untwine, MIERUNE point-tiler) convert RAW point clouds — a different job than
// these tiled-format transcodes — so they are compared on the docs page's methodology terms, not here.
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { convert } from '../packages/convert/index.js';
import { mirrorRemote } from '../packages/convert/fetch-source.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(root, '.bench-cache');

const DATASETS = [
  { id: 'potree1-lion-takanawa', fmt: 'potree', unit: 'points', points: 272768,
    src: 'https://raw.githubusercontent.com/potree/potree/develop/pointclouds/lion_takanawa/cloud.js' },
  { id: 'potree2-lion', fmt: 'potree', unit: 'points', points: 3954696,
    src: 'https://potree.org/pointclouds/lion/metadata.json' },
  { id: 'sog-skatepark', fmt: 'sog', unit: 'splats', points: null,
    src: 'https://code.playcanvas.com/examples_data/example_skatepark_02/lod-meta.json' },
  { id: 'rad-tastier-500k', fmt: 'rad', unit: 'splats', points: 500000,
    src: 'https://wlt-ai-cdn.art/tastier_rad_500/0524c1a1-abf2-4969-ae40-9981ee836536_500k-lod.rad' },
];

const args = process.argv.slice(2);
const only = (args.includes('--only') ? args[args.indexOf('--only') + 1] : '').split(',').filter(Boolean);
const outBase = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'benchmark-results';

async function dirStats(dir) {
  let files = 0, bytes = 0;
  const walk = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else { files++; bytes += (await fs.stat(p)).size; }
    }
  };
  await walk(dir);
  return { files, bytes };
}

const results = [];
for (const ds of DATASETS) {
  if (only.length && !only.includes(ds.fmt) && !only.includes(ds.id)) continue;
  process.stdout.write(`\n── ${ds.id} (${ds.fmt}) ──\n`);
  const mirrorDir = path.join(CACHE, ds.id + '.src');
  const outDir = path.join(CACHE, ds.id + '.out');
  await fs.rm(outDir, { recursive: true, force: true });
  try {
    const t0 = performance.now();
    const input = await mirrorRemote(ds.src, ds.fmt, mirrorDir);   // cached: near-instant when warm
    const tDownload = performance.now() - t0;
    const srcStats = await dirStats(mirrorDir);

    const t1 = performance.now();
    await convert(input, outDir, { format: ds.fmt });
    const tConvert = (performance.now() - t1) / 1000;
    const out = await dirStats(outDir);

    const row = {
      id: ds.id, format: ds.fmt, unit: ds.unit, points: ds.points,
      sourceMB: +(srcStats.bytes / 1e6).toFixed(1), downloadS: +(tDownload / 1000).toFixed(1),
      convertS: +tConvert.toFixed(2), outputTiles: out.files, outputMB: +(out.bytes / 1e6).toFixed(1),
      throughputMptsS: ds.points ? +((ds.points / 1e6) / tConvert).toFixed(2) : null,
      srcMBs: +((srcStats.bytes / 1e6) / tConvert).toFixed(1),
    };
    results.push(row);
    console.log(`   convert ${row.convertS}s · ${row.outputTiles} files · ${row.outputMB} MB out` +
      (row.throughputMptsS ? ` · ${row.throughputMptsS} M${ds.unit}/s` : ''));
  } catch (e) {
    console.error(`   FAILED: ${e.message}`);
    results.push({ id: ds.id, format: ds.fmt, error: String(e.message) });
  }
}

// ── report ──
const os = await import('os');
const meta = { date: new Date().toISOString(), node: process.version, cpu: os.cpus()[0]?.model, cores: os.cpus().length, platform: process.platform };
const md = [
  `Machine: ${meta.cpu} × ${meta.cores} · Node ${meta.node} · ${meta.platform} · ${meta.date.slice(0, 10)}`,
  '',
  '| Dataset | Format | Source MB | Convert s | Output files | Output MB | Throughput |',
  '|---|---|--:|--:|--:|--:|--:|',
  ...results.map(r => r.error
    ? `| ${r.id} | ${r.format} | — | — | — | — | FAILED: ${r.error} |`
    : `| ${r.id} | ${r.format} | ${r.sourceMB} | ${r.convertS} | ${r.outputTiles} | ${r.outputMB} | ${r.throughputMptsS ? r.throughputMptsS + ' M ' + r.unit + '/s' : r.srcMBs + ' MB/s'} |`),
].join('\n');
console.log('\n' + md + '\n');

await fs.mkdir(path.join(root, outBase), { recursive: true });
const stamp = meta.date.slice(0, 19).replace(/[:T]/g, '-');
await fs.writeFile(path.join(root, outBase, `bench-${stamp}.json`), JSON.stringify({ meta, results }, null, 2));
console.log(`written → ${outBase}/bench-${stamp}.json`);
