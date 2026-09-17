/**
 * export-live.js — materialise any 3D Tiles tileset into a self-contained LOCAL FOLDER.
 *
 * The far end of the materialization continuum: /stream serves a dataset without storing anything,
 * /convert caches it on this server, and export writes a finished, static OGC 3D Tiles tree that any
 * web server, S3 bucket or Cesium for Unreal can host without this middleware.
 *
 * It works on URLs, not on source formats, so ONE code path covers everything the server can serve:
 * a raw dataset wrapped by /stream or /convert, an /aggregate mosaic, a /proxy'd non-CORS host, or any
 * remote 3D Tiles. The tree keeps its shape; nothing is re-encoded:
 *   - each tileset JSON (root and every external tileset) is downloaded, rewritten, and written out;
 *   - an IMPLICIT tileset is expanded to explicit first (its .subtree availability is read with the
 *     implicit-to-explicit package), because a folder copy must not depend on URL templates whose
 *     query strings point back at this server;
 *   - every content file is downloaded and its uri rewritten to a relative local path.
 *
 * Layout:  <out>/tileset.json · <out>/tilesets/<name>.json · <out>/tiles/<xx>/<name> · export-report.json
 * Tile files are sharded by two hex digits of a hash so a million-tile dataset never puts a million
 * files in one directory. File names keep the source basename, prefixed by a short hash when two
 * different URLs share a basename (every /stream dataset has a "tile/0-0-0-0.glb").
 *
 *   POST   /export            {url, outDir, maxDepth?, overwrite?}   → 202 {id}
 *   GET    /export/<id>       → progress / result
 *   DELETE /export/<id>       → cancel
 *   GET    /export/<id>/files/<path>  → a file of that export's folder (to preview the result as it
 *                                       will be hosted; only folders this server exported are served)
 *
 * The HTTP endpoints WRITE TO THE LOCAL DISK, so they are off unless the server was started with
 * TILED_ALLOW_EXPORT=1 (the desktop app sets it) and they only answer loopback clients.
 * The same exporter is `3dtiled export <url> <outDir>` on the CLI.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { CORS } from '../core/index.js';
import { buildExplicitFromUrl } from '../implicit-to-explicit/index.js';

const hash = (s, n = 8) => createHash('sha1').update(s).digest('hex').slice(0, n);
const KNOWN_EXT = /\.(json|glb|gltf|b3dm|i3dm|pnts|cmpt|subtree|bin|ktx2|png|jpe?g|webp|splat|spz)$/i;

/**
 * The file name a url stands for. Wrapper endpoints carry the real resource in `url=`
 * (/proxy?url=…/Cesium_Brooklyn.json), and their own path ("/proxy") says nothing about it.
 */
function effectiveName(abs) {
  const u = new URL(abs);
  const own = path.posix.basename(u.pathname);
  if (KNOWN_EXT.test(own)) return own;
  const inner = u.searchParams.get('url');
  if (inner) { try { return path.posix.basename(new URL(inner).pathname) || own; } catch { /* not a url */ } }
  return own;
}

/** Is this content an external tileset? By name when it has a known extension, else by sniffing. */
async function isTilesetJson(abs, signal) {
  const name = effectiveName(abs);
  if (KNOWN_EXT.test(name)) return /\.json$/i.test(name);
  const r = await fetch(abs, { signal, headers: { Range: 'bytes=0-0' } });
  const first = r.ok ? Buffer.from(await r.arrayBuffer())[0] : 0;
  return first === 0x7b;                                       // '{'
}
const safeName = (s) => s.replace(/[^\w.\-]+/g, '_').slice(-80) || 'file';

/** Content uris of a tile: `content`, the 3D Tiles 1.0 `content.url` spelling, and 1.1 `contents[]`. */
function contentsOf(tile) {
  const out = [];
  if (tile.content) out.push(tile.content);
  for (const c of tile.contents || []) out.push(c);
  return out;
}
const uriOf = (c) => c.uri ?? c.url;
const setUri = (c, v) => { if ('uri' in c) c.uri = v; else if ('url' in c) c.url = v; else c.uri = v; };

