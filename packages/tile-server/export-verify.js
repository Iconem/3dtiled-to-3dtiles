/**
 * export-verify.js — does a finished export folder hold what it should?
 *
 * Modes, each including the one before:
 *   off     no check
 *   counts  walk from tileset.json as a client would (external tilesets, implicit subtrees); every tile it reaches must
 *           be a file of the length its own header declares. Adds up the points in the tile headers and compares them
 *           with the total the SOURCE declares, where it has one. Only the headers are read.
 *   sample  (default) also reads a few tiles of each level in full: chunks, buffer views and accessors must fit, and
 *           uncompressed positions must be finite
 *   full    the same on every tile
 *
 * The source comparison is the one that catches a reader dropping nodes: a walk of the folder cannot, as a tile that was
 * never listed is not missing from anything. Potree and COPC state their totals: cloud.js / metadata.json `points`,
 * the LAS header of a COPC file. Tiled meshes, splats and plain 3D Tiles have no such total, and the report says so.
 */
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadSubtree, morton2Decode, morton3Decode } from '../core/index.js';
import { parseCloudJs } from '../potree-to-3dtiles/src/potree1.js';
import { inspectGlb } from './stats-live.js';

export const VERIFY_MODES = ['off', 'counts', 'sample', 'full'];
const SAMPLE_TILES = 64;
const POOL = 32;
const TOLERANCE = 0.001;                       // a converter may round; a tenth of a percent is not a lost level
const LIST_MAX = 20;

const contentUris = (tile) => [tile.content, ...(tile.contents ?? [])].filter(Boolean).map((c) => c.uri ?? c.url).filter(Boolean);

/** Read a tile's header: is the file as long as it says, and how many points does it declare? */
async function readTileHead(file, rel) {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (!size) return { size };
    const head = Buffer.alloc(Math.min(28, size));
    await fh.read(head, 0, head.length, 0);
    const magic = head.toString('latin1', 0, 4);
    if (/\.glb$/i.test(rel) && magic !== 'glTF') return { size, problem: `not a GLB (starts with ${JSON.stringify(head.toString('latin1', 0, 8))})` };
    const known = magic === 'glTF' || magic === 'pnts' || magic === 'b3dm' || magic === 'i3dm' || magic === 'cmpt';
    if (!known) return { size, points: 0 };
    if (head.length < 12) return { size, problem: 'shorter than its header' };
    const declared = head.readUInt32LE(8);
    if (declared !== size) return { size, problem: `header says ${declared} bytes, the file has ${size}` };
    if (magic === 'glTF') {
      const jsonLength = head.readUInt32LE(12);
      if (20 + jsonLength > size) return { size, problem: 'JSON chunk runs past the file' };
      const whole = Buffer.alloc(20 + jsonLength);
      await fh.read(whole, 0, whole.length, 0);
      const r = inspectGlb(whole);
      return r.ok ? { size, points: r.points, triangles: r.triangles } : { size, problem: r.reason };
    }
    if (magic === 'pnts') {
      const jsonLength = head.readUInt32LE(12);
      if (28 + jsonLength > size) return { size, problem: 'feature table runs past the file' };
      const ft = Buffer.alloc(jsonLength);
      await fh.read(ft, 0, jsonLength, 28);
      try { return { size, points: JSON.parse(ft.toString('utf8')).POINTS_LENGTH ?? 0 }; }
      catch { return { size, problem: 'bad feature table JSON' }; }
    }
    return { size, points: 0 };
  } finally { await fh.close(); }
}

