// OSGB (OpenSceneGraph binary tiled meshes): the reader over every layout the versions bring, the textures, the tile GLB,
// the georeference of metadata.xml, and a dataset served through /stream from a host and from a folder. No network: the
// files are written by a minimal encoder (packages/osgb-to-3dtiles/test/osgb-fixture.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { NodeIO } from '@gltf-transform/core';
import { parseOsgb, readOsgbHeader, osgbUnits } from '../osgb-to-3dtiles/src/osgb-reader.js';
import { osgbTexture, decodeS3tc } from '../osgb-to-3dtiles/src/osgb-image.js';
import { encodeOsgb, quad } from '../osgb-to-3dtiles/test/osgb-fixture.js';
import { osgbUnitGlb } from './mesh-tile.js';
import { parseOsgbMetadata, osgbGeoref, osgbRootsFromListing, osgbGeometricError, splitSourceUrl, parseTileIndex } from './osgb-live.js';
import { handleStream } from './stream-live.js';
import { ecefToLlh, httpStatusOf, detectFormatByName, writeZip } from '../core/index.js';

const quiet = (t) => { t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); };
const JPEG = jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, 200), width: 8, height: 8 }, 90).data;
const textured = (g, name = 't.jpg') => ({ ...g, texture: { name, file: JPEG } });

/** One level of a tile: a PagedLOD with its own mesh and the name of the finer file, as ContextCapture writes it. */
const level = (finer, range = 40, extra = {}) => ({
  type: 'PagedLOD', center: [5, 5, 0], radius: 8, rangeMode: 1, ranges: [[0, range], [range, 1e30]], files: ['', finer],
  children: [{ type: 'Geode', drawables: [textured(quad(0, 0, 10))] }], ...extra,
});
/** The last level: PagedLODs that name no finer file. */
const last = (x0, y0, z) => ({ type: 'PagedLOD', center: [x0 + 2.5, y0 + 2.5, z], radius: 4, rangeMode: 1, ranges: [[0, 1e30]], files: [''], children: [{ type: 'Geode', drawables: [textured(quad(x0, y0, 5, z))] }] });
const leaf = { type: 'Group', children: [last(0, 0, 0), last(5, 5, 1)] };

// ── the reader ───────────────────────────────────────────────────────────────────────────────────

const LAYOUTS = [
  ['version 80 (OSG 3.0)', { version: 80 }],
  ['version 91 (OSG 3.2, ContextCapture)', { version: 91 }],
  ['version 97', { version: 97 }],
  ['version 91, zlib body', { version: 91, compress: true }],
  ['version 100, block sizes', { version: 100, brackets: true }],
  ['version 131, block sizes (arrays as objects)', { version: 131, brackets: true }],
  ['version 131, no block sizes', { version: 131 }],
  ['version 161, 64-bit block sizes, zlib', { version: 161, brackets: true, compress: true }],
];
for (const [name, opts] of LAYOUTS) {
  test(`reader: ${name}`, () => {
    const g = textured({ ...quad(0, 0, 10), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]) });
    const file = encodeOsgb({ type: 'Group', children: [level('finer.osgb', 40, { children: [{ type: 'Geode', drawables: [g] }] }), { type: 'Geode', drawables: [quad(20, 0, 2)] }] }, opts);
    const header = readOsgbHeader(file);
    assert.deepEqual([header.version, header.brackets, header.compressor], [opts.version, !!opts.brackets, opts.compress ? 'zlib' : '0']);
    const scene = parseOsgb(file);
    assert.deepEqual([scene.skipped, scene.misread], [[], []]);
    const [paged, loose] = osgbUnits(scene);
    assert.deepEqual([paged.center, paged.radius, paged.rangeMode, paged.range, paged.files], [[5, 5, 0], 8, 'pixels', 40, ['finer.osgb']]);
    const m = paged.meshes[0];
    assert.deepEqual([...m.positions], [...g.vertices]);
    assert.deepEqual([...m.uvs], [...g.uvs]);
    assert.deepEqual([...m.normals], [...g.normals]);
    assert.deepEqual([...m.indices], [...g.indices]);
    assert.equal(Buffer.compare(m.image.file, JPEG), 0);
    assert.equal(m.image.FileName, 't.jpg');
    // the mesh outside any PagedLOD is a unit of its own, bounded by its vertices
    assert.deepEqual([loose.files, loose.meshes.length, loose.min, loose.max], [[], 1, [20, 0, 0], [22, 2, 0]]);
  });
}

