/**
 * osgb-live.js — live **OSGB (OpenSceneGraph binary tiled mesh) → OGC 3D Tiles** streaming middleware.
 *
 * OSGB is what photogrammetry software writes when asked for an "OpenSceneGraph" tiled model: Bentley ContextCapture /
 * iTwin Capture, DJI Terra, Smart3D, Skyline PhotoMesh, Metashape. A dataset is a folder: `metadata.xml` (the SRS and
 * its origin) and, per top tile, a chain of `.osgb` files, each one level of detail of that tile. A file is a small
 * OpenSceneGraph scene: `osg::PagedLOD` nodes, each holding its own coarse textured mesh and the NAME of the file that
 * refines it. The hierarchy is therefore spread over every file, exactly as in 3MX, and is served the same way: one
 * `.osgb` → one tileset.json fragment, fetched as the camera refines in (packages/osgb-to-3dtiles reads the files).
 *
 *   GET /stream/tileset.json?url=<…/metadata.xml | dataset folder | one .osgb>&format=osgb
 *   GET /stream/osgb/node/<encRelPath>.json?url=<same>[&ge=&bs=]      (lazy fragment for a finer .osgb)
 *   GET /stream/tile/<encRelPath>__<unit>.glb?url=<same>&format=osgb
 *
 * `url` is an http(s) URL or a local path. A folder cannot be listed over plain HTTP, so the top tiles are found by,
 * in order: the folder's own listing (a local folder, a GitHub raw URL through the GitHub tree API, a server's HTML
 * index of `Data/`), then by asking for the names the exporters use (`Data/Tile_+xxx_+yyy/Tile_+xxx_+yyy.osgb` walked
 * outwards from the tiles found, `Block/Block.osgb`, `Data/Model/Model.osgb`). A dataset laid out otherwise is opened
 * by the URL of its root `.osgb`.
 *
 * TILE = one PagedLOD of one file ("unit"): bounding sphere as OSG has it (the PagedLOD's user-defined centre and
 * radius, which bound the finer levels too), content = its inline mesh, children = the file that refines it, as an
 * external tileset. `refine: REPLACE`.
 *
 * GEOMETRIC ERROR. A PagedLOD in PIXEL_SIZE_ON_SCREEN mode (every export seen) hands over to the finer file when its
 * bounding sphere is `range` pixels across on screen. A 3D Tiles client refines when geometricError · K / distance
 * exceeds its threshold (K = viewport height / 2·tan(fov/2)), and the sphere is 2r · K / distance pixels across. Both
 * switch at the same distance when
 *     geometricError = 2 · radius · 16 / range                 (16 px: the default maximumScreenSpaceError)
 * In DISTANCE_FROM_EYE_POINT mode the finer file takes over under `range` metres, so geometricError = 16 · range / K
 * with K taken for a 1080 px viewport and a 60° field of view (935). A unit with no finer file has error 0.
 *
 * FRAMES. OSG is Z-up, as is a 3D Tiles tileset: bounding volumes are written as read. Tile content is glTF (Y-up), so
 * a mesh is written (x, z, −y) (mesh-tile.js). `metadata.xml` gives the root transform: `ENU:lat,lon` is an east-north-up
 * frame at that point, `EPSG:n` (or WKT) a projected CRS placed through core/geo.js, both offset by `SRSOrigin`.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import proj4 from 'proj4';
import { georefFromCrs, crsDefinition, llhToEcef, enuMatrix, mat4Multiply, memoizeAsync, fetchSource, requestSource, isAbsent, parallelMap, tilePool, runTileTaskOr, ownBytes } from '../core/index.js';
import { parseOsgb, osgbUnits } from '../osgb-to-3dtiles/src/osgb-reader.js';
import { osgbUnitGlb } from './mesh-tile.js';

const isHttp = (u) => /^https?:\/\//i.test(u);
const joinRel = (relDir, child) => path.posix.normalize(path.posix.join(relDir, child));
const encRel = (rel) => rel.split('/').map(encodeURIComponent).join('/');
const SSE = 16, K_DISTANCE = 1080 / (2 * Math.tan(Math.PI / 6));

// ── source files, cached ─────────────────────────────────────────────────────────────────────────────────────────
// A fragment request and the tile requests that follow it read the same file: keep the last files read, by size.
const CACHE_BYTES = (Number(process.env.TILED_OSGB_CACHE_MB) || 256) * 1e6;
const files = new Map();                                    // key → { promise, bytes }
let cached = 0;
function readFile(ctx, rel) {
  rel = path.posix.normalize(rel);
  const key = `${ctx.base}\n${rel}`;
  const hit = files.get(key);
  if (hit) { files.delete(key); files.set(key, hit); return hit.promise; }
  if (rel.startsWith('../') || rel === '..' || path.posix.isAbsolute(rel)) return Promise.reject(Object.assign(new Error(`osgb: ${rel} is outside the dataset`), { status: 404 }));
  const entry = { bytes: 0 };
  entry.promise = (ctx.http ? fetchSource(ctx.base + encRel(rel))
    : fs.readFile(path.join(ctx.base, rel)).catch((e) => { throw e.code === 'ENOENT' ? Object.assign(e, { status: 404 }) : e; }))
    .then((buf) => {
      entry.bytes = buf.length; cached += buf.length;
      for (const [k, e] of files) { if (cached <= CACHE_BYTES || e === entry) break; files.delete(k); cached -= e.bytes; }
      return buf;
    }, (e) => { files.delete(key); throw e; });
  files.set(key, entry);
  return entry.promise;
}

// ── metadata.xml ─────────────────────────────────────────────────────────────────────────────────────────────────
/** `<SRS>` and `<SRSOrigin>` of a metadata.xml → { srs, origin } (origin [0,0,0] when absent). */
export function parseOsgbMetadata(xml) {
  const tag = (name) => (new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(xml) || [])[1]?.trim();
  const srs = tag('SRS') || null;
  const origin = (tag('SRSOrigin') || '').split(/[\s,]+/).map(Number).filter(Number.isFinite);
  while (origin.length < 3) origin.push(0);
  return { srs, origin: origin.slice(0, 3) };
}