const COMPONENT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_ITEMS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/** Read a whole GLB: its chunks, views and accessors must fit, and plain positions must be finite. A problem, or null. */
export function checkGlb(buf) {
  const jsonLength = buf.readUInt32LE(12);
  let gltf;
  try { gltf = JSON.parse(buf.toString('utf8', 20, 20 + jsonLength)); } catch (e) { return `bad JSON chunk: ${e.message}`; }
  const binStart = 20 + jsonLength;
  const binLength = binStart + 8 <= buf.length ? buf.readUInt32LE(binStart) : 0;
  if (binStart + 8 + binLength > buf.length) return 'BIN chunk runs past the file';
  const views = gltf.bufferViews ?? [];
  for (const [i, v] of views.entries()) {
    if ((v.buffer ?? 0) === 0 && !gltf.buffers?.[0]?.uri && (v.byteOffset ?? 0) + v.byteLength > binLength) return `buffer view ${i} runs past the BIN chunk`;
  }
  const accessors = gltf.accessors ?? [];
  for (const [i, a] of accessors.entries()) {
    const v = views[a.bufferView];
    if (a.bufferView == null) continue;
    if (!v) return `accessor ${i} names a missing buffer view`;
    const element = COMPONENT_SIZE[a.componentType] * TYPE_ITEMS[a.type];
    const stride = v.byteStride ?? element;
    if (a.count && (a.byteOffset ?? 0) + stride * (a.count - 1) + element > v.byteLength) return `accessor ${i} runs past its buffer view`;
  }
  for (const mesh of gltf.meshes ?? []) for (const prim of mesh.primitives ?? []) {
    const a = accessors[prim.attributes?.POSITION];
    const v = a && views[a.bufferView];
    if (!v || a.componentType !== 5126 || v.extensions || prim.extensions?.KHR_draco_mesh_compression || (v.buffer ?? 0) !== 0) continue;
    const start = binStart + 8 + (v.byteOffset ?? 0) + (a.byteOffset ?? 0), stride = v.byteStride ?? 12;
    for (let i = 0; i < a.count; i++) for (let k = 0; k < 3; k++) {
      if (!Number.isFinite(buf.readFloatLE(start + i * stride + k * 4))) return `position ${i} is not a finite number`;
    }
  }
  return null;
}

/** Where a tileset url of this server came from, when it wraps one raw dataset. A mosaic or a plain tileset has no such source. */
export function sourceOfUrl(url) {
  try {
    const u = new URL(url);
    if (!/^\/(stream|tiles|convert|potree|copc)(\/|$)/.test(u.pathname)) return null;
    const src = u.searchParams.get('url');
    return src ? { src, format: u.searchParams.get('format') } : null;
  } catch { return null; }
}

const isUrl = (s) => /^https?:\/\//i.test(s);
const nameOf = (s) => (isUrl(s) ? new URL(s).pathname : s).replace(/\\/g, '/').toLowerCase();

async function readSource(src, rel, bytes) {
  if (isUrl(src)) {
    const u = new URL(src);
    if (rel) u.pathname = `${u.pathname.replace(/\/[^/]*\.[^/.]*$/, '').replace(/\/$/, '')}/${rel}`;
    const r = await fetch(u, bytes ? { headers: { Range: `bytes=0-${bytes - 1}` } } : undefined);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  const file = rel ? path.join((await stat(src)).isDirectory() ? src : path.dirname(src), rel) : src;
  if (!bytes) return readFile(file);
  const fh = await open(file, 'r');
  try { const b = Buffer.alloc(bytes); const { bytesRead } = await fh.read(b, 0, bytes, 0); return b.subarray(0, bytesRead); }
  finally { await fh.close(); }
}

/** The number of points a raw source says it holds, or null when it says nothing we can read cheaply. */
export async function declaredPoints({ src, format }) {
  const name = nameOf(src);
  if (/\.copc\.laz$/.test(name) || format === 'copc') {
    const h = await readSource(src, null, 375);
    if (h.toString('latin1', 0, 4) !== 'LASF') throw new Error('not a LAS header');
    // LAS 1.4 moved the count to a 64-bit field; a COPC file is always 1.4, the older field is for anything else.
    const count = h[24] === 1 && h[25] >= 4 && h.length >= 255 ? Number(h.readBigUInt64LE(247)) : h.readUInt32LE(107);
    return { format: 'copc', declared: count, from: 'LAS header' };
  }
  const potreeFile = /\/cloud\.js$/.test(name) ? 'cloud.js' : /\/metadata\.json$/.test(name) ? 'metadata.json' : null;
  if (format !== 'potree' && !potreeFile) return null;
  for (const rel of potreeFile ? [potreeFile] : ['cloud.js', 'metadata.json']) {
    let text;
    try { text = (await readSource(src, rel)).toString('utf8'); } catch { continue; }
    const meta = parseCloudJs(text);
    const points = Number(meta.points);
    if (Number.isFinite(points) && points > 0) return { format: 'potree', declared: points, from: rel };
    // Potree 1.4 has no total, but lists every node with its count in the same file.
    if (Array.isArray(meta.hierarchy)) return { format: 'potree', declared: meta.hierarchy.reduce((a, e) => a + e[1], 0), from: `${rel} hierarchy` };
  }
  return null;
}

async function compareWithSource(source, points, partial) {
  if (!source) return { available: false, reason: 'not a single raw dataset' };
  let d;
  try { d = await declaredPoints(source); }
  catch (e) { return { available: false, reason: `could not read the source: ${e.message}` }; }
  if (!d) return { available: false, reason: 'this source declares no total' };
  const out = { available: true, ...d, exported: points, missing: d.declared - points, missingRatio: d.declared ? (d.declared - points) / d.declared : 0 };
  if (partial) return { ...out, comparable: false, ok: true };   // a depth cap keeps part of the cloud on purpose
  return { ...out, comparable: true, ok: Math.abs(out.missingRatio) <= TOLERANCE };
}

const big = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} M` : n.toLocaleString('en-US'));

function summaryOf(v) {
  const levels = Object.keys(v.levels).map(Number);
  const parts = [`Checked ${v.contentTiles.toLocaleString('en-US')} tiles${levels.length ? `, levels ${Math.min(...levels)}–${Math.max(...levels)}` : ''}`];
  if (v.points) parts.push(`${big(v.points)} points`);
  if (v.triangles) parts.push(`${big(v.triangles)} triangles`);
  parts.push(`${v.missing} missing`);
  if (v.badTiles) parts.push(`${v.badTiles} damaged`);
  if (v.deepChecked) parts.push(`${v.deepChecked.toLocaleString('en-US')} read in full`);
  let s = `${parts.join(', ')}.`;
  if (!v.contentTiles) s += v.partial ? ' The depth limit stops above the first tile with content.' : ' The tileset holds no tile content.';
  const src = v.source;
  if (src?.available && src.comparable) {
    s += src.ok
      ? ` Matches the source's ${big(src.declared)} points.`
      : ` The source declares ${big(src.declared)} points, ${big(src.exported)} were exported: ${(src.missingRatio * 100).toFixed(1)}% ${src.missing > 0 ? 'lost' : 'over'}.`;
  } else if (src?.available) s += ` The source holds ${big(src.declared)} points; a depth limit keeps only part of them.`;
  return s;
}

