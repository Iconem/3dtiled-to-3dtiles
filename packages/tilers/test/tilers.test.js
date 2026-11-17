// The one-stop tiler (packages/tilers): options are checked before they reach a command line, commands are built as
// the tools want them, a download is refused unless it matches its pinned hash, and the desktop app's subprocess
// runner drives the CLI. No third-party tool is run here: the tools themselves are tried by hand (see the docs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { TOOLS, RUNTIMES, RUST_BUILD, toolById, listTools, toolsFor, describeInput, parseDb, sniffPly, resolveOptions, planRun, unzip, installTool, detectTool, detectRuntime, commandLine, stepLine } from '../index.js';

const found = (exe = ['tool.exe']) => ({ status: 'ready', source: 'path', exe });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tilers-test-'));

/** A ZIP of `files` (name → string), DEFLATE entries. */
function zip(files) {
  const locals = [], dir = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), data = zlib.deflateRawSync(raw);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26); local.write(name, 30, 'latin1');
    const entry = Buffer.alloc(46 + name.length);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(8, 10); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42); entry.write(name, 46, 'latin1');
    locals.push(local, data); dir.push(entry); offset += local.length + data.length;
  }
  const cd = Buffer.concat(dir), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(dir.length, 8); eocd.writeUInt16LE(dir.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('the manifest: every tool says what it takes, what it writes, how it is delivered and under which licence', () => {
  const ids = TOOLS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const t of listTools()) {
    assert.ok(t.name && t.summary && t.licence && /^https:\/\//.test(t.homepage), t.id);
    assert.ok(t.inputs.length && t.output.format && t.output.label, t.id);
    assert.ok(['pointcloud', 'mesh', 'splat'].includes(t.kind), t.id);
    assert.ok(['copc', 'potree', 'sog', 'rad', 'nexus', 'package', '3dtiles'].includes(t.output.format), `${t.id}: an output this repo opens`);
    assert.ok(['bundled', 'download', 'uv', 'cargo', 'detect'].includes(t.delivery));
    assert.equal(t.inputs.includes('ply'), !!t.ply, `${t.id}: a tool that takes PLY says which kind`);
    for (const o of t.options) {
      assert.ok(o.key && o.label && o.help && ['int', 'number', 'bool', 'enum', 'text'].includes(o.type), `${t.id}.${o.key}`);
      assert.notEqual(o.default, undefined, `${t.id}.${o.key} has a default`);
      if (o.type === 'enum') assert.ok(o.values.includes(o.default));
      if (o.required) assert.equal(o.default, '', `${t.id}.${o.key}: a required option has no default`);
    }
    assert.equal(JSON.parse(JSON.stringify(t)).id, t.id, 'plain data: it goes to a form as JSON');
  }
  for (const t of [...TOOLS, ...Object.values(RUNTIMES).map((r) => ({ provide: r }))]) for (const [key, dl] of Object.entries(t.provide.download ?? {})) {
    if (key === 'version') continue;
    assert.match(dl.url, /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//, 'a release asset of the project itself');
    assert.match(dl.sha256, /^[0-9a-f]{64}$/); assert.ok(dl.bytes > 0 && dl.exe);
  }
  for (const t of TOOLS) if (t.provide.needs) assert.ok(RUNTIMES[t.provide.needs.runtime] && t.provide.command, `${t.id}: its runtime is declared`);
  for (const t of TOOLS) if (t.provide.uv) assert.match(t.provide.uv.spec, /==\d/, `${t.id}: a pinned version`);
  for (const t of TOOLS) if (t.provide.cargo) {
    assert.match(t.provide.cargo.url, /^https:\/\/github\.com\/[^/]+\/[^/]+\/archive\/refs\/tags\//, `${t.id}: the source of a tagged version`);
    assert.match(t.provide.cargo.sha256, /^[0-9a-f]{64}$/); assert.ok(t.provide.cargo.manifest && t.provide.cargo.bin);
  }
});

test('which tools take a file or a folder', () => {
  assert.deepEqual(toolsFor('C:\\scans\\site.LAS'), ['pdal', 'untwine', 'potreeconverter', 'potreeconverter1', 'gocesiumtiler', 'point-tiler', 'py3dtiles', 'rusty-tiles-points', 'mago-3d-tiler']);
  assert.deepEqual(toolsFor('/data/scan.e57'), ['pdal', 'gocesiumtiler']);
  assert.deepEqual(toolsFor('already.copc.laz'), [], 'a COPC is tiled already: it is streamed, not tiled again');
  assert.deepEqual(toolsFor('model.obj'), ['obj2tiles', 'mago-3d-tiler', 'nexus']);
  assert.deepEqual(toolsFor('model.glb'), ['mago-3d-tiler', 'rusty-tiles']);
  assert.deepEqual(toolsFor('part.stl'), ['mago-3d-tiler', 'nexus']);
  assert.deepEqual(toolsFor('building.ifc'), ['mago-3d-tiler']);
  assert.deepEqual(toolsFor('scene.spz'), ['splat-transform', 'spark-build-lod']);
  assert.deepEqual(toolsFor('scene.splat'), ['splat-transform', 'spark-build-lod']);
  assert.deepEqual(toolsFor('scan.ptx'), ['pdal'], 'PotreeConverter 1.7 lists PTX but its binary crashes on it');
  assert.deepEqual(toolsFor('cloud.txt'), ['pdal', 'potreeconverter1', 'point-tiler']);
  assert.deepEqual(toolsFor('cloud.xyz'), ['potreeconverter1', 'py3dtiles']);
  assert.deepEqual(toolsFor('footprints.shp'), ['mago-3d-tiler', 'fanvanzh-3dtiles-shape']);
  assert.deepEqual(toolsFor('parcels.geojson'), ['mago-3d-tiler', 'rusty-tiles-vector']);
  assert.deepEqual(toolsFor('notes.docx'), []);

  // A PLY is points, a mesh or splats: its header says, and only the tools for that kind are offered.
  const dir = tmp(), ply = (name, header) => { const f = path.join(dir, name); fs.writeFileSync(f, `ply\nformat binary_little_endian 1.0\n${header}\nend_header\n`); return f; };
  const points = ply('points.ply', 'element vertex 10\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red');
  const splats = ply('splats.ply', 'element vertex 10\nproperty float x\nproperty float f_dc_0\nproperty float opacity\nproperty float scale_0');
  const mesh = ply('mesh.ply', 'element vertex 10\nproperty float x\nelement face 20\nproperty list uchar int vertex_indices');
  const packed = ply('scene.compressed.ply', 'element chunk 4\nproperty float min_x\nelement vertex 10\nproperty uint packed_position\nproperty uint packed_rotation');
  assert.deepEqual([sniffPly(points), sniffPly(splats), sniffPly(mesh), sniffPly(packed)], ['points', 'splats', 'mesh', 'splats']);
  assert.deepEqual(toolsFor(points), ['pdal', 'potreeconverter1', 'gocesiumtiler', 'py3dtiles']);
  assert.deepEqual(toolsFor(splats), ['splat-transform', 'gocesiumtiler-splats', '3dgs-ply-3dtiles-converter', 'spark-build-lod']);
  assert.deepEqual(toolsFor(mesh), ['mago-3d-tiler', 'nexus'], 'a PLY mesh goes to the mesh tools');
  assert.equal(toolsFor('not-on-disk.ply').length, 10, 'a PLY that cannot be read is offered every PLY tool');

  // A folder is matched by what it holds.
  const scans = path.join(dir, 'scans'), osgb = path.join(dir, 'oblique');
  fs.mkdirSync(scans); fs.writeFileSync(path.join(scans, 'a.las'), ''); fs.writeFileSync(path.join(scans, 'b.laz'), '');
  fs.mkdirSync(path.join(osgb, 'Data', 'Tile_1'), { recursive: true }); fs.writeFileSync(path.join(osgb, 'metadata.xml'), ''); fs.writeFileSync(path.join(osgb, 'Data', 'Tile_1', 'Tile_1.osgb'), '');
  assert.deepEqual(describeInput(scans).exts, ['las', 'laz']);
  assert.deepEqual(toolsFor(scans), ['untwine', 'potreeconverter', 'potreeconverter1', 'gocesiumtiler', 'rusty-tiles-points', 'mago-3d-tiler'], 'the tools that take a folder');
  assert.deepEqual(toolsFor(osgb), ['fanvanzh-3dtiles']);
  // a folder is not a point cloud because it holds a text file
  const notes = path.join(dir, 'notes'); fs.mkdirSync(notes); fs.writeFileSync(path.join(notes, 'readme.txt'), '');
  assert.deepEqual(toolsFor(notes), []);
  assert.deepEqual(toolsFor(path.join(osgb, 'Data', 'Tile_1', 'Tile_1.osgb')), [], 'an OSGB tile alone is not an input: the folder is');
  assert.throws(() => planRun('pdal', scans, path.join(dir, 'out'), {}, found()), /takes one file .*not a folder/);
  assert.throws(() => planRun('gocesiumtiler', scans, path.join(scans, 'out'), {}, found()), /inside the input folder/);
  assert.throws(() => planRun('splat-transform', points, path.join(dir, 'out'), {}, found()), /reads a PLY of splats; this one holds points/);
});

test('options: defaults filled, values checked, nothing undeclared or flag-like gets through', () => {
  const potree = toolById('potreeconverter'), splat = toolById('splat-transform'), pdal = toolById('pdal');
  assert.deepEqual(resolveOptions(potree), { method: 'poisson', encoding: 'UNCOMPRESSED', attributes: '' });
  assert.deepEqual(resolveOptions(splat, { levels: '4', adaptive: 'true', keep: 25 }), { levels: 4, keep: 25, adaptive: true, chunkCount: 512, chunkExtent: 16, gpu: 'auto' });
  assert.equal(resolveOptions(splat, { levels: '' }).levels, 3, 'an empty field is the default');
  assert.throws(() => resolveOptions(potree, { method: 'fancy' }), /one of poisson/);
  assert.throws(() => resolveOptions(splat, { levels: 99 }), /between 1 and 8/);
  assert.throws(() => resolveOptions(splat, { levels: 2.5 }), /whole number/);
  assert.throws(() => resolveOptions(splat, { keep: 'half' }), /whole number/);
  assert.throws(() => resolveOptions(potree, { exe: 'evil.exe' }), /no option "exe"/);
  assert.throws(() => resolveOptions(pdal, { srs: '--writers.copc.filename=C:\\x' }), /not a valid value/);
  assert.throws(() => resolveOptions(pdal, { srs: 'EPSG:2154\n--x' }), /not a valid value/);
  assert.equal(resolveOptions(pdal, { srs: ' EPSG:2154 ' }).srs, 'EPSG:2154');
  const ptiler = toolById('point-tiler');
  assert.throws(() => resolveOptions(ptiler), /inputEpsg: point-tiler \(MIERUNE\) needs it/, 'an option the tool cannot run without');
  assert.equal(resolveOptions(ptiler, {}, true).inputEpsg, '', 'a form still being filled is not an error');
  assert.equal(resolveOptions(toolById('potreeconverter1'), { projection: '+proj=utm +zone=31 +datum=WGS84' }).projection, '+proj=utm +zone=31 +datum=WGS84');
  assert.equal(resolveOptions(toolById('gocesiumtiler-splats'), { upAxis: '-y', lon: '-2.5' }).lon, -2.5, 'a negative number and a signed axis are values, not flags');
});

test('commands: each tool is called the way it documents', () => {
  const dir = tmp(), las = path.join(dir, 'scan one.las'), out = path.join(dir, 'out');
  const p = planRun('potreeconverter', las, out, { encoding: 'BROTLI', attributes: 'rgb, intensity' }, found(['C:\\tools\\PotreeConverter.exe']));
  assert.deepEqual(p.steps.map((s) => s.cmd), [['C:\\tools\\PotreeConverter.exe', las, '-o', out, '--method', 'poisson', '--encoding', 'BROTLI', '--attributes', 'rgb', 'intensity']]);
  assert.deepEqual([p.output.format, p.output.path, path.basename(p.output.proof)], ['potree', out, 'metadata.json'], 'the Potree folder is what gets streamed');
  assert.equal(planRun('potreeconverter', las, out, {}, found()).steps[0].cmd.includes('--encoding'), false, 'the default encoding is not passed');

  const c = planRun('pdal', las, out, { srs: 'EPSG:2154' }, found(['pdal']));
  assert.deepEqual(c.steps[0].cmd, ['pdal', 'translate', las, path.join(out, 'scan one.copc.laz'), '--writers.copc.threads=10', '--writers.copc.forward=all', '--writers.copc.a_srs=EPSG:2154']);
  assert.equal(c.output.format, 'copc');
  const e57 = planRun('pdal', path.join(dir, 'a.e57'), out, {}, found(['pdal']));
  assert.ok(!e57.steps[0].cmd.includes('--writers.copc.forward=all'), 'no LAS header to forward from an E57');

  const u = planRun('untwine', las, out, { cube: true }, found(['untwine']));
  assert.deepEqual(u.steps[0].cmd, ['untwine', '-i', las, '-o', path.join(out, 'scan one.copc.laz'), '--temp_dir', path.join(out, '.tiler-tmp'), '--cube']);

  const ply = path.join(dir, 'scene.ply');
  const s = planRun('splat-transform', ply, out, { levels: 3, keep: 40, gpu: 'cpu' }, found(['node', 'cli.mjs']));
  const t = (n) => path.join(out, '.tiler-tmp', `lod${n}.ply`);
  assert.deepEqual(s.steps.map((x) => x.cmd), [
    ['node', 'cli.mjs', '-w', ply, '--decimate', '40%', t(1)],
    ['node', 'cli.mjs', '-w', t(1), '--decimate', '40%', t(2)],
    ['node', 'cli.mjs', '-w', ply, '-l', '0', t(1), '-l', '1', t(2), '-l', '2', path.join(out, 'lod-meta.json'), '--lod-chunk-count', '512', '--lod-chunk-extent', '16', '--gpu', 'cpu'],
  ]);
  assert.equal(planRun('splat-transform', ply, out, { levels: 1 }, found(['node', 'cli.mjs'])).steps.length, 1, 'one level: no decimation');
  assert.equal(planRun('splat-transform', ply, out, { adaptive: true, levels: 2 }, found(['x'])).steps[0].cmd[3], '--decimate-adaptive');

  // the tools that write 3D Tiles: the tileset is the output, opened as is
  const exe = found(['t.exe']), ts = path.join(out, 'tileset.json'), obj = path.join(dir, 'model.obj');
  const g = planRun('gocesiumtiler', las, out, { crs: 'EPSG:32631', version: '1.0' }, exe);
  assert.deepEqual(g.steps[0].cmd, ['t.exe', 'pcloud', '--plain', '-o', out, '--version', '1.0', '--points-per-tile', '50000', '--refine-mode', 'add', '--crs', 'EPSG:32631', las]);
  assert.deepEqual([g.output.format, g.output.path], ['3dtiles', ts]);
  const gs = planRun('gocesiumtiler-splats', ply, out, { maxShDegree: 3, upAxis: '-y', lon: 2.29, lat: 48.86 }, exe);
  assert.deepEqual(gs.steps[0].cmd, ['t.exe', 'splats', '--plain', '--no-preview', '-o', out, '--max-sh-degree', '3', '--input-up-axis', '-y', '--splats-per-tile', '40000', '--min-opacity', '0.05', '--longitude', '2.29', '--latitude', '48.86', ply]);
  const pt = planRun('point-tiler', las, out, { inputEpsg: 32631, meshopt: true }, exe);
  assert.deepEqual(pt.steps[0].cmd, ['t.exe', '--input', las, '--output', out, '--input-epsg', '32631', '--output-epsg', '4979', '--min', '15', '--max', '18', '--max-memory-mb', '4096', '--temp-dir', path.join(out, '.tiler-tmp'), '--meshopt']);
  const o2 = planRun('obj2tiles', obj, out, {}, exe);
  assert.deepEqual(o2.steps[0].cmd, ['t.exe', '--lods', '3', '--divisions', '2', '--texture-format', 'Jpeg', '--decimation-mode', 'Standard', '--max-texture-size', '4096', '--local', '--glb', '--octree', obj, out], 'no position given: a local tileset');
  assert.ok(planRun('obj2tiles', obj, out, { lon: 2.29, lat: 48.86 }, exe).steps[0].cmd.join(' ').includes('--lon 2.29 --lat 48.86 --alt 0'));
  const p1 = planRun('potreeconverter1', las, out, { format: 'LAZ', attributes: 'rgb intensity', projection: '+proj=utm +zone=31' }, exe);
  assert.deepEqual(p1.steps[0].cmd, ['t.exe', las, '-o', out, '--output-format', 'LAZ', '--output-attributes', 'RGB', 'INTENSITY', '--projection', '+proj=utm +zone=31']);
  assert.deepEqual([p1.output.path, path.basename(p1.output.proof)], [out, 'cloud.js']);
  const py = planRun('py3dtiles', las, out, { srsIn: 32631 }, exe);
  assert.deepEqual(py.steps[0].cmd, ['t.exe', 'convert', las, '--out', out, '--overwrite', '--spec-version', '1.0', '--srs_in', '32631', '--srs_out', '4978']);
  assert.ok(!planRun('py3dtiles', las, out, {}, exe).steps[0].cmd.includes('--srs_out'), 'no reprojection asked of a file without a CRS');
  const m = planRun('mago-3d-tiler', obj, out, { crs: 'EPSG:5186', rotateX: 90 }, found(['java', '-jar', 'mago.jar']));
  assert.deepEqual(m.steps[0].cmd, ['java', '-jar', 'mago.jar', '--input', obj, '--output', out, '--temp', path.join(out, '.tiler-tmp'), '--inputType', 'obj', '--tilesVersion', '1.1', '--crs', '5186', '--rotateXAxis', '90']);
  const osgb = path.join(dir, 'oblique'); fs.mkdirSync(path.join(osgb, 'Data'), { recursive: true }); fs.writeFileSync(path.join(osgb, 'Data', 'a.osgb'), '');
  const f = planRun('fanvanzh-3dtiles', osgb, out, { lon: 108.96, lat: 34.22, maxLevel: 18 }, exe);
  assert.deepEqual(f.steps[0].cmd, ['t.exe', '-f', 'osgb', '-i', osgb, '-o', out, '-c', '{"x":108.96,"y":34.22,"max_lvl":18}']);

  // tools that write one file to stream: a .3tz archive, a Nexus file, a RAD
  const glb = path.join(dir, 'model.glb');
  const rm = planRun('rusty-tiles', glb, out, { lon: 2.29, lat: 48.86 }, exe);
  assert.deepEqual(rm.steps[0].cmd, ['t.exe', 'mesh', '--force', '--input', glb, '--output', path.join(out, 'model.3tz'), '--profile', 'balanced', '--anchor', '2.29', '48.86', '0']);
  assert.deepEqual([rm.output.format, rm.output.path], ['package', path.join(out, 'model.3tz')]);
  const rp = planRun('rusty-tiles-points', las, out, { sourceCrs: 'EPSG:32631' }, exe);
  assert.deepEqual(rp.steps[0].cmd, ['t.exe', 'point-cloud', '--force', '--input', las, '--output', path.join(out, 'scan one.3tz'), '--sourceCrs', 'EPSG:32631', '--maxPoints', '8192', '--heightOffset', '0']);
  assert.throws(() => planRun('rusty-tiles-points', las, out, {}, exe), /sourceCrs: .* needs it/);
  const nx = planRun('nexus', obj, out, { compress: true, colors: true }, found(['C:\\tools\\nxsbuild.exe']));
  assert.deepEqual(nx.steps.map((x) => x.cmd), [
    ['C:\\tools\\nxsbuild.exe', obj, '-o', path.join(out, '.tiler-tmp', 'model.nxs'), '-f', '32768', '-t', '4096', '-s', '0.5', '-r', '2000', '-C'],
    [path.join('C:\\tools', 'nxscompress.exe'), path.join(out, '.tiler-tmp', 'model.nxs'), '-o', path.join(out, 'model.nxz')],
  ]);
  assert.deepEqual([nx.output.format, path.basename(nx.output.path)], ['nexus', 'model.nxz']);
  assert.equal(path.basename(planRun('nexus', obj, out, {}, exe).output.path), 'model.nxs');
  const wl = planRun('3dgs-ply-3dtiles-converter', ply, out, { sh: 2, lon: 2.29, lat: 48.86, alt: 60 }, found(['node', 'c.js']));
  assert.deepEqual(wl.steps[0].cmd, ['node', 'c.js', '--no-open-inspector', '--tmp-dir', path.join(out, '.tiler-tmp'), '--sh', '2', '--coordinate', '[48.86,2.29,60]', ply, out]);
  // a tool that writes beside its input is given a copy, and its file is moved out: steps this package does itself
  const sp = planRun('spark-build-lod', ply, out, { method: 'quick', maxSh: 1 }, exe);
  const copy = path.join(out, '.tiler-tmp', 'scene.ply');
  assert.deepEqual(sp.steps.map((x) => x.cmd ?? x.copy ?? x.move), [[ply, copy], ['t.exe', '--quick', '--max-sh=1', '--gsplat', copy], [path.join(out, '.tiler-tmp', 'scene-lod.rad'), path.join(out, 'scene-lod.rad')]]);
  assert.deepEqual([sp.output.format, stepLine(sp.steps[0]).startsWith('copy '), stepLine(sp.steps[2]).startsWith('move ')], ['rad', true, true]);
  assert.ok(planRun('mago-3d-tiler', path.join(dir, 'm.stl'), out, {}, exe).steps[0].cmd.join(' ').includes('--inputType stl'));

  assert.throws(() => planRun('potreeconverter', ply, out, {}, found()), /takes \.las, \.laz, not \.ply/);
  assert.throws(() => planRun('pdal', las, out, {}, { status: 'missing', hint: 'not found: install QGIS' }), /not available: not found: install QGIS/);
  assert.throws(() => planRun('nope', las, out), /unknown tool/);
  assert.equal(commandLine(['a b.exe', 'x', 'say "hi"']), '"a b.exe" x "say \\"hi\\""');
});

test('a download that does not match its pinned hash installs nothing', async () => {
  const dir = tmp(); process.env.TILED_TOOLS_DIR = dir;
  const dl = toolById('potreeconverter').provide.download, key = `${process.platform}-${process.arch}`;
  if (!dl[key]) return;                                      // no asset for this platform: nothing to try
  const fake = zip({ 'PotreeConverter.exe': 'not the real thing' });
  const log = [];
  await assert.rejects(installTool('potreeconverter', { fetch: async () => new Response(fake), log: (l) => log.push(l) }), /does not match its pinned SHA-256.*Nothing was installed/s);
  assert.deepEqual(fs.readdirSync(dir), [], 'the tools folder is untouched');
  assert.equal(detectTool('potreeconverter').source === 'downloaded', false);
  await assert.rejects(installTool('potreeconverter', { fetch: async () => new Response('gone', { status: 404 }) }), /HTTP 404/);
  await assert.rejects(installTool('pdal'), /no download/);
});

test('a tool that needs a runtime says what is missing, and a found runtime that is too old is passed over', async (t) => {
  const dir = tmp(); process.env.TILED_TOOLS_DIR = dir;
  const saved = { path: process.env.PATH, Path: process.env.Path, home: process.env.JAVA_HOME };
  process.env.PATH = dir; delete process.env.Path; delete process.env.JAVA_HOME;      // a machine without Java
  try {
    const key = `${process.platform}-${process.arch}`, has = !!RUNTIMES.java.download[key];
    const d = detectTool('mago-3d-tiler');
    assert.equal(d.status, 'missing');
    if (has) {
      assert.equal(d.missing.length, 2, 'the program and its Java runtime');
      assert.equal(d.downloadBytes, toolById('mago-3d-tiler').provide.download[key].bytes + RUNTIMES.java.download[key].bytes);
      assert.equal(d.downloadable, true);
    }
    assert.equal(detectRuntime('java', 25).status, 'missing');
    // a `java` that answers version 17 is not one mago can run on (Node stands in for it, asked to print that)
    const asked = RUNTIMES.java.version;
    RUNTIMES.java.version = { ...asked, args: ['-e', 'console.error(\'openjdk version "17.0.12" 2024-07-16\')'] };
    t.after(() => { RUNTIMES.java.version = asked; });
    process.env.TILED_JAVA = process.execPath;
    const old = detectRuntime('java', 25);
    assert.equal(old.status, 'missing'); assert.match(old.hint, /is version 17/);
    assert.equal(detectRuntime('java', 17).status, 'ready', 'the same one is fine for a tool that asks for 17');
  } finally {
    process.env.PATH = saved.path; if (saved.Path !== undefined) process.env.Path = saved.Path; if (saved.home !== undefined) process.env.JAVA_HOME = saved.home; delete process.env.TILED_JAVA;
  }
});

test('an asset that is the program itself (an .exe, a .jar) is put in place, hash-checked like an archive', async (t) => {
  const dir = tmp(); process.env.TILED_TOOLS_DIR = dir;
  const tool = toolById('point-tiler'), key = `${process.platform}-${process.arch}`, real = tool.provide.download[key];
  if (!real) return;
  const program = Buffer.from('MZ a program');
  tool.provide.download[key] = { ...real, sha256: createHash('sha256').update(program).digest('hex'), bytes: program.length };
  t.after(() => { tool.provide.download[key] = real; });
  const r = await installTool('point-tiler', { fetch: async () => new Response(program) });
  assert.equal(fs.readFileSync(r.exe, 'utf8'), 'MZ a program');
  assert.equal(path.basename(r.exe), real.exe);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'point-tiler')), [tool.provide.download.version], 'no download file left beside it');
  // two tools that are one binary share the install
  assert.equal(toolById('gocesiumtiler').provide, toolById('gocesiumtiler-splats').provide);
});

