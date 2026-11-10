// LCC2 (XGRIDS, a *.lcc2 manifest over bundled SOG chunks): the manifest → tileset mapping, a tile cut from a chunk read in
// part, and the offline converter writing the same tiles. The scene is synthetic, built here: no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeSog, writeSpz, writePly, DataTable, Column, MemoryFileSystem } from '@playcanvas/splat-transform';
import { detectFormat, detectFormatByName, LCC_LOCAL_UPRIGHT } from '../core/index.js';
import { parseLcc2, lcc2Tileset as buildTileset } from '../lcc-to-3dtiles/src/lcc2Manifest.js';
import { convert as convertLcc } from '../lcc-to-3dtiles/src/index.js';
import { mirrorRemote } from '../convert/fetch-source.js';
import { bundledSogFiles, zipDirectory } from '../sog-to-3dtiles/src/sogBundle.js';
import { lcc2Tileset, lcc2Tile } from './lcc2-live.js';

const quiet = (t) => { t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); };

/** `n` splats on the x axis (x = first + i), with one band of spherical harmonics (so that a SOG of them has shN planes). */
function splats(n, first = 0) {
  const f = (fn) => Float32Array.from({ length: n }, (_, i) => fn(i));
  return new DataTable([
    new Column('x', f((i) => first + i)), new Column('y', f(() => 2)), new Column('z', f(() => 3)),
    new Column('rot_0', f(() => 1)), new Column('rot_1', f(() => 0)), new Column('rot_2', f(() => 0)), new Column('rot_3', f(() => 0)),
    new Column('scale_0', f(() => -3)), new Column('scale_1', f(() => -3)), new Column('scale_2', f(() => -3)),
    new Column('opacity', f(() => 2)), new Column('f_dc_0', f((i) => i / 10)), new Column('f_dc_1', f(() => 0)), new Column('f_dc_2', f(() => 0)),
    ...Array.from({ length: 9 }, (_, k) => new Column(`f_rest_${k}`, f((i) => (i + k) / 20))),
  ]);
}

/** A bundled SOG of `splats(n, first)`. */
async function sogBundle(n, first = 0) {
  const out = new MemoryFileSystem();
  await writeSog({ dataTable: splats(n, first), filename: 'a.sog', bundle: true, iterations: 1, logging: 'silent' }, out);
  return Buffer.from(out.results.get('a.sog'));
}

/** The same splats as an SPZ (version 3, gzip) or a binary 3DGS PLY: the whitepaper's other two chunk types. */
async function splatFile(type, n, first = 0) {
  const out = new MemoryFileSystem();
  if (type === '.spz') await writeSpz({ dataTable: splats(n, first), filename: 'a.spz', version: 3 }, out);
  else await writePly({ plyData: { comments: [], elements: [{ name: 'vertex', dataTable: splats(n, first) }] }, filename: 'a.ply' }, out);
  return Buffer.from(out.results.get('a' + type));
}

/** A ZIP of `files` (name → bytes), DEFLATE entries unless `stored`. */
function zip(files, { stored = false } = {}) {
  const locals = [], dir = [];
  let offset = 0;
  for (const [name, bytes] of Object.entries(files)) {
    const data = stored ? Buffer.from(bytes) : zlib.deflateRawSync(bytes);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(stored ? 0 : 8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26); local.write(name, 30, 'latin1');
    const entry = Buffer.alloc(46 + name.length);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(stored ? 0 : 8, 10); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42); entry.write(name, 46, 'latin1');
    locals.push(local, data); dir.push(entry);
    offset += local.length + data.length;
  }
  const dirBytes = Buffer.concat(dir), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(dir.length, 8); end.writeUInt16LE(dir.length, 10); end.writeUInt32LE(dirBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dirBytes, end]);
}

