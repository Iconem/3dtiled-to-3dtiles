// core/extract-core.js, the crop and extract shared by the server and the browser: the walk (ADD and REPLACE trees,
// external and implicit tilesets), the box test, and the writers. The tilesets are synthetic and served from memory.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Document, NodeIO } from '@gltf-transform/core';
import { enuMatrix, llhToEcef, ecefToLlh } from '../core/index.js';
import { walkTileset, extractLas, extractZip, extractTilesetJson, extractMeshDocument, parseBbox, crc32 } from '../core/extract-core.js';
import { zipDirectory, zipEntries } from '../sog-to-3dtiles/src/sogBundle.js';
import { crc32 as nodeCrc32 } from 'node:zlib';

const io = new NodeIO();
const LON = 2, LAT = 48, H = 100;
const ROOT_M = enuMatrix(LON, LAT, ...llhToEcef(LON, LAT, H));          // local East/North/Up metres → ECEF
const M_PER_DEG_LON = 111320 * Math.cos(LAT * Math.PI / 180), M_PER_DEG_LAT = 111132;
// A box in metres around the origin (east0, north0, east1, north1) → the geographic box, heights wide open.
const boxM = (e0, n0, e1, n1) => [LON + e0 / M_PER_DEG_LON, LAT + n0 / M_PER_DEG_LAT, -1e4, LON + e1 / M_PER_DEG_LON, LAT + n1 / M_PER_DEG_LAT, 1e4];
const EVERYWHERE = boxM(-5000, -5000, 5000, 5000);

/** A points tile: `pts` are [east, north, up] metres; the GLB is Y-up, so (e, n, u) is stored as (e, u, −n). */
async function pointsGlb(pts, color = [255, 0, 0]) {
  const doc = new Document(), buf = doc.createBuffer();
  const pos = new Float32Array(pts.flatMap(([e, n, u]) => [e, u, -n]));
  const col = new Uint8Array(pts.flatMap(() => [...color, 255]));
  const prim = doc.createPrimitive().setMode(0)
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buf))
    .setAttribute('COLOR_0', doc.createAccessor().setType('VEC4').setArray(col).setNormalized(true).setBuffer(buf));
  doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)));
  return io.writeBinary(doc);
}
/** A mesh tile: one triangle at (east, north). */
async function triangleGlb(e, n) {
  const doc = new Document(), buf = doc.createBuffer();
  const pos = new Float32Array([e, 0, -n, e + 1, 0, -n, e, 0, -(n + 1)]);
  const prim = doc.createPrimitive().setMode(4).setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buf));
  doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)));
  return io.writeBinary(doc);
}
const box = (e, n, half) => [e, n, 0, half, 0, 0, 0, half, 0, 0, 0, 50];
const json = (o) => new TextEncoder().encode(JSON.stringify(o));

/** fetchBytes over a Map of url → bytes, counting what was asked. */
function memory(files) {
  const asked = [];
  const fetchBytes = async (url) => { asked.push(url); const b = files.get(url); if (!b) throw new Error(`404 ${url}`); return b; };
  return { fetchBytes, asked, deps: { fetchBytes, readGlb: (bytes) => io.readBinary(new Uint8Array(bytes)), Document } };
}
const B = 'https://x.test/';