// proj4 knows two EPSG codes and core/geo.js a few dozen; an export's metadata.xml can name any. The definition of a
// code met for the first time is asked from epsg.io, once per process; without an answer the dataset is served local.
const epsgDef = memoizeAsync(async (code) => {
  const def = (await fetchSource(`https://epsg.io/${code}.proj4`, { timeoutMs: 8000, attempts: 1 })).toString('utf8').trim();
  if (!def.startsWith('+proj')) throw new Error(`no proj4 definition for EPSG:${code}`);
  return def;
});

/** The root transform of a dataset from its metadata, or null when it has no (usable) georeference. */
export async function osgbGeoref({ srs, origin }) {
  if (!srs) return null;
  const enu = /^ENU\s*:\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/i.exec(srs);           // ENU:<lat>,<lon>, origin in metres in that frame
  if (enu) {
    const lat = Number(enu[1]), lon = Number(enu[2]), e = llhToEcef(lon, lat, 0);
    return mat4Multiply(enuMatrix(lon, lat, e[0], e[1], e[2]), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, origin[0], origin[1], origin[2], 1]);
  }
  const epsg = /^EPSG\s*:\s*(\d+)/i.exec(srs);
  if (epsg && +epsg[1] === 4978) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, origin[0], origin[1], origin[2], 1];   // geocentric: the model is in ECEF already
  let crs = epsg ? `EPSG:${epsg[1]}` : srs;                                  // "EPSG:32650+5773" → the horizontal part
  if (epsg) {
    let known = crsDefinition(crs) !== crs;
    if (!known) try { proj4(crs); known = true; } catch { /* not one proj4 was born with */ }
    if (!known) try { crs = await epsgDef(+epsg[1]); } catch (e) { console.warn(`[osgb-live] EPSG:${epsg[1]} has no definition here (${e.message}): served without georeference`); return null; }
  }
  return georefFromCrs(origin, crs, 'osgb-live');
}

// ── finding the top tiles ────────────────────────────────────────────────────────────────────────────────────────
const LEVEL_RE = /_L\d+_[^/]*\.osgb$/i;                      // Tile_+000_+000_L17_00.osgb, Block_L15_1.osgb: a finer level, not a root

/**
 * The root files of a dataset from the paths of its .osgb files (relative to the dataset folder): in each folder, the
 * file named after the folder, else those that are not a level of another. An index file at the top of the dataset
 * (DJI Terra's Block.osgb) is left out when folders below have roots: it only repeats them.
 */
export function osgbRootsFromListing(paths) {
  const dirs = new Map();
  for (const p of paths) { if (!/\.osgb$/i.test(p)) continue; const d = path.posix.dirname(p); if (!dirs.has(d)) dirs.set(d, []); dirs.get(d).push(p); }
  const roots = [];
  for (const [d, list] of dirs) {
    const named = list.find((p) => path.posix.basename(p).toLowerCase() === `${path.posix.basename(d).toLowerCase()}.osgb`);
    const plain = list.filter((p) => !LEVEL_RE.test(p));
    if (named && d !== '.') roots.push(named);
    else if (plain.length) roots.push(...plain);
    else {                                                   // a folder of levels only (a copy without its root): start at the coarsest one
      const level = (p) => Number(/_L(\d+)_[^/]*$/i.exec(p)[1]), min = Math.min(...list.map(level));
      roots.push(...list.filter((p) => level(p) === min));
    }
  }
  const below = roots.filter((p) => p.includes('/'));
  return (below.length ? below : roots).sort();
}