const box = (min, max) => ({ min, max });
/** Two LODs over two chunks: the root (environment only), one coarse node of 4 splats, two fine children of 5 and 3 sharing a chunk. */
const manifest = () => ({
  version: '0.0.3', epsg: 0, offset: [0, 0, 0], totalSplats: 12, lodSplats: [8, 4], totalLevels: 2, splatType: '.sog',
  root: {
    id: '0', boundingBox: box([0, 0, 0], [8, 4, 6]), childNum: 1, data: { env: { name: 2 } },
    splatFiles: ['data/3dgs/0_0.sog', 'data/3dgs/0_0_0.sog', 'data/3dgs/environment.sog'],
    child: { 0: {
      id: '0_0', boundingBox: box([0, 0, 0], [8, 4, 6]), childNum: 2, data: { '3dgs': { name: 0, start: 0, count: 4 }, mesh: { name: 0, vertex: 3, face: 1 } },
      child: {
        0: { id: '0_0_0', boundingBox: box([0, 0, 0], [5, 4, 6]), childNum: 0, data: { '3dgs': { name: 1, start: 0, count: 5 } } },
        1: { id: '0_0_1', boundingBox: box([5, 0, 0], [8, 4, 6]), childNum: 0, data: { '3dgs': { name: 1, start: 5, count: 3 } } },
      },
    } },
  },
});

