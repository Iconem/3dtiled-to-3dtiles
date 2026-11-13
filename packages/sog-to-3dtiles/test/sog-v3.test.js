// SOG v3 (splat-transform 3.11, November 2026) next to v2: one scene written as both (test/fixtures, made by
// scripts/make-fixtures.mjs) decodes to the same tiles; a v3 chunk whose opacity exceeds 1 is clamped; a streamed SOG
// whose chunks mix the two versions converts, offline and live; a lod-meta.json with `lodErrors` sets the LOD chain's
// geometric errors. No network: the live route is fed by a local host of the fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeChunk, extractRange } from '../src/sogChunk.js';
import { lodGeometricErrors } from '../src/lodMeta.js';
import { convert } from '../src/index.js';
import { buildSplatTileGlb, computeBounds } from '../../core/index.js';
import { sogTileset, sogTile } from '../../tile-server/sog-live.js';
import { sceneTable, SCENE_COUNT } from './scene.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (...p) => path.join(FIXTURES, ...p);
// (the converter's progress goes through process.stdout.write, left alone: mocking it swallows the test reporter's own lines)
const quiet = (t) => { t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); };

/** A GLB's JSON chunk, after its header is checked. */
const gltf = (glb) => { assert.equal(glb.toString('latin1', 0, 4), 'glTF'); assert.equal(glb.readUInt32LE(8), glb.length); return JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12))); };
/** The SPZ payload of a splat tile GLB, inflated: { count, positions: Buffer, alphas: Buffer }. */
function spz(glb) {
  const jsonLen = glb.readUInt32LE(12), binOff = 20 + jsonLen;
  assert.equal(glb.readUInt32LE(binOff + 4), 0x004e4942, 'BIN chunk');
  const raw = zlib.gunzipSync(glb.subarray(binOff + 8, binOff + 8 + glb.readUInt32LE(binOff)));
  assert.equal(raw.readUInt32LE(0), 0x5053474e, 'SPZ magic'); assert.equal(raw.readUInt32LE(4), 2, 'SPZ v2');
  const count = raw.readUInt32LE(8);
  return { count, positions: raw.subarray(16, 16 + count * 9), alphas: raw.subarray(16 + count * 9, 16 + count * 10) };
}
const maxAbsDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
/** The largest angle, in degrees, between paired quaternions (xyzw, 4 per splat). */
function maxAngle(a, b) {
  let worst = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs(a[i] * b[i] + a[i + 1] * b[i + 1] + a[i + 2] * b[i + 2] + a[i + 3] * b[i + 3]);
    worst = Math.max(worst, 2 * Math.acos(Math.min(1, d)) * 180 / Math.PI);
  }
  return worst;
}

test('SOG v2 and v3 of one scene decode to the same positions, colours, scales, alphas and rotations', async () => {
  const v2 = await decodeChunk(fixture('v2', 'meta.json')), v3 = await decodeChunk(fixture('v3', 'meta.json'));
  assert.equal(JSON.parse(await readFile(fixture('v3', 'meta.json'), 'utf8')).version, 3);
  assert.equal(v2.numRows, SCENE_COUNT); assert.equal(v3.numRows, SCENE_COUNT);
  for (const name of ['x', 'y', 'z', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'scale_0', 'scale_1', 'scale_2', 'opacity', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'f_rest_0', 'f_rest_8']) {
    assert.ok(v3.getColumnByName(name), `v3 has ${name}`);
  }
  assert.equal(v3.getColumnByName('opacity_linear'), undefined, 'no opacity above 1 in the scene itself');
  const a = extractRange(v2, 0, v2.numRows), b = extractRange(v3, 0, v3.numRows);
  assert.ok(maxAbsDiff(a.positions, b.positions) < 1e-4, 'positions: the same 16-bit quantizer');
  assert.ok(maxAbsDiff(a.rgb, b.rgb) < 0.02, 'colours: the same codebooks, within a step');
  let scaleRatio = 0; for (let i = 0; i < a.scales.length; i++) scaleRatio = Math.max(scaleRatio, Math.abs(Math.log(a.scales[i] / b.scales[i])));
  assert.ok(scaleRatio < 0.05, `scales within 5 % (${scaleRatio})`);
  assert.ok(maxAbsDiff(a.alphas, b.alphas) < 0.01, 'alphas: v2 linear byte vs v3 square-root byte, within 0.01');
  const angle = maxAngle(a.rotations, b.rotations);
  assert.ok(angle < 2.5, `rotations: v2 smallest-three vs v3 exp map, ${angle.toFixed(2)}° apart at most`);
  for (const arr of [b.alphas, b.positions, b.rgb, b.scales, b.rotations]) for (const v of arr) assert.ok(Number.isFinite(v));

  // and both are the scene, the fixtures' ground truth (test/scene.mjs): the SOG writer reorders the rows (Morton
  // order), so each channel is compared as a sorted distribution.
  const truth = extractRange(sceneTable(), 0, SCENE_COUNT);
  const sorted = (arr, stride, k) => Float32Array.from({ length: arr.length / stride }, (_, i) => arr[i * stride + k]).sort();
  for (const [name, stride, tol] of [['positions', 3, 2e-3], ['rgb', 3, 0.02], ['alphas', 1, 0.01], ['scales', 3, 0.01]]) {
    for (let k = 0; k < stride; k++) {
      assert.ok(maxAbsDiff(sorted(b[name], stride, k), sorted(truth[name], stride, k)) < tol, `v3 ${name}[${k}] are the scene's`);
      assert.ok(maxAbsDiff(sorted(a[name], stride, k), sorted(truth[name], stride, k)) < tol, `v2 ${name}[${k}] are the scene's`);
    }
  }
});

