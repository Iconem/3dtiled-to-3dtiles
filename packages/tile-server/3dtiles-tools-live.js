/**
 * 3dtiles-tools-live.js — /3dtiles-tools streaming middleware.
 *
 * Streaming semantics (like /stream, NOT like /convert) for `implicit-to-explicit` and `upgrade`:
 *   • Tileset JSON is built once on first request and cached in memory.
 *   • Each tile is converted/served on-demand when Cesium requests it.
 *   • Nothing is written to disk; no pre-conversion of the whole dataset.
 *
 * `upgrade-real` is different (see its section below): it's a genuine batch/cache operation like
 * /convert, because the REAL CesiumGS `3d-tiles-tools` package only operates on local filesystem
 * directories (no streaming/remote API) — a remote `url=` is mirrored to disk first, the whole
 * tileset is converted once, and the result is served statically from a cache dir on every request.
 *
 * Endpoints:
 *   GET /3dtiles-tools/tileset.json?tool=<t>&dir=<localPath>         (local)
 *   GET /3dtiles-tools/tileset.json?tool=<t>&url=<remoteTilesetUrl>  (remote)
 *   GET /3dtiles-tools/tile/<relPath>?tool=<t>&dir=<path>
 *   GET /3dtiles-tools/tile/<relPath>?tool=<t>&url=<remoteBaseUrl>   (base dir, not tileset.json)
 *
 * Tools:
 *   implicit-to-explicit  Reads binary .subtree files (OCTREE or QUADTREE), builds an explicit
 *                         children tree, rewrites content URIs to our /tile/... streaming endpoints.
 *                         Tile content: proxied as-is (GLB) or converted b3dm→glb on the fly.
 *
 *   upgrade               Reads an existing explicit 1.0 tileset (local or remote), bumps version
 *                         to 1.1, and rewrites content URIs so that each b3dm/pnts tile is converted
 *                         on demand. GLB tiles are passed through. No files written. Hand-rolled
 *                         (this repo's own upgrade.js), zero-copy where possible.
 *
 *   upgrade-real           Same 1.0 → 1.1 upgrade, but via the REAL CesiumGS `3d-tiles-tools` npm
 *                         package's TilesetUpgrader (b3dm/pnts/i3dm → glb, content upgraded through
 *                         gltf-pipeline, not just re-pointed). Batch: converts the WHOLE tileset once
 *                         into a cache dir, then serves the static result — see its section below.
 */
import fs   from 'node:fs/promises';
import fss  from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildExplicitFromUrl, transcodeToExplicit } from 'implicit-to-explicit';
import { pipeB3dmAsGlb, pntsToGlb, b3dmToGlb2, upgradeTilesetReal } from '3dtiles-tools';

const CORS_JSON = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Content-Type': 'application/json' };
const CORS_GLB  = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Content-Type': 'model/gltf-binary' };
const CORS_ERR  = CORS_JSON;

// ── Tileset JSON cache ─────────────────────────────────────────────────────────
const tilesetCache = new Map(); // cacheKey → plain-object tileset (NOT yet URI-rewritten)

// ── URI rewriting ──────────────────────────────────────────────────────────────

function rewriteContentUris(node, rewrite) {
  if (!node) return;
  // Support both `uri` (3D Tiles 1.1) and `url` (legacy 1.0 / 0.0 format)
  if (node.content?.uri) node.content.uri = rewrite(node.content.uri);
  else if (node.content?.url) { node.content.uri = rewrite(node.content.url); delete node.content.url; }
  if (node.children) node.children.forEach(c => rewriteContentUris(c, rewrite));
}

/** Determine if a URI should be converted (b3dm/pnts) vs passed through. */
const needsConvert = (uri) => /\.(b3dm|pnts)$/i.test(uri.split('?')[0]);

