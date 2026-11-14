// Nexus (.nxs / .nxz, CNR-ISTI multiresolution meshes, 3DHOP): the reader over a synthetic file written by
// packages/nexus-to-3dtiles/test/nexus-fixture.js and over the head of a real .nxz (the gargoyle's header, tables and
// node 0, MIT, 37 KB), the DAG → tree mappings, a node's GLB, the live /stream route on a host that answers Range and
// on a local file, and the offline converter. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { NodeIO } from '@gltf-transform/core';
import {
  parseNexus, parseNexusHeader, parseNexusIndex, indexBytes, decodeRawNode, decodeNode, nodeChildren, nodeTextures, nodeRange,
  nexusStats, textureImage, HEADER_BYTES, NEXUS_PADDING,
} from '../nexus-to-3dtiles/src/nexus-reader.js';
import { nexusTileset as buildTileset, unionSphere, tileSphere } from '../nexus-to-3dtiles/src/nexus-tileset.js';
import { nexusNodeGlb } from '../nexus-to-3dtiles/src/nexus-glb.js';
import { convert as convertNexus } from '../nexus-to-3dtiles/src/index.js';
import { encodeNxs, quad, merge } from '../nexus-to-3dtiles/test/nexus-fixture.js';
import { nexusTileset, nexusTile } from './nexus-live.js';
import { handleStream } from './stream-live.js';
import { detectFormat, detectFormatByName, httpStatusOf } from '../core/index.js';

const quiet = (t) => { t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); };
const GARGO_HEAD = new URL('../nexus-to-3dtiles/test/fixtures/gargo-head.nxz', import.meta.url);
const jpegOf = (v) => jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, v), width: 8, height: 8 }, 90).data;
const JPEGS = [jpegOf(200), jpegOf(50)];

/**
 * A three-level DAG of four nodes: the root (one quad, two triangles, each refined by one of nodes 1 and 2), two
 * nodes of level 1, and node 3, a leaf of level 2 under BOTH of them (what a Nexus file does all the time), whose
 * two patches name two textures. Spheres nest, errors halve.
 */
const DAG = () => ({
  sphere: [5, 5, 0, 8],
  nodes: [
    { ...quad(0, 0, 10), error: 4, sphere: [5, 5, 0, 8], patches: [{ node: 1, end: 1 }, { node: 2, end: 2 }] },
    { ...merge([quad(0, 0, 5), quad(5, 0, 5)]), error: 2, sphere: [5, 5, 0, 8], tightRadius: 4, patches: [{ node: 3, end: 2 }, { node: 'sink', end: 4 }] },
    { ...merge([quad(0, 5, 5), quad(5, 5, 5)]), error: 2, sphere: [5, 5, 0, 8], tightRadius: 4, patches: [{ node: 3, end: 2 }, { node: 'sink', end: 4 }] },
    { ...merge([quad(0, 0, 2.5), quad(5, 5, 2.5)]), error: 1, sphere: [5, 5, 0, 5], patches: [{ node: 'sink', end: 2, texture: 0 }, { node: 'sink', end: 4, texture: 1 }] },
  ],
  textures: JPEGS,
});
const FILE = encodeNxs(DAG());

// ── the reader ───────────────────────────────────────────────────────────────────────────────────

