/**
 * tools.js — the **manifest** of the third-party tilers the one-stop tiler can run: for each, what it takes, what it
 * writes (and so how the result is opened afterwards), how it gets on the machine, the options offered (each one a
 * flag of the tool itself, with the tool's default) and the command line.
 *
 * We write no tiler: this file only says how to find, fetch and call the official ones. A tool is delivered the way
 * its authors ship it:
 *   bundled   it is a dependency of this repo, run with our own Node (splat-transform)
 *   download  one release asset per platform, fetched from the authors' release page and checked against the
 *             SHA-256 pinned here, so a moved or replaced asset fails loudly. `archive: 'file'` is an asset that is
 *             the program itself (an .exe, a .jar) rather than a zip.
 *   needs     a runtime the tool runs on (RUNTIMES below): a Java runtime for a .jar. Looked for on the machine,
 *             else downloaded the same way, next to the tool, never installed system-wide.
 *   uv        a Python tool: a pinned version installed by `uv` into a private environment of its own (its own
 *             Python too), inside the tools folder
 *   cargo     a Rust program its authors publish as source only: built once with the machine's own `cargo` from a
 *             pinned, hash-checked source archive, the binary kept in the tools folder. Without a Rust toolchain the
 *             tool is not offered for download.
 *   detect    an existing install is looked for: an environment variable, PATH, a QGIS or OSGeo4W install (QGIS
 *             ships PDAL and untwine), pixi's global bin
 *
 * Windows first: the download entries and the QGIS layouts below are Windows'. Detection by PATH and by environment
 * variable works on every platform.
 *
 * `kind` is what the tool tiles (pointcloud, mesh, splat); `inputs` the extensions it takes; `dir` whether the input
 * may be a folder of such files (true) or must be one ('only'); `ply` which kind of PLY it reads (points, splats),
 * since the extension alone does not say.
 *
 * `steps(ctx)` returns the steps to run in order: `{ cmd }`, an argv array (never a shell string), or a file step
 * done by this package, `{ copy: [from, to] }` or `{ move: [from, to] }`, for a tool that writes next to its input. ctx:
 *   exe      the tool's executable, as detected: an argv prefix (one path, or [node, script], or [java, -jar, jar])
 *   input    absolute path of the input file or folder
 *   isDir    whether the input is a folder
 *   ext      the input's extension, lower case (a folder: the first extension of the tool found in it)
 *   outDir   absolute path of the output folder (created, empty or new)
 *   tmpDir   a scratch folder inside outDir, removed after the run
 *   name     the input's base name without extension
 *   opt      the options, validated against `options` and filled with their defaults
 *
 * `output.format` says how the result is opened: `copc`, `potree`, `sog`, `rad`, `nexus` and `package` (a .3tz
 * archive) go to the stream flow; `3dtiles` is a finished tileset folder, opened as is. `output.path(ctx)` is the file or folder to hand over, and `output.proof(ctx)`
 * (default: the path) the file whose presence says the run produced something.
 */
import path from 'node:path';

const pct = (v) => `${v}%`;
const epsg = (v) => String(v).trim().replace(/^epsg:/i, '');
const tileset = { format: '3dtiles', path: (ctx) => path.join(ctx.outDir, 'tileset.json'), label: '3D Tiles (tileset.json)' };

// Where a model without a georeference goes on the globe: the same three options on every tool that takes them.
const placement = (flags) => [
  { key: 'lon', label: 'Longitude', type: 'number', min: -180, max: 180, default: '', placeholder: '2.2945', help: `${flags.lon}: where to put a model that has no georeference. Give latitude too.` },
  { key: 'lat', label: 'Latitude', type: 'number', min: -90, max: 90, default: '', placeholder: '48.8584', help: `${flags.lat}: with the longitude.` },
  { key: 'alt', label: 'Altitude (m)', type: 'number', min: -1000, max: 10000, default: '', placeholder: '0', help: `${flags.alt}: height of the model's origin above the ellipsoid.` },
];

