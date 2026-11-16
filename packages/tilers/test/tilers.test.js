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
import { TOOLS, toolById, listTools, toolsFor, resolveOptions, planRun, unzip, installTool, detectTool, commandLine } from '../index.js';

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
    assert.ok(['bundled', 'download', 'detect'].includes(t.delivery));
    for (const o of t.options) {
      assert.ok(o.key && o.label && o.help && ['int', 'number', 'bool', 'enum', 'text'].includes(o.type), `${t.id}.${o.key}`);
      assert.notEqual(o.default, undefined, `${t.id}.${o.key} has a default`);
      if (o.type === 'enum') assert.ok(o.values.includes(o.default));
    }
    assert.equal(JSON.parse(JSON.stringify(t)).id, t.id, 'plain data: it goes to a form as JSON');
  }
  for (const t of TOOLS) for (const [key, dl] of Object.entries(t.provide.download ?? {})) {
    if (key === 'version') continue;
    assert.match(dl.url, /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//, 'a release asset of the project itself');
    assert.match(dl.sha256, /^[0-9a-f]{64}$/); assert.ok(dl.bytes > 0 && dl.exe);
  }
});

test('which tools take a file', () => {
  assert.deepEqual(toolsFor('C:\\scans\\site.LAS'), ['potreeconverter', 'pdal', 'untwine']);
  assert.deepEqual(toolsFor('/data/scan.e57'), ['pdal']);
  assert.deepEqual(toolsFor('scene.ply'), ['splat-transform']);
  assert.deepEqual(toolsFor('already.copc.laz'), [], 'a COPC is tiled already: it is streamed, not tiled again');
  assert.deepEqual(toolsFor('model.obj'), []);
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