test('reader: header, tables and node data of a synthetic .nxs', () => {
  const h = parseNexusHeader(FILE);
  assert.deepEqual([h.version, h.nvert, h.nface, h.nodesCount, h.patchesCount, h.texturesCount, h.sphere, h.compressed, h.codec, h.deepzoom],
    [2, 4 + 8 + 8 + 8, 2 + 4 + 4 + 4, 5, 8, 3, [5, 5, 0, 8], false, null, false]);
  assert.deepEqual(Object.keys(h.signature.vertex), ['coord', 'normal', 'color', 'uv']);
  assert.deepEqual([h.vertexBytes, h.faceBytes], [12 + 6 + 4 + 8, 6]);

  const idx = parseNexus(FILE);
  assert.equal(idx.nodes.length, 5, 'the sink is in the table');
  assert.deepEqual(idx.nodes.map((n) => n.nvert), [4, 8, 8, 8, 0]);
  assert.deepEqual(idx.nodes.map((n) => n.nface), [2, 4, 4, 4, 0]);
  assert.deepEqual(idx.nodes.map((n) => n.error), [4, 2, 2, 1, 0]);
  assert.deepEqual([idx.nodes[1].sphere, idx.nodes[1].tightRadius], [[5, 5, 0, 8], 4]);
  assert.deepEqual(idx.nodes.map((n) => [n.firstPatch, n.lastPatch]), [[0, 2], [2, 4], [4, 6], [6, 8], [8, 8]]);
  for (const n of idx.nodes) assert.equal(n.offset % NEXUS_PADDING, 0);
  for (let i = 0; i < 4; i++) assert.equal(idx.nodes[i].end, idx.nodes[i + 1].offset, 'a node ends where the next begins');
  assert.deepEqual(idx.patches.slice(6), [{ node: 4, end: 2, texture: 0 }, { node: 4, end: 4, texture: 1 }]);
  assert.deepEqual(idx.patches[0], { node: 1, end: 1, texture: -1 });
  assert.equal(idx.textures.length, 2, 'the sink texture entry is dropped');
  assert.equal(idx.textures[0].end, idx.textures[1].offset);
  assert.equal(idx.nroots, 1);
  assert.deepEqual([nodeChildren(idx, 0), nodeChildren(idx, 1), nodeChildren(idx, 3)], [[1, 2], [3], []]);
  assert.deepEqual([nodeTextures(idx, 0), nodeTextures(idx, 3)], [[], [0, 1]]);

  // the index alone, from the bytes after the header, is the same as the whole file's
  const alone = parseNexusIndex(h, FILE.subarray(HEADER_BYTES, HEADER_BYTES + indexBytes(h)));
  assert.deepEqual(alone, { nodes: idx.nodes, patches: idx.patches, textures: idx.textures, nroots: idx.nroots });

  // node data round-trips
  const src = DAG().nodes[3], r = nodeRange(idx, 3);
  const g = decodeRawNode(h, idx.nodes[3], FILE.subarray(r.begin, r.end));
  assert.deepEqual([...g.positions], [...src.positions]);
  assert.deepEqual([...g.normals], [...src.normals]);
  assert.deepEqual([...g.colors], [...src.colors]);
  assert.deepEqual([...g.uvs], [...src.uvs]);
  assert.deepEqual([...g.indices], [...src.indices]);
  // a texture as stored: the JPEG cut at its end-of-image marker
  const tx = idx.textures[1], img = textureImage(FILE.subarray(tx.offset, tx.end));
  assert.deepEqual([img.mimeType, Buffer.compare(img.bytes, JPEGS[1])], ['image/jpeg', 0]);
});

test('reader: the statistics of the DAG', () => {
  const s = nexusStats(parseNexus(FILE));
  assert.deepEqual(
    [s.nodes, s.patches, s.textures, s.roots, s.levels, s.leaves, s.shared, s.maxParents, s.paths, s.vertices, s.triangles, s.leafTriangles],
    [4, 8, 2, 1, 3, 1, 1, 2, 5, 28, 14, 4]);
  assert.deepEqual([s.nodeOrderOk, s.errorsOk, s.spheresOk, s.patchesOk, s.layeredOk], [true, true, true, true, true]);
  assert.deepEqual([...s.depth], [0, 1, 1, 2]);
  assert.deepEqual([...s.parents], [0, 1, 1, 2]);
});

test('reader: not a Nexus file, a truncated header, a truncated index and truncated node data are errors', () => {
  assert.throws(() => parseNexusHeader(Buffer.from('<html>not found</html>, long enough to hold a header of 88 bytes, and then some more text')), /not a Nexus file/);
  assert.throws(() => parseNexusHeader(FILE.subarray(0, 40)), /too short/);
  assert.throws(() => parseNexus(FILE.subarray(0, HEADER_BYTES + 100)), /index truncated/);
  const idx = parseNexus(FILE), r = nodeRange(idx, 1);
  assert.throws(() => decodeRawNode(idx.header, idx.nodes[1], FILE.subarray(r.begin, r.begin + 50)), /node data truncated/);
});