test('reader: a class it has no layout for is stepped over when the file has block sizes, and is an error without', () => {
  const scene = { type: 'Group', children: [{ type: 'Unknown', className: 'osgSim::Fancy', bytes: Buffer.alloc(37, 7) }, { type: 'Geode', drawables: [quad(0, 0, 1)] }] };
  const parsed = parseOsgb(encodeOsgb(scene, { version: 131, brackets: true }));
  assert.deepEqual(parsed.skipped, ['osgSim::Fancy']);
  assert.equal(osgbUnits(parsed)[0].meshes.length, 1);
  assert.throws(() => parseOsgb(encodeOsgb(scene, { version: 91 })), /osgSim::Fancy is not supported/);
});

test('reader: not an OSGB file, and a truncated one, are errors', () => {
  assert.throws(() => parseOsgb(Buffer.from('<html>not found</html>, long enough to hold a header')), /not an OSGB file/);
  const file = encodeOsgb(leaf);
  assert.throws(() => parseOsgb(file.subarray(0, file.length - 40)));
});

test('reader: strips, fans, quads and non-indexed runs become triangles', () => {
  const v = new Float32Array(6 * 3).map((_, i) => i);
  const tris = (d) => [...osgbUnits(parseOsgb(encodeOsgb({ type: 'Geode', drawables: [{ vertices: v, ...d }] })))[0].meshes[0].indices];
  assert.deepEqual(tris({ mode: 5, indices: new Uint32Array([0, 1, 2, 3, 4]) }), [0, 1, 2, 2, 1, 3, 2, 3, 4]);       // strip: winding kept
  assert.deepEqual(tris({ mode: 6, indices: new Uint32Array([0, 1, 2, 3]) }), [0, 1, 2, 0, 2, 3]);                    // fan
  assert.deepEqual(tris({ mode: 7, indices: new Uint32Array([0, 1, 2, 3]) }), [0, 1, 2, 0, 2, 3]);                    // quad
  assert.deepEqual(tris({ mode: 4, arrays: { first: 0, count: 6 } }), [0, 1, 2, 3, 4, 5]);                            // DrawArrays
  assert.deepEqual(tris({ mode: 4, indices: new Uint32Array([0, 1, 2, 3, 4, 99]) }), [0, 1, 2]);                      // an index past the vertices drops its triangle
});

test('reader: a MatrixTransform moves the meshes under it, and a distance-mode PagedLOD keeps its range', () => {
  const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 200, 300, 1];          // OSG row-major, translation in the last row
  const paged = { type: 'PagedLOD', center: [0, 0, 0], radius: 5, rangeMode: 0, ranges: [[250, 1e30], [0, 250]], files: ['', 'near.osgb'], children: [{ type: 'Geode', drawables: [quad(0, 0, 1)] }] };
  const [u] = osgbUnits(parseOsgb(encodeOsgb({ type: 'MatrixTransform', matrix: m, children: [paged] })));
  assert.deepEqual([...u.meshes[0].positions.subarray(0, 3)], [100, 200, 300]);
  assert.deepEqual([u.rangeMode, u.range, u.files], ['distance', 250, ['near.osgb']]);
});

// ── textures ─────────────────────────────────────────────────────────────────────────────────────

const decode = (t) => (t.mimeType === 'image/png' ? PNG.sync.read(Buffer.from(t.bytes)) : jpeg.decode(Buffer.from(t.bytes), { useTArray: true }));
const near = (a, b, tol = 12) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
// one S3TC colour block of a single colour (both endpoints equal, every pixel index 0)
const dxtBlock = (r, g, b) => { const c = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3), blk = Buffer.alloc(8); blk.writeUInt16LE(c, 0); blk.writeUInt16LE(c, 2); return blk; };

test('texture: an embedded JPEG file passes through untouched', () => {
  const t = osgbTexture({ file: JPEG });
  assert.equal(t.mimeType, 'image/jpeg');
  assert.equal(t.bytes, JPEG);
  assert.equal(t.transcoded, undefined);
  assert.equal(osgbTexture({ external: true, FileName: 'elsewhere.jpg' }), null);
});