/**
 * Walks a finished folder from its tileset.json and checks what it reaches. `source` is {src, format} of the raw dataset,
 * `partial` says the export kept part of it on purpose. Never throws on a bad folder: an unreadable tree is a failed check.
 */
export async function verifyExport(outDir, { mode = 'sample', source = null, partial = false, signal, onProgress } = {}) {
  if (mode === 'off') return { mode, ok: true, skipped: true };
  const levels = {}, pointsByLevel = {}, missing = [], bad = [], tiles = [];
  let subtrees = 0;
  const seen = new Set();
  const local = (rel) => path.join(outDir, ...rel.split('/'));
  const sizeOf = async (rel) => { try { return (await stat(local(rel))).size; } catch { return 0; } };

  async function walkImplicit(tile, base, level0) {
    const imp = tile.implicitTiling, oct = imp.subdivisionScheme === 'OCTREE', arity = oct ? 8 : 4;
    const content = contentUris(tile);
    const fill = (t, l, x, y, z) => t.replace('{level}', l).replace('{x}', x).replace('{y}', y).replace('{z}', z);
    const decode = (m) => { const c = oct ? morton3Decode(m) : morton2Decode(m); return [c.x, c.y, c.z ?? 0]; };
    let frontier = [[0, 0, 0, 0]];
    while (frontier.length) {
      const next = [];
      for (const [l, x, y, z] of frontier) {
        const rel = path.posix.normalize(path.posix.join(base, fill(imp.subtrees.uri, l, x, y, z)));
        let buf;
        try { buf = await readFile(local(rel)); } catch { missing.push(rel); continue; }
        subtrees++;
        const sub = await loadSubtree(buf, (b) => readFile(path.join(path.dirname(local(rel)), b)));
        for (let d = 0, off = 0; d < imp.subtreeLevels && l + d < imp.availableLevels; off += arity ** d, d++) {
          for (let i = 0; i < arity ** d; i++) {
            if (!sub.contentBit(off + i)) continue;
            const [a, b, c] = decode(i), n = 2 ** d;
            for (const t of content) tiles.push({ rel: path.posix.normalize(path.posix.join(base, fill(t, l + d, x * n + a, y * n + b, z * n + c))), level: level0 + l + d });
          }
        }
        if (l + imp.subtreeLevels >= imp.availableLevels) continue;
        const n = 2 ** imp.subtreeLevels;
        for (let i = 0; i < arity ** imp.subtreeLevels; i++) {
          if (sub.childBit(i)) { const [a, b, c] = decode(i); next.push([l + imp.subtreeLevels, x * n + a, y * n + b, z * n + c]); }
        }
      }
      frontier = next;
    }
  }
  async function walkTileset(rel, level0) {
    if (seen.has(rel)) return;
    seen.add(rel);
    const base = path.posix.dirname(rel);
    const json = JSON.parse(await readFile(local(rel), 'utf8'));
    await (async function walk(tile, level) {
      if (tile.implicitTiling) return walkImplicit(tile, base, level);
      for (const uri of contentUris(tile)) {
        const target = path.posix.normalize(path.posix.join(base, uri));
        if (/\.json$/i.test(uri)) {
          if (await sizeOf(target)) await walkTileset(target, level); else missing.push(target);
        } else tiles.push({ rel: target, level });
      }
      for (const c of tile.children ?? []) await walk(c, level + 1);
    })(json.root, level0);
  }

  try { await walkTileset('tileset.json', 0); }
  catch (e) {
    signal?.throwIfAborted();
    return { mode, ok: false, error: String(e.message || e), contentTiles: tiles.length, subtrees, levels, missing: missing.length, missingFiles: missing.slice(0, LIST_MAX),
      summary: `The check could not walk the folder: ${e.message}` };
  }

  let points = 0, triangles = 0;
  async function pool(list, work) {
    let next = 0, done = 0;
    await Promise.all(Array.from({ length: Math.min(POOL, list.length) }, async () => {
      while (next < list.length) {
        signal?.throwIfAborted();
        await work(list[next++]);
        if (++done % 200 === 0) onProgress?.(done, list.length);
      }
    }));
  }
  onProgress?.(0, tiles.length);
  await pool(tiles, async ({ rel, level }) => {
    levels[level] = (levels[level] ?? 0) + 1;
    let head;
    try { head = await readTileHead(local(rel), rel); } catch { missing.push(rel); return; }
    if (!head.size) { missing.push(rel); return; }
    if (head.problem) { bad.push({ file: rel, problem: head.problem }); return; }
    points += head.points;
    triangles += head.triangles ?? 0;
    if (head.points) pointsByLevel[level] = (pointsByLevel[level] ?? 0) + head.points;
  });

  // The deep read covers every level, however few tiles the coarse ones have.
  const failed = new Set([...missing, ...bad.map((b) => b.file)]);
  const glbs = tiles.filter((t) => /\.glb$/i.test(t.rel) && !failed.has(t.rel));
  let deep = [];
  if (mode === 'full') deep = glbs;
  else if (mode === 'sample') {
    const byLevel = new Map();
    for (const t of glbs) { if (!byLevel.has(t.level)) byLevel.set(t.level, []); byLevel.get(t.level).push(t); }
    const each = Math.ceil(SAMPLE_TILES / Math.max(1, byLevel.size));
    for (const list of byLevel.values()) {
      const step = Math.max(1, list.length / each);
      for (let i = 0; i < list.length; i += step) deep.push(list[Math.floor(i)]);
    }
  }
  await pool(deep, async ({ rel }) => {
    try {
      const problem = checkGlb(await readFile(local(rel)));
      if (problem) bad.push({ file: rel, problem });
    } catch (e) { bad.push({ file: rel, problem: String(e.message || e) }); }
  });

  const sourceCheck = await compareWithSource(source, points, partial);
  const v = {
    // Nothing at all is never a pass, unless a depth limit stopped above the first tile with content.
    mode, ok: !missing.length && !bad.length && sourceCheck.ok !== false && (tiles.length > 0 || partial),
    partial, contentTiles: tiles.length, subtrees, levels, points, triangles, pointsByLevel, deepChecked: deep.length,
    missing: missing.length, missingFiles: missing.slice(0, LIST_MAX),
    badTiles: bad.length, badFiles: bad.slice(0, LIST_MAX),
    source: sourceCheck,
  };
  return { ...v, summary: summaryOf(v) };
}
