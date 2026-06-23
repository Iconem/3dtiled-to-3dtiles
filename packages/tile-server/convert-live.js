/**
 * convert-live.js — generic <fmt> → 3D Tiles live middleware (any format the meta-converter supports).
 *
 * The COPC path (server.js) is per-tile: each request HTTP-range-reads one octree node. This path is
 * per-dataset: on the FIRST request it runs the in-process `convert()` once (cached on disk) and then
 * serves the static 3D Tiles output. Not range-streamed, but genuinely on-demand for ANY format —
 * potree, sog (streamed-SOG), rad, lcc, copc, i3s.
 *
 *   GET /convert/tileset.json?url=<SRC>[&format=<fmt>]   → tileset (root content URIs rewritten absolute)
 *   GET /convert/<key>/<path>                            → static tile / subtree / sub-tileset file
 *
 * SRC may be a remote URL (we download the source + the sibling files each converter reads) OR a local
 * path — file or dataset dir. Local paths make every format testable instantly against on-disk data,
 * e.g. ?url=/abs/path/POTREE/lion_p2&format=potree
 */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { convert, detectFormat } from '../convert/index.js';

const CACHE = path.join(os.tmpdir(), '3dtiles-live-cache');
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
const isRemote = s => /^https?:\/\//i.test(s);
const exists = async p => !!(await fs.stat(p).catch(() => null));
const keyFor = (src, fmt) => crypto.createHash('sha1').update(`${fmt || ''}|${src}`).digest('hex').slice(0, 16);

const MIME = {
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream',
  '.subtree': 'application/octet-stream', '.b3dm': 'application/octet-stream', '.pnts': 'application/octet-stream',
};

// Map a (remote-or-local) basename to a format when the extension / index filename is decisive.
// Used for remote URLs, where detectFormat() can't stat sibling files to recognise directory formats.
function detectByName(name) {
  const l = name.toLowerCase();
  if (l.endsWith('.rad')) return 'rad';
  if (l.endsWith('.copc.laz') || l.endsWith('.copc') || l.endsWith('.laz') || l.endsWith('.las')) return 'copc';
  if (l.endsWith('.slpk')) return 'i3s';
  if (l === 'metadata.json' || l === 'cloud.js') return 'potree';
  if (l.endsWith('lod-meta.json')) return 'sog';
  if (l.endsWith('.lcc')) return 'lcc';
  return null;
}

async function resolveFormat(src, explicit, name) {
  if (explicit) return explicit;
  if (!isRemote(src)) { const f = await detectFormat(src.startsWith('file://') ? fileURLToPath(src) : src).catch(() => null); if (f) return f; }
  return detectByName(name);
}

// ── remote mirroring: fetch the source + the sibling files each converter reads ──
async function fetchTo(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, Buffer.from(await r.arrayBuffer()));
}
const tryFetch = (url, dest) => fetchTo(url, dest).catch(() => {});

// Download a remote dataset into `dir`, returning the local input path to hand to convert().
async function mirrorRemote(src, fmt, dir) {
  const clean = src.split('?')[0];
  const base = clean.slice(0, clean.lastIndexOf('/') + 1);
  const name = clean.slice(clean.lastIndexOf('/') + 1) || 'input';
  const get = (rel) => fetchTo(base + rel, path.join(dir, rel));

  if (fmt === 'potree') {                                   // Potree 2.0 (3 files). 1.x (cloud.js + node tree) isn't mirrored.
    await get('metadata.json'); await get('hierarchy.bin'); await get('octree.bin');
    return dir;
  }
  if (fmt === 'lcc') {                                      // meta.lcc (+ index.bin, data.bin, optional shcoef.bin)
    await get(name);
    for (const f of ['index.bin', 'data.bin', 'shcoef.bin']) await tryFetch(base + f, path.join(dir, f));
    return dir;
  }
  if (fmt === 'sog') {                                      // lod-meta.json + per-chunk meta.json + the files each chunk references
    const r = await fetch(base + name); if (!r.ok) throw new Error(`fetch ${base + name} → ${r.status}`);
    const lod = JSON.parse(Buffer.from(await r.arrayBuffer()).toString('utf8'));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'lod-meta.json'), JSON.stringify(lod));
    if (lod.environment) await tryFetch(base + lod.environment, path.join(dir, lod.environment));
    for (const cm of lod.filenames || []) {
      await get(cm);                                        // chunk meta.json (e.g. "1_0/meta.json")
      const cj = JSON.parse(await fs.readFile(path.join(dir, cm), 'utf8'));
      const cdir = path.posix.dirname(cm);
      for (const k of Object.keys(cj)) {                    // each column's WebP textures, siblings of the chunk meta
        const files = cj[k]?.files;
        if (Array.isArray(files)) for (const fn of files) await get(path.posix.join(cdir, fn));
      }
    }
    return path.join(dir, 'lod-meta.json');
  }
  await get(name);                                          // single-file formats: copc / rad / i3s-slpk
  return path.join(dir, name);
}