test('reader: the head of a real .nxz (the gargoyle): its tables, and node 0 decoded from Corto', async () => {
  const head = await readFile(GARGO_HEAD);
  const idx = parseNexus(head);
  const { header: h } = idx;
  assert.deepEqual([h.version, h.codec, h.nodesCount - 1, h.patchesCount, h.texturesCount, h.nvert, h.nface], [2, 'corto', 187, 697, 0, 2055182, 3966820]);
  assert.deepEqual(Object.keys(h.signature.vertex), ['coord', 'normal', 'color']);
  assert.equal(idx.nroots, 1);
  const s = nexusStats(idx);
  assert.deepEqual([s.levels, s.leaves, s.shared, s.maxParents, s.paths, s.layeredOk, s.errorsOk, s.spheresOk, s.patchesOk], [9, 96, 171, 10, 25202, true, true, true, true]);
  const r = nodeRange(idx, 0);
  assert.equal(r.end, head.length, 'the fixture ends with node 0');
  const g = await decodeNode(idx, 0, head.subarray(r.begin, r.end));
  assert.deepEqual([g.positions.length, g.indices.length, g.normals.length, g.colors.length], [3882 * 3, 7760 * 3, 3882 * 3, 3882 * 4]);
  for (const v of g.indices) assert.ok(v < 3882);
  // every vertex is within the node's sphere
  const [cx, cy, cz, rad] = idx.nodes[0].sphere;
  for (let i = 0; i < g.positions.length; i += 3) assert.ok(Math.hypot(g.positions[i] - cx, g.positions[i + 1] - cy, g.positions[i + 2] - cz) <= rad * 1.001);
  assert.ok(g.normals.some((v) => v !== 0) && g.colors.some((v) => v !== 0));
});

// ── the tileset ──────────────────────────────────────────────────────────────────────────────────

test('tileset: unionSphere and the frame of a sphere', () => {
  assert.deepEqual(unionSphere([0, 0, 0, 2], [1, 0, 0, 1]), [0, 0, 0, 2]);
  assert.deepEqual(unionSphere([0, 0, 0, 1], [1, 0, 0, 2]), [1, 0, 0, 2]);
  assert.deepEqual(unionSphere([0, 0, 0, 1], [4, 0, 0, 1]), [2, 0, 0, 3]);
  assert.deepEqual(tileSphere([1, 2, 3, 4]), [1, -3, 2, 4], 'Y up → Z up');
});

test('tileset: by levels, the single root node is the root tile, the first node of a level carries the next, the others vanish through an empty child', (t) => {
  quiet(t);
  const { tileset, tiles, mode, stats } = buildTileset(parseNexus(FILE), (i) => `n${i}.glb`, { dag: 'levels' });
  assert.deepEqual([tiles, mode, stats.levels], [4, 'levels', 3]);
  assert.deepEqual(tileset.asset.version, '1.1');
  const model = [5, 0, 5, 8];
  // the root node's content is on the root tile (drawn from the first request, kept while a deep level loads), and
  // the level-1 nodes are its children; no contentless tile anywhere but the empty leaves (3DTilesRendererJS counts a
  // refined contentless tile as ready, so the root would stop standing in for a level still loading)
  const n0 = tileset.root;
  assert.deepEqual([n0.content.uri, n0.geometricError, tileset.geometricError, n0.refine, n0.boundingVolume.sphere, n0.content.boundingVolume.sphere], ['n0.glb', 32, 32, 'REPLACE', model, model]);
  assert.equal(n0.children.length, 2, 'the level-1 nodes');
  const [n1, n2] = n0.children;
  assert.deepEqual([n1.content.uri, n2.content.uri, n1.geometricError, n2.geometricError], ['n1.glb', 'n2.glb', 16, 16]);
  assert.deepEqual(n1.content.boundingVolume.sphere, [5, 0, 5, 4], 'the content is culled by the tight sphere');
  assert.deepEqual([n2.children.length, n2.children[0].content, n2.children[0].geometricError, n2.children[0].children], [1, undefined, 0, undefined], 'the other nodes vanish through an empty child');
  assert.equal(n1.children.length, 1, 'the first node carries level 2');
  const [n3] = n1.children;
  assert.deepEqual([n3.content.uri, n3.geometricError, n3.children, n3.content.boundingVolume.sphere], ['n3.glb', 0, undefined, [5, 0, 5, 5]]);
});

test('tileset: by paths, a shared node is a tile under each parent with the same content', () => {
  const { tileset, tiles, mode } = buildTileset(parseNexus(FILE), (i) => `n${i}.glb`, { dag: 'paths', geScale: 2 });
  assert.deepEqual([tiles, mode], [5, 'paths']);
  const root = tileset.root;
  assert.deepEqual([root.content.uri, root.geometricError, root.boundingVolume.sphere, root.children.length], ['n0.glb', 8, [5, 0, 5, 8], 2]);
  const [n1, n2] = root.children;
  assert.deepEqual([n1.geometricError, n1.boundingVolume.sphere, n2.content.uri], [4, [5, 0, 5, 8], 'n2.glb'], 'the saturated sphere, holding the child');
  assert.deepEqual(n1.children[0], n2.children[0]);
  assert.deepEqual([n1.children[0].content.uri, n1.children[0].geometricError], ['n3.glb', 0]);
  assert.throws(() => buildTileset(parseNexus(FILE), () => '', { dag: 'tree' }), /dag must be one of/);
});

