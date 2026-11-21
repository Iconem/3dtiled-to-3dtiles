// Where a tile's geometricError comes from: the shared rules (core/geometric-error.js), the fixes that made the live
// stream and the offline converters agree, and the opt-in density rule (&ge=density) format by format.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SSE_TARGET, DENSITY_K, screenDiameterError, boxSides, largestFace, densitySpacing, densityError, i3sLodError, geRuleParam, httpStatusOf } from '../core/index.js';
import { handleStream } from './stream-live.js';
import { threemxGeometricError } from './threemx-live.js';
import { osgbGeometricError } from './osgb-live.js';
import { bingFaceError } from './bing-live.js';
import { planOverview } from './vpc-live.js';
import { geosplatsTileset } from './geosplats-live.js';
import { potreeTileset } from './potree-live.js';
import { i3sTileset } from './i3s-live.js';
import { buildTileset as radTileset } from '../rad-to-3dtiles/src/tilesetBuilder.js';
import { parseLcc2, lcc2Tileset } from '../lcc-to-3dtiles/src/lcc2Manifest.js';
import { obbToFrameBox, i3sBoxError, i3sNodeLod } from '../i3s-to-3dtiles/src/i3sParse.js';
import { convert as convertI3s } from '../i3s-to-3dtiles/src/index.js';
import { convert as convertPotree } from '../potree-to-3dtiles/src/index.js';