// Wrap an original (possibly query-string-carrying) content URI as a single opaque path segment for
// our own /3dtiles-tools/tile/<...> route, then OUR query string (?tool=&url=/dir=) after it. Several
// real tilesets (Clermont among them) put x/y/z/id params directly on leaf content URIs
// (`mesh_21.b3dm?id=21&x=...`) — naively doing `tile/${uri}?tool=...` produced a URL with TWO `?`
// characters. A client resolving that via `new URL()` treats everything from the FIRST `?` onward as
// ONE query string, so `tool=` ends up folded into the ORIGINAL uri's last param value instead of
// being its own param — `tool` then reads as missing server-side, this tool's tile route 400s, and
// (worse) the tile can end up resolving against the wrong base entirely, delivering the RAW upstream
// b3dm/pnts straight to the glTF loader instead of our converted glb (exactly "tileset upgrade still
// tries to load b3dm"). encodeURIComponent the whole original URI into one path segment instead — it
// can never be reinterpreted as a query boundary — and decode it back in serveI2ETile/serveUpgradeTile.
const wrapTileUri = (uri, toolParams) => `tile/${encodeURIComponent(uri)}?${toolParams}`;

// ── implicit-to-explicit ──────────────────────────────────────────────────────

async function getCachedExplicit(cacheKey, builder) {
  if (!tilesetCache.has(cacheKey)) {
    const result = await builder();
    tilesetCache.set(cacheKey, result);
  }
  return tilesetCache.get(cacheKey);
}

async function serveI2ETileset(u, res) {
  const dir = u.searchParams.get('dir');
  const url = u.searchParams.get('url');
  if (!dir && !url) { res.writeHead(400, CORS_ERR); res.end(JSON.stringify({ error: 'missing ?dir= or ?url=' })); return; }

  let raw, tileBase; // tileBase = where to resolve relative tile URIs (local abs path or remote base URL)

  if (url) {
    const cacheKey = `i2e:url:${url}`;
    raw = await getCachedExplicit(cacheKey, async () => {
      console.log(`[3dtiles-tools] i→e fetching ${url}`);
      const { tileset, baseUrl } = await buildExplicitFromUrl(url);
      return { tileset, baseUrl };
    });
    tileBase = raw.baseUrl;
  } else {
    const abs = path.resolve(dir);
    const cacheKey = `i2e:dir:${abs}`;
    raw = await getCachedExplicit(cacheKey, async () => {
      console.log(`[3dtiles-tools] i→e local ${abs}`);
      const prebaked = path.join(abs, 'tileset-explicit.json');
      let tileset;
      try {
        tileset = JSON.parse(await fs.readFile(prebaked, 'utf8'));
      } catch {
        await transcodeToExplicit(abs, prebaked);
        tileset = JSON.parse(await fs.readFile(prebaked, 'utf8'));
      }
      return { tileset, dir: abs };
    });
    tileBase = raw.dir;
  }

  // Deep-clone the cached tileset, then rewrite content URIs to point at our tile endpoint.
  const out = JSON.parse(JSON.stringify(raw.tileset));
  const encBase = url
    ? encodeURIComponent(raw.baseUrl)
    : encodeURIComponent(dir);
  const baseParam = url ? `url=${encBase}` : `dir=${encBase}`;

  rewriteContentUris(out.root, (uri) =>
    wrapTileUri(uri, `tool=implicit-to-explicit&${baseParam}`)
  );

  res.writeHead(200, CORS_JSON);
  res.end(JSON.stringify(out));
}