/** GET with retries: a long export meets transient 5xx / resets (Aerometrex's S3 answers the odd 503). */
async function fetchOk(url, signal, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { signal });
      if (r.ok) return r;
      if (r.status < 500 || i >= attempts) throw Object.assign(new Error(`${r.status} ${r.statusText} — ${url.slice(0, 160)}`), { final: true });
    } catch (e) {
      if (e.final || signal?.aborted || i >= attempts) throw e;
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** i));
  }
}

/**
 * Export `rootUrl` into `outDir`. Resolves to the report written to export-report.json.
 * `onProgress(p)` is called as work completes; `signal` cancels.
 */
export async function exportTileset(rootUrl, outDir, { maxDepth = Infinity, concurrency = 8, signal, onProgress, overwrite = false } = {}) {
  outDir = path.resolve(outDir);
  await mkdir(outDir, { recursive: true });
  if (!overwrite) {
    const existing = (await readdir(outDir)).filter((f) => !f.startsWith('.'));
    if (existing.length) throw new Error(`${outDir} is not empty — pick an empty folder (or pass overwrite)`);
  }

  const t0 = Date.now();
  const p = { tilesets: 0, tilesDiscovered: 0, tilesWritten: 0, bytes: 0, failed: 0, implicitExpanded: 0, phase: 'crawling' };
  const failures = [];
  const report = () => onProgress?.({ ...p, elapsedMs: Date.now() - t0 });

  const names = new Map();                     // absolute url → local relative path (posix)
  const taken = new Set();
  function localPathFor(absUrl, dir) {
    let rel = names.get(absUrl);
    if (rel) return rel;
    const base = safeName(effectiveName(absUrl) || 'file');
    const h = hash(absUrl);
    const shard = dir === 'tiles' ? `${h.slice(0, 2)}/` : '';
    rel = `${dir}/${shard}${base}`;
    if (taken.has(rel)) rel = `${dir}/${shard}${h}-${base}`;
    taken.add(rel);
    names.set(absUrl, rel);
    return rel;
  }

  // Downloads run in a bounded pool while the crawl continues; tileset JSONs are crawled one after
  // another (they are few, and their order decides the output names).
  const downloads = [];
  const queued = new Set();                    // absolute urls already scheduled (shared tiles)
  const crawled = new Set();                   // tileset JSONs already crawled (shared externals)
  let active = 0;
  const waiters = [];
  function schedule(absUrl, rel) {
    if (queued.has(absUrl)) return;
    queued.add(absUrl);
    p.tilesDiscovered++;
    downloads.push(download(absUrl, rel));
  }
  async function download(absUrl, rel) {
    while (active >= concurrency) await new Promise((r) => waiters.push(r));
    active++;
    try {
      const buf = Buffer.from(await (await fetchOk(absUrl, signal)).arrayBuffer());
      const dest = path.join(outDir, ...rel.split('/'));
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      p.tilesWritten++;
      p.bytes += buf.length;
    } catch (e) {
      if (signal?.aborted) throw e;
      p.failed++;
      failures.push({ url: absUrl, file: rel, error: String(e.message || e) });
    } finally {
      active--;
      waiters.shift()?.();
      report();
    }
  }

  /** Crawl one tileset JSON; `rel` is where it will be written; `depth0` its root's global depth. */
  async function crawlTileset(url, rel, depth0) {
    signal?.throwIfAborted();
    crawled.add(url);
    let json = await (await fetchOk(url, signal)).json();
    if (json.root?.implicitTiling) {
      p.phase = 'expanding implicit tiling';
      report();
      // Only the levels the depth cap keeps: `depth0` is where this tileset's root sits.
      const maxLevels = Number.isFinite(maxDepth) ? Math.max(1, maxDepth - depth0 + 1) : null;
      json = (await buildExplicitFromUrl(url, { maxLevels })).tileset;
      p.implicitExpanded++;
      p.phase = 'crawling';
    }
    p.tilesets++;
    const fromDir = path.posix.dirname(rel);
    const relTo = (target) => path.posix.relative(fromDir, target) || path.posix.basename(target);

    const external = [];
    const tiles = [];
    (function walk(tile, depth) {
      if (depth >= maxDepth) tile.children = [];
      tiles.push({ tile, depth });
      for (const ch of tile.children || []) walk(ch, depth + 1);
    })(json.root, depth0);
    for (const { tile, depth } of tiles) {
      for (const c of contentsOf(tile)) {
        const uri = uriOf(c);
        if (!uri || /\{level\}|\{x\}|\{y\}|\{z\}/.test(uri)) continue;
        const abs = new URL(uri, url).href;
        if (await isTilesetJson(abs, signal)) {
          const childRel = localPathFor(abs, 'tilesets');
          external.push({ abs, rel: childRel, depth: depth + 1 });
          setUri(c, relTo(childRel));
        } else {
          const tileRel = localPathFor(abs, 'tiles');
          schedule(abs, tileRel);
          setUri(c, relTo(tileRel));
        }
      }
    }

    // an external schema file travels too
    if (typeof json.schemaUri === 'string') {
      const abs = new URL(json.schemaUri, url).href;
      const sRel = localPathFor(abs, 'tilesets');
      schedule(abs, sRel);
      json.schemaUri = relTo(sRel);
    }
    json.asset = { ...json.asset, extras: { ...json.asset?.extras, exportedFrom: url, exportedAt: new Date().toISOString() } };
    const dest = path.join(outDir, ...rel.split('/'));
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, JSON.stringify(json));
    report();
    // Children after the parent is written, depth-first — an external tileset shared by two parents
    // is written once (localPathFor already dedupes its name).
    for (const e of external) {
      if (crawled.has(e.abs)) continue;
      try { await crawlTileset(e.abs, e.rel, e.depth); }
      catch (err) {
        if (signal?.aborted) throw err;
        p.failed++;
        failures.push({ url: e.abs, file: e.rel, error: String(err.message || err) });
      }
    }
  }

  const rootUrlAbs = new URL(rootUrl).href;
  names.set(rootUrlAbs, 'tileset.json');
  taken.add('tileset.json');
  await crawlTileset(rootUrlAbs, 'tileset.json', 0);
  p.phase = 'downloading';
  report();
  await Promise.all(downloads);
  signal?.throwIfAborted();

  const result = {
    source: rootUrl, outDir, ...p, phase: 'done', elapsedMs: Date.now() - t0,
    maxDepth: Number.isFinite(maxDepth) ? maxDepth : null,
    // A failed tile keeps its uri: the tileset stays structurally valid and the gap is listed here,
    // so re-running the export (or fetching just these) can fill it.
    failures,
  };
  await writeFile(path.join(outDir, 'export-report.json'), JSON.stringify(result, null, 2));
  return result;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────