test('texture: raw RGB pixels are re-encoded, the first row of the data at the bottom of the picture', () => {
  const pixels = Buffer.alloc(8 * 8 * 3);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) pixels.set(y < 4 ? [255, 0, 0] : [0, 0, 255], (y * 8 + x) * 3);   // rows 0-3 red: the bottom half
  const t = osgbTexture({ width: 8, height: 8, depth: 1, pixelFormat: 0x1907, dataType: 0x1401, packing: 1, pixels });
  assert.deepEqual([t.mimeType, t.transcoded], ['image/jpeg', true]);
  const img = decode(t), px = (x, y) => [...img.data.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 3)];
  assert.ok(near(px(4, 0), [0, 0, 255], 40), `top ${px(4, 0)}`);
  assert.ok(near(px(4, 7), [255, 0, 0], 40), `bottom ${px(4, 7)}`);
});

test('texture: S3TC blocks decode (DXT1 raw and in a DDS file, DXT5 with its alpha)', () => {
  const raw = osgbTexture({ width: 4, height: 4, depth: 1, pixelFormat: 0x83F0, dataType: 0x1401, pixels: dxtBlock(255, 128, 0) });
  assert.ok(near([...decode(raw).data.subarray(0, 3)], [255, 128, 0], 16));

  const dds = Buffer.alloc(128 + 16);                        // 8 × 4: a red block then a green one
  dds.write('DDS ', 'latin1'); dds.writeUInt32LE(124, 4); dds.writeUInt32LE(4, 12); dds.writeUInt32LE(8, 16); dds.writeUInt32LE(4, 80); dds.write('DXT1', 84, 'latin1');
  dxtBlock(255, 0, 0).copy(dds, 128); dxtBlock(0, 255, 0).copy(dds, 136);
  const img = decode(osgbTexture({ file: dds }));
  assert.deepEqual([img.width, img.height], [8, 4]);
  assert.ok(near([...img.data.subarray(0, 3)], [255, 0, 0], 60) && near([...img.data.subarray(7 * 4, 7 * 4 + 3)], [0, 255, 0], 60), `${[...img.data.subarray(0, 32)]}`);

  const dxt5 = Buffer.concat([Buffer.from([255, 0, 0, 0, 0, 0, 0, 0]), dxtBlock(10, 20, 30)]);
  dxt5.writeUIntLE(0b001_000, 2, 3);                         // pixel 0 → alpha 255 (index 0), pixel 1 → alpha 0 (index 1)
  const rgba = decodeS3tc(dxt5, 4, 4, 5);
  assert.deepEqual([rgba[3], rgba[7]], [255, 0]);
  assert.equal(osgbTexture({ width: 4, height: 4, depth: 1, pixelFormat: 0x83F3, dataType: 0x1401, pixels: dxt5 }).mimeType, 'image/png');
});

// ── the tile ─────────────────────────────────────────────────────────────────────────────────────

test('tile: a unit becomes a GLB, Y-up, UVs flipped, texture embedded, grey kept for an untextured mesh', async () => {
  const grey = { ...quad(0, 0, 1), uvs: undefined, diffuse: [0.5, 0.5, 0.5, 1] };
  const file = encodeOsgb({ type: 'Geode', drawables: [textured({ ...quad(1, 2, 10, 3) }), grey] }, { version: 131, brackets: true });
  const glb = await osgbUnitGlb(file, 0);
  assert.equal(Buffer.from(glb.buffer, glb.byteOffset, 4).toString('latin1'), 'glTF');
  const doc = await new NodeIO().readBinary(glb);
  const [a, b] = doc.getRoot().listMeshes()[0].listPrimitives();
  assert.deepEqual([...a.getAttribute('POSITION').getArray().subarray(0, 6)], [1, 3, -2, 11, 3, -2]);           // (x, y, z) → (x, z, −y)
  assert.deepEqual([...a.getAttribute('TEXCOORD_0').getArray()], [0, 1, 1, 1, 1, 0, 0, 0]);                      // v → 1 − v
  assert.deepEqual([...a.getIndices().getArray()], [0, 1, 2, 0, 2, 3]);
  const tex = a.getMaterial().getBaseColorTexture();
  assert.deepEqual([tex.getMimeType(), Buffer.compare(Buffer.from(tex.getImage()), JPEG)], ['image/jpeg', 0]);
  assert.equal(a.getMaterial().getMetallicFactor(), 0);
  assert.equal(b.getAttribute('TEXCOORD_0'), null);
  assert.ok(near(b.getMaterial().getBaseColorFactor().map((v) => v * 1000), [214, 214, 214, 1000], 1));          // sRGB 0.5 → linear 0.214
  assert.equal(await osgbUnitGlb(file, 5), null);
});