async function serveI2ETile(relPathRaw, u, res) {
  const dir = u.searchParams.get('dir');
  const url = u.searchParams.get('url');
  // relPathRaw is the encodeURIComponent'd ORIGINAL content uri (see wrapTileUri) — decode it back to
  // the real relative path/query before resolving, instead of a raw uri that may carry its OWN `?`.
  const relPath = decodeURIComponent(relPathRaw);

  const ext = path.extname(relPath.split('?')[0]).toLowerCase();

  if (url) {
    // Remote tile: fetch from source, convert if needed
    const tileUrl = new URL(relPath, url).href;
    const r = await fetch(tileUrl);
    if (!r.ok) { res.writeHead(r.status, CORS_ERR); res.end(`upstream ${r.status}`); return; }
    if (ext === '.b3dm') {
      const buf = Buffer.from(await r.arrayBuffer());
      const glb = await b3dmToGlb2(buf);
      res.writeHead(200, { ...CORS_GLB, 'Content-Length': String(glb.length) }); res.end(glb);
    } else if (ext === '.pnts') {
      const buf = Buffer.from(await r.arrayBuffer());
      const glb = pntsToGlb(buf);
      res.writeHead(200, { ...CORS_GLB, 'Content-Length': String(glb.length) }); res.end(glb);
    } else {
      // GLB or other — proxy as-is
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = r.headers.get('content-type') || 'model/gltf-binary';
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': ct, 'Content-Length': String(buf.length) });
      res.end(buf);
    }
  } else {
    // Local tile
    const abs = path.join(path.resolve(dir), relPath);
    if (ext === '.b3dm') {
      await pipeB3dmAsGlb(abs, res);
    } else if (ext === '.pnts') {
      const buf = await fs.readFile(abs);
      const glb = pntsToGlb(buf);
      res.writeHead(200, { ...CORS_GLB, 'Content-Length': String(glb.length) }); res.end(glb);
    } else {
      let stat; try { stat = await fs.stat(abs); } catch { res.writeHead(404, CORS_ERR); res.end('not found'); return; }
      res.writeHead(200, { ...CORS_GLB, 'Content-Length': String(stat.size) });
      fss.createReadStream(abs).pipe(res);
    }
  }
}

// ── upgrade ───────────────────────────────────────────────────────────────────

async function getRawTileset(cacheKey, loader) {
  if (!tilesetCache.has(cacheKey)) tilesetCache.set(cacheKey, await loader());
  return tilesetCache.get(cacheKey);
}

async function serveUpgradeTileset(u, res) {
  const dir         = u.searchParams.get('dir');
  const url         = u.searchParams.get('url');
  const tilesetFile = u.searchParams.get('tilesetFile') ?? 'tileset.json';
  if (!dir && !url) { res.writeHead(400, CORS_ERR); res.end(JSON.stringify({ error: 'missing ?dir= or ?url=' })); return; }

  const cacheKey = url ? `upgrade:url:${url}` : `upgrade:dir:${path.resolve(dir)}:${tilesetFile}`;
  const raw = await getRawTileset(cacheKey, async () => {
    let obj;
    if (url) {
      const r = await fetch(url); if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
      obj = await r.json();
    } else {
      obj = JSON.parse(await fs.readFile(path.join(path.resolve(dir), tilesetFile), 'utf8'));
    }
    if (obj.root?.implicitTiling) throw new Error('tileset has implicitTiling — use tool=implicit-to-explicit first, then upgrade');
    return obj;
  });

  const out = JSON.parse(JSON.stringify(raw));
  if (out.asset) out.asset.version = '1.1';

  const encBase = url
    ? encodeURIComponent(url.replace(/\/[^/]+$/, '/'))
    : encodeURIComponent(dir);
  const baseParam = url ? `url=${encBase}` : `dir=${encBase}`;

  rewriteContentUris(out.root, (uri) =>
    wrapTileUri(uri, `tool=upgrade&${baseParam}`)
  );

  res.writeHead(200, CORS_JSON); res.end(JSON.stringify(out));
}