test('an archive whose entries are named with backslashes unpacks to the same paths', async (t) => {
  const dir = tmp(); process.env.TILED_TOOLS_DIR = dir;
  const tool = toolById('nexus'), key = `${process.platform}-${process.arch}`, real = tool.provide.download[key];
  if (!real) return;
  const archive = zip({ 'nexus_portable\\nxsbuild.exe': 'MZ build', 'nexus_portable\\nxscompress.exe': 'MZ compress', 'nexus_portable\\plugins\\a.dll': 'dll' });
  tool.provide.download[key] = { ...real, sha256: createHash('sha256').update(archive).digest('hex'), bytes: archive.length };
  t.after(() => { tool.provide.download[key] = real; });
  const r = await installTool('nexus', { fetch: async () => new Response(archive) });
  assert.equal(fs.readFileSync(r.exe, 'utf8'), 'MZ build');
  assert.ok(fs.existsSync(path.join(r.dir, 'nxscompress.exe')) && fs.existsSync(path.join(r.dir, 'plugins', 'a.dll')));
});

test('a tool published as source only is built with the machine\'s Rust toolchain, or with one fetched for the build', async (t) => {
  const dir = tmp(); process.env.TILED_TOOLS_DIR = dir;
  const key = `${process.platform}-${process.arch}`, rust = RUST_BUILD[key];
  const d = detectTool('spark-build-lod');
  assert.equal(d.status, 'missing');
  if (d.downloadable) assert.match(d.hint, /built here with cargo/);
  else assert.match(d.hint, /needs the Rust toolchain to build: install it from https:\/\/rustup\.rs/);
  assert.equal(listTools().find((x) => x.id === 'spark-build-lod').delivery, 'cargo');

  // without a cargo on the machine: the toolchain is part of what is fetched, where one is declared for the platform
  process.env.TILED_PRIVATE_RUST = '1';
  t.after(() => { delete process.env.TILED_PRIVATE_RUST; });
  const none = detectTool('spark-build-lod');
  assert.equal(none.downloadable, !!rust);
  if (rust) {
    assert.equal(none.missing.length, 2);
    assert.match(none.missing[1], /a Rust toolchain \d+\.\d+\.\d+ for the build, removed after it/);
    assert.equal(none.downloadBytes, toolById('spark-build-lod').provide.cargo.bytes + rust.bytes + rust.toolchainBytes);
  } else assert.match(none.hint, /install it from https:\/\/rustup\.rs/);
  // the installer is pinned like any download, and it comes from the Rust project
  for (const [k, dl] of Object.entries(RUST_BUILD)) {
    if (typeof dl !== 'object') continue;
    assert.match(dl.url, /^https:\/\/static\.rust-lang\.org\/rustup\/archive\/\d+\.\d+\.\d+\//, k);
    assert.match(dl.sha256, /^[0-9a-f]{64}$/); assert.ok(dl.bytes > 0 && dl.toolchainBytes > 0 && dl.host);
  }
  assert.match(RUST_BUILD.version, /^\d+\.\d+\.\d+$/, 'a pinned toolchain');
});

test('a database input: the address is parsed, its password kept out of every description, command line and record', () => {
  const address = 'postgresql://gis:s3cret@db.example.org:5433/city';
  assert.deepEqual(parseDb(address), { host: 'db.example.org', port: 5433, user: 'gis', password: 's3cret', database: 'city' });
  assert.equal(parseDb('postgres://localhost/city').port, 5432);
  assert.equal(parseDb('postgresql://localhost'), null, 'no database');
  assert.equal(parseDb('postgresql://u@h/db;Password=x'), null, 'nothing that would add a key to the connection string');
  assert.equal(parseDb('C:\\data\\a.las'), null);
  const d = describeInput(address);
  assert.deepEqual(d, { path: 'postgresql://gis@db.example.org:5433/city', exists: true, dir: false, ext: 'postgres', exts: ['postgres'], ply: null, db: true });
  assert.ok(!JSON.stringify(describeInput('postgresql://gis:s3cret@/')).includes('s3cret'), 'an incomplete address too');
  assert.deepEqual(toolsFor(address), ['pg2b3dm']);

  const out = path.join(tmp(), 'out');
  const plan = planRun('pg2b3dm', address, out, { table: 'public.buildings', attributes: 'name,height' }, found(['pg2b3dm.exe']));
  assert.deepEqual(plan.steps[0].cmd, ['pg2b3dm.exe', '--connection', 'Host=db.example.org;Port=5433;Username=gis;Database=city;CommandTimeOut=0', '-t', 'public.buildings', '-c', 'geom', '-o', out,
    '--max_features_per_tile', '1000', '-g', '2000', '-r', 'ADD', '--subdivision', 'QUADTREE', '-a', 'name,height']);
  assert.deepEqual(plan.steps[0].env, { PGPASSWORD: 's3cret' });
  assert.ok(!stepLine(plan.steps[0]).includes('s3cret'));
  assert.equal(planRun('pg2b3dm', 'postgresql://localhost/city', out, { table: 't' }, found()).steps[0].env, undefined, 'no password given: PGPASSWORD or pgpass of the machine');
  assert.throws(() => planRun('pg2b3dm', address, out, {}, found()), /table: pg2b3dm needs it/);
  assert.throws(() => planRun('pg2b3dm', 'C:\\data\\a.las', out, { table: 't' }, found()), /takes a PostgreSQL address/);
  assert.throws(() => planRun('obj2tiles', address, out, {}, found()), /not a database/);
});

test('splat-transform: the patched tool reads a format other than PLY in place as level 0', () => {
  const dir = tmp(), out = path.join(dir, 'out'), script = path.join(dir, 'pkg', 'bin', 'cli.mjs');
  fs.mkdirSync(path.join(dir, 'pkg', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pkg', 'dist', 'cli.mjs'), '// 3dtiled patch: …');
  const spz = path.resolve('C:\\s\\scene.spz'), t1 = path.join(out, '.tiler-tmp', 'lod1.ply');
  const steps = planRun('splat-transform', spz, out, { levels: 2 }, found(['node', script])).steps;
  assert.deepEqual(steps.map((x) => x.cmd.slice(2, 6)), [['-w', spz, '--decimate', '50%'], ['-w', spz, '-l', '0']]);
  assert.equal(steps[1].cmd[6], t1);
});

test('splat-transform, stock: a format other than PLY is first written out as a PLY, and an LCC keeps its own levels', () => {
  const out = path.join(tmp(), 'out'), exe = found(['node', 'cli.mjs']);
  const spz = planRun('splat-transform', 'C:\\s\\scene.spz', out, { levels: 2 }, exe).steps;
  assert.equal(spz.length, 3);
  assert.deepEqual(spz[0].cmd.slice(2), ['-w', path.resolve('C:\\s\\scene.spz'), path.join(out, '.tiler-tmp', 'lod0.ply')]);
  assert.equal(spz[1].cmd[3], path.join(out, '.tiler-tmp', 'lod0.ply'), 'level 1 is decimated from that PLY');
  assert.equal(planRun('splat-transform', 'C:\\s\\scene.lcc', out, {}, exe).steps.length, 1);
});

test('a matching download is unpacked where detection finds it, without its wrapping folder', async (t) => {
  const dir = tmp(); process.env.TILED_TOOLS_DIR = dir;
  const tool = toolById('potreeconverter'), key = `${process.platform}-${process.arch}`, real = tool.provide.download[key];
  if (!real) return;
  const archive = zip({ 'PotreeConverter_x/PotreeConverter.exe': 'MZ fake', 'PotreeConverter_x/licenses/LICENSE.txt': 'BSD', 'PotreeConverter_x/laszip.dll': 'dll' });
  tool.provide.download[key] = { ...real, sha256: createHash('sha256').update(archive).digest('hex'), bytes: archive.length };
  t.after(() => { tool.provide.download[key] = real; });
  const r = await installTool('potreeconverter', { fetch: async (url) => { assert.equal(url, real.url); return new Response(archive); } });
  assert.equal(r.downloaded, true);
  assert.equal(fs.readFileSync(path.join(dir, 'potreeconverter', tool.provide.download.version, 'PotreeConverter.exe'), 'utf8'), 'MZ fake');
  assert.ok(fs.existsSync(path.join(r.dir, 'licenses', 'LICENSE.txt')), 'the licence files come along');
  const d = detectTool('potreeconverter');
  assert.deepEqual([d.status, d.source, d.exe[0]], ['ready', 'downloaded', r.exe]);
  assert.equal((await installTool('potreeconverter', { fetch: async () => { throw new Error('not fetched twice'); } })).downloaded, false);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'potreeconverter')), [tool.provide.download.version], 'no temporary folder left');
});