test('tileset: by paths, a DAG with more root-to-node paths than the cap is refused, naming dag=levels', () => {
  const idx = parseNexus(FILE);
  assert.equal(nexusStats(idx).paths, 5, 'the synthetic DAG has 5 paths (node 3 under both of nodes 1 and 2)');
  assert.throws(() => buildTileset(idx, (i) => `${i}.glb`, { dag: 'paths', maxPaths: 4 }), /5 tiles .* more than 4: use dag=levels/);
  assert.equal(buildTileset(idx, (i) => `${i}.glb`, { dag: 'paths', maxPaths: 5 }).tiles, 5, 'at the cap it is written');
});

test('tileset: a DAG that is not layered is written by paths', (t) => {
  quiet(t);
  const dag = DAG();
  dag.nodes[0].patches = [{ node: 1, end: 1 }, { node: 3, end: 2 }];     // the root names a level-2 node directly
  const { mode, tiles } = buildTileset(parseNexus(encodeNxs(dag)), (i) => `n${i}.glb`, { dag: 'levels' });
  assert.deepEqual([mode, tiles], ['paths', 4]);
  assert.ok(console.warn.mock.calls.some((c) => /not layered/.test(c.arguments[0])));
});

// ── a node's GLB ─────────────────────────────────────────────────────────────────────────────────

const readGlb = async (glb) => {
  const b = Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength);
  assert.equal(b.toString('latin1', 0, 4), 'glTF');
  assert.equal(b.readUInt32LE(8), b.length, 'the header length is the file length');
  const jsonLen = b.readUInt32LE(12);
  assert.equal(b.toString('latin1', 16, 20), 'JSON');
  assert.equal(b.toString('latin1', 24 + jsonLen, 27 + jsonLen), 'BIN');
  assert.equal(28 + jsonLen + b.readUInt32LE(20 + jsonLen), b.length, 'the two chunks fill the file');
  return new NodeIO().readBinary(new Uint8Array(b));
};

test('glb: a textured node has one primitive per texture, the images embedded, v flipped; an untextured one its colours', async () => {
  const idx = parseNexus(FILE), slice = (i) => { const r = nodeRange(idx, i); return FILE.subarray(r.begin, r.end); };
  const tex = new Map(nodeTextures(idx, 3).map((t) => [t, FILE.subarray(idx.textures[t].offset, idx.textures[t].end)]));
  const doc = await readGlb(await nexusNodeGlb(idx, 3, slice(3), tex));
  const prims = doc.getRoot().listMeshes()[0].listPrimitives();
  assert.equal(prims.length, 2);
  assert.deepEqual(prims[0].listSemantics().sort(), ['NORMAL', 'POSITION', 'TEXCOORD_0']);
  assert.deepEqual([...prims[0].getIndices().getArray()], [0, 1, 2, 0, 2, 3]);
  assert.deepEqual([...prims[1].getIndices().getArray()], [4, 5, 6, 4, 6, 7]);
  const images = doc.getRoot().listTextures();
  assert.equal(images.length, 2);
  assert.equal(Buffer.compare(Buffer.from(images[0].getImage()), JPEGS[0]), 0);
  assert.notEqual(prims[0].getMaterial(), prims[1].getMaterial());
  assert.equal(prims[0].getMaterial().getBaseColorTexture(), images[0]);
  assert.deepEqual([...prims[0].getAttribute('TEXCOORD_0').getArray().slice(0, 4)], [0, 1, 1, 1], 'v → 1 − v');
  assert.deepEqual([...prims[0].getAttribute('NORMAL').getArray().slice(0, 3)], [0, 0, 1]);

  const plain = await readGlb(await nexusNodeGlb(idx, 0, slice(0)));
  const p = plain.getRoot().listMeshes()[0].listPrimitives();
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].listSemantics().sort(), ['COLOR_0', 'NORMAL', 'POSITION']);
  assert.deepEqual([p[0].getAttribute('COLOR_0').getNormalized(), [...p[0].getAttribute('COLOR_0').getArray().slice(0, 4)]], [true, [255, 0, 0, 255]]);
  assert.deepEqual([p[0].getMaterial().getMetallicFactor(), p[0].getMaterial().getRoughnessFactor()], [0, 1]);
  assert.equal(await nexusNodeGlb(idx, 4, Buffer.alloc(0)), null, 'the sink has no GLB');
});

