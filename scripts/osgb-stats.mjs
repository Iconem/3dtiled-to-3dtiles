#!/usr/bin/env node
/**
 * osgb-stats.mjs — measured geometry statistics of an OSGB (OpenSceneGraph binary tiled mesh) dataset: files, bytes,
 * vertices, triangles, leaf tiles, LOD depth, embedded texture bytes, and the finest level alone.
 *
 *   node scripts/osgb-stats.mjs <…/metadata.xml | …/root.osgb | dataset folder | …/tile.zip> [--server=http://localhost:3016]
 *        [--cache=sample-data/osgb] [--concurrency=8] [--max-files=N] [--max-depth=D] [--out=stats.json] [--quiet]
 *
 * A dataset zipped as one archive (Hong Kong's Planning Department tiles) is read in place through core/zip.js, member
 * by member, and cached extracted. `--max-files` stops the crawl after N files, `--max-depth` keeps it to the first D
 * levels: the counts are then those of the files read, and the JSON says what was left (`cut`: the files named and
 * not read, per depth), for a total to be extrapolated from the levels that were.
 *
 * The crawl follows the dataset the way a client does, file by file: every root `.osgb`, then every finer file a
 * PagedLOD names, down to the files that name none. The files themselves are read with packages/osgb-to-3dtiles's
 * reader, not through the server's GLBs: the reader is what the tiles are built from, it says what it skipped or
 * misread, and it costs no re-encoding. The tile-server is used for one thing only, finding the top tiles of a
 * dataset on a host (its GitHub listing, HTML index and name probing); a local folder or the URL of one root `.osgb`
 * needs no server, and without one the GitHub tree API is asked directly.
 *
 * Every file read from a URL is kept under `--cache` as the dataset has it (`<slug>/<relative path>`, with its
 * metadata.xml), so a dataset is downloaded once and the cached folder is itself a dataset the server can open. A file
 * the dataset names and the host does not have is remembered too (`<path>.missing`).
 *
 * Counting rules. A vertex is a position of an osg::Geometry the reader turns into a mesh; a triangle one of its
 * triangles after strips, fans and quads are expanded (points and lines are dropped, as in the tiles). A tile is one
 * "unit" of a file (one PagedLOD, or the bare meshes of a file); a leaf tile is one with no finer file reachable:
 * either it names none, or every file it names is missing from the copy. The finest level is the set of leaf tiles.
 * Depth 1 is a root file. An embedded texture is an osg::Image with bytes inside the file; an image shared by several
 * geometries of a file is one object in the reader and is counted once (across files nothing can be shared: each
 * `.osgb` is self-contained). Two PagedLODs naming the same finer file read it once.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseOsgb, osgbUnits } from '../packages/osgb-to-3dtiles/src/osgb-reader.js';
import { osgbRootsFromListing } from '../packages/tile-server/osgb-live.js';
import { fetchSource, isAbsent, parallelMap, openZip } from '../packages/core/index.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const isHttp = (u) => /^https?:\/\//i.test(u);
const joinRel = (relDir, child) => path.posix.normalize(path.posix.join(relDir, child));
const encRel = (rel) => rel.split('/').map(encodeURIComponent).join('/');

// ── the source: a folder (local or on a host) with a cache in front of it ────────────────────────────────────────

/** A folder name for the cache from the dataset's base URL: host and path, in file-system-safe characters. */
export function cacheSlug(base) {
  const u = new URL(base);
  return `${u.host}${decodeURIComponent(u.pathname)}`.replace(/\/+$/, '').replace(/[^\p{L}\p{N}._+-]+/gu, '_').slice(0, 180);
}

/**
 * The files of a dataset by their path relative to its folder. `read(rel)` → Buffer, or null when the host says the file
 * is not there (404); any other failure throws. `bytesFetched` / `bytesCached` tell where the bytes came from.
 */