test('unzip: files only, deflated or stored; an archive that reaches outside its folder is refused', async () => {
  const files = unzip(zip({ 'a/b.txt': 'hello', 'c.txt': 'x'.repeat(5000) }));
  assert.deepEqual(Object.keys(files), ['a/b.txt', 'c.txt']);
  assert.equal(files['a/b.txt'].toString(), 'hello'); assert.equal(files['c.txt'].length, 5000);
  assert.throws(() => unzip(Buffer.from('not a zip at all, just text of some length')), /not a ZIP/);
  const dir = tmp(); process.env.TILED_TOOLS_DIR = dir;
  const tool = toolById('potreeconverter'), key = `${process.platform}-${process.arch}`, real = tool.provide.download[key];
  if (!real) return;
  const evil = zip({ 'PotreeConverter.exe': 'x', '../../evil.txt': 'out' });
  tool.provide.download[key] = { ...real, sha256: createHash('sha256').update(evil).digest('hex') };
  try { await assert.rejects(installTool('potreeconverter', { fetch: async () => new Response(evil) }), /unsafe path/); }
  finally { tool.provide.download[key] = real; }
  assert.equal(fs.existsSync(path.join(dir, '..', 'evil.txt')), false);
});

test('the bundled splat tool is found', () => {
  const d = detectTool('splat-transform');
  assert.equal(d.status, 'ready'); assert.equal(d.source, 'bundled');
  assert.match(d.exe[1], /splat-transform[\\/]bin[\\/]cli\.mjs$/);
});