/** An ADD point tree: a coarse root (3 points) over two finer children, west (2 points) and east (2 points). */
async function addTree() {
  return memory(new Map([
    [B + 'ts.json', json({ asset: { version: '1.1' }, geometricError: 20, root: {
      transform: ROOT_M, boundingVolume: { box: box(0, 0, 100) }, geometricError: 10, refine: 'ADD', content: { uri: 'root.glb' },
      children: [
        { boundingVolume: { box: box(-50, 0, 50) }, geometricError: 0, content: { uri: 'west.glb' } },
        { boundingVolume: { box: box(50, 0, 50) }, geometricError: 0, content: { uri: 'sub/east.glb' } },
      ] } })],
    [B + 'root.glb', await pointsGlb([[-60, 0, 0], [0, 0, 0], [60, 0, 0]])],
    [B + 'west.glb', await pointsGlb([[-70, 10, 0], [-30, -10, 0]], [0, 255, 0])],
    [B + 'sub/east.glb', await pointsGlb([[30, 10, 0], [70, -10, 5]], [0, 0, 255])],
  ]));
}
/** A REPLACE mesh tree: a root triangle, replaced by a west and an east triangle. */
async function replaceTree() {
  return memory(new Map([
    [B + 'ts.json', json({ asset: { version: '1.1' }, geometricError: 20, root: {
      transform: ROOT_M, boundingVolume: { box: box(0, 0, 100) }, geometricError: 10, refine: 'REPLACE', content: { uri: 'root.glb' },
      children: [
        { boundingVolume: { box: box(-50, 0, 50) }, geometricError: 0, content: { uri: 'west.glb' } },
        { boundingVolume: { box: box(50, 0, 50) }, geometricError: 0, content: { uri: 'east.glb' } },
      ] } })],
    [B + 'root.glb', await triangleGlb(0, 0)], [B + 'west.glb', await triangleGlb(-50, 0)], [B + 'east.glb', await triangleGlb(50, 0)],
  ]));
}
const visited = async (m, bb, o = {}) => { const got = []; await walkTileset(B + 'ts.json', bb, { ...o, fetchBytes: m.fetchBytes }, (url) => { got.push(url.slice(B.length)); }); return got; };
const chunksSink = (seekable = true) => {
  const chunks = [];
  const sink = { write: (b) => { chunks.push(Uint8Array.from(b)); } };
  if (seekable) sink.rewrite = (pos, b) => { assert.equal(pos, 0); chunks[0] = Uint8Array.from(b); };
  return { sink, bytes: () => Buffer.concat(chunks) };
};
/** The points of a LAS written here: [x, y, z, r, g, b] in file coordinates. */
function lasPoints(buf) {
  const count = Number(buf.readBigUInt64LE(247)), scale = [131, 139, 147].map((o) => buf.readDoubleLE(o)), offset = [155, 163, 171].map((o) => buf.readDoubleLE(o));
  assert.equal(buf.length, 375 + count * 36, 'the header count matches the file size');
  return Array.from({ length: count }, (_, i) => { const o = 375 + i * 36;
    return [0, 1, 2].map((k) => buf.readInt32LE(o + k * 4) * scale[k] + offset[k]).concat([30, 32, 34].map((k) => buf.readUInt16LE(o + k))); });
}

test('bbox parsing', () => {
  assert.deepEqual(parseBbox('1,2,3,4,5,6'), [1, 2, 3, 4, 5, 6]);
  assert.equal(parseBbox('1,2,3'), null); assert.equal(parseBbox('a,2,3,4,5,6'), null); assert.equal(parseBbox(null), null);
});

test('an ADD tree gives every level down to maxGE, a REPLACE tree only the frontier', async () => {
  const add = await addTree(), rep = await replaceTree();
  assert.deepEqual(await visited(add, EVERYWHERE, { maxGE: 0 }), ['root.glb', 'west.glb', 'sub/east.glb']);
  assert.deepEqual(await visited(add, EVERYWHERE, { maxGE: 10 }), ['root.glb'], 'the root is fine enough: no descent');
  assert.deepEqual(await visited(rep, EVERYWHERE, { maxGE: 0 }), ['west.glb', 'east.glb'], 'the root is replaced, not added to');
  assert.deepEqual(await visited(rep, EVERYWHERE, { maxGE: 10 }), ['root.glb']);
  assert.deepEqual(await visited(rep, EVERYWHERE, { maxGE: 0, maxDepth: 0 }), [], 'maxDepth cuts the walk');
});

test('tiles outside the box are not fetched', async () => {
  const add = await addTree();
  assert.deepEqual(await visited(add, boxM(20, -40, 90, 40)), ['root.glb', 'sub/east.glb']);
  const m = await addTree();
  await extractLas({ url: B + 'ts.json', bb: boxM(20, -40, 90, 40), deps: m.deps }, chunksSink().sink);
  assert.ok(!m.asked.includes(B + 'west.glb'));
});