// ── conversion, cached per key. The in-flight promise dedupes concurrent first hits. ──
const jobs = new Map();
function ensureConverted(src, fmt, key) {
  if (jobs.has(key)) return jobs.get(key);
  const job = (async () => {
    const outDir = path.join(CACHE, key);
    if (await exists(path.join(outDir, 'tileset.json'))) return outDir;   // warm from a previous run
    let input = isRemote(src) ? await mirrorRemote(src, fmt, path.join(CACHE, key + '.src'))
              : src.startsWith('file://') ? fileURLToPath(src) : src;
    await fs.mkdir(outDir, { recursive: true });
    console.log(`[convert-live] ${fmt} ${src} → ${outDir}`);
    await convert(input, outDir, { format: fmt });
    return outDir;
  })();
  jobs.set(key, job);
  job.catch(() => jobs.delete(key));   // a failed conversion shouldn't poison the cache — allow a retry
  return job;
}

// Prefix every RELATIVE `uri` in the served root tileset with the static base, so content / subtree /
// sub-tileset references resolve regardless of how the viewer bases the funny `?url=` request URL.
// (Nested sub-tilesets are served at their real paths, so THEIR relative URIs already resolve — only
// the root, served from the query-string endpoint, needs absolutising.)
function rewriteUris(node, prefix) {
  if (Array.isArray(node)) { for (const v of node) rewriteUris(v, prefix); return; }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'uri' && typeof v === 'string' && !/^([a-z]+:)?\/\//i.test(v) && !v.startsWith('/')) node[k] = prefix + v;
    else rewriteUris(v, prefix);
  }
}

/** Try to handle a /convert/* request. Returns true iff it owned the response. */
export async function handleConvert(req, res, u) {
  const p = u.pathname;
  if (!p.startsWith('/convert/')) return false;

  if (p === '/convert/tileset.json') {
    const src = u.searchParams.get('url');
    if (!src) { res.writeHead(400, CORS); res.end('missing ?url=<source url or local path>'); return true; }
    const name = src.split('?')[0].split('/').pop() || 'input';
    const fmt = await resolveFormat(src, u.searchParams.get('format'), name);
    if (!fmt) { res.writeHead(400, CORS); res.end(`could not detect format for "${name}" — pass &format=`); return true; }
    const key = keyFor(src, fmt);
    const outDir = await ensureConverted(src, fmt, key);
    const tileset = JSON.parse(await fs.readFile(path.join(outDir, 'tileset.json'), 'utf8'));
    rewriteUris(tileset.root, `/convert/${key}/`);
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(tileset));
    return true;
  }

  const m = p.match(/^\/convert\/([0-9a-f]{16})\/(.+)$/);
  if (m) {
    const root = path.join(CACHE, m[1]);
    const file = path.join(root, decodeURIComponent(m[2]));
    if (!path.resolve(file).startsWith(path.resolve(root) + path.sep)) { res.writeHead(403, CORS); res.end('forbidden'); return true; }
    if (!await exists(file)) { res.writeHead(404, CORS); res.end('not found'); return true; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', ...CORS });
    createReadStream(file).pipe(res);
    return true;
  }

  res.writeHead(404, CORS); res.end('not found');
  return true;
}