const quiet = (t) => { t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); };
const near = (a, b, eps = 1e-9, what = '') => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${what} ${a} vs ${b}`);

/** A host serving `files` (path → Buffer | object). */
async function host(t, files) {
  const server = http.createServer((req, res) => {
    let body = files[decodeURIComponent(new URL(req.url, 'http://x').pathname)];
    if (body === undefined) { res.writeHead(404); return res.end(); }
    if (!Buffer.isBuffer(body)) body = Buffer.from(JSON.stringify(body));
    const m = req.headers.range?.match(/bytes=(\d+)-(\d+)/);
    if (m) {
      const [b, e] = [Number(m[1]), Math.min(Number(m[2]), body.length - 1)];
      res.writeHead(206, { 'Content-Range': `bytes ${b}-${e}/${body.length}` });
      return res.end(body.subarray(b, e + 1));
    }
    res.end(body);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
/** The /stream route, as server.js mounts it. */
async function streamServer(t) {
  const server = http.createServer(async (req, res) => {
    try { if (!await handleStream(req, res, new URL(req.url, 'http://x'))) { res.writeHead(404); res.end(); } }
    catch (e) { res.writeHead(httpStatusOf(e)); res.end(String(e.message)); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const getJson = async (url) => { const r = await fetch(url); assert.equal(r.status, 200, url); return r.json(); };
/** Every tile of a tree, parents first, with its parent. */
function* tilesOf(tile, parent = null) { yield [tile, parent]; for (const c of tile.children ?? []) yield* tilesOf(c, tile); }
const neverRises = (root) => { for (const [t, p] of tilesOf(root)) if (p) assert.ok(t.geometricError <= p.geometricError, `a child's error (${t.geometricError}) is above its parent's (${p.geometricError})`); };

// ── the shared rules ─────────────────────────────────────────────────────────────────────────────

test('screenDiameterError: a sphere `px` pixels across and a 16 px error are reached at the same distance', () => {
  const K = 935, radius = 12.5, px = 300;
  const ge = screenDiameterError(radius, px);
  const distance = 2 * radius * K / px;                    // where the sphere is `px` pixels across
  near(ge * K / distance, SSE_TARGET, 1e-12, 'screen-space error at that distance');
  assert.equal(screenDiameterError(1, 0), 32, '0 px: always refine, counted as 1 px');
  assert.equal(screenDiameterError(1, undefined), 32);
  // OSGB's pixel mode is the same rule
  near(osgbGeometricError({ files: ['a.osgb'], rangeMode: 'pixel', radius, range: px }), ge, 1e-12, 'osgb');
});

test('the density rule: spacing from the largest face, capped by the box rule and by the parent', () => {
  assert.deepEqual(boxSides([0, 0, 0, 5, 0, 0, 0, 2, 0, 0, 0, 0.5]), [10, 4, 1]);
  assert.deepEqual(boxSides([0, 0, 0, 3, 4, 0, 0, 0, 1, 0, 0, 0]), [10, 2, 0], 'half axes need not be axis-aligned');
  assert.equal(largestFace([1, 10, 4]), 40);
  assert.equal(densitySpacing([10, 4, 1], 160), 0.5);      // √(40 / 160)
  assert.equal(densitySpacing([10, 4, 1], 0), null);
  assert.equal(densitySpacing([0, 0, 0], 10), null);
  assert.deepEqual(DENSITY_K, { splats: 8, points: 1.5, mesh: 1 });
  assert.equal(densityError({ sides: [10, 4, 1], count: 160, k: 8, boxError: 100, parentError: 50 }), 4, 'k × spacing');
  assert.equal(densityError({ sides: [10, 4, 1], count: 160, k: 8, boxError: 3, parentError: 50 }), 3, 'the box rule is a ceiling');
  assert.equal(densityError({ sides: [10, 4, 1], count: 160, k: 8, boxError: 100, parentError: 2 }), 2, 'never above the parent');
  assert.equal(densityError({ sides: [10, 4, 1], count: undefined, k: 8, boxError: 7 }), 7, 'no count: the box rule');
  assert.equal(densityError({ area: 1e6, count: 4e6, k: 1.5, boxError: 1732 }), 0.75, 'a face area alone');
  assert.equal(geRuleParam('density'), 'density');
  assert.equal(geRuleParam('DENSITY'), 'density');
  for (const v of [null, undefined, '', '8', 'box']) assert.equal(geRuleParam(v), undefined);
});

test('I3S lodThreshold: a screen area or a screen diameter becomes the error that switches at the same distance', () => {
  const radius = 20, K = 935;
  // maxScreenThresholdSQ: the area of a disc 250 px across
  const area = Math.PI / 4 * 250 ** 2;
  const sq = i3sLodError({ metricType: 'maxScreenThresholdSQ', value: area, radius });
  near(sq, 2 * radius * 16 / 250, 1e-12, 'SQ');
  near(sq, 2 * radius * 16 / Math.sqrt(4 * area / Math.PI), 1e-12, 'SQ, as the page writes it');
  near(sq * K / (2 * radius * K / 250), 16, 1e-12, 'switch distance');
  near(i3sLodError({ metricType: 'maxScreenThreshold', value: 250, radius }), sq, 1e-12, 'a diameter says the same');
  assert.equal(i3sLodError({ metricType: 'maxScreenThresholdSQ', value: 0, radius }), 32 * radius, '0: always refine');
  // a point cloud's effective area: 1.5 × √(area / points)
  assert.equal(i3sLodError({ metricType: 'density-threshold', value: 400, radius, vertexCount: 1600 }), 0.75);
  assert.equal(i3sLodError({ metricType: 'density-threshold', value: 400, radius }), null, 'no count');
  assert.equal(i3sLodError({ metricType: 'maxScreenThresholdSQ', value: undefined, radius }), null, 'no threshold');
  assert.equal(i3sLodError({ metricType: 'screenSpaceRelative', value: 3, radius }), null, 'a metric this does not read');
  // where the value is stored: node pages, or a legacy node's lodSelection[]
  assert.deepEqual(i3sNodeLod({ lodThreshold: 5 }, 'maxScreenThresholdSQ'), { metricType: 'maxScreenThresholdSQ', value: 5 });
  assert.deepEqual(i3sNodeLod({ lodSelection: [{ metricType: 'removedFeatureDiameter', maxError: 1 }, { metricType: 'maxScreenThreshold', maxError: 300 }] }, null), { metricType: 'maxScreenThreshold', value: 300 });
  assert.equal(i3sNodeLod({}, 'maxScreenThresholdSQ'), null);
});

// ── 1. 3MX ───────────────────────────────────────────────────────────────────────────────────────

const threemxb = (nodes) => {
  const json = Buffer.from(JSON.stringify({ nodes, resources: [] }));
  const head = Buffer.alloc(9); head.write('3MXBO', 'latin1'); head.writeUInt32LE(json.length, 5);
  return Buffer.concat([head, json]);
};

test('3MX: the error reproduces maxScreenDiameter at a 16 px target, with the box diagonal as the sphere diameter', () => {
  const node = { bbMin: [0, 0, 0], bbMax: [3, 4, 12], maxScreenDiameter: 208, children: ['a.3mxb'] };   // diagonal 13
  assert.equal(threemxGeometricError(node), 1);            // 13 × 16 / 208
  const K = 935, distance = 13 * K / 208;                  // where the sphere is 208 px across
  near(threemxGeometricError(node) * K / distance, 16, 1e-12, 'screen-space error at the switch distance');
  assert.equal(threemxGeometricError({ ...node, maxScreenDiameter: 0 }), 13 * 16, '0: always refine');
  assert.equal(threemxGeometricError({ ...node, children: [] }), 0, 'nothing finer: 0');
  // the same sphere and the same pixel size in an OSGB PagedLOD give the same error
  near(osgbGeometricError({ files: ['a.osgb'], rangeMode: 'pixel', radius: 6.5, range: 208 }), 1, 1e-12, 'osgb');
});

test('3MX: a finer file is refined exactly when its node is, and never has a larger error', async (t) => {
  quiet(t);
  const h = await host(t, {
    '/root.3mxb': threemxb([{ bbMin: [0, 0, 0], bbMax: [3, 4, 12], maxScreenDiameter: 208, children: ['sub/a.3mxb'], resources: ['g'] }]),
    '/sub/a.3mxb': threemxb([
      { bbMin: [0, 0, 0], bbMax: [3, 4, 12], maxScreenDiameter: 104, children: ['b.3mxb'], resources: ['g'] },   // own error 2: above its parent's
      { bbMin: [0, 0, 0], bbMax: [1, 1, 1], maxScreenDiameter: 100, children: [], resources: ['g'] },
    ]),
  });
  const s = await streamServer(t);
  const ts = await getJson(`${s}/stream/tileset.json?format=threemx&url=${encodeURIComponent(`${h}/root.3mxb`)}`);
  assert.equal(ts.root.geometricError, 26, 'the dataset root: twice its diagonal');
  const node = ts.root.children[0], ref = node.children[0];
  assert.equal(node.geometricError, 1);
  assert.equal(ref.geometricError, 1, 'the tile that points at the finer file has the node\'s error (it had half)');
  assert.deepEqual(ref.boundingVolume, node.boundingVolume);
  const u = new URL(ref.content.uri, s);
  assert.equal(u.searchParams.get('ge'), '1');
  assert.equal(u.searchParams.get('bb'), '0,0,0,3,4,12');
  const frag = await getJson(u.href);
  assert.equal(frag.root.geometricError, 1, 'the fragment\'s root repeats it');
  assert.deepEqual(frag.root.boundingVolume, node.boundingVolume);
  assert.deepEqual(frag.root.children.map((c) => c.geometricError), [1, 0], 'a node stays under the node it refines; a leaf is 0');
  assert.equal(new URL(frag.root.children[0].children[0].content.uri, s).searchParams.get('ge'), '1');
  neverRises(ts.root); neverRises(frag.root);
});

// ── 2. RAD ───────────────────────────────────────────────────────────────────────────────────────

/** A binary tree of `depth` levels below the root; boxes shrink with depth and differ between siblings. */
function radTree(depth) {
  const nodes = [];
  for (let i = 0; i < 2 ** (depth + 1) - 1; i++) {
    const d = Math.floor(Math.log2(i + 1)), h = (8 / 2 ** d) * (1 + (i % 3) * 0.4);
    nodes.push({ nodeIndex: i, chunkIndex: i, bounds: [i, 0, 0, h, h, h / 2], splatCount: 1000 + 37 * (i % 5), children: d < depth ? [2 * i + 1, 2 * i + 2] : [] });
  }
  return nodes;
}
/** The fragment the live stream scans from node `rootIndex`: `levels` levels, cut at the last one. */
function radFragment(all, rootIndex, levels) {
  const out = [];
  (function walk(i, d) {
    const n = all[i], cut = d >= levels;
    out.push({ ...n, children: cut ? undefined : n.children, frontier: cut && n.children.length > 0 });
    if (!cut) for (const c of n.children) walk(c, d + 1);
  })(rootIndex, 0);
  return out;
}
const SUB = 'sub/{index}.json?d={depth}&pe={error}';
const indexOf = (tile) => Number(/(\d+)\.(glb|json)/.exec(tile.content.uri)[1]);

test('RAD live: no error rises across a fragment boundary; where the source is a tree, the first fragment has the whole tree\'s errors', (t) => {
  quiet(t);
  const all = radTree(6);
  const whole = radTileset(all.map((n) => ({ ...n })), { tileUriTemplate: 'tile/{index}.glb' });
  const offline = new Map([...tilesOf(whole.root)].map(([tile]) => [indexOf(tile), tile.geometricError]));
  neverRises(whole.root);

  const first = radTileset(radFragment(all, 0, 3), { tileUriTemplate: 'tile/{index}.glb', subtreeUriTemplate: SUB });
  assert.equal(first.geometricError, whole.geometricError);
  const refs = [];
  for (const [tile, parent] of tilesOf(first.root)) {
    if (/sub\//.test(tile.content.uri)) { refs.push([tile, parent]); continue; }
    assert.equal(tile.geometricError, offline.get(indexOf(tile)), `node ${indexOf(tile)}: live = offline in the first fragment`);
  }
  assert.equal(refs.length, 8, 'the 8 nodes of depth 3 point at their fragments');
  neverRises(first.root);

  let differing = 0;
  for (const [ref, node] of refs) {
    assert.equal(ref.geometricError, node.geometricError, 'the tile that points at a fragment has its node\'s error (it had half)');
    const u = new URL(ref.content.uri, 'http://x');
    assert.equal(u.searchParams.get('d'), '3', 'the fragment is told its root\'s depth in the whole tree');
    assert.equal(Number(u.searchParams.get('pe')), node.geometricError, 'and its error, exactly');
    const frag = radTileset(radFragment(all, indexOf(node), 3), {
      tileUriTemplate: 'tile/{index}.glb', subtreeUriTemplate: SUB,
      baseDepth: Number(u.searchParams.get('d')), parentError: Number(u.searchParams.get('pe')),
    });
    assert.equal(frag.root.geometricError, node.geometricError, 'the fragment\'s root repeats the error it has above');
    neverRises(frag.root);
    for (const [tile, parent] of tilesOf(frag.root)) {
      if (!parent) continue;
      assert.ok(tile.geometricError <= node.geometricError, 'nothing in the fragment is above the node it hangs from');
      if (!/sub\//.test(tile.content.uri) && tile.geometricError !== offline.get(indexOf(tile))) differing++;
    }
  }
  // what is NOT claimed: below the first fragment a level's error is a mean over the fragment's nodes only
  assert.ok(differing > 0, 'below the first fragment the live error is not the offline one (a mean over part of a level)');

  // before the fix a fragment restarted from its own nodes: its root could be above the tile that pointed at it
  const restarted = radTileset(radFragment(all, 9, 3), { tileUriTemplate: 'tile/{index}.glb', subtreeUriTemplate: SUB });
  assert.notEqual(restarted.root.geometricError, offline.get(9));
});

// ── 3. I3S ───────────────────────────────────────────────────────────────────────────────────────

const q = (() => { const v = [0.1, 0.2, 0.3, 0.9], n = Math.hypot(...v); return v.map((x) => x / n); })();
const i3sNodes = [
  { index: 0, obb: { center: [2, 48, 100], halfSize: [50, 40, 10], quaternion: q }, children: [1, 2], lodThreshold: Math.PI / 4 * 200 ** 2, mesh: { geometry: { resource: 0, vertexCount: 3 } } },
  { index: 1, obb: { center: [2.0001, 48.0001, 100], halfSize: [20, 10, 4], quaternion: [0, 0, 0, 1] }, children: [3], mesh: { geometry: { resource: 1, vertexCount: 3200 } } },
  { index: 2, obb: { center: [1.9999, 48, 100], halfSize: [20, 10, 4], quaternion: q }, children: [], lodThreshold: 9, mesh: { geometry: { resource: 2, vertexCount: 3 } } },
  { index: 3, obb: { center: [2.0001, 48.0001, 100], halfSize: [5, 5, 2], quaternion: q }, children: [], mesh: { geometry: { resource: 3, vertexCount: 3 } } },
];
const i3sLayer = {
  layerType: 'IntegratedMesh', spatialReference: { wkid: 4326, latestWkid: 4326 }, store: { version: '1.8' },
  nodePages: { nodesPerPage: 64, lodSelectionMetricType: 'maxScreenThresholdSQ' }, geometryDefinitions: [{ geometryBuffers: [{ offset: 8 }] }],
};
/** One triangle in the default geometry layout (position, normal, uv0, colour), a few metres across in degrees. */
function i3sTriangle() {
  const b = Buffer.alloc(8 + 3 * (12 + 12 + 8 + 4));
  b.writeUInt32LE(3, 0); b.writeUInt32LE(1, 4);
  [[0, 0, 0], [1e-5, 0, 0], [0, 1e-5, 1]].forEach((p, i) => p.forEach((v, k) => b.writeFloatLE(v, 8 + i * 12 + k * 4)));
  return b;
}

test('I3S: the live stream and the offline converter give every node the same error, from its OBB', async (t) => {
  quiet(t);
  const files = { '/3dSceneLayer.json': i3sLayer, '/nodepages/0.json': { nodes: i3sNodes } };
  for (const n of i3sNodes) files[`/nodes/${n.index}/geometries/0.bin`] = i3sTriangle();
  const h = await host(t, files);
  const live = await i3sTileset(`${h}/3dSceneLayer.json`, { hierarchy: 'eager' });

  const dir = await mkdtemp(path.join(tmpdir(), 'i3s-ge-')), out = await mkdtemp(path.join(tmpdir(), 'i3s-ge-out-'));
  t.after(() => Promise.all([rm(dir, { recursive: true, force: true }), rm(out, { recursive: true, force: true })]));
  for (const [p, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    await writeFile(path.join(dir, p), Buffer.isBuffer(body) ? body : JSON.stringify(body));
  }
  await convertI3s(dir, out, { workers: 0 });
  const offline = JSON.parse(await readFile(path.join(out, 'tileset.json'), 'utf8'));

  const errors = (ts) => [...tilesOf(ts.root)].map(([tile]) => tile.geometricError);
  assert.deepEqual(errors(offline), errors(live), 'tile by tile, in tree order');
  assert.equal(offline.geometricError, live.geometricError);
  // the rule: half the diagonal of the box that encloses the OBB in the tileset's frame; leaves 0
  assert.equal(errors(live)[0], i3sBoxError(live.root.boundingVolume.box, true));
  assert.ok(errors(live)[0] >= Math.hypot(50, 40, 10), 'the enclosing box is no smaller than the OBB');
  assert.deepEqual(errors(live).map((e) => e > 0), [true, true, false, false]);
  // the offline box is the decoded geometry's (a triangle a few metres across), which no longer sizes the error
  assert.ok(Math.hypot(offline.root.boundingVolume.box[3], offline.root.boundingVolume.box[7], offline.root.boundingVolume.box[11]) < errors(offline)[0]);
  assert.equal(obbToFrameBox({ center: [1, 2, 3], halfSize: [4, 5, 6] }, false).join(), '1,2,3,4,0,0,0,5,0,0,0,6', 'a local layer: the OBB as stored');
});

test('I3S &ge=density: lodThreshold first, the density of vertices where a node has none, leaves 0, default untouched', async (t) => {
  quiet(t);
  const h = await host(t, { '/3dSceneLayer.json': i3sLayer, '/nodepages/0.json': { nodes: i3sNodes } });
  const s = await streamServer(t);
  const src = `format=i3s&cache=hierarchy&url=${encodeURIComponent(`${h}/3dSceneLayer.json`)}`;
  const box = await getJson(`${s}/stream/tileset.json?${src}`);
  const density = await getJson(`${s}/stream/tileset.json?${src}&ge=density`);
  assert.deepEqual(await getJson(`${s}/stream/tileset.json?${src}&ge=8`), box, 'only ge=density changes anything');
  const [root, a, b, c] = [...tilesOf(density.root)].map(([tile]) => tile);
  // root: a sphere of radius |halfSize| that may be 200 px across
  near(root.geometricError, 2 * Math.hypot(50, 40, 10) * 16 / 200, 1e-12, 'root, from lodThreshold');
  assert.equal(density.geometricError, root.geometricError);
  // node 1 has no lodThreshold: √(largest face of its OBB / vertexCount) = √(40 × 20 / 3200) = 0.5, k = 1
  assert.equal(a.geometricError, 0.5);
  assert.deepEqual([b.geometricError, c.geometricError], [0, 0], 'leaves stay at 0, lodThreshold or not');
  assert.ok(root.geometricError < box.root.geometricError && a.geometricError < box.root.children[0].geometricError);
  neverRises(density.root);
  // the boxes and the content are the same
  const strip = (ts) => JSON.parse(JSON.stringify(ts, (k, v) => (k === 'geometricError' ? undefined : v)));
  assert.deepEqual(strip(density), strip(box));
});

// ── 4. Potree, offline ───────────────────────────────────────────────────────────────────────────

for (const spacing of [1, 0]) {
  test(`Potree offline = live: tileset-level error and tile errors, ${spacing ? 'with a spacing' : 'without one (the diagonal / 128)'}`, async (t) => {
    quiet(t);
    const metadata = {
      version: '1.8', octreeDir: 'data', hierarchyStepSize: 5, scale: 0.01, ...(spacing ? { spacing } : {}),
      boundingBox: { lx: 0, ly: 0, lz: 0, ux: 64, uy: 64, uz: 64 }, tightBoundingBox: { lx: 0, ly: 0, lz: 0, ux: 64, uy: 64, uz: 64 },
      pointAttributes: [{ name: 'POSITION_CARTESIAN', size: 12 }, { name: 'RGBA_PACKED', size: 4 }],
    };
    const hierarchy = Buffer.alloc(5); hierarchy.writeUInt32LE(1, 1);
    const point = Buffer.alloc(16); point.writeUInt32LE(50, 0); point.writeUInt32LE(50, 4); point.writeUInt32LE(50, 8); point.set([255, 128, 64, 255], 12);
    const files = { '/cloud.js': Buffer.from(JSON.stringify(metadata)), '/data/r/r.hrc': hierarchy, '/data/r/r.bin': point };
    const dir = await mkdtemp(path.join(tmpdir(), 'potree-ge-')), out = await mkdtemp(path.join(tmpdir(), 'potree-ge-out-'));
    t.after(() => Promise.all([rm(dir, { recursive: true, force: true }), rm(out, { recursive: true, force: true })]));
    for (const [p, body] of Object.entries(files)) { await mkdir(path.dirname(path.join(dir, p)), { recursive: true }); await writeFile(path.join(dir, p), body); }
    const h = await host(t, files);
    const diag = Math.hypot(64, 64, 64);
    for (const tiling of ['implicit', 'explicit']) {
      const live = await potreeTileset(`${h}/cloud.js`, { tiling, prefetch: 0 });
      await convertPotree(dir, out, { tiling, workers: 0 });
      const offline = JSON.parse(await readFile(path.join(out, 'tileset.json'), 'utf8'));
      assert.equal(offline.geometricError, live.geometricError, `${tiling}: tileset-level`);
      assert.equal(offline.root.geometricError, live.root.geometricError, `${tiling}: root tile`);
      near(offline.geometricError, diag, 1e-12, 'the cube\'s diagonal');
      near(offline.root.geometricError, spacing || diag / 128, 1e-12, 'the spacing, or the diagonal / 128');
    }
  });
}

// ── 6. Bing ──────────────────────────────────────────────────────────────────────────────────────

test('Bing: a face\'s error is read from its tile in td1, half the tileset\'s only when it states none', () => {
  assert.equal(bingFaceError({ geometricError: 393216 }, 786432), 393216);
  assert.equal(bingFaceError({ geometricError: 100000 }, 786432), 100000, 'its own, whatever the tileset says');
  assert.equal(bingFaceError({}, 786432), 393216);
  assert.equal(bingFaceError(undefined, 786432), 393216);
});

// ── B. the density rule, format by format ────────────────────────────────────────────────────────

test('LCC &ge=density: a level\'s error is 8 × the spacing of its splats, under the 5 % rule and the level above', async (t) => {
  quiet(t);
  const levels = [30_000_000, 16_000_000, 4_000_000, 9];   // splats per LOD, finest first; the last (coarsest) is sparse
  const index = Buffer.alloc(4 + 16 * levels.length);
  levels.forEach((pts, L) => { index.writeUInt32LE(pts, 4 + L * 16); index.writeBigUInt64LE(BigInt(32 + L), 8 + L * 16); index.writeUInt32LE(pts * 32, 16 + L * 16); });
  const h = await host(t, {
    '/meta.lcc': { attributes: [{ name: 'scale', min: [0, 0, 0], max: [1, 1, 1] }], indexDataSize: index.length, cellLengthX: 10, cellLengthY: 10, boundingBox: { min: [0, 0, 0], max: [10, 10, 2] } },
    '/index.bin': index,
  });
  const s = await streamServer(t);
  const src = `format=lcc&url=${encodeURIComponent(`${h}/meta.lcc`)}`;
  const chain = (ts) => { const out = []; for (let n = ts.root.children[0]; n; n = n.children?.[0]) out.push(n.geometricError); return out; };
  const box = await getJson(`${s}/stream/tileset.json?${src}`), density = await getJson(`${s}/stream/tileset.json?${src}&ge=density`);
  const rootGE = Math.hypot(10, 10, 2) * 0.05;
  assert.deepEqual(chain(box), [rootGE, rootGE / 2, rootGE / 4, rootGE / 8]);
  // the unit's box is 10 × 10 × 2: largest face 100 m²
  assert.deepEqual(chain(density), [
    rootGE,                                                // 9 splats: 8 × √(100 / 9) = 26.7, so the 5 % rule (0.714) is the ceiling
    8 * Math.sqrt(100 / 4_000_000),                        // 0.04, where the 5 % rule gave 0.357
    8 * Math.sqrt(100 / 16_000_000),                       // 0.02
    8 * Math.sqrt(100 / 16_000_000),                       // the finest level keeps the 5 % rule (0.089), capped by its parent's 0.02
  ]);
  assert.equal(density.geometricError, box.geometricError);
  assert.equal(density.root.geometricError, box.root.geometricError);
  neverRises(density.root);
  assert.deepEqual(density.root.children[0].content, box.root.children[0].content, 'tile URLs do not change');
});

test('LCC2 &ge=density: a node with splats and children gets 8 × their spacing; a leaf keeps the rule, under its parent', async (t) => {
  quiet(t);
  const manifest = { totalLevels: 2, root: { boundingBox: { min: [0, 0, 0], max: [10, 10, 2] }, splatFiles: ['data/3dgs/a.sog'], child: { 0: {
    boundingBox: { min: [0, 0, 0], max: [10, 10, 2] }, data: { '3dgs': { name: 0, start: 0, count: 250_000 } },
    child: { 0: { boundingBox: { min: [0, 0, 0], max: [5, 5, 2] }, data: { '3dgs': { name: 0, start: 250_000, count: 10 } } } },
  } } } };
  const uri = (run) => `tile/${run.file}_${run.start}_${run.count}.glb`;
  const box = lcc2Tileset(parseLcc2(JSON.stringify(manifest)), uri).tileset;
  const density = lcc2Tileset(parseLcc2(JSON.stringify(manifest)), uri, { density: true }).tileset;
  const errors = (ts) => [...tilesOf(ts.root)].map(([tile]) => tile.geometricError);
  const rootGE = Math.hypot(10, 10, 2) * 0.05;
  assert.deepEqual(errors(box), [rootGE * 2, rootGE, rootGE / 2]);
  assert.deepEqual(errors(density), [rootGE * 2, 8 * Math.sqrt(100 / 250_000), 8 * Math.sqrt(100 / 250_000)]);   // 0.16; the leaf's 0.357 is capped by it
  neverRises(density.root);
  // and through /stream
  const h = await host(t, { '/a.lcc2': manifest });
  const s = await streamServer(t);
  const live = await getJson(`${s}/stream/tileset.json?format=lcc2&url=${encodeURIComponent(`${h}/a.lcc2`)}&ge=density`);
  assert.deepEqual(errors(live), errors(density));
  assert.deepEqual(errors(await getJson(`${s}/stream/tileset.json?format=lcc2&url=${encodeURIComponent(`${h}/a.lcc2`)}`)), errors(box));
});

test('GeoSplats &ge=density: a cell with finer cells gets 8 × the spacing of the LOD its tile draws', async (t) => {
  quiet(t);
  const bb = (x0, y0, z0, x1, y1, z1) => ({ min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } });
  const meta = { bounding_box: bb(0, 0, 0, 100, 100, 10), entries: [], voxel_grids: {
    grid_1: [{ offset: 0, total_count: 10_000, counts: [100, 200, 300, 10_300, 0, 0, 0, 0], center: { x: 50, y: 50, z: 5 } }],   // drawn at LOD 4, which adds 10 000 splats
    grid_8: [{ offset: 0, total_count: 500, counts: [0, 0, 0, 0, 0, 500, 0, 0], center: { x: 25, y: 25, z: 5 }, bounding_box: bb(0, 0, 0, 50, 50, 10) }],
  } };
  const h = await host(t, { '/splats/m1/model.json': { global_position: { lat: 0, lon: 0 }, models: [{ baseurl: 'sub0' }] }, '/splats/m1/sub0/metadata.json': meta });
  const url = `${h}/splats/m1/model.json?key=test`;
  const errors = (ts) => [...tilesOf(ts.root)].map(([tile]) => tile.geometricError);
  const box = await geosplatsTileset(url), density = await geosplatsTileset(url, { geRule: 'density' });
  assert.deepEqual(errors(box), [200, Math.hypot(100, 100, 10), Math.hypot(50, 50, 10)]);
  // grid_1: largest face 100 × 100, 10 000 splats of its own at LOD 4 (counts are cumulative) → spacing 1 → 8; the grid_8 cell has nothing finer: its rule, under 8
  assert.deepEqual(errors(density), [200, 8, 8]);
  neverRises(density.root);
});

test('VPC &ge=density: without an overview a file leaf gets 1.5 × √(footprint / pc:count); an overview or a leaf error wins', async () => {
  const entry = (name, points, area, extra = {}) => {
    const e = { format: 'copc', url: `https://host/${name}.copc.laz`, name, ...(points ? { points } : {}), bounds: { sphere: [0, 0, 0, 900], geometricError: 1732.051 }, ...extra };
    Object.defineProperty(e, 'area', { value: area, enumerable: false });
    return e;
  };
  const set = { label: 't', entries: [entry('a', 4_000_000, 1e6), entry('b', 0, 1e6), entry('c', 100, 0), entry('nested', 0, 0, { format: 'vpc' })] };
  const report = { areaKm2: 2 };
  const errors = (plan) => plan.set.entries.map((e) => e.bounds.geometricError);
  const strict = await planOverview(set, report, {});
  assert.deepEqual(errors(strict), [1732.051, 1732.051, 1732.051, 1732.051]);
  assert.equal(strict.set.entries[3].params.ge, undefined);
  const density = await planOverview(set, report, { density: true });
  assert.deepEqual(errors(density), [0.75, 1732.051, 1732.051, 1732.051], 'a: √(1e6 / 4e6) = 0.5 m; b has no count, c no footprint');
  assert.equal(density.extras.leafErrorRule, 'density');
  assert.deepEqual(density.set.entries[3].params, { overview: '0', ge: 'density' }, 'a nested VPC is told the rule');
  const byHand = await planOverview(set, report, { density: true, leafError: 5 });
  assert.deepEqual(errors(byHand), [5, 5, 5, 1732.051], '&leafError= wins over the rule');
  assert.equal(byHand.extras.leafErrorRule, undefined);
});
