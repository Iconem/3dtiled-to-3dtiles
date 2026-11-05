#!/usr/bin/env node
/**
 * 3dtiled — meta-converter CLI. Detects the input format and converts to 3D Tiles.
 *
 *   3dtiled <input> <outDir> [--format rad|sog|lcc|copc|potree|i3s]
 *           [--scale N] [--ge-scale N] [--ge-layer N] [--centroids-only] [--verify off|counts|sample|full] [--hierarchy-errors error|warn] [-- <extra converter args>]
 *
 *   3dtiled serve [<input>] [--port 3001] [--format <fmt>] [--lon <deg> --lat <deg>] [--alt m]
 *           [--heading deg] [--place-scale N]
 *     Start the live tile-server middleware and (with <input>) print the ready-to-paste 3D Tiles URL
 *     for it — the "point Cesium for Unreal at a local dataset" one-liner. Remote streamable sources
 *     get a /stream URL (nothing pre-converted); local paths and non-streamable formats get /convert
 *     (converted once on first request, then cached). --lon/--lat append the tileset-level globe
 *     placement params (see tile-server docs).
 *
 *   3dtiled export <tileset-url> <outDir> [--max-depth N] [--keep-implicit] [--pack 3tz,3dtiles] [--overwrite] [--verify off|counts|sample|full] [--hierarchy-errors error|warn]
 *     Materialise any 3D Tiles tileset (a remote one, or a /stream, /convert or /aggregate URL of a
 *     running server) into a self-contained folder: every tileset JSON and tile file, uris made
 *     relative, implicit tilings expanded. For a raw dataset (a .copc.laz, a Potree folder…), either
 *     use the default convert command below or `3dtiled serve` it and export the printed URL.
 *
 * --centroids-only: for splat formats (rad/sog/lcc), emit a glTF POINTS tileset of splat centroids
 *   instead of KHR_gaussian_splatting tiles — renderable by point-cloud-only 3D Tiles viewers.
 *
 * Detection covers: .rad · .copc.laz/.laz · streamed-SOG (lod-meta.json) · single SOG (meta.json+webp)
 * · LCC (meta.lcc/index.bin/data.bin) · Potree 2.0 (metadata.json+octree.bin) / 1.x (cloud.js)
 * · I3S (.slpk / 3dSceneLayer.json).
 */
import { convert, detectFormat, supportedFormats } from './index.js';
import { detectFormatByName } from '3dtiles-convert-core';
import { isRemote } from './fetch-source.js';

const rawArgv = process.argv.slice(2);
const sepIdx = rawArgv.indexOf('--');
const argv = sepIdx >= 0 ? rawArgv.slice(0, sepIdx) : rawArgv;
const extraArgs = sepIdx >= 0 ? rawArgv.slice(sepIdx + 1) : [];

const VALUE_FLAGS = new Set(['workers', 'verify', 'hierarchy-errors', 'max-depth', 'pack', 'format', 'scale', 'ge-scale', 'ge-layer', 'tiling', 'port', 'lon', 'lat', 'alt', 'heading', 'place-scale']);
function flag(name) { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; }
// --workers auto|<n>: decode and encode COPC and Potree tiles on worker threads (same as TILED_WORKERS)
if (flag('workers') != null) { const { setTileWorkers } = await import('3dtiles-convert-core'); setTileWorkers(flag('workers')); }
const verifyMode = flag('verify') ?? 'sample';
if (!['off', 'counts', 'sample', 'full'].includes(verifyMode)) { console.error('--verify must be off, counts, sample or full'); process.exit(1); }
const hierarchyErrors = flag('hierarchy-errors') ?? 'error';
if (!['error', 'warn'].includes(hierarchyErrors)) { console.error('--hierarchy-errors must be error or warn'); process.exit(1); }

