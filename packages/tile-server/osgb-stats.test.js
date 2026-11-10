// scripts/osgb-stats.mjs: the counting of an OSGB dataset (files, depth, leaves, vertices, triangles, textures), on
// the synthetic dataset the OSGB tests use, from a local folder and through the tile-server's root discovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { encodeOsgb, quad } from '../osgb-to-3dtiles/test/osgb-fixture.js';
import { parseOsgb } from '../osgb-to-3dtiles/src/osgb-reader.js';
import { osgbStats, fileStats, embeddedImages, cacheSlug } from '../../scripts/osgb-stats.mjs';
import { handleStream } from './stream-live.js';
import { httpStatusOf, writeZip } from '../core/index.js';

const quiet = (t) => { t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); };
const JPEG = jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, 200), width: 8, height: 8 }, 90).data;
const textured = (g, name = 't.jpg') => ({ ...g, texture: { name, file: JPEG } });
const level = (finer, range = 40, extra = {}) => ({
  type: 'PagedLOD', center: [5, 5, 0], radius: 8, rangeMode: 1, ranges: [[0, range], [range, 1e30]], files: ['', finer],
  children: [{ type: 'Geode', drawables: [textured(quad(0, 0, 10))] }], ...extra,
});
const last = (x0, y0, z) => ({ type: 'PagedLOD', center: [x0 + 2.5, y0 + 2.5, z], radius: 4, rangeMode: 1, ranges: [[0, 1e30]], files: [''], children: [{ type: 'Geode', drawables: [textured(quad(x0, y0, 5, z))] }] });

// Tile 0: three levels, the last a file of two leaf PagedLODs. Tile 1: one level naming a finer file the copy lacks.
// Both PagedLODs of tile 0's L16 name the same L17 file: it must be read and counted once.
const T0 = 'Data/Tile_+000_+000/Tile_+000_+000', T1 = 'Data/Tile_+001_+000/Tile_+001_+000';
const DATASET = {
  'metadata.xml': Buffer.from('<ModelMetadata version="1"><SRS>ENU:48.8584,2.2945</SRS><SRSOrigin>0,0,0</SRSOrigin></ModelMetadata>'),
  [`${T0}.osgb`]: encodeOsgb(level('Tile_+000_+000_L16_0.osgb', 20)),
  [`${T0}_L16_0.osgb`]: encodeOsgb({ type: 'Group', children: [level('Tile_+000_+000_L17_00.osgb', 40), level('Tile_+000_+000_L17_00.osgb', 40, { center: [15, 5, 0] })] }),
  [`${T0}_L17_00.osgb`]: encodeOsgb({ type: 'Group', children: [last(0, 0, 0), last(5, 5, 1)] }),
  [`${T1}.osgb`]: encodeOsgb(level('Tile_+001_+000_L16_0.osgb', 20, { center: [25, 5, 0] }), { version: 131, brackets: true }),
};
// per file: vertices 4 / 8 / 8 / 4 (a quad is 4 vertices, 2 triangles), textures 1 / 2 / 2 / 1
const EXPECTED = {
  files: 4, roots: 2, depth: 3, missing: 1, duplicateReferences: 1,
  units: 6, meshes: 6, vertices: 24, triangles: 12, textures: 6, textureBytes: 6 * JPEG.length,
  // leaves: the two units of L17 (named twice by L16), and T1's unit whose finer file is missing
  leafTiles: 3, finest: { units: 3, vertices: 12, triangles: 6, cut: 1 },
};
const check = (r) => {
  for (const [k, v] of Object.entries(EXPECTED)) assert.deepEqual(r[k], v, k);
  assert.deepEqual(r.perDepth.map((d) => [d.files, d.vertices]), [[2, 8], [1, 8], [1, 8]]);
  assert.deepEqual([r.versions, r.failed, r.skipped, r.misread], [{ 91: 3, 131: 1 }, [], [], []]);
  assert.equal(r.bytes, Object.entries(DATASET).filter(([k]) => k.endsWith('.osgb')).reduce((s, [, b]) => s + b.length, 0));
};

async function writeDataset(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'osgb-stats-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [rel, bytes] of Object.entries(DATASET)) { await mkdir(path.dirname(path.join(dir, rel)), { recursive: true }); await writeFile(path.join(dir, rel), bytes); }
  return dir;
}

test('osgb-stats: one file, and an image shared by two geometries counted once', () => {
  const { d, perUnit } = fileStats(DATASET[`${T0}_L17_00.osgb`]);
  assert.deepEqual(d, { files: 1, bytes: DATASET[`${T0}_L17_00.osgb`].length, units: 2, meshes: 2, vertices: 8, triangles: 4, textures: 2, textureBytes: 2 * JPEG.length });
  assert.deepEqual(perUnit.map((u) => [u.vertices, u.triangles, u.files]), [[4, 2, []], [4, 2, []]]);
  // the reader hands back one object for an id read twice: the same image under two geometries is one texture
  const scene = parseOsgb(DATASET[`${T0}_L16_0.osgb`]);
  const img = embeddedImages(scene)[0];
  const twice = { root: { class: 'osg::Group', Children: [{ class: 'osg::Geode', StateSet: { TextureAttributeList: [[{ class: 'osg::Texture2D', Image: img }]] } }, { class: 'osg::Geode', StateSet: { TextureAttributeList: [[{ class: 'osg::Texture2D', Image: img }]] } }] } };
  assert.equal(embeddedImages(twice).length, 1);
  assert.equal(embeddedImages({ root: { class: 'osg::Image', external: true } }).length, 0, 'a texture in an external file has no bytes here');
});