test('a v3 chunk with opacity above 1 decodes to alpha 1 in the tile, the same tile its v2 encoding gives', async () => {
  const meta = JSON.parse(await readFile(fixture('lod-v3', '1_0', 'meta.json'), 'utf8'));
  assert.ok(meta.opacity?.max > 1, `the decimated level has opacity above 1 (${meta.opacity?.max})`);
  const v3 = await decodeChunk(fixture('lod-v3', '1_0', 'meta.json')), v2 = await decodeChunk(fixture('lod-v2', '1_0', 'meta.json'));
  const linear = v3.getColumnByName('opacity_linear')?.data;
  assert.ok(linear, 'readSog gives the true opacity as opacity_linear');
  const above = [...linear].map((v, i) => [v, i]).filter(([v]) => v > 1);
  assert.ok(above.length > 0 && Math.max(...above.map(([v]) => v)) <= 1.5625);
  const logit = v3.getColumnByName('opacity').data;
  for (const [, i] of above) assert.ok(logit[i] > 16 && logit[i] < 17, 'the logit column saturates (16.64) for opacity above 1');
  const a = extractRange(v3, 0, v3.numRows), b = extractRange(v2, 0, v2.numRows);
  for (const [, i] of above) assert.equal(a.alphas[i], 1, 'clamped to 1');
  for (const v of a.alphas) assert.ok(v >= 0 && v <= 1);
  assert.ok(maxAbsDiff(a.alphas, b.alphas) < 0.01, 'as v2, which clamps on write');

  const n = v3.numRows;
  const glb = Buffer.from(await buildSplatTileGlb(a, n, computeBounds(a.positions, n)));
  const json = gltf(glb);
  assert.ok(json.extensionsRequired.includes('KHR_gaussian_splatting_compression_spz_2'));
  const tile = spz(glb);
  assert.equal(tile.count, n);
  for (const [, i] of above) assert.equal(tile.alphas[i], 255, 'opaque in the SPZ');
  const tile2 = spz(Buffer.from(await buildSplatTileGlb(b, n, computeBounds(b.positions, n))));
  assert.ok(tile.positions.equals(tile2.positions), 'the same SPZ positions from either version');
});

test('lodGeometricErrors: a √2 step per level without errors, the leaf\'s own ratios with them, never above the parent', () => {
  const geAt = (d) => 8 / 2 ** d;
  const step = (k) => 4 * Math.pow(Math.SQRT1_2, k);   // depth 1 is 4; each finer level ÷ √2 (a level holds half the splats)
  assert.deepEqual([...lodGeometricErrors({}, [0, 1, 2], 1, geAt, false)], [[2, 4], [1, step(1)], [0, step(2)]]);
  assert.deepEqual([...lodGeometricErrors({ errors: [0, 1, 4] }, [0, 1, 2], 1, geAt, false)], [[2, 4], [1, step(1)], [0, step(2)]], 'errors ignored without lodErrors');
  assert.deepEqual([...lodGeometricErrors({ errors: [0, 1, 4] }, [0, 1, 2], 1, geAt, true)], [[2, 4], [1, 1], [0, 0]], 'the coarsest keeps its depth\'s error, the rest their share');
  assert.deepEqual([...lodGeometricErrors({ errors: [0, 1, 4] }, [1, 2], 1, geAt, true)], [[2, 4], [1, 1]], 'a leaf without the finest level');
  assert.deepEqual([...lodGeometricErrors({ errors: [0, 0, 0] }, [0, 1, 2], 1, geAt, true)], [[2, 4], [1, step(1)], [0, step(2)]], 'all-zero errors: the √2 step');
  assert.deepEqual([...lodGeometricErrors({ errors: [0, 'x', 4] }, [0, 1, 2], 1, geAt, true)], [[2, 4], [1, step(1)], [0, step(2)]], 'a bad value: the √2 step');
  assert.deepEqual([...lodGeometricErrors({ errors: [0, 5, 4] }, [0, 1, 2], 1, geAt, true)], [[2, 4], [1, 4], [0, 0]], 'a finer level never refines at more than its parent');
});