test('LAS: the points inside the box, once each, in ECEF, with their colours', async () => {
  const m = await addTree(), out = chunksSink();
  const r = await extractLas({ url: B + 'ts.json', bb: boxM(-65, -40, 65, 40), deps: m.deps }, out.sink);
  // inside ±65 m east: root's three, west's −30, east's +30; the two at ±70 are out
  assert.equal(r.points, 5); assert.equal(r.tiles, 3);
  const pts = lasPoints(out.bytes());
  const local = pts.map(([x, y, z]) => { const [lon, lat, h] = ecefToLlh(x, y, z); return [Math.round((lon - LON) * M_PER_DEG_LON), Math.round((lat - LAT) * M_PER_DEG_LAT), Math.round(h - H)].map((v) => v + 0); });   // + 0: no −0
  assert.deepEqual(local.map((p) => p[0]).sort((a, b) => a - b), [-60, -30, 0, 30, 60]);
  assert.equal(new Set(local.map(String)).size, 5, 'no point twice');
  assert.deepEqual(pts.find((_, i) => local[i][0] === -30).slice(3), [0, 65535, 0], 'west is green');
  assert.deepEqual(pts.find((_, i) => local[i][0] === 30).slice(3), [0, 0, 65535], 'east is blue');
  const head = out.bytes();
  assert.ok(head.readDoubleLE(179) >= head.readDoubleLE(187), 'bounds written');
});

test('LAS: one walk with a rewritten header and two walks give the same file; heights are clipped too', async () => {
  const bb = boxM(-500, -500, 500, 500), one = chunksSink(), two = chunksSink(false), forced = chunksSink();
  let counted = null;
  await extractLas({ url: B + 'ts.json', bb, deps: (await addTree()).deps }, one.sink);
  await extractLas({ url: B + 'ts.json', bb, deps: (await addTree()).deps, onCounted: (c) => { counted = c.points; } }, two.sink);
  await extractLas({ url: B + 'ts.json', bb, deps: (await addTree()).deps, twoPass: true }, forced.sink);
  assert.equal(counted, 7);
  assert.deepEqual(two.bytes(), one.bytes()); assert.deepEqual(forced.bytes(), one.bytes());
  const low = chunksSink(), lowBox = bb.slice(); lowBox[5] = H + 2;        // the point 5 m up is out
  assert.equal((await extractLas({ url: B + 'ts.json', bb: lowBox, deps: (await addTree()).deps }, low.sink)).points, 6);
  const enu = chunksSink();
  await extractLas({ url: B + 'ts.json', bb, enu: true, deps: (await addTree()).deps }, enu.sink);
  const east = lasPoints(enu.bytes()).map((p) => Math.round(p[0]) + 0).sort((a, b) => a - b);
  assert.deepEqual(east, [-70, -60, -30, 0, 30, 60, 70], 'the local frame is metres east of the box centre');
});

test('an external tileset and an implicit tiling are followed', async () => {
  const files = new Map([
    [B + 'ts.json', json({ asset: { version: '1.1' }, geometricError: 50, root: { transform: ROOT_M, boundingVolume: { box: box(0, 0, 200) }, geometricError: 40, refine: 'ADD',
      children: [
        { boundingVolume: { box: box(0, 0, 100) }, geometricError: 20, content: { uri: 'nested/inner.json' } },
        { boundingVolume: { box: box(0, 0, 64) }, geometricError: 16, refine: 'ADD', content: { uri: 'imp/{level}_{x}_{y}.glb' },
          implicitTiling: { subdivisionScheme: 'QUADTREE', subtreeLevels: 2, availableLevels: 2, subtrees: { uri: 'imp/{level}_{x}_{y}.subtree' } } },
      ] } })],
    [B + 'nested/inner.json', json({ asset: { version: '1.1' }, geometricError: 20, root: { boundingVolume: { box: box(0, 0, 100) }, geometricError: 0, refine: 'ADD', content: { uri: 'leaf.glb' } } })],
    [B + 'nested/leaf.glb', await pointsGlb([[1, 1, 0]])],
    [B + 'imp/0_0_0.subtree', json({ tileAvailability: { constant: 1 }, contentAvailability: [{ constant: 1 }], childSubtreeAvailability: { constant: 0 } })],
  ]);
  for (const [l, x, y] of [[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 0, 1], [1, 1, 1]]) files.set(`${B}imp/${l}_${x}_${y}.glb`, await pointsGlb([[(x - 0.5) * 60 * l, (y - 0.5) * 60 * l, 0]]));
  const m = memory(files);
  const all = await visited(m, EVERYWHERE, { maxGE: 0 });
  assert.deepEqual(all, ['nested/leaf.glb', 'imp/0_0_0.glb', 'imp/1_0_0.glb', 'imp/1_1_0.glb', 'imp/1_0_1.glb', 'imp/1_1_1.glb']);
  assert.deepEqual(await visited(m, EVERYWHERE, { maxGE: 16 }), ['nested/leaf.glb', 'imp/0_0_0.glb'], 'the implicit root is fine enough');
  assert.deepEqual(await visited(m, boxM(5, 5, 60, 60), { maxGE: 0 }), ['nested/leaf.glb', 'imp/0_0_0.glb', 'imp/1_1_1.glb'], 'only the north-east cell touches the box');
});