export function openSource(src, { cache } = {}) {
  const http = isHttp(src);
  const clean = http ? src.split('#')[0].split('?')[0] : path.resolve(src).replace(/\\/g, '/');
  const isFile = /\.osgb$/i.test(clean), isMeta = /metadata\.xml$/i.test(clean), isZip = /\.zip$/i.test(clean);
  const base = isFile || isMeta ? clean.slice(0, clean.lastIndexOf('/') + 1) : clean.replace(/\/?$/, '/');
  const entry = isFile ? decodeURIComponent(clean.slice(base.length)) : null;
  const remote = http || isZip;                               // a zip is read member by member, even from disk
  const cacheDir = remote && cache ? path.join(cache, isZip ? cacheSlug(http ? clean : pathToFileURL(clean).href) : cacheSlug(base)) : null;
  const s = { http, base, entry, cacheDir, zip: null, bytesFetched: 0, bytesCached: 0, requests: 0 };
  s.open = async () => { if (isZip && !s.zip) s.zip = await openZip(clean); return s; };

  const local = (rel) => fs.readFile(path.join(remote ? cacheDir : base, rel)).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
  s.read = async (rel, { count = true } = {}) => {
    rel = path.posix.normalize(rel);
    if (rel.startsWith('../') || path.posix.isAbsolute(rel)) throw new Error(`${rel} is outside the dataset`);
    if (!remote) return local(rel);
    if (cacheDir) {
      const hit = await local(rel);
      if (hit) { if (count) s.bytesCached += hit.length; return hit; }
      if (await fs.stat(path.join(cacheDir, `${rel}.missing`)).then(() => true, () => false)) return null;
    }
    s.requests++;
    let buf;
    try { buf = isZip ? await (await s.open()).zip.read(rel) : await fetchSource(base + encRel(rel), { attempts: 3, timeoutMs: 120_000 }); }
    catch (e) {
      if (!isAbsent(e.status)) throw e;
      buf = null;
    }
    if (!buf) {
      if (cacheDir) { await fs.mkdir(path.dirname(path.join(cacheDir, rel)), { recursive: true }); await fs.writeFile(path.join(cacheDir, `${rel}.missing`), ''); }
      return null;
    }
    if (count) s.bytesFetched += buf.length;
    if (cacheDir) { const at = path.join(cacheDir, rel); await fs.mkdir(path.dirname(at), { recursive: true }); await fs.writeFile(at, buf); }
    return buf;
  };
  return s;
}

async function listLocal(dir, rel = '', depth = 0, out = []) {
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (depth < 3) await listLocal(dir, p, depth + 1, out); } else if (/\.osgb$/i.test(e.name)) out.push(p);
  }
  return out;
}

