/**
 * tools.js — the **manifest** of the third-party tilers the one-stop tiler can run: for each, what it takes, what it
 * writes (and so how the result is streamed afterwards), how it gets on the machine, the options offered (each one a
 * flag of the tool itself, with the tool's default) and the command line.
 *
 * We write no tiler: this file only says how to find, fetch and call the official ones. A tool is delivered the way
 * its authors ship it:
 *   bundled   it is a dependency of this repo, run with our own Node (splat-transform)
 *   download  one release asset per platform, fetched from the authors' release page and checked against the
 *             SHA-256 pinned here, so a moved or replaced asset fails loudly
 *   detect    an existing install is looked for: an environment variable, PATH, a QGIS or OSGeo4W install (QGIS
 *             ships PDAL and untwine), pixi's global bin
 *
 * Windows first: the download entries and the QGIS layouts below are Windows'. Detection by PATH and by environment
 * variable works on every platform.
 *
 * `steps(ctx)` returns the commands to run in order, each an argv array (never a shell string). ctx:
 *   exe      the tool's executable, as detected: an argv prefix (one path, or [node, script] for a bundled tool)
 *   input    absolute path of the input file
 *   outDir   absolute path of the output folder (created, empty or new)
 *   tmpDir   a scratch folder inside outDir, removed after the run
 *   name     the input's base name without extension
 *   opt      the options, validated against `options` and filled with their defaults
 *
 * `output.path(ctx)` is what to hand to the stream or convert flow afterwards, `output.format` its format there, and
 * `output.proof(ctx)` (default: the path) the file whose presence says the run produced something.
 */
import path from 'node:path';

const pct = (v) => `${v}%`;