// ── metadata.xml, roots, geometric error ─────────────────────────────────────────────────────────

const metadata = (srs, origin = '0,0,0') => `<?xml version="1.0" encoding="utf-8"?>\n<ModelMetadata version="1">\n\t<!--Spatial Reference System-->\n\t<SRS>${srs}</SRS>\n\t<SRSOrigin>${origin}</SRSOrigin>\n</ModelMetadata>`;
const place = async (xml) => { const m = await osgbGeoref(parseOsgbMetadata(xml)); return m && ecefToLlh(m[12], m[13], m[14]); };

test('metadata.xml: ENU, projected EPSG and geographic origins land where they say', async (t) => {
  quiet(t);
  assert.deepEqual(parseOsgbMetadata(metadata('ENU:34.2196,108.9594', '1, 2 ,3')), { srs: 'ENU:34.2196,108.9594', origin: [1, 2, 3] });
  assert.ok(near(await place(metadata('ENU:34.2196,108.9594')), [108.9594, 34.2196, 0], 1e-6));                  // ContextCapture: ENU:<lat>,<lon>
  const enu = await osgbGeoref(parseOsgbMetadata(metadata('ENU:0,0', '10,20,30')));                               // the origin is in metres in that frame
  assert.ok(near([enu[12], enu[13], enu[14]], [6378137 + 30, 10, 20], 1e-6));
  assert.ok(near(await place(metadata('EPSG:4547', '595251.0978,2865092.1622,234.955')), [114.951, 25.8915, 234.955], 1e-3));   // CGCS2000 / 3° GK CM 114E
  const utm = await place(metadata('EPSG:32631', '500000,5400000,0'));                                            // UTM 31N, on its central meridian
  assert.ok(Math.abs(utm[0] - 3) < 1e-9 && utm[1] > 48.7 && utm[1] < 48.8, `${utm}`);
  assert.ok(near(await place(metadata('EPSG:4326', '120.0717,30.4936,22.9')), [120.0717, 30.4936, 22.9], 1e-6)); // DJI Terra: lon, lat, height
  assert.equal(await osgbGeoref(parseOsgbMetadata('<ModelMetadata></ModelMetadata>')), null);
  assert.equal(detectFormatByName('metadata.xml'), 'osgb');
  assert.equal(detectFormatByName('https://pdmap.pland.gov.hk/PLANDWEB/public/3d_photo_realistic_models/OSGB/Tile_+005_+006_OSGB.zip'), 'osgb');
  assert.equal(detectFormatByName('https://pdmap.pland.gov.hk/PLANDWEB/public/3d_photo_realistic_models/Metadata/GridIdx_OSGB.csv'), 'osgb');
  assert.equal(detectFormatByName('Tile_+000_+000.osgb'), 'osgb');
});

test('roots: the top tiles of each export layout, from a listing of its files', () => {
  const cc = ['Data/Tile_+000_+000/Tile_+000_+000.osgb', 'Data/Tile_+000_+000/Tile_+000_+000_L16_0.osgb', 'Data/Tile_+001_+000/Tile_+001_+000.osgb', 'Data/Tile_+001_+000/Tile_+001_+000_L17_00.osgb'];
  assert.deepEqual(osgbRootsFromListing(cc), ['Data/Tile_+000_+000/Tile_+000_+000.osgb', 'Data/Tile_+001_+000/Tile_+001_+000.osgb']);
  // DJI Terra: an index at the top that only repeats the block below it
  assert.deepEqual(osgbRootsFromListing(['Block.osgb', 'Block/Block.osgb', 'Block/Block_L15_1.osgb', 'Block/Block_L16_3.osgb']), ['Block/Block.osgb']);
  assert.deepEqual(osgbRootsFromListing(['Data/Block.osgb', 'Data/Block_L15_1.osgb']), ['Data/Block.osgb']);
  assert.deepEqual(osgbRootsFromListing(['Data/Model/Model.osgb', 'Data/Model/Model_with_transform.osgb', 'Data/Model/tile_0_0_0_tex_children.osgb']), ['Data/Model/Model.osgb']);
  assert.deepEqual(osgbRootsFromListing(['BlockX/BlockX_L20_73.osgb', 'BlockX/BlockX_L19_37.osgb']), ['BlockX/BlockX_L19_37.osgb']);   // a copy without its root
  assert.deepEqual(osgbRootsFromListing(['main.osgb', 'readme.txt']), ['main.osgb']);
});