/** The root files named by a tileset the server built: the tile GLBs it points at, which are the roots' units. */
function rootsOfTileset(tileset) {
  const roots = new Set();
  const walk = (t) => {
    const m = /^\/stream\/tile\/(.+)__\d+\.glb\?/.exec(t.content?.uri || '');
    if (m) roots.add(decodeURIComponent(m[1]));
    const from = /[?&]from=([^&]+)/.exec(t.content?.uri || '');       // a fragment link carries its parent's key
    if (from && /^\/stream\/osgb\/node\//.test(t.content.uri)) roots.add(decodeURIComponent(decodeURIComponent(from[1]).replace(/__\d+$/, '')));
    for (const c of t.children || []) if (!/^\/stream\/osgb\/node\//.test(c.content?.uri || '')) walk(c);
  };
  walk(tileset.root);
  return [...roots].sort();
}

/** The .osgb paths under a raw.githubusercontent.com folder, through the tree API, or null for any other host. */
async function listGithub(base) {
  const m = /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.*)$/i.exec(base);
  if (!m) return null;
  const [, owner, repo, ref, dirEnc] = m, dir = decodeURIComponent(dirEnc);
  const headers = { 'User-Agent': '3dtiled-osgb-stats', Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
  const tree = JSON.parse((await fetchSource(`https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, { headers, attempts: 1, timeoutMs: 30_000 })).toString('utf8'));
  if (tree.truncated) throw new Error('the GitHub tree listing is truncated');
  return tree.tree.filter((t) => t.type === 'blob' && t.path.startsWith(dir) && /\.osgb$/i.test(t.path)).map((t) => t.path.slice(dir.length));
}

/** The top tiles of the dataset: the given .osgb, a listing of the folder, or what the tile-server finds. */
export async function findRoots(s, src, { server, log = () => {} } = {}) {
  if (s.entry) return [s.entry];
  if (s.zip) return osgbRootsFromListing(s.zip.names);
  if (!s.http) return osgbRootsFromListing(await listLocal(s.base));
  if (server) {
    try {
      const url = `${server.replace(/\/$/, '')}/stream/tileset.json?format=osgb&url=${encodeURIComponent(src)}`;
      const roots = rootsOfTileset(JSON.parse((await fetchSource(url, { attempts: 1, timeoutMs: 300_000 })).toString('utf8')));
      if (roots.length) return roots;
      log(`the server's root tileset names no tile: listing the host instead`);
    } catch (e) { log(`no root tileset from ${server} (${e.message}): listing the host instead`); }
  }
  const listing = await listGithub(s.base);
  if (!listing) throw new Error(`cannot list ${s.base}: give the URL of a root .osgb, or a running tile-server (--server=)`);
  return osgbRootsFromListing(listing);
}

// ── counting ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every osg::Image with pixels inside the file, each object once however many geometries share it. */
export function embeddedImages(scene) {
  const seen = new Set(), out = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object' || ArrayBuffer.isView(o) || seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) { for (const v of o) walk(v); return; }
    if (o.class === 'osg::Image') { if (o.file || o.pixels) out.push(o); return; }
    for (const v of Object.values(o)) walk(v);
  };
  walk(scene.root);
  return out;
}

const fresh = () => ({ files: 0, bytes: 0, units: 0, meshes: 0, vertices: 0, triangles: 0, textures: 0, textureBytes: 0 });
const add = (acc, d) => { for (const k of Object.keys(d)) acc[k] = (acc[k] || 0) + d[k]; };
/** What an embedded image is: the file format by its magic bytes, or the OpenGL pixel format of raw pixels. */
export function imageKind(img) {
  if (img.file) {
    const f = img.file;
    if (f[0] === 0xff && f[1] === 0xd8) return 'jpeg';
    if (f[0] === 0x89 && f[1] === 0x50) return 'png';
    if (f.toString('latin1', 0, 4) === 'DDS ') return 'dds';
    return 'file';
  }
  const fmt = { 0x83f0: 'dxt1', 0x83f1: 'dxt1a', 0x83f2: 'dxt3', 0x83f3: 'dxt5', 0x1907: 'rgb', 0x1908: 'rgba', 0x80e0: 'bgr', 0x80e1: 'bgra', 0x1909: 'luminance' };
  return `raw ${fmt[img.pixelFormat] || fmt[img.internalFormat] || `0x${(img.pixelFormat >>> 0).toString(16)}`}`;
}

/** What one parsed file contributes. */
export function fileStats(buf) {
  const scene = parseOsgb(buf), units = osgbUnits(scene), images = embeddedImages(scene);
  const d = { ...fresh(), files: 1, bytes: buf.length, units: units.length, textures: images.length }, kinds = {};
  for (const img of images) { d.textureBytes += img.file ? img.file.length : img.pixels.length; const k = imageKind(img); kinds[k] = (kinds[k] || 0) + 1; }
  const perUnit = units.map((u) => {
    const v = u.meshes.reduce((n, m) => n + m.positions.length / 3, 0), t = u.meshes.reduce((n, m) => n + m.indices.length / 3, 0);
    d.meshes += u.meshes.length; d.vertices += v; d.triangles += t;
    return { vertices: v, triangles: t, files: u.files, rangeMode: u.rangeMode };
  });
  return { d, perUnit, kinds, version: scene.header.version, compressor: scene.header.compressor, skipped: scene.skipped, misread: scene.misread };
}

/**
 * Crawl a dataset and count it.
 * @param {string} src a metadata.xml or root .osgb URL, or a local folder / file
 * @param {{ server?: string, cache?: string, concurrency?: number, maxFiles?: number, maxDepth?: number, log?: (line: string) => void }} opts
 */
export async function osgbStats(src, { server, cache, concurrency = 8, maxFiles = Infinity, maxDepth = Infinity, log = () => {} } = {}) {
  const t0 = performance.now();
  const s = await openSource(src, { cache }).open();
  const roots = await findRoots(s, src, { server, log });
  if (!roots.length) throw new Error(`no root .osgb found under ${s.base}`);
  log(`${roots.length} root file(s) under ${s.base}`);
  // keep the dataset's metadata.xml with its files (the cache only holds what is under the base folder); not counted
  if (s.zip) { for (const n of s.zip.names) if (/(^|\/)metadata\.xml$/i.test(n)) try { await s.read(n, { count: false }); } catch { /* none */ } }
  else if (s.http && s.cacheDir) try { await s.read('metadata.xml', { count: false }); } catch { /* none */ }

  const total = fresh(), perDepth = [], versions = {}, compressors = {}, textureKinds = {}, skipped = new Set(), misread = new Set();
  const missing = [], failed = [], seen = new Set(roots), unitRecords = [], cut = [];
  let duplicates = 0, read = 0;
  let queue = roots.map((rel) => ({ rel, depth: 1 }));
  while (queue.length) {
    const depth = queue[0].depth, next = [];
    // the limits: a level past --max-depth, or the files past --max-files, are named but not read
    if (depth > maxDepth || read >= maxFiles) { cut[depth - 1] = (cut[depth - 1] || 0) + queue.length; break; }
    if (read + queue.length > maxFiles) { const keep = maxFiles - read; cut[depth - 1] = (cut[depth - 1] || 0) + queue.length - keep; queue = queue.slice(0, keep); }
    read += queue.length;
    await parallelMap(queue, async ({ rel }) => {
      let buf;
      try { buf = await s.read(rel); } catch (e) { failed.push({ file: rel, error: e.message }); return; }
      if (!buf) { missing.push(rel); return; }
      let r;
      try { r = fileStats(buf); } catch (e) { failed.push({ file: rel, error: e.message }); return; }
      add(total, r.d);
      perDepth[depth - 1] ??= fresh();
      add(perDepth[depth - 1], r.d);
      versions[r.version] = (versions[r.version] || 0) + 1;
      compressors[r.compressor] = (compressors[r.compressor] || 0) + 1;
      for (const [k, v] of Object.entries(r.kinds)) textureKinds[k] = (textureKinds[k] || 0) + v;
      for (const c of r.skipped) skipped.add(c);
      for (const c of r.misread) misread.add(c);
      const dir = path.posix.dirname(rel);
      for (const u of r.perUnit) {
        const finer = u.files.map((f) => joinRel(dir, f));
        unitRecords.push({ depth, vertices: u.vertices, triangles: u.triangles, finer });
        for (const f of finer) { if (seen.has(f)) duplicates++; else { seen.add(f); next.push({ rel: f, depth: depth + 1 }); } }
      }
    }, { concurrency });
    log(`depth ${depth}: ${queue.length} file(s), ${(total.bytes / 1e6).toFixed(1)} MB so far, ${next.length} finer file(s) named`);
    queue = next;
  }

  // leaf tiles: units with no finer file reachable (none named, or every one named missing from this copy); a unit
  // whose finer files a limit left unread names files that are neither read nor missing, so it is not a leaf
  const absent = new Set(missing);
  const finest = { units: 0, vertices: 0, triangles: 0, cut: 0 };
  const cutTotal = cut.reduce((n, v) => n + (v || 0), 0);
  for (const u of unitRecords) {
    if (u.finer.length && !u.finer.every((f) => absent.has(f))) continue;
    finest.units++; finest.vertices += u.vertices; finest.triangles += u.triangles;
    if (u.finer.length) finest.cut++;
  }
  const seconds = (performance.now() - t0) / 1000;
  await s.zip?.close?.();
  return {
    source: src, base: s.base, roots: roots.length, depth: perDepth.length,
    ...total, leafTiles: finest.units, finest,
    perDepth, versions, compressors, textureKinds, skipped: [...skipped], misread: [...misread],
    missing: missing.length, missingFiles: missing.slice(0, 50), failed, duplicateReferences: duplicates,
    cut: cutTotal ? Array.from(cut, (v) => v || 0) : null, limits: cutTotal ? { maxFiles: Number.isFinite(maxFiles) ? maxFiles : null, maxDepth: Number.isFinite(maxDepth) ? maxDepth : null } : null,
    bytesFetched: s.bytesFetched, bytesCached: s.bytesCached, requests: s.requests, seconds: Number(seconds.toFixed(1)),
    cacheDir: s.cacheDir, date: new Date().toISOString().slice(0, 10),
  };
}
export const summaryLine = (r) => {
  const mb = (b) => (b && b < 1e6 ? `${Math.round(b / 1e3)} KB` : `${(b / 1e6).toFixed(1)} MB`);
  const lose = r.missing || r.failed.length ? `, ${r.missing} missing, ${r.failed.length} failed` : '';
  const cut = r.cut ? ` · CUT: ${r.cut.reduce((n, v) => n + v, 0)} file(s) named and not read (${r.cut.map((v, i) => `${v} at depth ${i + 1}`).filter((_, i) => r.cut[i]).join(', ')})` : '';
  return `${r.files} files (${mb(r.bytes)}, ${r.roots} roots, depth ${r.depth}${lose}) · ${r.units} tiles, ${r.leafTiles} leaves · ${r.vertices.toLocaleString('en')} vertices, ${r.triangles.toLocaleString('en')} triangles (finest level ${r.finest.vertices.toLocaleString('en')} / ${r.finest.triangles.toLocaleString('en')}) · ${r.textures} textures (${Object.entries(r.textureKinds).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}), ${mb(r.textureBytes)} · versions ${Object.keys(r.versions).join(',')}${r.skipped.length ? ` · skipped ${r.skipped.join(',')}` : ''}${r.misread.length ? ` · misread ${r.misread.join(',')}` : ''}${cut} · ${r.seconds} s, ${mb(r.bytesFetched)} downloaded`;
};

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), flag = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
  const src = args.find((a) => !a.startsWith('--'));
  if (!src) { console.error('usage: node scripts/osgb-stats.mjs <metadata.xml | root.osgb URL | folder | tile.zip> [--server=http://localhost:3016] [--cache=sample-data/osgb] [--concurrency=8] [--max-files=N] [--max-depth=D] [--out=file.json] [--quiet]'); process.exit(2); }
  const quiet = args.includes('--quiet');
  const opts = {
    server: flag('server', 'http://localhost:3016'), cache: path.resolve(REPO, flag('cache', 'sample-data/osgb')),
    concurrency: Number(flag('concurrency', 8)), log: quiet ? () => {} : (l) => console.error(`[osgb-stats] ${l}`),
    maxFiles: Number(flag('max-files', Infinity)), maxDepth: Number(flag('max-depth', Infinity)),
  };
  try {
    const r = await osgbStats(src, opts);
    console.log(summaryLine(r));
    const json = JSON.stringify(r, null, 2);
    if (flag('out')) { await fs.writeFile(flag('out'), json); console.error(`[osgb-stats] written to ${flag('out')}`); } else console.log(json);
  } catch (e) { console.error(`[osgb-stats] ${e.message}`); process.exit(1); }
}