const jobs = new Map();                        // id → { state, progress, result, error, ctrl, … }
const MAX_JOBS = 50;

const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', ...CORS }); res.end(JSON.stringify(body)); };

async function readBody(req, limit = 64 * 1024) {
  let s = '';
  for await (const chunk of req) {
    s += chunk;
    if (s.length > limit) throw new Error('request body too large');
  }
  return s ? JSON.parse(s) : {};
}

const publicJob = (j) => ({ id: j.id, state: j.state, url: j.url, outDir: j.outDir, startedAt: j.startedAt,
  progress: j.progress, result: j.result, error: j.error,
  preview: j.state === 'done' ? `/export/${j.id}/files/tileset.json` : null });

export async function handleExport(req, res, u) {
  if (u.pathname !== '/export' && !u.pathname.startsWith('/export/')) return false;
  if (process.env.TILED_ALLOW_EXPORT !== '1') {
    json(res, 403, { error: 'export is disabled — start the tile-server with TILED_ALLOW_EXPORT=1 (the desktop app does)', enabled: false });
    return true;
  }
  if (!isLoopback(req)) { json(res, 403, { error: 'export only answers loopback clients' }); return true; }

  if (u.pathname === '/export' && req.method === 'GET') {
    json(res, 200, { enabled: true, jobs: [...jobs.values()].map(publicJob) });
    return true;
  }
  if (u.pathname === '/export' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { json(res, 400, { error: e.message }); return true; }
    const { outDir, overwrite } = body;
    const maxDepth = body.maxDepth == null || body.maxDepth === '' ? Infinity : Number(body.maxDepth);
    if (!body.url || !outDir) { json(res, 400, { error: 'body must be {"url": <tileset url>, "outDir": <absolute folder>}' }); return true; }
    if (!path.isAbsolute(outDir)) { json(res, 400, { error: 'outDir must be an absolute path' }); return true; }
    // A server-relative url ("/stream/tileset.json?…") means this server.
    const url = new URL(body.url, `http://127.0.0.1:${req.socket.localPort}`).href;
    if (!/^https?:/.test(url)) { json(res, 400, { error: 'url must be http(s)' }); return true; }
    try {
      await mkdir(outDir, { recursive: true });
      if (!overwrite && (await readdir(outDir)).some((f) => !f.startsWith('.'))) {
        json(res, 409, { error: `${outDir} is not empty — pick an empty folder` });
        return true;
      }
    } catch (e) { json(res, 400, { error: `cannot use ${outDir}: ${e.message}` }); return true; }

    if (jobs.size >= MAX_JOBS) {
      const oldest = [...jobs.values()].filter((j) => j.state !== 'running').sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
      if (oldest) jobs.delete(oldest.id);
    }
    const job = { id: randomUUID(), state: 'running', url, outDir, startedAt: new Date().toISOString(), progress: null, ctrl: new AbortController() };
    jobs.set(job.id, job);
    exportTileset(url, outDir, { maxDepth, overwrite: true, signal: job.ctrl.signal, onProgress: (pr) => { job.progress = pr; } })
      .then((r) => { job.state = 'done'; job.result = r; job.progress = { ...job.progress, ...r, failures: undefined }; })
      .catch((e) => { job.state = job.ctrl.signal.aborted ? 'cancelled' : 'failed'; job.error = String(e.message || e); });
    json(res, 202, { id: job.id, status: `/export/${job.id}` });
    return true;
  }
  const f = u.pathname.match(/^\/export\/([\w-]+)\/files\/(.+)$/);
  if (f) {
    const fjob = jobs.get(f[1]);
    if (!fjob) { json(res, 404, { error: 'no such export' }); return true; }
    const file = path.resolve(fjob.outDir, decodeURIComponent(f[2]));
    if (!file.startsWith(path.resolve(fjob.outDir) + path.sep)) { json(res, 403, { error: 'outside the export folder' }); return true; }
    try {
      const buf = await readFile(file);
      res.writeHead(200, { 'Content-Type': file.endsWith('.json') ? 'application/json' : 'application/octet-stream', ...CORS });
      res.end(buf);
    } catch { json(res, 404, { error: 'no such file' }); }
    return true;
  }
  const m = u.pathname.match(/^\/export\/([\w-]+)$/);
  const job = m && jobs.get(m[1]);
  if (!job) { json(res, 404, { error: 'no such export' }); return true; }
  if (req.method === 'DELETE') {
    job.ctrl.abort();
    json(res, 200, publicJob(job));
    return true;
  }
  json(res, 200, publicJob(job));
  return true;
}

/** Folder size, for tests and the CLI summary. */
export async function folderStats(dir) {
  let files = 0, bytes = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { const s = await folderStats(f); files += s.files; bytes += s.bytes; }
    else { files++; bytes += (await stat(f)).size; }
  }
  return { files, bytes };
}