// ── the live route ───────────────────────────────────────────────────────────────────────────────

/** A host that answers Range as a static file server does, and remembers the ranges asked. */
async function serve(t, files) {
  const ranges = [];
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname).slice(1), f = files[p];
    if (!f) { res.writeHead(404); return res.end(); }
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (!m) { ranges.push(`${p} whole`); res.writeHead(200, { 'Content-Length': f.length, 'Accept-Ranges': 'bytes' }); return res.end(f); }
    const a = Number(m[1]), b = m[2] ? Math.min(Number(m[2]), f.length - 1) : f.length - 1;
    ranges.push(`${p} ${a}-${b}`);
    if (a >= f.length) { res.writeHead(416, { 'Content-Range': `bytes */${f.length}` }); return res.end(); }
    res.writeHead(206, { 'Content-Length': b - a + 1, 'Content-Range': `bytes ${a}-${b}/${f.length}`, 'Accept-Ranges': 'bytes' });
    res.end(f.subarray(a, b + 1));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${server.address().port}`, ranges };
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
const contentTiles = (t, out = []) => { if (t.content) out.push(t); for (const c of t.children || []) contentTiles(c, out); return out; };

test('/stream?format=nexus: the tileset from two range reads, tiles by node range, textures read once, dag= and ge=', async (t) => {
  quiet(t);
  const h = await serve(t, { 'model.nxs': FILE });
  const s = await streamServer(t);
  const src = `${h.base}/model.nxs`, q = `url=${encodeURIComponent(src)}`;
  const ts = await json(`${s}/stream/tileset.json?${q}`);                                  // the format from the name
  const idx = parseNexus(FILE), tablesEnd = HEADER_BYTES + indexBytes(idx.header) - 1;
  assert.deepEqual(h.ranges, [`model.nxs 0-${HEADER_BYTES - 1}`, `model.nxs ${HEADER_BYTES}-${tablesEnd}`], 'the header, then the tables; nothing else');
  const tiles = contentTiles(ts.root);
  assert.equal(tiles.length, 4);
  assert.match(tiles[0].content.uri, /^tile\/0\.glb\?url=/);
  const n3 = tiles.find((x) => /^tile\/3\.glb/.test(x.content.uri));
  assert.deepEqual([n3.geometricError, n3.content.boundingVolume.sphere], [0, [5, 0, 5, 5]]);

  h.ranges.length = 0;
  const glb3 = await get(`${s}/stream/${n3.content.uri}`);
  assert.equal(glb3.status, 200);
  const doc = await readGlb(glb3.body);
  assert.equal(doc.getRoot().listTextures().length, 2);
  const r3 = nodeRange(idx, 3), tx = idx.textures;
  // The node and its two textures are asked for together and lie back-to-back, so the shared getter (range-getter.js)
  // reads them as one range, from the node's first byte to the last texture's.
  assert.equal(tx[0].offset, r3.end); assert.equal(tx[1].offset, tx[0].end);
  assert.deepEqual(h.ranges, [`model.nxs ${r3.begin}-${tx[1].end - 1}`], 'the node and its two textures, in one merged read');

  h.ranges.length = 0;
  const glb0 = await get(`${s}/stream/tile/0.glb?format=nexus&${q}`);
  assert.equal(glb0.status, 200);
  assert.deepEqual(h.ranges, [`model.nxs ${idx.nodes[0].offset}-${idx.nodes[0].end - 1}`], 'an untextured node is one range');
  assert.equal((await get(`${s}/stream/tile/3.glb?format=nexus&${q}`)).status, 200);
  assert.equal(h.ranges.length, 2, 'the textures were cached: the node alone was read again');

  assert.equal((await get(`${s}/stream/tile/4.glb?format=nexus&${q}`)).status, 404, 'the sink');
  assert.equal((await get(`${s}/stream/tile/9.glb?format=nexus&${q}`)).status, 404);
  assert.equal((await get(`${s}/stream/tile/x.glb?format=nexus&${q}`)).status, 404);

  const paths = await json(`${s}/stream/tileset.json?format=nexus&${q}&dag=paths&ge=2`);
  assert.deepEqual([contentTiles(paths.root).length, paths.root.geometricError, paths.root.content.uri.split('?')[0]], [5, 8, 'tile/0.glb']);
});

test('/stream?format=nexus: a local .nxs, the real .nxz head (Corto), a missing file, and a DEEPZOOM file', async (t) => {
  quiet(t);
  const dir = await mkdtemp(path.join(tmpdir(), 'nexus-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const local = path.join(dir, 'model.nxs');
  await writeFile(local, FILE);
  const deep = Buffer.from(FILE); deep.writeUInt32LE(8, 56);                                 // flags: DEEPZOOM
  await writeFile(path.join(dir, 'deep.nxs'), deep);
  await writeFile(path.join(dir, 'gargo-head.nxz'), await readFile(GARGO_HEAD));
  const s = await streamServer(t);

  const ts = await nexusTileset(local, {});
  assert.equal(contentTiles(ts.root).length, 4);
  assert.equal((await readGlb(await nexusTile(local, '3'))).getRoot().listTextures().length, 2);

  const gargo = await json(`${s}/stream/tileset.json?url=${encodeURIComponent(path.join(dir, 'gargo-head.nxz'))}`);
  assert.equal(contentTiles(gargo.root).length, 187);
  const glb0 = await get(`${s}/stream/tile/0.glb?format=nexus&url=${encodeURIComponent(path.join(dir, 'gargo-head.nxz'))}`);
  assert.equal(glb0.status, 200);
  const prim = (await readGlb(glb0.body)).getRoot().listMeshes()[0].listPrimitives()[0];
  assert.deepEqual([prim.getAttribute('POSITION').getCount(), prim.getIndices().getCount() / 3, prim.listSemantics().sort()], [3882, 7760, ['COLOR_0', 'NORMAL', 'POSITION']]);
  assert.notEqual((await get(`${s}/stream/tile/1.glb?format=nexus&url=${encodeURIComponent(path.join(dir, 'gargo-head.nxz'))}`)).status, 200, 'node 1 is past the end of the fixture');

  assert.equal((await get(`${s}/stream/tileset.json?url=${encodeURIComponent(path.join(dir, 'none.nxs'))}`)).status, 404);
  const deepRes = await get(`${s}/stream/tileset.json?url=${encodeURIComponent(path.join(dir, 'deep.nxs'))}`);
  assert.deepEqual([deepRes.status, /DEEPZOOM/.test(deepRes.body.toString())], [500, true], 'an unsupported layout is our own error, as the other adapters report it');
});

// ── the offline converter and detection ──────────────────────────────────────────────────────────

test('offline: convert() writes a tileset.json and one GLB per node, by levels and by paths', async (t) => {
  quiet(t);
  const dir = await mkdtemp(path.join(tmpdir(), 'nexus-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'model.nxs');
  await writeFile(src, FILE);
  assert.equal(detectFormatByName('https://host/a/model.nxz?x=1'), 'nexus');
  assert.equal(detectFormatByName('model.NXS'), 'nexus');
  assert.equal(await detectFormat(src), 'nexus');

  const r = await convertNexus(src, path.join(dir, 'out'), {});
  assert.deepEqual([r.format, r.tiles, r.nodes, r.written, r.mode], ['nexus', 4, 4, 4, 'levels']);
  assert.deepEqual((await readdir(path.join(dir, 'out/tiles'))).sort(), ['node_0.glb', 'node_1.glb', 'node_2.glb', 'node_3.glb']);
  const ts = JSON.parse(await readFile(path.join(dir, 'out/tileset.json'), 'utf8'));
  assert.deepEqual(contentTiles(ts.root).map((x) => x.content.uri).sort(), ['tiles/node_0.glb', 'tiles/node_1.glb', 'tiles/node_2.glb', 'tiles/node_3.glb']);
  const doc = await readGlb(await readFile(path.join(dir, 'out/tiles/node_3.glb')));
  assert.equal(doc.getRoot().listTextures().length, 2);

  const p = await convertNexus(src, path.join(dir, 'paths'), { dag: 'paths', geScale: 2 });
  assert.deepEqual([p.tiles, p.written, p.mode], [5, 4, 'paths']);
  const pts = JSON.parse(await readFile(path.join(dir, 'paths/tileset.json'), 'utf8'));
  assert.deepEqual([pts.root.geometricError, pts.root.content.uri], [8, 'tiles/node_0.glb']);
});