test("the desktop app's runner drives the tilers CLI, and refuses anything else", async () => {
  const { createCliRunner, nodeSpawn, validateArgs } = await import('../../../apps/desktop/src/bun/cli-runner.ts');
  assert.deepEqual(validateArgs(['packages/tilers/cli.js', 'run', 'pdal', 'a.las', 'out']).slice(0, 2), ['packages/tilers/cli.js', 'run']);
  assert.throws(() => validateArgs(['packages/tilers/cli.js', 'exec', 'calc.exe']), /not a tilers command/);
  assert.throws(() => validateArgs(['packages/tilers/index.js', 'run']), /not an allowed script/);
  const repo = path.resolve(import.meta.dirname, '..', '..', '..');
  const runner = createCliRunner({ spawn: await nodeSpawn(), cwd: repo, node: process.execPath });
  const wait = async (id) => { for (;;) { const s = runner.status(id); if (s.state !== 'running') return s; await new Promise((r) => setTimeout(r, 50)); } };
  const dir = tmp();
  const dry = await wait(runner.run([['packages/tilers/cli.js', 'run', 'splat-transform', path.join(dir, 'scene.ply'), path.join(dir, 'out'), '--levels', '2', '--dry-run', '--json']]));
  assert.equal(dry.state, 'done');
  const plan = JSON.parse(dry.tail.find((l) => l.startsWith('TILER_JSON ')).slice(11));
  assert.equal(plan.steps.length, 2); assert.equal(plan.output.format, 'sog'); assert.equal(plan.options.levels, 2);
  const bad = await wait(runner.run([['packages/tilers/cli.js', 'run', 'splat-transform', path.join(dir, 'scene.ply'), path.join(dir, 'out'), '--levels', '99']]));
  assert.equal(bad.state, 'failed');
  assert.ok(bad.tail.some((l) => /no such input|between 1 and 8/.test(l)), 'the reason is in the output the app shows');
});