test('geometric error: 2·radius·16/range for a pixel range, 16·range/K for a distance, 0 for a leaf', () => {
  assert.equal(osgbGeometricError({ files: ['a'], rangeMode: 'pixels', range: 40, radius: 8 }), 6.4);
  assert.equal(osgbGeometricError({ files: ['a'], rangeMode: 'pixels', range: 0, radius: 8 }), 256);              // a range of 0 px: always refine
  assert.ok(Math.abs(osgbGeometricError({ files: ['a'], rangeMode: 'distance', range: 935.3, radius: 8 }) - 16) < 0.01);
  assert.equal(osgbGeometricError({ files: [], rangeMode: null, range: null, radius: 8 }), 0);
});

// ── a dataset through /stream ────────────────────────────────────────────────────────────────────

// Two top tiles on ContextCapture's grid. Tile 0 has three levels, the last a file of two bare meshes; tile 1 names a
// finer file the dataset does not have.
const T0 = 'Data/Tile_+000_+000/Tile_+000_+000', T1 = 'Data/Tile_+001_+000/Tile_+001_+000';
const DATASET = {
  'metadata.xml': Buffer.from(metadata('ENU:48.8584,2.2945')),
  [`${T0}.osgb`]: encodeOsgb(level('Tile_+000_+000_L16_0.osgb', 20)),
  [`${T0}_L16_0.osgb`]: encodeOsgb(level('Tile_+000_+000_L17_00.osgb', 40)),
  [`${T0}_L17_00.osgb`]: encodeOsgb(leaf),
  [`${T1}.osgb`]: encodeOsgb(level('Tile_+001_+000_L16_0.osgb', 20, { center: [25, 5, 0] }), { version: 131, brackets: true }),
};