/** A host of `files` that answers `bytes=a-b` and `bytes=-n` ranges (unless `noRange`) and records what it was asked. */
async function host(t, files, { noRange = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const body = files[p];
    requests.push({ path: p, range: req.headers.range ?? null, search: new URL(req.url, 'http://x').search });
    if (body === undefined) { res.writeHead(404); return res.end(); }
    const m = !noRange && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (!m) return res.end(body);
    const b = m[1] === '' ? Math.max(0, body.length - Number(m[2])) : Number(m[1]);
    const e = m[1] === '' || m[2] === '' ? body.length - 1 : Math.min(Number(m[2]), body.length - 1);
    res.writeHead(206, { 'Content-Range': `bytes ${b}-${e}/${body.length}` });
    res.end(body.subarray(b, e + 1));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${server.address().port}`, requests };
}

/** A GLB's JSON chunk. */
const gltf = (glb) => { assert.equal(glb.toString('latin1', 0, 4), 'glTF'); assert.equal(glb.readUInt32LE(8), glb.length); return JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12))); };
const position = (glb) => { const j = gltf(glb); return j.accessors[j.meshes[0].primitives[0].attributes.POSITION]; };

test('lcc2: a *.lcc2 name or folder is detected, and *.lcc still is LCC', async (t) => {
  assert.equal(detectFormatByName('https://h/scene/03-19.lcc2?sig=1'), 'lcc2');
  assert.equal(detectFormatByName('https://h/scene/meta.lcc'), 'lcc');
  const dir = await mkdtemp(path.join(tmpdir(), 'lcc2-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'scene.lcc2'), '{}');
  assert.equal(await detectFormat(dir), 'lcc2');
  assert.equal(await detectFormat(path.join(dir, 'scene.lcc2')), 'lcc2');
});

test('lcc2: the manifest tree is the tile tree, one LOD per depth, the root without content', () => {
  const { tileset, runs } = buildTileset(parseLcc2(JSON.stringify(manifest())), (r) => `t/${r.file}_${r.start}_${r.count}`);
  const { root } = tileset;
  assert.equal(root.content, undefined, 'the environment chunk is not a tile');
  assert.deepEqual(root.transform, LCC_LOCAL_UPRIGHT, 'no EPSG: stood upright like LCC');
  // Z-up source box → tile frame: centre (cx, −cz, cy), half sizes (hx, hz, hy)
  assert.deepEqual(root.boundingVolume.box, [4, -3, 2, 4, 0, 0, 0, 3, 0, 0, 0, 2]);
  const [coarse] = root.children, fine = coarse.children;
  assert.equal(coarse.content.uri, 't/0_0_4');
  assert.deepEqual(fine.map((c) => c.content.uri), ['t/1_0_5', 't/1_5_3']);
  assert.deepEqual(fine[1].boundingVolume.box, [6.5, -3, 2, 1.5, 0, 0, 0, 3, 0, 0, 0, 2]);
  const diagonal = Math.hypot(8, 4, 6);
  assert.ok(Math.abs(coarse.geometricError - diagonal * 0.05) < 1e-12, 'coarsest LOD: 5 % of the scene diagonal');
  assert.equal(root.geometricError, coarse.geometricError * 2);
  assert.equal(fine[0].geometricError, coarse.geometricError / 2);
  assert.equal(tileset.geometricError, root.geometricError);
  assert.ok([root, coarse, ...fine].every((tile) => tile.refine === 'REPLACE'));
  assert.deepEqual(runs.map((r) => [r.depth, r.count]), [[1, 4], [2, 5], [2, 3]]);
  assert.deepEqual(tileset.extensions['3DTILES_content_gltf'].extensionsRequired, ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2']);
  assert.equal(buildTileset(parseLcc2(JSON.stringify(manifest())), () => 'x', { centroids: true }).tileset.extensions, undefined);
});

test('lcc2: a manifest with trailing commas, array children or the earlier field names is read', () => {
  const m = manifest();
  const old = { lod_level: 2, lod_3dgs_info: [4, 8], total_splats: 12, root: { ...m.root, splatFiles: undefined, files: m.root.splatFiles.map((f) => f.replace(/\//g, '\\')), child: [m.root.child[0]] } };
  const parsed = parseLcc2(JSON.stringify(old).replace(/\}$/, ',}').replace('"lod_level"', '"note": "a,} in a string", "lod_level"'));
  assert.equal(parsed.totalLevels, 2);
  assert.deepEqual(parsed.lodSplats, [8, 4]);
  assert.equal(parsed.files[0], 'data/3dgs/0_0.sog');
  assert.equal(parsed.meta.note, 'a,} in a string');
  assert.equal(buildTileset(parsed, () => 'x').runs.length, 3);
});

test('lcc2: what is not an LCC2 manifest, or has chunks this cannot read, is said so', () => {
  assert.throws(() => parseLcc2('PK\u0003\u0004'), /not JSON/);
  assert.throws(() => parseLcc2('{"root":{}}'), /no root\.splatFiles/);
  assert.throws(() => parseLcc2(JSON.stringify({ ...manifest(), splatType: '.splat' })), /\.splat.*not supported/);
  assert.deepEqual(['.sog', '.spz', '.ply'].map((t) => parseLcc2(JSON.stringify({ ...manifest(), splatType: t })).splatType), ['.sog', '.spz', '.ply']);
  const m = manifest(); m.root.child[0].data['3dgs'].name = 7;
  assert.throws(() => buildTileset(parseLcc2(JSON.stringify(m)), () => 'x'), /names chunk 7/);
});

test('bundled SOG: the kept files are the same read whole, by ranges, stored or deflated', async () => {
  const bundle = await sogBundle(8);
  const all = await bundledSogFiles(bundle, bundle.length, null, () => true);
  assert.ok(all['shN_centroids.webp'] && all['shN_labels.webp'], 'the fixture has SH planes');
  const kept = await bundledSogFiles(bundle, bundle.length);
  assert.deepEqual(Object.keys(kept).sort(), ['means_l.webp', 'means_u.webp', 'meta.json', 'quats.webp', 'scales.webp', 'sh0.webp']);
  assert.equal(JSON.parse(Buffer.from(kept['meta.json'])).shN, undefined, 'meta.json no longer names the planes left out');
  assert.ok(JSON.parse(Buffer.from(all['meta.json'])).shN);

  for (const stored of [true, false]) {
    const z = zip(all, { stored });                      // entries in the bundle's order: the kept planes, the SH planes, meta.json
    const { dirOffset } = zipDirectory(z, z.length);
    const shStart = z.indexOf('shN_centroids.webp') - 30, shEnd = z.indexOf('meta.json') - 30;
    assert.ok(shStart > 0 && shEnd > shStart && shEnd < dirOffset);
    // the tail holds: the whole file · the directory and meta.json · the directory alone · not even the directory
    for (const tailBytes of [z.length, z.length - shEnd, z.length - dirOffset, 30]) {
      const reads = [];
      const range = async (begin, length) => { reads.push([begin, length]); return z.subarray(begin, begin + length); };
      const got = await bundledSogFiles(z.subarray(z.length - tailBytes), z.length, range);
      assert.deepEqual(Object.keys(got).sort(), Object.keys(kept).sort());
      for (const name of Object.keys(kept)) assert.equal(Buffer.compare(Buffer.from(got[name]), Buffer.from(kept[name])), 0, `${name} (stored ${stored}, tail ${tailBytes})`);
      assert.equal(reads.length, { [z.length]: 0, [z.length - shEnd]: 1, [z.length - dirOffset]: 2 }[tailBytes] ?? 3, `reads with a tail of ${tailBytes}`);
      assert.ok(reads.every(([b, l]) => b + l <= shStart || b >= shEnd), 'no byte of the SH planes is read');
    }
  }
  await assert.rejects(bundledSogFiles(Buffer.from('not a zip at all, just some bytes'), 33), /no ZIP end-of-central-directory/);
});

test('lcc2: tiles are cut from one read of their chunk, the same on a host that ignores Range, and the offline converter writes them too', async (t) => {
  quiet(t);
  const files = { '/s/scene.lcc2': Buffer.from(JSON.stringify(manifest())), '/s/data/3dgs/0_0.sog': await sogBundle(4), '/s/data/3dgs/0_0_0.sog': await sogBundle(8, 10) };
  const [ranged, plain] = [await host(t, files), await host(t, files, { noRange: true })];
  const url = `${ranged.base}/s/scene.lcc2?sig=token`;

  const ts = await lcc2Tileset(url);
  assert.equal(ts.root.children[0].content.uri, `tile/0_0_4.glb?url=${encodeURIComponent(url)}`);
  assert.equal((await lcc2Tileset(url, { centroids: true })).extensions, undefined);

  const coarse = await lcc2Tile(url, '0_0_4');
  assert.equal(position(coarse).count, 4);
  assert.ok(gltf(coarse).extensionsUsed.includes('KHR_gaussian_splatting_compression_spz_2'));
  // The fine chunk's 8 splats are one unit apart on x, and a SOG stores them sorted along it: rows 0..4 and rows 5..7 are
  // two runs of neighbours, 4 and 2 units long, that do not overlap.
  const second = await lcc2Tile(url, '1_5_3');
  const [a, b] = [position(await lcc2Tile(url, '1_0_5')), position(second)];
  assert.deepEqual([a.count, b.count], [5, 3]);
  const near = (v, w) => Math.abs(v - w) < 0.05;
  assert.ok(near(a.max[0] - a.min[0], 4) && near(b.max[0] - b.min[0], 2), `x ${a.min[0]}..${a.max[0]} and ${b.min[0]}..${b.max[0]}`);
  assert.ok(a.max[0] < b.min[0] || b.max[0] < a.min[0], 'the two runs are different rows');
  const points = gltf(await lcc2Tile(url, '1_5_3', { centroids: true }));
  assert.equal(points.extensionsUsed, undefined, 'centroids: plain glTF POINTS');
  assert.equal(points.meshes[0].primitives[0].mode, 0);

  // The fine chunk is read once, however many tiles are cut from it (reading a larger bundle in part: the test above).
  const chunk = ranged.requests.filter((r) => r.path === '/s/data/3dgs/0_0_0.sog');
  assert.deepEqual(chunk.map((r) => r.search), chunk.map(() => '?sig=token'), 'the manifest URL\'s query goes with the chunk reads');
  assert.deepEqual(chunk.map((r) => r.range), ['bytes=-65536'], 'one read for its three tiles: a bundle this small is all in the tail');

  const plainUrl = `${plain.base}/s/scene.lcc2`;
  assert.equal(Buffer.compare(await lcc2Tile(plainUrl, '1_5_3'), second), 0);

  // What is not a run of the scene is no tile: an unknown chunk, the environment chunk, rows past the chunk's end.
  assert.equal(await lcc2Tile(url, '9_0_1'), null);
  assert.equal(await lcc2Tile(url, '2_0_1'), null);
  assert.equal(await lcc2Tile(url, '1_6_3'), null);

  // Offline: the same scene on disk → the same tiles, named by their run.
  const dir = await mkdtemp(path.join(tmpdir(), 'lcc2-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'in', 'data', '3dgs'), { recursive: true });
  for (const [p, bytes] of Object.entries(files)) await writeFile(path.join(dir, 'in', p.slice(3)), bytes);
  const r = await convertLcc(path.join(dir, 'in'), path.join(dir, 'out'));
  assert.deepEqual([r.format, r.tiles], ['lcc2', 3]);
  const offline = JSON.parse(await readFile(path.join(dir, 'out', 'tileset.json'), 'utf8'));
  assert.equal(offline.root.children[0].children[1].content.uri, 'tiles/1_5_3.glb');
  assert.equal(Buffer.compare(await readFile(path.join(dir, 'out', 'tiles', '1_5_3.glb')), second), 0);

  // A remote scene is mirrored for the converter: the manifest and its chunks, without the environment chunk (this host has none).
  const local = await mirrorRemote(`${plain.base}/s/scene.lcc2`, 'lcc2', path.join(dir, 'mirror'));
  assert.equal((await convertLcc(local, path.join(dir, 'out2'))).tiles, 3);
  assert.ok(!plain.requests.some((r) => r.path.endsWith('environment.sog')));
});

test('lcc2: .spz and .ply chunks give the tiles a .sog chunk does, live and offline', async (t) => {
  quiet(t);
  const sogFiles = { '/s/scene.lcc2': Buffer.from(JSON.stringify(manifest())), '/s/data/3dgs/0_0.sog': await sogBundle(4), '/s/data/3dgs/0_0_0.sog': await sogBundle(8, 10) };
  const sog = await host(t, sogFiles);
  const reference = { coarse: position(await lcc2Tile(`${sog.base}/s/scene.lcc2`, '0_0_4')) };
  const near = (a, b) => a.count === b.count && [0, 1, 2].every((k) => Math.abs(a.min[k] - b.min[k]) < 0.05 && Math.abs(a.max[k] - b.max[k]) < 0.05);
  const fines = {};

  for (const type of ['.spz', '.ply']) {
    const m = manifest();
    m.splatType = type;
    m.root.splatFiles = m.root.splatFiles.map((f) => f.replace(/\.sog$/, type));
    const files = { '/s/scene.lcc2': Buffer.from(JSON.stringify(m)), [`/s/data/3dgs/0_0${type}`]: await splatFile(type, 4), [`/s/data/3dgs/0_0_0${type}`]: await splatFile(type, 8, 10) };
    const { base, requests } = await host(t, files);
    const url = `${base}/s/scene.lcc2`;
    const ts = await lcc2Tileset(url);
    assert.equal(ts.root.children[0].content.uri, `tile/0_0_4.glb?url=${encodeURIComponent(url)}`, type);
    const coarse = await lcc2Tile(url, '0_0_4'), fine = await lcc2Tile(url, '1_5_3');
    assert.ok(gltf(coarse).extensionsUsed.includes('KHR_gaussian_splatting_compression_spz_2'), type);
    // The coarse tile is the whole chunk, so it holds the SOG's splats whatever their order (a SOG sorts its rows, these
    // keep theirs): the same box. The fine run is rows 5..7 of 8 splats one unit apart on x: 3 splats, 2 units long.
    assert.ok(near(position(coarse), reference.coarse), `${type} coarse tile ${JSON.stringify(position(coarse))} vs SOG ${JSON.stringify(reference.coarse)}`);
    const p = position(fine);
    assert.ok(p.count === 3 && Math.abs(p.max[0] - p.min[0] - 2) < 0.05 && Math.abs(p.max[2] - p.min[2]) < 0.05, `${type} fine tile ${JSON.stringify(p)}`);
    fines[type] = p;
    assert.equal(await lcc2Tile(url, '1_6_3'), null, `${type}: rows past the chunk's end are no tile`);
    // A chunk that cannot be read in part is read whole, once, for all of its tiles.
    assert.deepEqual(requests.filter((r) => r.path === `/s/data/3dgs/0_0_0${type}`).map((r) => r.range), [null], type);

    const dir = await mkdtemp(path.join(tmpdir(), 'lcc2-')); t.after(() => rm(dir, { recursive: true, force: true }));
    await mkdir(path.join(dir, 'in', 'data', '3dgs'), { recursive: true });
    for (const [p, bytes] of Object.entries(files)) await writeFile(path.join(dir, 'in', p.slice(3)), bytes);
    assert.deepEqual((await convertLcc(path.join(dir, 'in'), path.join(dir, 'out'))).tiles, 3, type);
    assert.equal(Buffer.compare(await readFile(path.join(dir, 'out', 'tiles', '1_5_3.glb')), fine), 0, `${type}: the offline tile is the live one`);
  }
  assert.ok(near(fines['.spz'], fines['.ply']), `the SPZ and the PLY of the same splats cut the same fine tile: ${JSON.stringify(fines)}`);
});