async function listLocal(dir, rel = '', depth = 0, out = []) {
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (depth < 3) await listLocal(dir, p, depth + 1, out); } else if (/\.osgb$/i.test(e.name)) out.push(p);
  }
  return out;
}

/** The .osgb paths under a raw.githubusercontent.com folder, through the tree API (one request), or null. */
async function listGithub(base) {
  const m = /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.*)$/i.exec(base);
  if (!m) return null;
  const [, owner, repo, ref, dirEnc] = m, dir = decodeURIComponent(dirEnc);
  try {
    const headers = { 'User-Agent': '3dtiled-tile-server', Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
    const tree = JSON.parse((await fetchSource(`https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, { headers, attempts: 1, timeoutMs: 30_000 })).toString('utf8'));
    if (tree.truncated) return null;
    return tree.tree.filter((t) => t.type === 'blob' && t.path.startsWith(dir) && /\.osgb$/i.test(t.path)).map((t) => t.path.slice(dir.length));
  } catch (e) { console.warn(`[osgb-live] GitHub listing failed (${e.message}): probing names instead`); return null; }
}

/** The tile folders of an HTML directory index (nginx/Apache autoindex, S3 website listings), as root paths, or null. */
async function listHtmlIndex(base) {
  for (const data of ['Data/', 'data/']) {
    try {
      const { headers, body } = await requestSource(base + data, { attempts: 1, timeoutMs: 15_000 });
      if (!/html/i.test(headers.get('content-type') || '')) continue;
      const names = [...body.toString('utf8').matchAll(/href="(?:\.\/)?([^"?#/][^"?#/]*)\/"/gi)].map((h) => decodeURIComponent(h[1])).filter((n) => n !== '..');
      if (names.length) return names.map((n) => `${data}${n}/${n}.osgb`);
    } catch { /* no index here */ }
  }
  return null;
}

/** True when the source has this file (it is then in the cache for the read that follows). */
const has = (ctx, rel) => readFile(ctx, rel).then(() => true, (e) => { if (isAbsent(e.status)) return false; throw e; });

/** Top tiles by the names the exporters use, for a host that lists nothing. */
async function probeRoots(ctx) {
  const tile = (x, y) => { const n = (v) => `${v < 0 ? '-' : '+'}${String(Math.abs(v)).padStart(3, '0')}`; return `Tile_${n(x)}_${n(y)}`; };
  for (const data of ['Data/', 'data/', '']) {
    const rel = (x, y) => `${data}${tile(x, y)}/${tile(x, y)}.osgb`;
    // ContextCapture numbers its tiles on a grid that need not start at 0: look over a first window, then walk outwards
    const window = [];
    for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) window.push([x, y]);
    const seen = new Set(), found = [];
    let frontier = [];
    await parallelMap(window, async ([x, y]) => { seen.add(`${x},${y}`); if (await has(ctx, rel(x, y))) { found.push(rel(x, y)); frontier.push([x, y]); } }, { concurrency: 12 });
    while (frontier.length && found.length < 20000) {
      const next = [];
      for (const [x, y] of frontier) for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) { const k = `${x + dx},${y + dy}`; if (!seen.has(k)) { seen.add(k); next.push([x + dx, y + dy]); } }
      frontier = [];
      await parallelMap(next, async ([x, y]) => { if (await has(ctx, rel(x, y))) { found.push(rel(x, y)); frontier.push([x, y]); } }, { concurrency: 12 });
    }
    if (found.length) return found.sort();
  }
  for (const rel of ['Block/Block.osgb', 'Data/Block/Block.osgb', 'Data/Block.osgb', 'Data/Model/Model.osgb', 'Block.osgb', 'Data/main.osgb', 'main.osgb']) if (await has(ctx, rel)) return [rel];
  return [];
}

// ── per-URL context ──────────────────────────────────────────────────────────────────────────────────────────────
const getCtx = memoizeAsync(async (url) => {
  const http = isHttp(url);
  const clean = http ? url.split('#')[0].split('?')[0] : url.replace(/\\/g, '/');
  const ctx = { http, base: '', roots: [], transform: null, srs: null };
  const isFile = /\.osgb$/i.test(clean);
  ctx.base = isFile || /metadata\.xml$/i.test(clean) ? clean.slice(0, clean.lastIndexOf('/') + 1) : clean.replace(/\/?$/, '/');

  // metadata.xml sits at the top of the dataset: beside the root .osgb, or up to two folders above it (Data/Tile/…)
  let meta = null;
  for (const up of isFile ? ['', '../', '../../'] : ['']) {
    try {
      const at = http ? new URL(`${up}metadata.xml`, ctx.base).href : path.posix.join(ctx.base, up, 'metadata.xml');
      meta = parseOsgbMetadata((http ? await fetchSource(at, { attempts: 2 }) : await fs.readFile(at)).toString('utf8'));
      break;
    } catch (e) { if (e.transient) throw e; }
  }
  if (meta) { ctx.srs = meta.srs; ctx.transform = await osgbGeoref(meta); }

  if (isFile) ctx.roots = [decodeURIComponent(clean.slice(ctx.base.length))];
  else {
    const listing = http ? (await listGithub(ctx.base)) : await listLocal(ctx.base);
    ctx.roots = listing ? osgbRootsFromListing(listing) : (await listHtmlIndex(ctx.base)) || [];
    if (!ctx.roots.length && http) ctx.roots = await probeRoots(ctx);
    if (!ctx.roots.length) throw Object.assign(new Error(`osgb: no root .osgb found under ${ctx.base.slice(-120)}. Give the URL of the dataset's root .osgb file.`), { status: 404 });
  }
  console.log(`[osgb-live] ${clean.slice(-100)} → ${ctx.roots.length} top tile(s), srs=${ctx.srs || 'none'}, georef=${!!ctx.transform}`);
  return ctx;
});

// ── tiles ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The geometric error of a unit (see the header for the formula). */
export function osgbGeometricError(unit) {
  if (!unit.files.length) return 0;
  if (unit.rangeMode === 'distance') return SSE * unit.range / K_DISTANCE;
  return 2 * unit.radius * SSE / Math.max(unit.range ?? 0, 1);                // a range of 0 px: always refine
}

const sphere = (u) => [u.center[0], u.center[1], u.center[2], Math.max(u.radius, 1e-3)];
const num = (v) => Number(v.toPrecision(9));

/** The tiles of one .osgb file: one per unit, each with its mesh as content and its finer files as external tilesets. */
async function fileTiles(ctx, relPath, masterUrl) {
  const enc = encodeURIComponent(masterUrl), relDir = path.posix.dirname(relPath);
  const units = osgbUnits(parseOsgb(await readFile(ctx, relPath)));
  return units.map((u, i) => {
    const ge = num(osgbGeometricError(u)), bs = sphere(u).map(num);
    const tile = { boundingVolume: { sphere: bs }, geometricError: ge, refine: 'REPLACE' };
    // Absolute URIs: a fragment is served at /stream/tileset.json or nested under /stream/osgb/node/…, and a relative
    // "tile/…" would resolve against the fragment's own path (the same as threemx-live.js).
    if (u.meshes.length) tile.content = { uri: `/stream/tile/${encodeURIComponent(relPath)}__${i}.glb?url=${enc}&format=osgb` };
    // The finer file is another tileset. Its tile here has the bounding sphere and the error of this one, and the
    // fragment answers with a root that has them too (&ge, &bs), so that it is refined exactly when this tile is.
    if (u.files.length) tile.children = u.files.map((f) => ({
      boundingVolume: { sphere: bs }, geometricError: ge, refine: 'REPLACE',
      content: { uri: `/stream/osgb/node/${encodeURIComponent(joinRel(relDir, f))}.json?url=${enc}&ge=${ge}&bs=${bs.join(',')}${u.meshes.length ? `&from=${encodeURIComponent(`${encodeURIComponent(relPath)}__${i}`)}` : ''}` },
    }));
    return tile;
  });
}

/** The smallest sphere holding spheres a and b ([x, y, z, r]). */
function unionSphere(a, b) {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  if (d + b[3] <= a[3]) return a;
  if (d + a[3] <= b[3]) return b;
  const r = (d + a[3] + b[3]) / 2, t = (r - a[3]) / d;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, r];
}

/** One tile over `tiles`: no content, their union as bounds, and an error no smaller than theirs nor than its own size. */
function groupTile(tiles) {
  const bs = tiles.map((t) => t.boundingVolume.sphere).reduce(unionSphere);
  return { boundingVolume: { sphere: bs.map(num) }, geometricError: num(Math.max(2 * bs[3], ...tiles.map((t) => t.geometricError))), refine: 'REPLACE', children: tiles };
}

/** A dataset of hundreds of top tiles under one root is a root with hundreds of children: split them in two along the longer axis until a group is small. */
function groupSpatially(tiles, max = 16) {
  if (tiles.length <= max) return tiles;
  const c = (t, k) => t.boundingVolume.sphere[k];
  const span = (k) => Math.max(...tiles.map((t) => c(t, k))) - Math.min(...tiles.map((t) => c(t, k)));
  const k = span(0) >= span(1) ? 0 : 1, sorted = [...tiles].sort((a, b) => c(a, k) - c(b, k)), half = sorted.length >> 1;
  return [sorted.slice(0, half), sorted.slice(half)].map((part) => groupTile(groupSpatially(part, max)));
}

const tilesetOf = (root) => ({ asset: { version: '1.1' }, geometricError: root.geometricError, root });

async function buildRoot(ctx, url) {
  const perFile = new Array(ctx.roots.length);
  // A top tile a dataset lists but the host does not have (a partial copy) is left out; one that cannot be read is an error.
  await parallelMap(ctx.roots, async (rel, i) => {
    try { perFile[i] = await fileTiles(ctx, rel, url); }
    catch (e) { if (ctx.roots.length > 1 && isAbsent(e.status)) perFile[i] = []; else throw e; }
  }, { concurrency: 16 });
  const tiles = perFile.flat();
  if (!tiles.length) throw Object.assign(new Error('osgb: the root files hold no mesh and name no finer file'), { status: 404 });
  const root = tiles.length === 1 ? tiles[0] : groupTile(groupSpatially(tiles));
  if (ctx.transform) root.transform = ctx.transform;
  return tilesetOf(root);
}

/**
 * The fragment of a finer file. `ge`/`bs` are the error and sphere of the tile that points here (see fileTiles), `from`
 * its key. A finer file the dataset names but does not have (a copy cut at some level, as the samples on the web often
 * are) is answered with that tile's own mesh again, as a leaf: the coarser level stays on screen where the finer one is
 * missing, instead of a hole.
 */
async function buildFragment(ctx, relPath, url, { ge, bs, from } = {}) {
  let tiles;
  try { tiles = await fileTiles(ctx, relPath, url); }
  catch (e) {
    // `from` is a tile key as fileTiles wrote it, percent-encoded already: it goes back into a URI as it came
    if (!isAbsent(e.status) || !from || !/^[\w%.~!*'()+-]+__\d+$/.test(from) || bs?.length !== 4 || !bs.every(Number.isFinite)) throw e;
    return tilesetOf({ boundingVolume: { sphere: bs }, geometricError: 0, refine: 'REPLACE', content: { uri: `/stream/tile/${from}.glb?url=${encodeURIComponent(url)}&format=osgb` } });
  }
  if (!tiles.length) return null;
  if (tiles.length === 1) return tilesetOf(tiles[0]);
  const root = groupTile(tiles);
  if (Number.isFinite(ge) && bs?.length === 4 && bs.every(Number.isFinite)) { root.geometricError = ge; root.boundingVolume = { sphere: bs }; }
  return tilesetOf(root);
}

// ── per-unit GLB ─────────────────────────────────────────────────────────────────────────────────────────────────
const MESH_TASKS = new URL('./tile-tasks-mesh.js', import.meta.url).href;   // what a tile worker runs (TILED_WORKERS)

async function buildUnitGlb(ctx, relPath, unitIdx) {
  const file = await readFile(ctx, relPath);
  const here = async () => { const glb = await osgbUnitGlb(file, unitIdx); return glb ? Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength) : null; };
  const pool = tilePool();
  if (!pool) return here();
  const bytes = ownBytes(file);
  const glb = await runTileTaskOr(pool, MESH_TASKS, 'osgbTileTask', { bytes, unitIdx }, [bytes.buffer], here);
  return !glb || Buffer.isBuffer(glb) ? glb : Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength);
}

// Pure builders for the /stream dispatcher.
export const osgbTileRe = /^.+__\d+$/;                       // <encodeURIComponent(relPath)>__<unit>
export async function osgbTileset(url) { return buildRoot(await getCtx(url), url); }
export async function osgbTile(url, key) {
  const us = key.lastIndexOf('__');
  return buildUnitGlb(await getCtx(url), decodeURIComponent(key.slice(0, us)), Number(key.slice(us + 2)));
}
/** Lazy fragment continuation for a finer .osgb, called from stream-live.js's /stream/osgb/node/<path>.json. */
export async function osgbNode(url, relPath, hint) { return buildFragment(await getCtx(url), relPath, url, hint); }