async function serveUpgradeTile(relPathRaw, u, res) {
  const dir = u.searchParams.get('dir');
  const url = u.searchParams.get('url');
  // See the matching comment in serveI2ETile — relPathRaw is encodeURIComponent'd (wrapTileUri).
  const relPath = decodeURIComponent(relPathRaw);
  const ext = path.extname(relPath.split('?')[0]).toLowerCase();

  if (url) {
    // A NESTED tileset.json (e.g. Lille: root tileset.json → pyramid/tileset.json → leaf b3dm) must be
    // recursively rewritten the SAME way serveUpgradeTileset rewrites the root — otherwise its own
    // content URIs stay plain, unwrapped b3dm/pnts references, resolved and fetched directly by the
    // client/renderer, completely bypassing our b3dmToGlb2 conversion. That's why multi-level tilesets
    // kept crashing in the client's own (legacy-glTF-1.0-incapable) b3dm parser even with the "upgrade"
    // transform selected — only the ROOT tileset was ever actually being upgraded.
    if (ext === '.json') {
      const tilesetUrl = new URL(relPath, url).href;
      const r = await fetch(tilesetUrl);
      if (!r.ok) { res.writeHead(r.status, CORS_ERR); res.end(`upstream ${r.status}`); return; }
      const obj = await r.json();
      if (obj.asset) obj.asset.version = '1.1';
      const newBaseParam = `url=${encodeURIComponent(tilesetUrl.replace(/\/[^/]+$/, '/'))}`;
      rewriteContentUris(obj.root, (uri) => wrapTileUri(uri, `tool=upgrade&${newBaseParam}`));
      res.writeHead(200, CORS_JSON); res.end(JSON.stringify(obj));
      return;
    }
    const tileUrl = new URL(relPath, url).href;
    const r = await fetch(tileUrl);
    if (!r.ok) { res.writeHead(r.status, CORS_ERR); res.end(`upstream ${r.status}`); return; }
    if (ext === '.b3dm') {
      const buf = Buffer.from(await r.arrayBuffer()); const glb = await b3dmToGlb2(buf);
      res.writeHead(200, { ...CORS_GLB, 'Content-Length': String(glb.length) }); res.end(glb);
    } else if (ext === '.pnts') {
      const buf = Buffer.from(await r.arrayBuffer()); const glb = pntsToGlb(buf);
      res.writeHead(200, { ...CORS_GLB, 'Content-Length': String(glb.length) }); res.end(glb);
    } else {
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, { ...CORS_GLB, 'Content-Length': String(buf.length) }); res.end(buf);
    }
  } else {
    const abs = path.join(path.resolve(dir), relPath);
    if (ext === '.json') {
      const obj = JSON.parse(await fs.readFile(abs, 'utf8'));
      if (obj.asset) obj.asset.version = '1.1';
      const newBaseParam = `dir=${encodeURIComponent(path.dirname(abs))}`;
      rewriteContentUris(obj.root, (uri) => wrapTileUri(uri, `tool=upgrade&${newBaseParam}`));
      res.writeHead(200, CORS_JSON); res.end(JSON.stringify(obj));
      return;
    }
    if (ext === '.b3dm') {
      await pipeB3dmAsGlb(abs, res);
    } else if (ext === '.pnts') {
      const buf = await fs.readFile(abs); const glb = pntsToGlb(buf);
      res.writeHead(200, { ...CORS_GLB, 'Content-Length': String(glb.length) }); res.end(glb);
    } else {
      let stat; try { stat = await fs.stat(abs); } catch { res.writeHead(404, CORS_ERR); res.end('not found'); return; }
      res.writeHead(200, { ...CORS_GLB, 'Content-Length': String(stat.size) });
      fss.createReadStream(abs).pipe(res);
    }
  }
}

// ── upgrade-real (real CesiumGS 3d-tiles-tools package) ────────────────────────
//
// The real package's TilesetSources/TilesetTargets support exactly three kinds: .3tz, .3dtiles,
// or a plain filesystem directory — there's no HTTP source (see upgrade-real.js's file header for
// how this was confirmed). So this tool works like /convert, not like /stream:
//   1. dir=  → used as-is.  url= → the WHOLE explicit tileset (json + every tile file) is mirrored
//      to a local temp dir first (recursive content.uri walk + fetch, one time).
//   2. TilesetOperations.upgrade runs ONCE against that local dir, writing a real converted copy
//      (b3dm/pnts/i3dm → glb via gltf-pipeline) to a cache dir.
//   3. Every subsequent request for the same source is served straight from that cache dir — the
//      tileset.json (content URIs rewritten to our own /tile/<relPath>?tool=upgrade-real&key=<k>
//      route) and each static tile file.
const realUpgradeJobs = new Map();      // cacheKey → Promise<outDir> (in-flight de-dupe, like convert-live.js)
const CACHE_ROOT = path.join(os.tmpdir(), '3dtiles-tools-upgrade-real');
const keyFor = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);   // dot-free — see upgrade-real.js gotcha