/** A copy of the lod-v3 scene whose chunk 0 is the v2 encoding of the same rows, in a temp dir removed after the test. */
async function mixedScene(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sog-mixed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(fixture('lod-v3'), dir, { recursive: true });
  const lod = JSON.parse(await readFile(path.join(dir, 'lod-meta.json'), 'utf8'));
  const chunk0 = path.posix.dirname(lod.filenames[0]);
  await rm(path.join(dir, chunk0), { recursive: true });
  await cp(fixture('lod-v2', chunk0), path.join(dir, chunk0), { recursive: true });
  assert.equal(JSON.parse(await readFile(path.join(dir, chunk0, 'meta.json'), 'utf8')).version, 2);
  assert.equal(JSON.parse(await readFile(path.join(dir, path.posix.dirname(lod.filenames[1]), 'meta.json'), 'utf8')).version, 3);
  return { dir, lod };
}

test('offline: a streamed SOG whose chunks mix v2 and v3 converts to one tileset of valid splat tiles', async (t) => {
  quiet(t);
  const { dir, lod } = await mixedScene(t);
  const out = await mkdtemp(path.join(tmpdir(), 'sog-tiles-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const result = await convert(dir, out, { splatBudget: 0 });   // the 1:1 mapping: one tile per leaf LOD run
  const tileset = JSON.parse(await readFile(path.join(out, 'tileset.json'), 'utf8'));
  assert.equal(tileset.asset.version, '1.1');
  // every leaf's LOD chain is a tile per level, geometric error halving down the chain
  let tiles = 0, leaves = 0;
  const walk = (tile, parentGe) => {
    assert.ok(tile.geometricError <= parentGe, 'geometric error never grows down the tree');
    if (tile.content) tiles++;
    if (!tile.children?.length) leaves++;
    for (const c of tile.children ?? []) walk(c, tile.geometricError);
  };
  walk(tileset.root, Infinity);
  assert.equal(tiles, result.tiles);
  const runs = (node) => node.children ? node.children.reduce((n, c) => n + runs(c), 0) : Object.keys(node.lods ?? {}).length;
  assert.equal(tiles, runs(lod.tree), 'one tile per leaf LOD run');
  const files = (await readdir(path.join(out, 'tiles'))).filter((f) => f.endsWith('.glb'));
  assert.equal(files.length, tiles);
  let splats = 0;
  for (const f of files) { const glb = await readFile(path.join(out, 'tiles', f)); gltf(glb); splats += spz(glb).count; }
  assert.equal(splats, lod.count, 'every gaussian of every level is in a tile');

  // the default: the tree collapsed per LOD level under the splat budget, the same gaussians in fewer tiles
  const out2 = await mkdtemp(path.join(tmpdir(), 'sog-tiles-'));
  t.after(() => rm(out2, { recursive: true, force: true }));
  const collapsed = await convert(dir, out2);
  assert.ok(collapsed.tiles < tiles, `${collapsed.tiles} merged tiles for ${tiles} leaf runs`);
  let merged = 0;
  for (const f of (await readdir(path.join(out2, 'tiles'))).filter((n) => n.endsWith('.glb'))) { const glb = await readFile(path.join(out2, 'tiles', f)); gltf(glb); merged += spz(glb).count; }
  assert.equal(merged, lod.count, 'collapsed: every gaussian of every level is in a tile');
});

/** The files of `dir` over HTTP, as a streamed SOG host does. */
async function host(t, dir) {
  const server = http.createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    try { res.end(await readFile(path.join(dir, p))); } catch { res.writeHead(404); res.end(); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('live: the mixed scene served through sog-live, a tile from the v2 chunk and one from a v3 chunk', async (t) => {
  quiet(t);
  const { dir, lod } = await mixedScene(t);
  // the same scene again with lodErrors, under another name so that sog-live's per-URL context is its own
  const withErrors = (node) => node.children ? { ...node, children: node.children.map(withErrors) } : { ...node, errors: [0, 1, 3].slice(0, lod.lodLevels) };
  await writeFile(path.join(dir, 'lod-meta-errors.json'), JSON.stringify({ ...lod, lodErrors: true, tree: withErrors(lod.tree) }));
  const base = await host(t, dir);

  // the default tileset is collapsed per LOD level: merged tiles named by node path and level, the same gaussians
  const collapsed = await sogTileset(`${base}/lod-meta.json`);
  let mergedSplats = 0;
  const each = async (tile) => {
    if (tile.content) { const glb = await sogTile(`${base}/lod-meta.json`, /tile\/(m\d*_\d+)\.glb/.exec(tile.content.uri)[1]); gltf(glb); mergedSplats += spz(glb).count; }
    for (const c of tile.children ?? []) await each(c);
  };
  await each(collapsed.root);
  assert.equal(mergedSplats, lod.count, 'collapsed live: every gaussian of every level is in a tile');
  assert.equal(await sogTile(`${base}/lod-meta.json`, 'm999_0'), null, 'no such node');

  // a budget the coarsest level alone exceeds: the root carries a preview of it, every stride-th splat, enlarged by
  // √stride, which the level's own tiles replace (its error is above theirs)
  const L = lod.lodLevels - 1;
  const coarse = (function sum(n) { return n.children ? n.children.reduce((a, c) => a + sum(c), 0) : (n.lods?.[String(L)]?.count ?? 0); })(lod.tree);
  const thin = await sogTileset(`${base}/lod-meta.json`, { splatBudget: Math.max(1, Math.floor(coarse / 3)) });
  const thinKey = /tile\/(m_\d+s\d+)\.glb/.exec(thin.root.content.uri)[1];
  const stride = Number(/s(\d+)$/.exec(thinKey)[1]);
  assert.ok(stride >= 3, `stride ${stride} for ${coarse} coarsest splats`);
  const previewGlb = await sogTile(`${base}/lod-meta.json`, thinKey);
  gltf(previewGlb);
  assert.equal(spz(previewGlb).count, Math.ceil(coarse / stride), 'the preview is every stride-th splat of the coarsest level');
  assert.ok(thin.root.children.length > 0 && thin.root.children.every((c) => c.geometricError < thin.root.geometricError), 'the preview refines into the level');

  const tileset = await sogTileset(`${base}/lod-meta.json`, { splatBudget: 0 });
  assert.ok(tileset.extensions['3DTILES_content_gltf'].extensionsRequired.includes('KHR_gaussian_splatting_compression_spz_2'));
  // the native frame reaches the client: Z-up by default (the client's Y-up→Z-up turn undone), `up` for the others
  assert.deepEqual(collapsed.root.transform, [1,0,0,0, 0,0,-1,0, 0,1,0,0, 0,0,0,1]);
  assert.deepEqual((await sogTileset(`${base}/lod-meta.json`, { up: 'y' })).root.transform, [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], 'Y-up: the turn is exact');
  assert.deepEqual((await sogTileset(`${base}/lod-meta.json`, { up: '-y' })).root.transform, [1,0,0,0, 0,-1,0,0, 0,0,-1,0, 0,0,0,1], 'Y-down: half a turn about X');
  assert.deepEqual((await sogTileset(`${base}/lod-meta.json`, { up: 'sideways' })).root.transform, collapsed.root.transform, 'an unknown axis is the default');
  const chains = [];   // [outermost (coarsest) tile of a leaf, ...]
  const walk = (tile) => { if (tile.content) chains.push(tile); else for (const c of tile.children ?? []) walk(c); };
  walk(tileset.root);
  assert.ok(chains.length > 1);
  const key = (tile) => /tile\/(\d+_\d+_\d+)\.glb/.exec(tile.content.uri)[1];
  const fromFile = (f) => chains.flatMap((c) => { const all = []; for (let x = c; x; x = x.children?.[0]) all.push(x); return all; }).find((x) => key(x).startsWith(`${f}_`));
  for (const f of [0, 1]) {
    const tile = fromFile(f);
    assert.ok(tile, `a tile cut from chunk ${f}`);
    const glb = await sogTile(`${base}/lod-meta.json`, key(tile));
    gltf(glb);
    assert.equal(spz(glb).count, Number(key(tile).split('_')[2]));
  }
  assert.equal(await sogTile(`${base}/lod-meta.json`, '99_0_1'), null, 'no such chunk');

  // without lodErrors the finest tile of a chain keeps a positive error; with them it refines to 0
  const finest = (tile) => { let x = tile; while (x.children?.[0]) x = x.children[0]; return x; };
  assert.ok(chains.every((c) => finest(c).geometricError > 0));
  const withLodErrors = await sogTileset(`${base}/lod-meta-errors.json`, { splatBudget: 0 });
  const chains2 = []; const walk2 = (tile) => { if (tile.content) chains2.push(tile); else for (const c of tile.children ?? []) walk2(c); }; walk2(withLodErrors.root);
  const threeLevels = chains2.find((c) => c.children?.[0]?.children?.[0]);
  assert.ok(threeLevels, 'a leaf with all three levels');
  assert.equal(finest(threeLevels).geometricError, 0);
  assert.ok(Math.abs(threeLevels.children[0].geometricError - threeLevels.geometricError / 3) < 1e-9, 'the middle level at a third of the coarsest (errors 1 of 3)');
  const sameDepth = chains.find((c) => key(c) === key(threeLevels));
  assert.equal(threeLevels.geometricError, sameDepth.geometricError, 'the coarsest level keeps the error of its depth');
});
