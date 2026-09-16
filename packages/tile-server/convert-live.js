/**
 * convert-live.js — generic <fmt> → 3D Tiles live middleware (any format the meta-converter supports).
 *
 * The COPC path (server.js) is per-tile: each request HTTP-range-reads one octree node. This path is
 * per-dataset: on the FIRST request it runs the in-process `convert()` once (cached on disk) and then
 * serves the static 3D Tiles output. Not range-streamed, but genuinely on-demand for ANY format —
 * potree, sog (streamed-SOG), rad, lcc, copc, i3s.
 *
 *   GET /convert/tileset.json?url=<SRC>[&format=<fmt>][&centroids=1]  → tileset (URIs rewritten absolute)
 *   GET /convert/<key>/<path>                                        → static tile / subtree / sub-tileset
 *
 * &centroids=1 makes splat formats (rad/sog/lcc) emit a POINTS tileset of splat centroids, so
 * renderers without KHR_gaussian_splatting can still display the scene.
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
import { isRemote, mirrorRemote } from '../convert/fetch-source.js';
import { detectFormatByName, applyPlacement } from '../core/index.js';

const CACHE = path.join(os.tmpdir(), '3dtiles-live-cache');
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
const exists = async p => !!(await fs.stat(p).catch(() => null));
// Bump when the GLB bytes a converter writes change meaning, so a cached conversion is rebuilt
// instead of silently served forever. v2: point COLOR_0 is now linear (it used to be raw sRGB, which
// rendered washed out in every spec-following client) — caches from before that must not be reused.
const OUTPUT_VERSION = 'v2';
const keyFor = (src, fmt, centroids, tiling) => crypto.createHash('sha1').update(`${OUTPUT_VERSION}|${fmt || ''}|${centroids ? 'c|' : ''}${tiling || ''}|${src}`).digest('hex').slice(0, 16);

const MIME = {
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream',
  '.subtree': 'application/octet-stream', '.b3dm': 'application/octet-stream', '.pnts': 'application/octet-stream',
};

// Resolve the format: explicit &format wins; else detect (stat for local dirs, basename for remote).
async function resolveFormat(src, explicit, name) {
  if (explicit) return explicit;
  if (!isRemote(src)) { const f = await detectFormat(src.startsWith('file://') ? fileURLToPath(src) : src).catch(() => null); if (f) return f; }
  return detectFormatByName(name);
}

// ── conversion, cached per key. The in-flight promise dedupes concurrent first hits.
// Remote sources are mirrored (source + sibling files each converter needs) via the shared
// fetch-source module, which the CLI / JS API use too. ──
const jobs = new Map();
function ensureConverted(src, fmt, key, opts) {
  if (jobs.has(key)) return jobs.get(key);
  const job = (async () => {
    const outDir = path.join(CACHE, key);
    if (await exists(path.join(outDir, 'tileset.json'))) return outDir;   // warm from a previous run
    let input = isRemote(src) ? await mirrorRemote(src, fmt, path.join(CACHE, key + '.src'))
              : src.startsWith('file://') ? fileURLToPath(src) : src;
    await fs.mkdir(outDir, { recursive: true });
    console.log(`[convert-live] ${fmt}${opts.centroidsOnly ? ' (centroids)' : ''}${opts.tiling ? ' ['+opts.tiling+']' : ''} ${src} → ${outDir}`);
    await convert(input, outDir, { format: fmt, ...opts });
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
    const centroids = ['1', 'true', 'yes'].includes((u.searchParams.get('centroids') || '').toLowerCase());
    const tiling = u.searchParams.get('tiling') || undefined;   // 'implicit' | 'explicit'
    const key = keyFor(src, fmt, centroids, tiling);
    const outDir = await ensureConverted(src, fmt, key, { centroidsOnly: centroids, tiling });
    const tileset = JSON.parse(await fs.readFile(path.join(outDir, 'tileset.json'), 'utf8'));
    rewriteUris(tileset.root, `/convert/${key}/`);
    // Same user-directed globe placement as /stream (&lon=&lat=[&alt=][&heading=][&scale=]) — applied
    // to the served JSON only, never baked into the on-disk cache (so one cached convert can be
    // placed differently per request).
    if (fmt !== 'geosplats') applyPlacement(tileset.root, u.searchParams, `convert:${fmt}`);
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