test('meshes: the frontier primitives that touch the box, merged, in ECEF', async () => {
  const all = await extractMeshDocument({ url: B + 'ts.json', bb: EVERYWHERE, deps: (await replaceTree()).deps });
  assert.equal(all.primitives, 2); assert.equal(all.tiles, 2);
  const east = await extractMeshDocument({ url: B + 'ts.json', bb: boxM(40, -5, 60, 5), deps: (await replaceTree()).deps });
  assert.equal(east.primitives, 1);
  const back = await io.readBinary(await io.writeBinary(east.document));
  const p = back.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('POSITION').getElement(0, [0, 0, 0]);
  const [lon, lat] = ecefToLlh(...p);
  assert.ok(Math.abs((lon - LON) * M_PER_DEG_LON - 50) < 0.5 && Math.abs((lat - LAT) * M_PER_DEG_LAT) < 0.5, 'the east triangle, where it is on the globe');
});

test('zip and cropped tileset: the tiles untouched, placed by their world transform', async () => {
  const m = await addTree(), out = chunksSink(false);
  const r = await extractZip({ url: B + 'ts.json', bb: boxM(20, -40, 90, 40), deps: m.deps }, out.sink);
  const zip = out.bytes();
  assert.equal(r.tiles, 2); assert.equal(r.bytes, zip.length);
  const { count, dirOffset, dirSize } = zipDirectory(zip, zip.length);
  const entries = zipEntries(zip.subarray(dirOffset, dirOffset + dirSize), count);
  assert.deepEqual(entries.map((e) => e.name), ['tiles/tile_0.glb', 'tiles/tile_1.glb', 'tileset.json']);
  const data = (e) => zip.subarray(e.offset + 30 + e.name.length, e.offset + 30 + e.name.length + e.size);
  assert.deepEqual(Buffer.from(data(entries[1])), Buffer.from(await m.fetchBytes(B + 'sub/east.glb')), 'the tile as it was fetched');
  const ts = JSON.parse(data(entries[2]).toString('utf8'));
  assert.deepEqual(ts.root.children.map((c) => c.content.uri), ['tiles/tile_0.glb', 'tiles/tile_1.glb']);
  assert.deepEqual(ts.root.children[1].transform, ROOT_M);

  const { tileset, tiles } = await extractTilesetJson({ url: B + 'ts.json', bb: EVERYWHERE, deps: (await addTree()).deps });
  assert.equal(tiles, 3);
  assert.deepEqual(tileset.root.children.map((c) => c.content.uri), [B + 'root.glb', B + 'west.glb', B + 'sub/east.glb'], 'absolute tile urls');
  for (const s of ['', 'a', 'tileset.json', 'x'.repeat(5000)]) assert.equal(crc32(Buffer.from(s)), nodeCrc32(Buffer.from(s)) >>> 0);
});

test('a cancelled extract stops at the next tile; an unreadable tile is skipped', async () => {
  const m = await addTree(), ctl = new AbortController();
  const seen = [];
  await assert.rejects(walkTileset(B + 'ts.json', EVERYWHERE, { fetchBytes: m.fetchBytes, signal: ctl.signal }, (url) => { seen.push(url); ctl.abort(new Error('stop')); }), /stop/);
  assert.equal(seen.length, 1);
  const broken = await addTree();
  broken.deps.fetchBytes = async (url) => { if (/west/.test(url)) throw new Error('503'); return broken.fetchBytes(url); };
  const out = chunksSink();
  assert.equal((await extractLas({ url: B + 'ts.json', bb: EVERYWHERE, deps: broken.deps }, out.sink)).points, 5);
});