// ── `3dtiled export` — materialise a tileset URL into a folder ─────────────────────────────────────
if (argv[0] === 'export') {
  const [, src, out] = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && VALUE_FLAGS.has(argv[i - 1].slice(2))));
  if (!src || !out || !/^https?:\/\//.test(src)) {
    console.error('Usage: 3dtiled export <tileset-url> <outDir> [--max-depth N] [--keep-implicit] [--pack 3tz,3dtiles] [--overwrite] [--verify off|counts|sample|full] [--hierarchy-errors error|warn]');
    process.exit(1);
  }
  (async () => {
    const { exportTileset } = await import('../tile-server/export-live.js');
    let last = 0;
    const r = await exportTileset(src, out, {
      maxDepth: flag('max-depth') != null ? Number(flag('max-depth')) : Infinity,
      overwrite: argv.includes('--overwrite'),
      keepImplicit: argv.includes('--keep-implicit'),
      verify: verifyMode,
      hierarchyErrors,
      pack: (flag('pack') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      onProgress: (p) => {
        if (Date.now() - last < 1000) return;
        last = Date.now();
        // The desktop app reads this line for its bar: [step/steps] label: done/total
        process.stdout.write(`\r  [${p.step}/${p.steps}] ${p.stepLabel}${p.stepTotal != null ? `: ${p.stepDone}/${p.stepTotal}` : ''} · ${p.tilesets} tilesets · ${(p.bytes / 1e6).toFixed(1)} MB${p.failed ? ` · ${p.failed} failed` : ''}   `);
      },
    });
    console.log(`\n[3dtiled export] ${r.tilesets} tilesets (${r.implicitExpanded} implicit expanded, ${r.implicitKept} kept), ${r.tilesWritten} files, `
      + `${(r.bytes / 1e6).toFixed(1)} MB in ${(r.elapsedMs / 1000).toFixed(1)} s → ${r.outDir}${r.failed ? `  (${r.failed} failed — see export-report.json)` : ''}${r.packages.length ? `
  packed: ${r.packages.join(', ')}` : ''}`);
    if (r.hierarchyFailures.length) console.error(`[3dtiled export] ${r.hierarchyFailures.length} part(s) of the hierarchy could not be read; see export-report.json.`);
    if (r.verify.summary) (r.verify.ok ? console.log : console.error)(`[3dtiled export] ${r.verify.summary}${r.verify.ok ? '' : ' See export-report.json.'}`);
  })().catch((e) => { console.error('\n[3dtiled export]', e.message); process.exit(1); });
} else if (argv[0] === 'serve') {
  const input = argv.slice(1).find((a, i, arr) => !a.startsWith('--') && !(i > 0 && arr[i-1].startsWith('--') && VALUE_FLAGS.has(arr[i-1].slice(2))));
  (async () => {
    const port = Number(flag('port')) || Number(process.env.TILE_PORT) || 3001;
    process.argv.push('--port', String(port));                 // server.js reads --port itself
    await import('../tile-server/server.js');                  // starts listening on import
    if (!input) return;
    const { streamableFormats } = await import('../tile-server/stream-live.js');
    const fmt = flag('format') || detectFormatByName(input) || (isRemote(input) ? null : await detectFormat(input).catch(() => null));
    const streamable = isRemote(input) && fmt && streamableFormats.includes(fmt);
    const params = new URLSearchParams({ url: input });
    if (fmt) params.set('format', fmt);
    for (const [k, f] of [['lon','lon'], ['lat','lat'], ['alt','alt'], ['heading','heading'], ['scale','place-scale']])
      if (flag(f) != null) params.set(k, flag(f));
    const pathName = streamable ? '/stream/tileset.json' : '/convert/tileset.json';
    const { networkInterfaces } = await import('node:os');
    const lan = Object.values(networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address;
    console.log(`\n[3dtiled serve] ${fmt ?? '?'} via ${streamable ? '/stream (live range-streaming)' : '/convert (converted once on first request, then cached)'}`);
    console.log(`\n  Paste this 3D Tiles URL into any client (CesiumJS, Cesium for Unreal/Unity, QGIS):`);
    console.log(`\n    http://localhost:${port}${pathName}?${params}`);
    if (lan) console.log(`    http://${lan}:${port}${pathName}?${params}   (same network)`);
    if (flag('lon') == null) console.log(`\n  Tip: add --lon <deg> --lat <deg> [--alt m] [--heading deg] to place a local dataset on the globe.`);
    console.log('');
  })().catch(e => { console.error('[3dtiled serve]', e.message); process.exit(1); });
} else {
// ── default: convert path ─────────────────────────────────────────────────────────────────────────

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
  console.error(`Usage: 3dtiled <input> <outDir> [--format <fmt>] [--scale N] [--ge-scale N] [--ge-layer N] [--centroids-only] [--verify off|counts|sample|full] [--hierarchy-errors error|warn] [-- extra args]
       3dtiled serve [<input>] [--port 3001] [--lon <deg> --lat <deg>] [--alt m] [--heading deg]
  formats: ${supportedFormats.join(', ')}`);
  process.exit(1);
}

(async () => {
  const format = flag('format') || (isRemote(input) ? detectFormatByName(input) : await detectFormat(input));
  console.log(`[3dtiled] input: ${input}`);
  console.log(`[3dtiled] detected format: ${format ?? '(none — pass --format)'}`);
  if (!format) process.exit(2);
  const opts = {
    format,
    scale:   flag('scale')   != null ? Number(flag('scale'))   : undefined,
    geScale: flag('ge-scale')!= null ? Number(flag('ge-scale')): undefined,
    geLayer: flag('ge-layer')!= null ? Number(flag('ge-layer')): undefined,
    centroidsOnly: argv.includes('--centroids-only'),   // splat fmts → POINTS centroid tileset
    tiling: flag('tiling'),                             // 'implicit' | 'explicit' (copc, potree)
    extraArgs,
  };
  // The desktop app reads these lines for its bar: [step/steps] label: done/total
  const remote = isRemote(input), steps = (remote ? 1 : 0) + 1 + (verifyMode !== 'off' ? 1 : 0);
  const step = remote ? 2 : 1;
  const { isAbsent } = await import('./fetch-source.js');
  const unread = [];
  let last = 0;
  if (!remote) console.log(`[${step}/${steps}] Converting to 3D Tiles`);
  const converted = await convert(input, outDir, { ...opts,
    onSourceFailure: (f) => {
      unread.push(f);
      if (hierarchyErrors === 'warn' || isAbsent(f.status)) return;
      throw new Error(`could not read ${f.file}: ${f.error}. Retry, or pass --hierarchy-errors warn to carry on without it.`);
    },
    onSourceProgress: (d, t) => { if (Date.now() - last > 1000) { last = Date.now(); console.log(`[1/${steps}] Downloading the source: ${d}/${t}`); } },
    onSourceDone: () => console.log(`[${step}/${steps}] Converting to 3D Tiles`),
  });
  console.log(`[3dtiled] done → ${outDir}/tileset.json`);
  if (unread.length) console.error(`[3dtiled] ${unread.length} file(s) of the source could not be read, first: ${unread[0].file}`);
  if (verifyMode !== 'off') {
    console.log(`[${steps}/${steps}] Checking the output`);
    const { verifyExport } = await import('../tile-server/export-verify.js');
    const v = await verifyExport(outDir, { mode: verifyMode, source: { src: input, format: converted?.format ?? format } });
    (v.ok ? console.log : console.error)(`[3dtiled] ${v.summary}`);
  }
})().catch(e => { console.error('[3dtiled] error:', e.message); process.exit(1); });
}