// Unlike the `dir=`-mode tools above (where the CALLER already names the whole directory directly, so
// there's nothing to gain from a `../` escape they couldn't already ask for outright), CACHE_ROOT here
// is a server-owned path the caller can never name directly — they only supply a `relPath` that's
// supposed to stay INSIDE one `key` subdirectory of it. `relPath` reaches this from two untrusted
// places: a remote tileset.json's own `content.uri` fields (mirrorRemoteTileset — a hostile/compromised
// public tileset could embed "../../../../etc/passwd") and the caller's own request path
// (serveRealUpgradeTile). Resolve-and-check before ever touching the filesystem with it.
function safeJoin(base, relPath) {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(resolvedBase, relPath);
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
    throw new Error(`path escapes ${resolvedBase}: ${relPath}`);
  }
  return resolved;
}

async function walkContentUris(node, visit) {
  if (!node) return;
  const uri = node.content?.uri ?? node.content?.url;
  if (uri) await visit(uri);
  if (node.children) await Promise.all(node.children.map((c) => walkContentUris(c, visit)));
}

/** Mirror a remote EXPLICIT 3D Tiles tileset (tileset.json + every tile it references) to `dir`. */
async function mirrorRemoteTileset(tilesetUrl, dir) {
  await fs.mkdir(dir, { recursive: true });
  const r = await fetch(tilesetUrl);
  if (!r.ok) throw new Error(`fetch ${tilesetUrl} → ${r.status}`);
  const text = await r.text();
  await fs.writeFile(path.join(dir, 'tileset.json'), text);
  const obj = JSON.parse(text);
  if (obj.root?.implicitTiling) throw new Error('tileset has implicitTiling — run tool=implicit-to-explicit first, then upgrade-real');
  const base = tilesetUrl.replace(/\/[^/]+$/, '/');
  const seen = new Set();
  await walkContentUris(obj.root, async (uri) => {
    if (seen.has(uri)) return; seen.add(uri);
    const src = new URL(uri, base).href;
    const dst = safeJoin(dir, uri.split('?')[0]);
    const resp = await fetch(src);
    if (!resp.ok) throw new Error(`fetch ${src} → ${resp.status}`);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.writeFile(dst, Buffer.from(await resp.arrayBuffer()));
  });
  return dir;
}

function ensureRealUpgrade(cacheKey, srcDirPromise) {
  if (realUpgradeJobs.has(cacheKey)) return realUpgradeJobs.get(cacheKey);
  const job = (async () => {
    const outDir = path.join(CACHE_ROOT, cacheKey);   // hex hash — dot-free, dodges the Windows path bug
    if (fss.existsSync(path.join(outDir, 'tileset.json'))) return outDir;   // warm from a previous run
    const srcDir = await srcDirPromise;
    console.log(`[3dtiles-tools] upgrade-real ${srcDir} → ${outDir}`);
    await upgradeTilesetReal(srcDir, outDir);
    return outDir;
  })();
  realUpgradeJobs.set(cacheKey, job);
  job.catch(() => realUpgradeJobs.delete(cacheKey));   // a failed conversion shouldn't poison the cache
  return job;
}