export const TOOLS = [
  {
    id: 'splat-transform',
    name: 'PlayCanvas splat-transform',
    summary: 'A Gaussian-splat file to a streamed SOG with levels of detail, each level a decimation of the one before.',
    homepage: 'https://github.com/playcanvas/splat-transform',
    licence: 'MIT',
    inputs: ['ply', 'spz', 'sog', 'splat', 'ksplat'],
    output: { format: 'sog', path: (ctx) => path.join(ctx.outDir, 'lod-meta.json'), label: 'streamed SOG (lod-meta.json)' },
    provide: { bundled: { package: '@playcanvas/splat-transform', script: 'bin/cli.mjs' } },
    options: [
      { key: 'levels', label: 'Levels of detail', type: 'int', min: 1, max: 8, default: 3, help: 'How many levels the scene gets, the finest being the input itself.' },
      { key: 'keep', label: 'Kept per level (%)', type: 'int', min: 5, max: 90, default: 50, help: 'Each level keeps this share of the splats of the level before it (--decimate).' },
      { key: 'adaptive', label: 'Adaptive decimation', type: 'bool', default: false, help: 'Remove splats where the error is lowest (--decimate-adaptive): better on scenes of mixed scale such as skies, more memory.' },
      { key: 'chunkCount', label: 'Splats per chunk (thousands)', type: 'int', min: 16, max: 4096, default: 512, advanced: true, help: '--lod-chunk-count: approximate size of a chunk file.' },
      { key: 'chunkExtent', label: 'Chunk size (m)', type: 'number', min: 0.1, max: 10000, default: 16, advanced: true, help: '--lod-chunk-extent: approximate size of a chunk in the scene\'s units.' },
      { key: 'gpu', label: 'Device', type: 'enum', values: ['auto', 'cpu'], default: 'auto', advanced: true, help: 'SOG compression runs on the GPU by default; "cpu" is slower and works everywhere (--gpu cpu).' },
    ],
    steps(ctx) {
      const { exe, input, outDir, tmpDir, opt } = ctx;
      const steps = [], levels = [input];
      const decimate = opt.adaptive ? '--decimate-adaptive' : '--decimate';
      for (let i = 1; i < opt.levels; i++) {
        const out = path.join(tmpDir, `lod${i}.ply`);
        steps.push({ cmd: [...exe, '-w', levels[i - 1], decimate, pct(opt.keep), out], label: `level ${i}: ${opt.keep} % of level ${i - 1}` });
        levels.push(out);
      }
      const merge = [...exe, '-w'];
      levels.forEach((file, i) => merge.push(file, '-l', String(i)));
      merge.push(path.join(outDir, 'lod-meta.json'), '--lod-chunk-count', String(opt.chunkCount), '--lod-chunk-extent', String(opt.chunkExtent));
      if (opt.gpu === 'cpu') merge.push('--gpu', 'cpu');
      steps.push({ cmd: merge, label: `${opt.levels} levels → streamed SOG` });
      return steps;
    },
  },
  {
    id: 'potreeconverter',
    name: 'PotreeConverter 2',
    summary: 'A LAS or LAZ point cloud to a Potree 2 octree (metadata.json, hierarchy.bin, octree.bin). Very fast, out of core.',
    homepage: 'https://github.com/potree/PotreeConverter',
    licence: 'BSD-2-Clause',
    inputs: ['las', 'laz'],
    // the folder is what is streamed afterwards (the Potree reader is given the folder); metadata.json proves the run
    output: { format: 'potree', path: (ctx) => ctx.outDir, proof: (ctx) => path.join(ctx.outDir, 'metadata.json'), label: 'Potree 2 folder (metadata.json, octree.bin)' },
    provide: {
      env: 'POTREECONVERTER_BIN',
      path: ['PotreeConverter'],
      download: {
        version: '2.1.5',
        'win32-x64': {
          url: 'https://github.com/potree/PotreeConverter/releases/download/2.1.5/PotreeConverter_2.1.5_x64_windows.zip',
          sha256: 'a05bc3a936e41705649dc41b9ae4300ee5273ed23a3f1845e94690ca142e6248',
          bytes: 14407178,
          exe: 'PotreeConverter.exe',
        },
      },
    },
    options: [
      { key: 'method', label: 'Sampling', type: 'enum', values: ['poisson', 'poisson_average', 'random'], default: 'poisson', help: '--method: how the points of coarser levels are picked. poisson is the tool\'s default; random is the fastest.' },
      { key: 'encoding', label: 'Encoding', type: 'enum', values: ['UNCOMPRESSED', 'BROTLI'], default: 'UNCOMPRESSED', help: '--encoding: BROTLI makes octree.bin several times smaller and is slower to write. UNCOMPRESSED is what the tool does by default.' },
      { key: 'attributes', label: 'Attributes', type: 'text', default: '', advanced: true, placeholder: 'rgb intensity classification', help: '--attributes: the attributes to keep, separated by spaces. Empty keeps them all.' },
    ],
    steps(ctx) {
      const { exe, input, outDir, opt } = ctx;
      const cmd = [...exe, input, '-o', outDir, '--method', opt.method];
      if (opt.encoding !== 'UNCOMPRESSED') cmd.push('--encoding', opt.encoding);
      const attributes = opt.attributes.split(/[\s,]+/).filter(Boolean);
      if (attributes.length) cmd.push('--attributes', ...attributes);
      return [{ cmd, label: 'LAS → Potree 2' }];
    },
  },
  {
    id: 'pdal',
    name: 'PDAL (writers.copc)',
    summary: 'A LAS, LAZ or E57 point cloud to one COPC file, with PDAL\'s COPC writer: the reference path.',
    homepage: 'https://pdal.io/en/stable/stages/writers.copc.html',
    licence: 'BSD-3-Clause',
    inputs: ['las', 'laz', 'e57'],
    output: { format: 'copc', path: (ctx) => path.join(ctx.outDir, `${ctx.name}.copc.laz`), label: 'COPC (.copc.laz)' },
    provide: { env: 'PDAL_BIN', path: ['pdal'], qgis: ['bin/pdal.exe'], pixi: 'pdal' },
    options: [
      { key: 'srs', label: 'Assign a CRS', type: 'text', default: '', placeholder: 'EPSG:2154', help: '--writers.copc.a_srs: for a file that carries none. It is assigned, not reprojected.' },
      { key: 'forward', label: 'Keep the header of the input', type: 'bool', default: true, advanced: true, help: '--writers.copc.forward=all: scale, offset and other header fields are copied from the input.' },
      { key: 'threads', label: 'Threads', type: 'int', min: 1, max: 64, default: 10, advanced: true, help: '--writers.copc.threads (the writer\'s default is 10).' },
    ],
    steps(ctx) {
      const { exe, input, outDir, name, opt } = ctx;
      const cmd = [...exe, 'translate', input, path.join(outDir, `${name}.copc.laz`), `--writers.copc.threads=${opt.threads}`];
      if (opt.forward && /\.la[sz]$/i.test(input)) cmd.push('--writers.copc.forward=all');
      if (opt.srs) cmd.push(`--writers.copc.a_srs=${opt.srs}`);
      return [{ cmd, label: 'points → COPC' }];
    },
  },
  {
    id: 'untwine',
    name: 'untwine',
    summary: 'LAS or LAZ files to one COPC file, with Hobu\'s untwine: built for very large inputs, the tool QGIS itself uses.',
    homepage: 'https://github.com/hobuinc/untwine',
    licence: 'GPL-3.0',
    inputs: ['las', 'laz'],
    output: { format: 'copc', path: (ctx) => path.join(ctx.outDir, `${ctx.name}.copc.laz`), label: 'COPC (.copc.laz)' },
    provide: { env: 'UNTWINE_BIN', path: ['untwine'], qgis: ['apps/qgis/untwine.exe', 'bin/untwine.exe'], pixi: 'untwine' },
    options: [
      { key: 'srs', label: 'Assign a CRS', type: 'text', default: '', placeholder: 'EPSG:2154', help: '--a_srs: for a file that carries none.' },
      { key: 'cube', label: 'Cubic octree', type: 'bool', default: false, advanced: true, help: '--cube: a cube instead of a box fitted to the data.' },
      { key: 'stats', label: 'Statistics', type: 'bool', default: false, advanced: true, help: '--stats: per-dimension statistics, as Entwine writes them.' },
    ],
    steps(ctx) {
      const { exe, input, outDir, tmpDir, name, opt } = ctx;
      const cmd = [...exe, '-i', input, '-o', path.join(outDir, `${name}.copc.laz`), '--temp_dir', tmpDir];
      if (opt.srs) cmd.push('--a_srs', opt.srs);
      if (opt.cube) cmd.push('--cube');
      if (opt.stats) cmd.push('--stats');
      return [{ cmd, label: 'points → COPC' }];
    },
  },
];

export const toolById = (id) => TOOLS.find((t) => t.id === id) ?? null;