async function serve(t, files) {
  const hits = {};
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname).slice(1);
    hits[p] = (hits[p] ?? 0) + 1;
    if (!files[p]) { res.writeHead(404); return res.end(); }
    res.end(files[p]);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${server.address().port}`, hits };
}
async function streamServer(t) {
  const server = http.createServer(async (req, res) => {
    try { if (!await handleStream(req, res, new URL(req.url, 'http://x'))) { res.writeHead(404); res.end(); } }
    catch (e) { res.writeHead(httpStatusOf(e)); res.end(String(e.message)); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const get = async (url) => { const r = await fetch(url); return { status: r.status, body: Buffer.from(await r.arrayBuffer()) }; };
const json = async (url) => { const r = await get(url); assert.equal(r.status, 200, `${url} → ${r.status} ${r.body.toString().slice(0, 200)}`); return JSON.parse(r.body); };

/** What a client does: the root, then every fragment and tile under it. → the checks every source shares. */
async function walk(s, src) {
  const ts = await json(`${s}/stream/tileset.json?format=osgb&url=${encodeURIComponent(src)}`);
  assert.equal(ts.asset.version, '1.1');
  const root = ts.root;
  assert.equal(root.refine, 'REPLACE');
  assert.equal(root.children.length, 2, 'two top tiles');
  const [lon, lat] = ecefToLlh(root.transform[12], root.transform[13], root.transform[14]);
  assert.ok(near([lon, lat], [2.2945, 48.8584], 1e-6), 'the root sits at the ENU origin of metadata.xml');

  const [t0, t1] = [...root.children].sort((a, b) => a.boundingVolume.sphere[0] - b.boundingVolume.sphere[0]);
  assert.deepEqual([t0.boundingVolume.sphere, t0.geometricError], [[5, 5, 0, 8], 2 * 8 * 16 / 20]);
  assert.ok(root.geometricError >= t0.geometricError);

  // tile 0, level 0: its own mesh, and the finer file as an external tileset with the same sphere and error
  const glb0 = await get(s + t0.content.uri);
  assert.deepEqual([glb0.status, glb0.body.toString('latin1', 0, 4)], [200, 'glTF']);
  const ref = t0.children[0];
  assert.deepEqual([ref.boundingVolume, ref.geometricError], [t0.boundingVolume, t0.geometricError]);
  assert.match(ref.content.uri, /^\/stream\/osgb\/node\/.+\.json\?/);

  const l16 = (await json(s + ref.content.uri)).root;                     // one PagedLOD in the file: it is the fragment's root
  assert.deepEqual([l16.boundingVolume.sphere, l16.geometricError], [[5, 5, 0, 8], 2 * 8 * 16 / 40]);
  assert.ok(l16.geometricError < t0.geometricError, 'the error decreases down the tree');

  const l17 = (await json(s + l16.children[0].content.uri)).root;         // two units in the file: a root with the parent's sphere and error over them
  assert.deepEqual([l17.boundingVolume, l17.geometricError, l17.content], [l16.boundingVolume, l16.geometricError, undefined]);
  assert.deepEqual(l17.children.map((c) => [c.geometricError, c.children, c.boundingVolume.sphere]), [[0, undefined, [2.5, 2.5, 0, 4]], [0, undefined, [7.5, 7.5, 1, 4]]]);
  for (const c of l17.children) {
    const doc = await new NodeIO().readBinary(new Uint8Array((await get(s + c.content.uri)).body));
    const prims = doc.getRoot().listMeshes()[0].listPrimitives();
    assert.deepEqual(prims.map((p) => [p.getAttribute('POSITION').getCount(), p.getIndices().getCount()]), [[4, 6]]);
    assert.equal(doc.getRoot().listTextures()[0].getMimeType(), 'image/jpeg');
    // the mesh is inside its tile's sphere (glTF (x, y, z) is the tileset's (x, −z, y))
    const p = prims[0].getAttribute('POSITION').getArray(), [cx, cy, cz, r] = c.boundingVolume.sphere;
    for (let i = 0; i < p.length; i += 3) assert.ok(Math.hypot(p[i] - cx, -p[i + 2] - cy, p[i + 1] - cz) <= r);
  }

  // tile 1 names a finer file that is not there: the fragment answers with the tile's own mesh, as a leaf
  const missing = (await json(s + t1.children[0].content.uri)).root;
  assert.deepEqual([missing.geometricError, missing.boundingVolume, missing.content.uri], [0, t1.boundingVolume, t1.content.uri]);
  assert.equal((await get(s + missing.content.uri)).status, 200);
  return ts;
}

test('stream: a dataset on a host that lists nothing is found by its tile names and served as lazy fragments', async (t) => {
  quiet(t);
  const h = await serve(t, DATASET), s = await streamServer(t);
  const viaMetadata = await walk(s, `${h.base}/metadata.xml`);
  assert.equal(h.hits[`${T0}.osgb`], 1, 'a file is read once for its fragment and its tiles');
  const viaFolder = await json(`${s}/stream/tileset.json?format=osgb&url=${encodeURIComponent(`${h.base}/`)}`);
  assert.deepEqual([viaFolder.root.boundingVolume, viaFolder.root.transform, viaFolder.root.children.length], [viaMetadata.root.boundingVolume, viaMetadata.root.transform, 2], 'the folder URL is the same dataset');
  assert.equal((await get(`${s}/stream/tileset.json?url=${encodeURIComponent(`${h.base}/metadata.xml`)}`)).status, 200, 'format detected from metadata.xml');
});

test('stream: the same dataset from a local folder', async (t) => {
  quiet(t);
  const dir = await mkdtemp(path.join(tmpdir(), 'osgb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [rel, bytes] of Object.entries(DATASET)) { await mkdir(path.dirname(path.join(dir, rel)), { recursive: true }); await writeFile(path.join(dir, rel), bytes); }
  const s = await streamServer(t);
  await walk(s, path.join(dir, 'metadata.xml'));
  await walk(s, dir);
});

test('stream: one root .osgb by its URL, with the metadata.xml two folders up', async (t) => {
  quiet(t);
  const h = await serve(t, DATASET), s = await streamServer(t);
  const ts = await json(`${s}/stream/tileset.json?url=${encodeURIComponent(`${h.base}/${T0}.osgb`)}`);          // format detected from .osgb
  assert.deepEqual(ts.root.boundingVolume.sphere, [5, 5, 0, 8]);
  assert.ok(ts.root.transform && ts.root.content && ts.root.children.length === 1);
});

test('stream: a file outside the dataset is not read, and a dataset with no root is a 404', async (t) => {
  quiet(t);
  const h = await serve(t, DATASET), s = await streamServer(t);
  const q = `url=${encodeURIComponent(`${h.base}/Data/Tile_+000_+000/Tile_+000_+000.osgb`)}`;
  assert.equal((await get(`${s}/stream/osgb/node/${encodeURIComponent('../../metadata.xml').replace(/%2F/g, '~')}.json?${q}`)).status, 404);
  assert.equal((await get(`${s}/stream/tile/${encodeURIComponent('../Tile_+001_+000/Tile_+001_+000.osgb').replace(/%2F/g, '~')}__0.glb?format=osgb&${q}`)).status, 404);
  const empty = await serve(t, { 'metadata.xml': DATASET['metadata.xml'] });
  assert.equal((await get(`${s}/stream/tileset.json?format=osgb&url=${encodeURIComponent(`${empty.base}/metadata.xml`)}`)).status, 404);
});

// ── a dataset in a zip, placement hints, a collection of zipped tiles ────────────────────────────

/** A host that honours Range, as a zip needs (the tail, the central directory, one member at a time). */
async function serveRanges(t, files) {
  const hits = {};
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname).slice(1);
    hits[p] = (hits[p] ?? 0) + 1;
    const body = files[p];
    if (!body) { res.writeHead(404); return res.end(); }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (!range) { res.writeHead(200, { 'Content-Length': body.length }); return res.end(body); }
    const a = range[1] === '' ? Math.max(0, body.length - Number(range[2])) : Number(range[1]);
    const b = range[2] === '' || range[1] === '' ? body.length - 1 : Math.min(Number(range[2]), body.length - 1);
    res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${body.length}`, 'Content-Length': b - a + 1 });
    res.end(body.subarray(a, b + 1));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${server.address().port}`, hits };
}

// The same dataset zipped as Hong Kong's Planning Department ships a tile: a top folder, the files below it
const ZIPPED = Object.fromEntries([['tile/', Buffer.alloc(0)], ...Object.entries(DATASET).map(([k, v]) => [`tile/${k}`, v])]);

test('stream: a dataset in a zip is read member by member, its metadata.xml found in the archive', async (t) => {
  quiet(t);
  const zip = writeZip(ZIPPED);
  const h = await serveRanges(t, { 'tile.zip': zip }), s = await streamServer(t);
  const ts = await walk(s, `${h.base}/tile.zip`);
  assert.ok(ts.root.children.every((c) => /tile~Data~Tile_/.test(c.content.uri)), 'tile keys are paths inside the archive, a slash written as ~ (path-key.js)');
  assert.ok(h.hits['tile.zip'] >= 3 && h.hits['tile.zip'] <= 12, `${h.hits['tile.zip']} range reads: the tail, then members`);
  assert.deepEqual(osgbRootsFromListing(Object.keys(ZIPPED)), [`tile/${T0}.osgb`, `tile/${T1}.osgb`]);
});

test('stream: placement hints in the dataset URL stand in for a missing metadata.xml, and yield to one', async (t) => {
  quiet(t);
  const bare = Object.fromEntries(Object.entries(ZIPPED).filter(([k]) => !k.endsWith('metadata.xml')));
  const h = await serveRanges(t, { 'bare.zip': writeZip(bare), 'tile.zip': writeZip(ZIPPED) }), s = await streamServer(t);
  const at = async (src) => { const ts = await json(`${s}/stream/tileset.json?format=osgb&url=${encodeURIComponent(src)}`); return ts.root.transform ? ecefToLlh(ts.root.transform[12], ts.root.transform[13], ts.root.transform[14]) : null; };
  assert.equal(await at(`${h.base}/bare.zip`), null, 'no metadata.xml, no hint: served local');
  assert.ok(near(await at(`${h.base}/bare.zip?srs=ENU:22.3,114.17&origin=0,0,5`), [114.17, 22.3, 5], 1e-6), 'the hint places it');
  const hk = await at(`${h.base}/bare.zip?srs=EPSG:2326&origin=835786.0,820848.9,0`);
  assert.ok(near(hk, [114.17, 22.32, 0], 0.02), `a projected hint through its CRS: ${hk}`);
  assert.ok(near(await at(`${h.base}/tile.zip?srs=ENU:22.3,114.17`), [2.2945, 48.8584, 0], 1e-6), 'the archive has a metadata.xml: it wins');
  assert.deepEqual(splitSourceUrl('C:\\data\\tile.zip'), { http: false, clean: 'C:/data/tile.zip', hints: { srs: null, origin: null }, query: '' });
  assert.deepEqual(splitSourceUrl('https://h/t.zip?origin=1,2,3&srs=EPSG:2326&x=1#f').hints, { srs: 'EPSG:2326', origin: '1,2,3' });
});

test('stream: a tile index is a collection, each zip an external tileset placed by its extent, the hints passed on', async (t) => {
  quiet(t);
  const h = await serveRanges(t, { 'a.zip': writeZip(ZIPPED), 'b.zip': writeZip(ZIPPED) }), s = await streamServer(t);
  // the Planning Department's index: UTF-16, tab-separated, an extent in HK1980 and in WGS84, a zip URL per row
  const rows = [
    ['OBJECTID', 'GRID_NAME', 'LOC_EN', 'MIN_X', 'MIN_Y', 'MAX_X', 'MAX_Y', 'MIN_LNG', 'MIN_LAT', 'MAX_LNG', 'MAX_LAT', 'FILE_URL', 'MODI_DATE'],
    ['1', 'Tile_+005_+006', '"Mong Kok, Yau Ma Tei"', '834872', '818398', '835122', '818648', '114.163302', '22.304511', '114.165772', '22.306809', `${h.base}/a.zip`, '28/01/2019'],
    ['2', 'Tile_+006_+006', '"Mong Kok, Yau Ma Tei"', '835122', '818402', '835372', '818652', '114.165726', '22.304553', '114.168196', '22.306852', `${h.base}/b.zip`, '28/01/2019'],
    ['3', 'no file', '', '0', '0', '0', '0', '0', '0', '0', '0', '', ''],
  ];
  const csv = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(rows.map((r) => r.join('\t')).join('\r\n') + '\r\n', 'utf16le')]);
  assert.deepEqual(parseTileIndex(csv).map((r) => [r.name, r.url, r.lon, r.lat]), [['Tile_+005_+006', `${h.base}/a.zip`, [114.163302, 114.165772], [22.304511, 22.306809]], ['Tile_+006_+006', `${h.base}/b.zip`, [114.165726, 114.168196], [22.304553, 22.306852]]]);
  assert.deepEqual(parseTileIndex(Buffer.from('NAME,MIN_X,MIN_Y,MAX_X,MAX_Y,OSGB_URL\n"t, quoted",1,2,3,4,http://h/t.zip\n')).map((r) => [r.name, r.x, r.y, r.lon]), [['t, quoted', [1, 3], [2, 4], undefined]]);
  assert.throws(() => parseTileIndex(Buffer.from('a,b\n1,2\n')), /needs a \*_URL column/);

  const idx = await serveRanges(t, { 'GridIdx_OSGB.csv': csv });
  const ts = await json(`${s}/stream/tileset.json?format=osgb&url=${encodeURIComponent(`${idx.base}/GridIdx_OSGB.csv?srs=EPSG:2326&origin=835786.0,820848.9,0`)}`);
  assert.deepEqual([ts.root.children.length, ts.root.content, ts.root.refine], [2, undefined, 'REPLACE']);
  const [mid] = ecefToLlh(ts.root.transform[12], ts.root.transform[13], ts.root.transform[14]);
  assert.ok(Math.abs(mid - 114.1657) < 1e-3, 'the root frame sits at the middle of the collection');
  const [a, b] = [...ts.root.children].sort((p, q) => p.boundingVolume.sphere[0] - q.boundingVolume.sphere[0]);
  assert.ok(a.boundingVolume.sphere[0] < 0 && b.boundingVolume.sphere[0] > 0 && Math.abs(b.boundingVolume.sphere[0] - a.boundingVolume.sphere[0] - 250) < 5, 'the tiles sit 250 m apart');
  assert.ok(Math.abs(a.geometricError - 127) < 3, `a tile is opened at half its width: ${a.geometricError}`);
  assert.ok(a.boundingVolume.sphere[3] > 300 && a.boundingVolume.sphere[3] < 400, 'the sphere holds the tile and the height a city may have');
  assert.match(a.content.uri, /^\/stream\/tileset\.json\?format=osgb&url=/);
  const child = new URL(a.content.uri, 'http://x').searchParams.get('url');
  assert.equal(child, `${h.base}/a.zip?srs=EPSG%3A2326&origin=835786.0%2C820848.9%2C0`, 'the hints go to each tile');
  const sub = await json(s + a.content.uri);
  assert.ok(near(ecefToLlh(sub.root.transform[12], sub.root.transform[13], sub.root.transform[14]), [2.2945, 48.8584, 0], 1e-6), 'the tile has its own metadata.xml, which wins over the hint');
  assert.equal(sub.root.children.length, 2);
});