async function serveRealUpgradeTileset(u, res) {
  const dir = u.searchParams.get('dir');
  const url = u.searchParams.get('url');
  if (!dir && !url) { res.writeHead(400, CORS_ERR); res.end(JSON.stringify({ error: 'missing ?dir= or ?url=' })); return; }

  // "-" not ":" as the kind/hash separator — a literal ":" is illegal in a Windows directory NAME
  // (reserved for drive letters/NTFS alternate data streams), and this key becomes a directory name.
  const cacheKey = url ? `url-${keyFor(url)}` : `dir-${keyFor(path.resolve(dir))}`;
  const srcDirPromise = url
    ? mirrorRemoteTileset(url, path.join(CACHE_ROOT, `${cacheKey}.src`))
    : Promise.resolve(path.resolve(dir));
  const outDir = await ensureRealUpgrade(cacheKey, srcDirPromise);

  const obj = JSON.parse(await fs.readFile(path.join(outDir, 'tileset.json'), 'utf8'));
  rewriteContentUris(obj.root, (uri) => `tile/${encodeURIComponent(uri)}?tool=upgrade-real&key=${cacheKey}`);
  res.writeHead(200, CORS_JSON); res.end(JSON.stringify(obj));
}

async function serveRealUpgradeTile(relPathRaw, u, res) {
  const key = u.searchParams.get('key');
  // key is always server-generated (`${'url'|'dir'}-${16 hex chars}`, see keyFor above) — reject
  // anything else outright rather than letting a hand-crafted `../` in key itself escape CACHE_ROOT
  // before relPath is even considered.
  if (!key || !/^(url|dir)-[0-9a-f]{16}$/.test(key)) { res.writeHead(400, CORS_ERR); res.end(JSON.stringify({ error: 'missing or malformed ?key= (request the tileset.json first)' })); return; }
  const relPath = decodeURIComponent(relPathRaw).split('?')[0];
  let abs;
  try { abs = safeJoin(path.join(CACHE_ROOT, key), relPath); }
  catch { res.writeHead(400, CORS_ERR); res.end(JSON.stringify({ error: 'invalid tile path' })); return; }
  let stat; try { stat = await fs.stat(abs); } catch { res.writeHead(404, CORS_ERR); res.end('not found'); return; }
  const ct = /\.glb$/i.test(abs) ? 'model/gltf-binary' : /\.json$/i.test(abs) ? 'application/json' : 'application/octet-stream';
  res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': ct, 'Content-Length': String(stat.size) });
  fss.createReadStream(abs).pipe(res);
}

// ── Router ────────────────────────────────────────────────────────────────────

const PREFIX = '/3dtiles-tools/';
const TOOLS = 'implicit-to-explicit, upgrade, or upgrade-real';

export async function handle3dtilesTools(req, res, u) {
  if (!u.pathname.startsWith(PREFIX)) return false;
  const tool    = u.searchParams.get('tool');
  const subPath = u.pathname.slice(PREFIX.length);

  try {
    if (subPath === 'tileset.json') {
      if      (tool === 'implicit-to-explicit') await serveI2ETileset(u, res);
      else if (tool === 'upgrade')              await serveUpgradeTileset(u, res);
      else if (tool === 'upgrade-real')         await serveRealUpgradeTileset(u, res);
      else { res.writeHead(400, CORS_ERR); res.end(JSON.stringify({ error: `unknown tool "${tool}" — use ${TOOLS}` })); }
      return true;
    }
    if (subPath.startsWith('tile/')) {
      const relPath = subPath.slice('tile/'.length);
      if      (tool === 'implicit-to-explicit') await serveI2ETile(relPath, u, res);
      else if (tool === 'upgrade')              await serveUpgradeTile(relPath, u, res);
      else if (tool === 'upgrade-real')         await serveRealUpgradeTile(relPath, u, res);
      else { res.writeHead(400, CORS_ERR); res.end(JSON.stringify({ error: `unknown tool "${tool}" — use ${TOOLS}` })); }
      return true;
    }
    res.writeHead(404, CORS_ERR); res.end('expected /3dtiles-tools/tileset.json or /3dtiles-tools/tile/<relPath>');
  } catch (e) {
    console.error('[3dtiles-tools]', e.message);
    if (!res.headersSent) { res.writeHead(500, CORS_ERR); res.end(JSON.stringify({ error: e.message })); }
    else res.end();
  }
  return true;
}