/** What some tools run on. Found on the machine (env, PATH), else downloaded like a tool. */
export const RUNTIMES = {
  java: {
    id: 'java', name: 'Java runtime (Eclipse Temurin JRE)', licence: 'GPL-2.0 with Classpath Exception', homepage: 'https://adoptium.net/',
    env: 'TILED_JAVA', path: ['java'], javaHome: true,
    // A found `java` is used only when it is at least the major version the tool asks for (its `needs.min`).
    version: { args: ['-version'], major: /version "(\d+)/ },
    download: {
      version: '25.0.5+8',
      'win32-x64': {
        url: 'https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5%2B8/OpenJDK25U-jre_x64_windows_hotspot_25.0.5_8.zip',
        sha256: 'da78d54a2fcdbba1e92d5e3f07dd30236f96297891c4a21a781c3f38f5c0beae', bytes: 58589419, exe: 'bin/java.exe',
      },
    },
  },
  uv: {
    id: 'uv', name: 'uv (Astral)', licence: 'Apache-2.0 or MIT', homepage: 'https://docs.astral.sh/uv/',
    env: 'UV_BIN', path: ['uv'],
    download: {
      version: '0.13.8',
      'win32-x64': {
        url: 'https://github.com/astral-sh/uv/releases/download/0.13.8/uv-x86_64-pc-windows-msvc.zip',
        sha256: '529e78a9cec6cd7e3e014f7ecd8bda0c113969d4ed0f2efeedb85c30943325b8', bytes: 15529884, exe: 'uv.exe',
      },
    },
  },
};

// gocesiumtiler 3 (`gotiler`) is one binary with two commands, so two tools here share one install.
const GOTILER = {
  env: 'GOTILER_BIN', path: ['gotiler'], dir: 'gotiler',
  download: {
    version: '3.2.0',
    'win32-x64': {
      url: 'https://github.com/mfbonfigli/gocesiumtiler/releases/download/v3.2.0/gotiler-windows-amd64-v3.2.0.zip',
      sha256: 'b8761025f85fe0de35eb1978a1c4f4cd1e49f72bacfcd76b060c5e24dd0f16f2', bytes: 18260085, exe: 'gotiler.exe',
    },
  },
};

// rusty-tiles is one binary with a command per kind of input.
const RUSTY = {
  env: 'RUSTY_TILES_BIN', path: ['rusty-tiles'], dir: 'rusty-tiles',
  download: {
    version: '0.4.1',
    'win32-x64': {
      url: 'https://github.com/BenDyson-Arch/rusty-tiles/releases/download/v0.4.1/rusty-tiles-0.4.1-x86_64-pc-windows-msvc.zip',
      sha256: '3fe6c62f017188935d86e38b8011b40a6b76cdebc7d1843f0f25f42abba26233', bytes: 9695576, exe: 'rusty-tiles.exe',
    },
  },
};
const archive = { format: 'package', path: (ctx) => path.join(ctx.outDir, `${ctx.name}.3tz`), label: '3D Tiles archive (.3tz)' };

export const TOOLS = [
  // ── point clouds ───────────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'pdal',
    name: 'PDAL (writers.copc)',
    kind: 'pointcloud',
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
    kind: 'pointcloud',
    summary: 'LAS or LAZ files, or a folder of them, to one COPC file, with Hobu\'s untwine: built for very large inputs, the tool QGIS itself uses.',
    homepage: 'https://github.com/hobuinc/untwine',
    licence: 'GPL-3.0',
    inputs: ['las', 'laz'],
    dir: true,
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
  {
    id: 'potreeconverter',
    name: 'PotreeConverter 2',
    kind: 'pointcloud',
    summary: 'A LAS or LAZ point cloud, or a folder of them, to a Potree 2 octree (metadata.json, hierarchy.bin, octree.bin). Very fast, out of core.',
    homepage: 'https://github.com/potree/PotreeConverter',
    licence: 'BSD-2-Clause',
    inputs: ['las', 'laz'],
    dir: true,
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
      return [{ cmd, label: 'points → Potree 2' }];
    },
  },
  {
    id: 'potreeconverter1',
    name: 'PotreeConverter 1.7',
    kind: 'pointcloud',
    summary: 'The last 1.x PotreeConverter: LAS, LAZ, PTX or a point PLY to a Potree 1.x octree (cloud.js and one file per node). Slower than version 2; kept for viewers and pipelines that still read 1.x, and for PLY and PTX input.',
    homepage: 'https://github.com/potree/PotreeConverter/releases/tag/1.7',
    licence: 'BSD-2-Clause',
    inputs: ['las', 'laz', 'ptx', 'ply'],
    ply: 'points',
    dir: true,
    output: { format: 'potree', path: (ctx) => ctx.outDir, proof: (ctx) => path.join(ctx.outDir, 'cloud.js'), label: 'Potree 1.x folder (cloud.js)' },
    provide: {
      env: 'POTREECONVERTER1_BIN',
      download: {
        version: '1.7',
        'win32-x64': {
          url: 'https://github.com/potree/PotreeConverter/releases/download/1.7/PotreeConverter_1.7_windows_x64.zip',
          sha256: '79e3dac3de7d91d63b339e43a6c19cf08609f206bb862a1d50d50de98baf5fff',
          bytes: 16682148,
          exe: 'PotreeConverter.exe',
        },
      },
    },
    options: [
      { key: 'format', label: 'Node files', type: 'enum', values: ['BINARY', 'LAZ', 'LAS'], default: 'BINARY', help: '--output-format: how each node is stored. BINARY is the tool\'s default; LAZ is much smaller.' },
      { key: 'attributes', label: 'Attributes', type: 'text', default: '', placeholder: 'RGB INTENSITY CLASSIFICATION', help: '--output-attributes: any of RGB, INTENSITY, CLASSIFICATION, NORMAL, separated by spaces. Empty: RGB, the tool\'s default.' },
      { key: 'projection', label: 'Projection (proj4)', type: 'text', default: '', placeholder: '+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs', help: '--projection: the cloud\'s CRS as a proj4 string, written into cloud.js so that the result is georeferenced.' },
      { key: 'spacing', label: 'Root spacing', type: 'number', min: 0.000001, max: 100000, default: '', advanced: true, placeholder: 'auto', help: '--spacing: distance between points at the root level; it halves at each level. Empty: derived from the bounding box.' },
      { key: 'levels', label: 'Levels', type: 'int', min: 0, max: 30, default: '', advanced: true, placeholder: 'auto', help: '--levels: how many levels are generated. Empty: as many as the points need.' },
      { key: 'scale', label: 'Coordinate scale', type: 'number', min: 0.0000001, max: 1, default: '', advanced: true, placeholder: '0.001', help: '--scale: precision of stored coordinates, for LAS and LAZ node files.' },
    ],
    steps(ctx) {
      const { exe, input, outDir, opt } = ctx;
      const cmd = [...exe, input, '-o', outDir, '--output-format', opt.format];
      const attributes = opt.attributes.split(/[\s,]+/).filter(Boolean);
      if (attributes.length) cmd.push('--output-attributes', ...attributes.map((a) => a.toUpperCase()));
      if (opt.projection) cmd.push('--projection', opt.projection);
      if (opt.spacing !== '') cmd.push('--spacing', String(opt.spacing));
      if (opt.levels !== '') cmd.push('--levels', String(opt.levels));
      if (opt.scale !== '') cmd.push('--scale', String(opt.scale));
      return [{ cmd, label: 'points → Potree 1.x' }];
    },
  },
  {
    id: 'gocesiumtiler',
    name: 'gocesiumtiler (gotiler)',
    kind: 'pointcloud',
    summary: 'A LAS, LAZ, E57 or point PLY file, or a folder of them, straight to 3D Tiles 1.1 (meshopt-compressed GLB) or 1.0 (pnts). One Go binary, fast, reprojects with its own PROJ data.',
    homepage: 'https://github.com/mfbonfigli/gocesiumtiler',
    licence: 'AGPL-3.0',
    inputs: ['las', 'laz', 'e57', 'ply'],
    ply: 'points',
    dir: true,
    output: tileset,
    provide: GOTILER,
    options: [
      { key: 'crs', label: 'Input CRS', type: 'text', default: '', placeholder: 'EPSG:32631, or "local"', help: '--crs: the CRS of the input, an EPSG code or a proj4 string. Empty: read from the file. "local" places a cloud without CRS with the longitude and latitude below.' },
      { key: 'version', label: '3D Tiles version', type: 'enum', values: ['1.1', '1.0'], default: '1.1', help: '--version: 1.1 writes GLB tiles, 1.0 writes .pnts.' },
      { key: 'pointsPerTile', label: 'Points per tile', type: 'int', min: 5000, max: 5000000, default: 50000, help: '--points-per-tile: the approximate size of a tile.' },
      { key: 'refine', label: 'Refinement', type: 'enum', values: ['add', 'replace'], default: 'add', help: '--refine-mode: add (children add points to their parent) or replace.' },
      ...placement({ lon: '--longitude', lat: '--latitude', alt: '--height' }).map((o) => ({ ...o, advanced: true, help: `${o.help} Only with CRS "local".` })),
      { key: 'compression', label: 'Compression', type: 'enum', values: ['meshopt', 'none'], default: 'meshopt', advanced: true, help: '--compression: meshopt (EXT_meshopt_compression, version 1.1 only) or none.' },
      { key: 'attributes', label: 'Attributes', type: 'text', default: '', advanced: true, placeholder: 'intensity,classification', help: '--attributes: per-point attributes to keep, comma-separated; "none" for none. Empty: intensity and classification, the tool\'s default.' },
      { key: 'zOffset', label: 'Z offset (m)', type: 'number', min: -10000, max: 10000, default: 0, advanced: true, help: '--z-offset: added to every point\'s height.' },
      { key: 'eightBit', label: '8-bit colours', type: 'bool', default: false, advanced: true, help: '--8-bit: the input stores colours on 8 bits instead of 16.' },
      { key: 'join', label: 'Merge a folder into one tileset', type: 'bool', default: true, advanced: true, help: '--join: for a folder input, one tileset for all files (they must share a CRS). Off: one tileset per file, in sub-folders.' },
    ],
    steps(ctx) {
      const { exe, input, outDir, isDir, opt } = ctx;
      const cmd = [...exe, 'pcloud', '--plain', '-o', outDir, '--version', opt.version, '--points-per-tile', String(opt.pointsPerTile), '--refine-mode', opt.refine];
      if (opt.crs) cmd.push('--crs', opt.crs);
      if (opt.lon !== '' && opt.lat !== '') cmd.push('--longitude', String(opt.lon), '--latitude', String(opt.lat));
      if (opt.alt !== '') cmd.push('--height', String(opt.alt));
      if (opt.version === '1.1') cmd.push('--compression', opt.compression);
      if (opt.attributes) cmd.push('--attributes', opt.attributes);
      if (opt.zOffset) cmd.push('--z-offset', String(opt.zOffset));
      if (opt.eightBit) cmd.push('--8-bit');
      if (isDir && opt.join) cmd.push('--join');
      cmd.push(input);
      return [{ cmd, label: 'points → 3D Tiles' }];
    },
  },
  {
    id: 'point-tiler',
    name: 'point-tiler (MIERUNE)',
    kind: 'pointcloud',
    summary: 'A LAS, LAZ or CSV point cloud to 3D Tiles 1.1 on a zoom-level grid. One Rust binary. It needs the CRS of the input as an EPSG code.',
    homepage: 'https://github.com/MIERUNE/point-tiler',
    licence: 'MIT',
    inputs: ['las', 'laz', 'csv', 'txt'],
    output: tileset,
    provide: {
      env: 'PTILER_BIN', path: ['ptiler'],
      download: {
        version: '0.0.12',
        'win32-x64': {
          url: 'https://github.com/MIERUNE/point-tiler/releases/download/v0.0.12/ptiler-v0.0.12-x86_64-pc-windows-msvc.exe',
          sha256: '2e328616c9231f6989fd74cbbb5f0d0e0487c9a4cc991b087ba2c8db9366785c', bytes: 17476608, exe: 'ptiler.exe', archive: 'file',
        },
      },
    },
    options: [
      { key: 'inputEpsg', label: 'Input EPSG code', type: 'int', min: 1024, max: 999999, default: '', required: true, placeholder: '32631', help: '--input-epsg: the EPSG code of the input coordinates. Required by the tool.' },
      { key: 'min', label: 'Coarsest zoom', type: 'int', min: 0, max: 24, default: 15, help: '--min: the zoom level of the coarsest tiles.' },
      { key: 'max', label: 'Finest zoom', type: 'int', min: 0, max: 24, default: 18, help: '--max: the zoom level of the finest tiles.' },
      { key: 'meshopt', label: 'meshopt compression', type: 'bool', default: false, advanced: true, help: '--meshopt: compress the tiles with EXT_meshopt_compression.' },
      { key: 'quantize', label: 'Quantize', type: 'bool', default: false, advanced: true, help: '--quantize: KHR_mesh_quantization.' },
      { key: 'maxMemoryMb', label: 'Memory (MB)', type: 'int', min: 256, max: 1048576, default: 4096, advanced: true, help: '--max-memory-mb: what the tool may hold in memory before it spills to disk.' },
    ],
    steps(ctx) {
      const { exe, input, outDir, tmpDir, opt } = ctx;
      const cmd = [...exe, '--input', input, '--output', outDir, '--input-epsg', String(opt.inputEpsg), '--output-epsg', '4979',
        '--min', String(opt.min), '--max', String(opt.max), '--max-memory-mb', String(opt.maxMemoryMb), '--temp-dir', tmpDir];
      if (opt.meshopt) cmd.push('--meshopt');
      if (opt.quantize) cmd.push('--quantize');
      return [{ cmd, label: 'points → 3D Tiles' }];
    },
  },
  {
    id: 'py3dtiles',
    name: 'py3dtiles',
    kind: 'pointcloud',
    summary: 'A LAS, LAZ, XYZ or point PLY cloud to 3D Tiles, with Oslandia\'s Python tiler. Installed with its own Python into a private environment (about 260 MB on disk).',
    homepage: 'https://py3dtiles.org/',
    licence: 'Apache-2.0',
    inputs: ['las', 'laz', 'xyz', 'ply'],
    ply: 'points',
    output: tileset,
    provide: { uv: { version: '12.1.1', spec: 'py3dtiles[las,ply]==12.1.1', python: '3.12', bin: 'py3dtiles', approxBytes: 110e6 } },
    options: [
      { key: 'srsIn', label: 'Input EPSG code', type: 'int', min: 1024, max: 999999, default: '', placeholder: '32631', help: '--srs_in: the EPSG code of the input, for a file that carries none (or to override it).' },
      { key: 'srsOut', label: 'Output EPSG code', type: 'int', min: 1024, max: 999999, default: 4978, help: '--srs_out: 4978 (Earth-centred, what 3D Tiles viewers expect) when the input has a CRS. Not passed when the input has none.' },
      // 1.0 is the tool's own default, and ours: the glTF tiles of 1.1 came out wrong with py3dtiles 12.1.1 (byte colours
      // not marked as normalized, so they show saturated; one dot in CesiumJS, a misplaced cloud in 3DTilesRendererJS).
      { key: 'specVersion', label: '3D Tiles version', type: 'enum', values: ['1.0', '1.1'], default: '1.0', help: '--spec-version: 1.0 writes .pnts tiles, the tool\'s default. 1.1 writes glTF tiles, which did not display correctly with py3dtiles 12.1.1 when tried here.' },
      { key: 'noRgb', label: 'Drop colours', type: 'bool', default: false, advanced: true, help: '--no-rgb' },
      { key: 'jobs', label: 'Parallel jobs', type: 'int', min: 1, max: 256, default: '', advanced: true, placeholder: 'all cores', help: '--jobs' },
      { key: 'extraFields', label: 'Extra fields', type: 'text', default: '', advanced: true, placeholder: 'classification', help: '--extra-fields: one more field of the source to keep in the tiles.' },
    ],
    steps(ctx) {
      const { exe, input, outDir, opt } = ctx;
      // --overwrite: py3dtiles refuses a folder that exists, and ours does (it holds the scratch folder)
      const cmd = [...exe, 'convert', input, '--out', outDir, '--overwrite', '--spec-version', opt.specVersion];
      if (opt.srsIn !== '') cmd.push('--srs_in', String(opt.srsIn), '--srs_out', String(opt.srsOut));
      if (opt.noRgb) cmd.push('--no-rgb');
      if (opt.jobs !== '') cmd.push('--jobs', String(opt.jobs));
      if (opt.extraFields) cmd.push('--extra-fields', opt.extraFields);
      return [{ cmd, label: 'points → 3D Tiles' }];
    },
  },

  {
    id: 'rusty-tiles-points',
    name: 'rusty-tiles point-cloud',
    kind: 'pointcloud',
    summary: 'A LAS or LAZ point cloud, or a folder of them, to one 3D Tiles 1.1 archive (.3tz) with a disk-backed spatial hierarchy. One Rust binary, young (version 0.4).',
    homepage: 'https://github.com/BenDyson-Arch/rusty-tiles',
    licence: 'MIT',
    inputs: ['las', 'laz'],
    dir: true,
    output: archive,
    provide: RUSTY,
    options: [
      { key: 'sourceCrs', label: 'Source CRS', type: 'text', default: '', required: true, placeholder: 'EPSG:32631, or "local"', help: '--sourceCrs: the CRS of the input, an EPSG code, or "local" for plain metres. Required by the tool.' },
      { key: 'heightOffset', label: 'Height offset (m)', type: 'number', min: -10000, max: 10000, default: 0, help: '--heightOffset: added to the heights to make them ellipsoidal. The tool wants it stated for a georeferenced cloud; 0 keeps them.' },
      { key: 'maxPoints', label: 'Points per tile', type: 'int', min: 256, max: 8192, default: 8192, advanced: true, help: '--maxPoints: at most 8192.' },
      { key: 'metadata', label: 'Keep every source field', type: 'bool', default: false, advanced: true, help: '--metadata: per-point fields in a property table. Off: position and colour only.' },
    ],
    steps(ctx) {
      const { exe, input, outDir, name, opt } = ctx;
      const cmd = [...exe, 'point-cloud', '--input', input, '--output', path.join(outDir, `${name}.3tz`), '--sourceCrs', opt.sourceCrs, '--maxPoints', String(opt.maxPoints)];
      if (opt.sourceCrs.toLowerCase() !== 'local') cmd.push('--heightOffset', String(opt.heightOffset));
      if (opt.metadata) cmd.push('--metadata');
      return [{ cmd, label: 'points → 3D Tiles archive' }];
    },
  },

  // ── meshes ─────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'obj2tiles',
    name: 'Obj2Tiles',
    kind: 'mesh',
    summary: 'A textured OBJ mesh to 3D Tiles with levels of detail: it decimates, splits and tiles. OpenDroneMap\'s tool, self-contained.',
    homepage: 'https://github.com/OpenDroneMap/Obj2Tiles',
    licence: 'AGPL-3.0',
    inputs: ['obj'],
    output: tileset,
    provide: {
      env: 'OBJ2TILES_BIN', path: ['Obj2Tiles'],
      download: {
        version: '1.10.2',
        'win32-x64': {
          url: 'https://github.com/OpenDroneMap/Obj2Tiles/releases/download/v1.10.2/Obj2Tiles-Win64.zip',
          sha256: 'f1ada6c4713ed0913fdba8c4c17a1652ab2ce4a5571163f940364c5b61e8e47b', bytes: 23715330, exe: 'Obj2Tiles.exe',
        },
      },
    },
    options: [
      { key: 'lods', label: 'Levels of detail', type: 'int', min: 1, max: 10, default: 3, help: '--lods' },
      { key: 'divisions', label: 'Divisions', type: 'int', min: 0, max: 8, default: 2, help: '--divisions: how many levels of spatial splitting the coarsest level sits at.' },
      ...placement({ lon: '--lon', lat: '--lat', alt: '--alt' }).map((o) => ({ ...o, help: `${o.help} Without them the tileset is local (--local).` })),
      { key: 'glb', label: 'GLB tiles (3D Tiles 1.1)', type: 'bool', default: true, help: '--glb: plain GLB tile content instead of b3dm. The tool\'s own default is b3dm.' },
      { key: 'octree', label: 'Octree hierarchy', type: 'bool', default: true, help: '--octree: each finer level is split once more, a proper tile hierarchy. The tool\'s own default is the same split at every level.' },
      { key: 'yUp', label: 'Input is Y-up', type: 'bool', default: false, help: '--y-up-to-z-up: for an OBJ exported with Y as the up axis.' },
      { key: 'unlit', label: 'Unlit materials', type: 'bool', default: false, help: '--unlit: for photogrammetry, where the lighting is already in the textures.' },
      { key: 'textureFormat', label: 'Textures', type: 'enum', values: ['Jpeg', 'Webp', 'Ktx2'], default: 'Jpeg', advanced: true, help: '--texture-format: Webp and Ktx2 need a viewer that reads them.' },
      { key: 'decimation', label: 'Decimation', type: 'enum', values: ['Standard', 'Quality', 'Aggressive'], default: 'Standard', advanced: true, help: '--decimation-mode' },
      { key: 'maxTextureSize', label: 'Largest texture (px)', type: 'int', min: 0, max: 16384, default: 4096, advanced: true, help: '--max-texture-size: 0 for no limit.' },
      { key: 'scale', label: 'Scale', type: 'number', min: 0.000001, max: 1000000, default: 1, advanced: true, help: '--scale: for a model that is not in metres.' },
    ],
    steps(ctx) {
      const { exe, input, outDir, opt } = ctx;
      const cmd = [...exe, '--lods', String(opt.lods), '--divisions', String(opt.divisions), '--texture-format', opt.textureFormat,
        '--decimation-mode', opt.decimation, '--max-texture-size', String(opt.maxTextureSize)];
      if (opt.lon !== '' && opt.lat !== '') cmd.push('--lon', String(opt.lon), '--lat', String(opt.lat), '--alt', String(opt.alt === '' ? 0 : opt.alt));
      else cmd.push('--local');
      if (opt.glb) cmd.push('--glb');
      if (opt.octree) cmd.push('--octree');
      if (opt.yUp) cmd.push('--y-up-to-z-up');
      if (opt.unlit) cmd.push('--unlit');
      if (opt.scale !== 1) cmd.push('--scale', String(opt.scale));
      cmd.push(input, outDir);
      return [{ cmd, label: 'OBJ → 3D Tiles' }];
    },
  },
  {
    id: 'mago-3d-tiler',
    name: 'mago 3DTiler',
    kind: 'mesh',
    summary: 'The widest input list: OBJ, FBX, 3DS, glTF, COLLADA, a PLY or STL mesh, IFC, 3MF, X3D, CityGML, KML, Shapefile, GeoJSON, GeoPackage and LAS or LAZ, a file or a folder, to 3D Tiles. A Java program (390 MB), run on a Java 25 runtime that is fetched next to it when the machine has none.',
    homepage: 'https://github.com/Gaia3D/mago-3d-tiler',
    licence: 'MPL-2.0',
    // the extensions of its own FormatType list (version 1.17.0); `--inputType` is the extension
    inputs: ['obj', 'fbx', '3ds', 'gltf', 'glb', 'dae', 'ply', 'stl', 'ifc', '3mf', 'x3d', 'ase', 'lwo', 'lws', 'lxo', 'x', 'gml', 'kml', 'shp', 'geojson', 'gpkg', 'las', 'laz'],
    ply: 'mesh',
    dir: true,
    output: tileset,
    provide: {
      env: 'MAGO_3D_TILER_JAR',
      needs: { runtime: 'java', min: 25 },
      command: ({ runtime, file }) => [...runtime, '-jar', file],
      download: {
        version: '1.17.0',
        'win32-x64': {
          url: 'https://github.com/Gaia3D/mago-3d-tiler/releases/download/v1.17.0/mago-3d-tiler-1.17.0.jar',
          sha256: '8d63857835bc4d7b1bb747be5a3ae762ee2c1dfd781b44ebcc22f0b692a67481', bytes: 390525435, exe: 'mago-3d-tiler-1.17.0.jar', archive: 'file',
        },
      },
    },
    options: [
      { key: 'crs', label: 'Input EPSG code', type: 'text', default: '', placeholder: '5186', help: '--crs: the EPSG code of the input coordinates (the tool\'s default is 3857). For a model in local coordinates, leave empty and give longitude and latitude.' },
      ...placement({ lon: '--longitude', lat: '--latitude', alt: '--zOffset' }),
      { key: 'tilesVersion', label: '3D Tiles version', type: 'enum', values: ['1.1', '1.0'], default: '1.1', help: '--tilesVersion' },
      { key: 'rotateX', label: 'Rotate about X (°)', type: 'number', min: -360, max: 360, default: 0, help: '--rotateXAxis: 90 for a Y-up model.' },
      { key: 'refineAdd', label: 'ADD refinement', type: 'bool', default: false, advanced: true, help: '--refineAdd' },
      { key: 'meshCompression', label: 'Mesh compression', type: 'enum', values: ['none', 'quantize', 'draco'], default: 'none', advanced: true, help: '--meshCompression' },
      { key: 'textureCompression', label: 'Texture compression', type: 'enum', values: ['none', 'ktx2'], default: 'none', advanced: true, help: '--textureCompression: ktx2 needs a viewer with a Basis transcoder.' },
      { key: 'unlit', label: 'Unlit materials', type: 'bool', default: false, advanced: true, help: '--unlit' },
      { key: 'photogrammetry', label: 'Photogrammetry pipeline', type: 'bool', default: false, advanced: true, help: '--photogrammetry (experimental): for large reality meshes.' },
      { key: 'maxPoints', label: 'Points per tile', type: 'int', min: 1000, max: 10000000, default: '', advanced: true, placeholder: 'tool default', help: '--maxPoints: point clouds only.' },
      { key: 'pointRatio', label: 'Points kept (%)', type: 'int', min: 1, max: 100, default: '', advanced: true, placeholder: '100', help: '--pointRatio: point clouds only.' },
      { key: 'recursive', label: 'Read sub-folders', type: 'bool', default: true, advanced: true, help: '--recursive: for a folder input.' },
    ],
    steps(ctx) {
      const { exe, input, outDir, tmpDir, isDir, ext, opt } = ctx;
      const type = { gml: 'citygml' }[ext] ?? ext;
      const cmd = [...exe, '--input', input, '--output', outDir, '--temp', tmpDir, '--inputType', type, '--tilesVersion', opt.tilesVersion];
      if (opt.crs) cmd.push('--crs', epsg(opt.crs));
      if (opt.lon !== '' && opt.lat !== '') cmd.push('--longitude', String(opt.lon), '--latitude', String(opt.lat));
      if (opt.alt !== '') cmd.push('--zOffset', String(opt.alt));
      if (opt.rotateX) cmd.push('--rotateXAxis', String(opt.rotateX));
      if (opt.refineAdd) cmd.push('--refineAdd');
      if (opt.meshCompression !== 'none') cmd.push('--meshCompression', opt.meshCompression);
      if (opt.textureCompression !== 'none') cmd.push('--textureCompression', opt.textureCompression);
      if (opt.unlit) cmd.push('--unlit');
      if (opt.photogrammetry) cmd.push('--photogrammetry');
      if (opt.maxPoints !== '') cmd.push('--maxPoints', String(opt.maxPoints));
      if (opt.pointRatio !== '') cmd.push('--pointRatio', String(opt.pointRatio));
      if (isDir && opt.recursive) cmd.push('--recursive');
      return [{ cmd, label: `${type} → 3D Tiles` }];
    },
  },
  {
    id: 'fanvanzh-3dtiles',
    name: '3dtile (fanvanzh/3dtiles)',
    kind: 'mesh',
    summary: 'An OSGB oblique-photography folder (metadata.xml and Data/) to 3D Tiles (b3dm), offline. The released binary is from 2021. This app also streams OSGB live with its own reader, without a conversion.',
    homepage: 'https://github.com/fanvanzh/3dtiles',
    licence: 'Apache-2.0',
    inputs: ['osgb'],
    dir: 'only',
    output: tileset,
    provide: {
      env: 'FANVANZH_3DTILE_BIN', path: ['3dtile'],
      download: {
        version: '0.4',
        'win32-x64': {
          url: 'https://github.com/fanvanzh/3dtiles/releases/download/v0.4/3dtile.zip',
          sha256: '3916d2eb1a152327dc0facaa44250c5b024799153a11b1be08a6ba416c06fadb', bytes: 12993133, exe: '3dtile.exe',
        },
      },
    },
    options: [
      { key: 'lon', label: 'Longitude', type: 'number', min: -180, max: 180, default: '', placeholder: 'from metadata.xml', help: 'the "x" of the tile config: overrides the origin in metadata.xml. Give latitude too.' },
      { key: 'lat', label: 'Latitude', type: 'number', min: -90, max: 90, default: '', placeholder: 'from metadata.xml', help: 'the "y" of the tile config.' },
      { key: 'offset', label: 'Height offset (m)', type: 'number', min: -10000, max: 10000, default: 0, help: 'the "offset" of the tile config: added to the model\'s height.' },
      { key: 'maxLevel', label: 'Deepest level', type: 'int', min: 1, max: 30, default: '', advanced: true, placeholder: 'all', help: 'the "max_lvl" of the tile config: stop at this level of the OSGB pyramid.' },
      { key: 'pbr', label: 'PBR materials', type: 'bool', default: false, advanced: true, help: 'the "pbr" of the tile config. Off: unlit, as photogrammetry wants.' },
    ],
    steps(ctx) {
      const { exe, input, outDir, opt } = ctx;
      const cmd = [...exe, '-f', 'osgb', '-i', input, '-o', outDir];
      const config = {};
      if (opt.lon !== '' && opt.lat !== '') { config.x = opt.lon; config.y = opt.lat; }
      if (opt.offset) config.offset = opt.offset;
      if (opt.maxLevel !== '') config.max_lvl = opt.maxLevel;
      if (opt.pbr) config.pbr = true;
      if (Object.keys(config).length) cmd.push('-c', JSON.stringify(config));
      return [{ cmd, label: 'OSGB → 3D Tiles' }];
    },
  },

  {
    id: 'rusty-tiles',
    name: 'rusty-tiles mesh',
    kind: 'mesh',
    summary: 'A glTF or GLB mesh, or a folder of them, streamed into one 3D Tiles 1.1 archive (.3tz) with implicit tiling. One Rust binary, young (version 0.4).',
    homepage: 'https://github.com/BenDyson-Arch/rusty-tiles',
    licence: 'MIT',
    inputs: ['glb', 'gltf'],
    dir: true,
    output: archive,
    provide: RUSTY,
    options: [
      { key: 'profile', label: 'Profile', type: 'enum', values: ['balanced', 'fast', 'quality', 'lossless'], default: 'balanced', help: '--profile: how much the tool simplifies and compresses.' },
      ...placement({ lon: '--anchor', lat: '--anchor', alt: '--anchor' }).map((o) => ({ ...o, help: `${o.help} For a model in local metres.` })),
      { key: 'sourceCrs', label: 'Source CRS', type: 'text', default: '', advanced: true, placeholder: 'local', help: '--sourceCrs: an EPSG code when the coordinates are in a projected CRS. Empty: local metres, glTF Y up.' },
      { key: 'sourceAxes', label: 'Axes in that CRS', type: 'enum', values: ['y-up', 'xyz'], default: 'y-up', advanced: true, help: '--sourceAxes: with a source CRS, y-up (east, height, minus north) or xyz (east, north, height).' },
    ],
    steps(ctx) {
      const { exe, input, outDir, name, opt } = ctx;
      const cmd = [...exe, 'mesh', '--input', input, '--output', path.join(outDir, `${name}.3tz`), '--profile', opt.profile];
      if (opt.lon !== '' && opt.lat !== '') cmd.push('--anchor', String(opt.lon), String(opt.lat), String(opt.alt === '' ? 0 : opt.alt));
      if (opt.sourceCrs) cmd.push('--sourceCrs', opt.sourceCrs, '--sourceAxes', opt.sourceAxes);
      return [{ cmd, label: 'glTF → 3D Tiles archive' }];
    },
  },
  {
    id: 'nexus',
    name: 'Nexus (nxsbuild)',
    kind: 'mesh',
    summary: 'A PLY, OBJ or STL mesh, or a folder of them merged, to a Nexus multiresolution mesh (.nxs, or Corto-compressed .nxz): CNR-ISTI\'s format, the one 3DHOP shows. This app streams it as 3D Tiles.',
    homepage: 'https://github.com/cnr-isti-vclab/nexus',
    licence: 'GPL-3.0',
    inputs: ['ply', 'obj', 'stl'],
    ply: 'mesh',
    dir: true,
    output: { format: 'nexus', path: (ctx) => path.join(ctx.outDir, `${ctx.name}.${ctx.opt.compress ? 'nxz' : 'nxs'}`), label: 'Nexus (.nxs or .nxz)' },
    provide: {
      env: 'NXSBUILD_BIN', path: ['nxsbuild'],
      download: {
        version: '2025.05',
        'win32-x64': {
          url: 'https://github.com/cnr-isti-vclab/nexus/releases/download/v2025.05/nexus-windows-x86_64.zip',
          sha256: '6a90423c7bf6ee5c6cbdb581c70846a79d0a05fd7225a2e458ba43fc0053aa6f', bytes: 48061423, exe: 'nxsbuild.exe',
        },
      },
    },
    options: [
      { key: 'compress', label: 'Compress (.nxz)', type: 'bool', default: false, help: 'a second step, nxscompress: Corto compression, several times smaller.' },
      { key: 'colors', label: 'Keep vertex colours', type: 'bool', default: false, help: '-C: for a mesh coloured per vertex, without textures.' },
      { key: 'noTextures', label: 'Drop textures', type: 'bool', default: false, help: '-u: no textures and no texture coordinates.' },
      { key: 'nodeFaces', label: 'Faces per patch', type: 'int', min: 1000, max: 32768, default: 32768, advanced: true, help: '-f: smaller patches change more gradually and compress less well.' },
      { key: 'topFaces', label: 'Faces in the top node', type: 'int', min: 256, max: 1000000, default: 4096, advanced: true, help: '-t: the size of the coarsest level.' },
      { key: 'scaling', label: 'Decimation per level', type: 'number', min: 0.1, max: 0.9, default: 0.5, advanced: true, help: '-s: the share of faces kept from one level to the next.' },
      { key: 'ram', label: 'Memory (MB)', type: 'int', min: 256, max: 1048576, default: 2000, advanced: true, help: '-r: what the tool may hold in memory (an approximation).' },
    ],
    steps(ctx) {
      const { exe, input, outDir, tmpDir, name, opt } = ctx;
      const nxs = path.join(opt.compress ? tmpDir : outDir, `${name}.nxs`);
      const build = [...exe, input, '-o', nxs, '-f', String(opt.nodeFaces), '-t', String(opt.topFaces), '-s', String(opt.scaling), '-r', String(opt.ram)];
      if (opt.colors) build.push('-C');
      if (opt.noTextures) build.push('-u');
      const steps = [{ cmd: build, label: 'mesh → Nexus' }];
      // nxscompress ships beside nxsbuild in the same release
      if (opt.compress) steps.push({ cmd: [path.join(path.dirname(exe[exe.length - 1]), path.basename(exe[exe.length - 1]).replace(/nxsbuild/i, 'nxscompress')), nxs, '-o', path.join(outDir, `${name}.nxz`)], label: 'Corto compression' });
      return steps;
    },
  },

  // ── Gaussian splats ────────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'splat-transform',
    name: 'PlayCanvas splat-transform',
    kind: 'splat',
    summary: 'A Gaussian-splat file to a streamed SOG with levels of detail, each level a decimation of the one before.',
    homepage: 'https://github.com/playcanvas/splat-transform',
    licence: 'MIT',
    inputs: ['ply', 'spz', 'sog', 'splat', 'ksplat'],
    ply: 'splats',
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
    id: 'gocesiumtiler-splats',
    name: 'gocesiumtiler splats (gotiler)',
    kind: 'splat',
    summary: 'A 3DGS splat PLY straight to 3D Tiles 1.1 with SPZ-compressed glTF splats (KHR_gaussian_splatting), placed on the globe. It can keep spherical harmonics.',
    homepage: 'https://github.com/mfbonfigli/gocesiumtiler',
    licence: 'AGPL-3.0',
    inputs: ['ply'],
    ply: 'splats',
    output: tileset,
    provide: GOTILER,
    options: [
      { key: 'maxShDegree', label: 'Spherical harmonics', type: 'enum', values: ['0', '1', '2', '3'], default: '0', help: '--max-sh-degree: the highest degree kept. 0 is base colour only; higher degrees keep view-dependent colour and make the tiles heavier.' },
      { key: 'upAxis', label: 'Up axis of the input', type: 'enum', values: ['z', '-z', 'y', '-y', 'x', '-x'], default: 'z', help: '--input-up-axis: scenes trained with OpenCV or COLMAP conventions usually need -y.' },
      ...placement({ lon: '--longitude', lat: '--latitude', alt: '--height' }),
      { key: 'scale', label: 'Scale', type: 'number', min: 0.000001, max: 1000000, default: 1, help: '--scale: trained scenes often have arbitrary units; the factor that makes them metres.' },
      { key: 'splatsPerTile', label: 'Splats per tile', type: 'int', min: 1000, max: 1000000, default: 40000, advanced: true, help: '--splats-per-tile' },
      { key: 'minOpacity', label: 'Drop below opacity', type: 'number', min: 0, max: 1, default: 0.05, advanced: true, help: '--min-opacity: 0 keeps every splat.' },
      { key: 'heading', label: 'Heading (°)', type: 'number', min: -360, max: 360, default: 0, advanced: true, help: '--heading: rotation from north, positive eastward.' },
    ],
    steps(ctx) {
      const { exe, input, outDir, opt } = ctx;
      // --no-preview: without it the tool opens its own viewer and waits
      const cmd = [...exe, 'splats', '--plain', '--no-preview', '-o', outDir, '--max-sh-degree', opt.maxShDegree, '--input-up-axis', opt.upAxis,
        '--splats-per-tile', String(opt.splatsPerTile), '--min-opacity', String(opt.minOpacity)];
      if (opt.lon !== '' && opt.lat !== '') cmd.push('--longitude', String(opt.lon), '--latitude', String(opt.lat));
      if (opt.alt !== '') cmd.push('--height', String(opt.alt));
      if (opt.scale !== 1) cmd.push('--scale', String(opt.scale));
      if (opt.heading) cmd.push('--heading', String(opt.heading));
      cmd.push(input);
      return [{ cmd, label: 'splats → 3D Tiles' }];
    },
  },
  {
    id: '3dgs-ply-3dtiles-converter',
    name: '3DGS-PLY-3DTiles-Converter',
    kind: 'splat',
    summary: 'A 3DGS splat PLY to 3D Tiles with a level-of-detail tree of merged splats, SPZ-compressed glTF tiles: William Liu\'s converter, the companion of the splat plugin this viewer uses. It has no up-axis option: a scene whose up is Z comes out lying on its side.',
    homepage: 'https://www.npmjs.com/package/3dgs-ply-3dtiles-converter',
    licence: 'Apache-2.0',
    inputs: ['ply'],
    ply: 'splats',
    output: tileset,
    provide: { bundled: { package: '3dgs-ply-3dtiles-converter', script: 'bin/3dgs-ply-3dtiles-converter.js' } },
    options: [
      { key: 'sh', label: 'Spherical harmonics', type: 'enum', values: ['tool default', '0', '1', '2', '3'], default: 'tool default', help: '--sh: the highest degree kept while reading, simplifying and writing.' },
      ...placement({ lon: '--coordinate', lat: '--coordinate', alt: '--coordinate' }),
      { key: 'lodMultiplier', label: 'Detail', type: 'enum', values: ['tool default', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'tool default', help: '--lod-multiplier: how early finer tiles are asked for.' },
      { key: 'convention', label: 'PLY convention', type: 'enum', values: ['graphdeco', 'khr_native'], default: 'graphdeco', advanced: true, help: '--input-convention: how quaternions and opacity are stored. graphdeco is what 3DGS trainers write.' },
      { key: 'opacityFilter', label: 'Drop below opacity', type: 'number', min: 0, max: 1, default: '', advanced: true, placeholder: 'tool default', help: '--opacity-filter: 0 keeps every splat.' },
      { key: 'samplingRate', label: 'Kept per level', type: 'number', min: 0.01, max: 1, default: '', advanced: true, placeholder: 'tool default', help: '--sampling-rate-per-level: the share of splats kept from one level to the next coarser one.' },
      { key: 'maxDepth', label: 'Deepest level', type: 'int', min: 1, max: 30, default: '', advanced: true, placeholder: 'from the input size', help: '--max-depth' },
      { key: 'memoryBudget', label: 'Memory (GB)', type: 'number', min: 0.5, max: 1024, default: '', advanced: true, placeholder: 'tool default', help: '--memory-budget' },
    ],
    steps(ctx) {
      const { exe, input, outDir, tmpDir, opt } = ctx;
      // --no-open-inspector: without it the tool opens a viewer in the browser when it is done
      const cmd = [...exe, '--no-open-inspector', '--tmp-dir', tmpDir];
      if (opt.sh !== 'tool default') cmd.push('--sh', opt.sh);
      if (opt.lon !== '' && opt.lat !== '') cmd.push('--coordinate', JSON.stringify([opt.lat, opt.lon, opt.alt === '' ? 0 : opt.alt]));
      if (opt.lodMultiplier !== 'tool default') cmd.push('--lod-multiplier', opt.lodMultiplier);
      if (opt.convention !== 'graphdeco') cmd.push('--input-convention', opt.convention);
      if (opt.opacityFilter !== '') cmd.push('--opacity-filter', String(opt.opacityFilter));
      if (opt.samplingRate !== '') cmd.push('--sampling-rate-per-level', String(opt.samplingRate));
      if (opt.maxDepth !== '') cmd.push('--max-depth', String(opt.maxDepth));
      if (opt.memoryBudget !== '') cmd.push('--memory-budget', String(opt.memoryBudget));
      cmd.push(input, outDir);
      return [{ cmd, label: 'splats → 3D Tiles' }];
    },
  },
  {
    id: 'spark-build-lod',
    name: 'Spark build-lod',
    kind: 'splat',
    summary: 'A splat PLY or SPZ to a .RAD file with Spark\'s level-of-detail tree, the format SparkJS streams. Published as Rust source only: built once here with the machine\'s own Rust toolchain (cargo), a few minutes.',
    homepage: 'https://sparkjs.dev/docs/lod-getting-started/',
    licence: 'MIT',
    inputs: ['ply', 'spz'],
    ply: 'splats',
    output: { format: 'rad', path: (ctx) => path.join(ctx.outDir, `${ctx.name}-lod.rad`), label: 'RAD (.rad)' },
    provide: {
      env: 'SPARK_BUILD_LOD_BIN', path: ['build-lod'],
      cargo: {
        version: '2.4.0',
        url: 'https://github.com/sparkjsdev/spark/archive/refs/tags/v2.4.0.zip',
        sha256: '90e0c1e853c8f49ae3993ebb14e09c67909c98d962fecf57ac54823b148c3225', bytes: 6837524,
        manifest: 'rust/build-lod/Cargo.toml', bin: 'build-lod',
      },
    },
    options: [
      { key: 'method', label: 'Method', type: 'enum', values: ['quality', 'quick'], default: 'quality', help: '--quality (bhatt-lod, base 1.75, the default) or --quick (tiny-lod, base 1.5).' },
      { key: 'maxSh', label: 'Spherical harmonics', type: 'enum', values: ['3', '2', '1', '0'], default: '3', help: '--max-sh: the highest degree kept. 3 is the tool\'s default.' },
      { key: 'encoding', label: 'Splat encoding', type: 'enum', values: ['gsplat', 'csplat'], default: 'gsplat', advanced: true, help: '--gsplat (higher precision, the default) or --csplat (compact).' },
      { key: 'clusterSh', label: 'Cluster the harmonics', type: 'bool', default: false, advanced: true, help: '--cluster-sh: a codebook of at most 64 K coefficient sets, on the GPU: a much smaller file.' },
      { key: 'skipValidate', label: 'Skip validation', type: 'bool', default: false, advanced: true, help: '--skip-validate: go on when the input holds invalid splats.' },
    ],
    steps(ctx) {
      const { exe, input, outDir, tmpDir, name, ext, opt } = ctx;
      // build-lod writes <name>-lod.rad beside its input: it is given a copy in the scratch folder
      const copy = path.join(tmpDir, `${name}.${ext}`);
      const cmd = [...exe, opt.method === 'quick' ? '--quick' : '--quality', `--max-sh=${opt.maxSh}`, opt.encoding === 'csplat' ? '--csplat' : '--gsplat'];
      if (opt.clusterSh) cmd.push('--cluster-sh');
      if (opt.skipValidate) cmd.push('--skip-validate');
      cmd.push(copy);
      return [
        { copy: [input, copy], label: 'copy the input to the scratch folder' },
        { cmd, label: 'splats → RAD' },
        { move: [path.join(tmpDir, `${name}-lod.rad`), path.join(outDir, `${name}-lod.rad`)], label: 'keep the .rad' },
      ];
    },
  },
];

export const toolById = (id) => TOOLS.find((t) => t.id === id) ?? null;