test('osgb-stats: a dataset from a local folder, by its folder and by its metadata.xml', async (t) => {
  const dir = await writeDataset(t);
  check(await osgbStats(dir));
  const r = await osgbStats(path.join(dir, 'metadata.xml'));
  check(r);
  assert.equal(r.bytesFetched, 0);
  // one root .osgb: its own chain only
  const one = await osgbStats(path.join(dir, `${T1}.osgb`));
  assert.deepEqual([one.files, one.roots, one.missing, one.vertices, one.leafTiles], [1, 1, 1, 4, 1]);
});

test('osgb-stats: a dataset on a host, roots from the tile-server, files cached once and re-read from the cache', async (t) => {
  quiet(t);
  const hits = {};
  const host = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname).slice(1);
    hits[p] = (hits[p] ?? 0) + 1;
    if (!DATASET[p]) { res.writeHead(404); return res.end(); }
    res.end(DATASET[p]);
  }).listen(0, '127.0.0.1');
  const tiles = http.createServer(async (req, res) => {
    try { if (!await handleStream(req, res, new URL(req.url, 'http://x'))) { res.writeHead(404); res.end(); } }
    catch (e) { res.writeHead(httpStatusOf(e)); res.end(String(e.message)); }
  }).listen(0, '127.0.0.1');
  await Promise.all([once(host, 'listening'), once(tiles, 'listening')]);
  t.after(() => Promise.all([host, tiles].map((s) => new Promise((r) => { s.close(r); s.closeAllConnections(); }))));
  const cache = await mkdtemp(path.join(tmpdir(), 'osgb-cache-'));
  t.after(() => rm(cache, { recursive: true, force: true }));

  const src = `http://127.0.0.1:${host.address().port}/metadata.xml`, server = `http://127.0.0.1:${tiles.address().port}`;
  const first = await osgbStats(src, { server, cache });
  check(first);
  assert.equal(first.bytesFetched, first.bytes);
  assert.ok(Object.keys(hits).filter((p) => p.endsWith('.osgb') && DATASET[p]).every((p) => hits[p] >= 1));
  const slug = cacheSlug(`http://127.0.0.1:${host.address().port}/`);
  assert.deepEqual((await readdir(path.join(cache, slug, 'Data/Tile_+001_+000'))).sort(), ['Tile_+001_+000.osgb', 'Tile_+001_+000_L16_0.osgb.missing']);

  // a second run reads nothing from the host: the files, and the missing one, come from the cache
  const before = { ...hits };
  const again = await osgbStats(src, { server, cache });
  check(again);
  assert.deepEqual([again.bytesFetched, again.bytesCached, again.requests], [0, first.bytes, 0]);
  for (const p of Object.keys(hits)) if (p.endsWith('.osgb')) assert.equal(hits[p], before[p], `${p} fetched again`);
});

test('osgb-stats: a dataset in a zip, whole and under --max-files / --max-depth, the cut files counted and no leaf claimed among them', async (t) => {
  quiet(t);
  const zip = writeZip(Object.fromEntries(Object.entries(DATASET).map(([k, v]) => [`tile/${k}`, v])));
  const dir = await mkdtemp(path.join(tmpdir(), 'osgb-zip-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'tile.zip'), zip);
  const cache = path.join(dir, 'cache');
  const whole = await osgbStats(path.join(dir, 'tile.zip'), { cache });
  check(whole);
  assert.deepEqual([whole.cut, whole.limits, whole.bytesFetched], [null, null, whole.bytes]);
  assert.deepEqual((await readdir(path.join(cache, cacheSlug(`file:///${dir.replace(/\\/g, '/')}/tile.zip`), 'tile'))).sort(), ['Data', 'metadata.xml'], 'cached extracted, the metadata.xml with it');

  // depth 1 only: the two roots read, their two finer files named and not read; nothing is a leaf among what was cut
  const shallow = await osgbStats(path.join(dir, 'tile.zip'), { cache, maxDepth: 1 });
  assert.deepEqual([shallow.files, shallow.depth, shallow.vertices, shallow.cut, shallow.limits], [2, 1, 8, [0, 2], { maxFiles: null, maxDepth: 1 }]);
  assert.deepEqual([shallow.leafTiles, shallow.missing], [0, 0], 'the roots name finer files that were not read: not leaves, not missing');
  // three files: the roots and one of depth 2; the other of depth 2, and the one of depth 3 the file read names, left
  const three = await osgbStats(path.join(dir, 'tile.zip'), { cache, maxFiles: 3 });
  assert.deepEqual([three.files, three.cut, three.limits.maxFiles, three.leafTiles], [3, [0, 1, 1], 3, 0]);
});
