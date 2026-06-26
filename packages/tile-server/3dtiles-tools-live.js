/**
 * 3dtiles-tools-live.js — /3dtiles-tools streaming middleware.
 *
 * Streaming semantics (like /stream, NOT like /convert):
 *   • Tileset JSON is built once on first request and cached in memory.
 *   • Each tile is converted/served on-demand when Cesium requests it.
 *   • Nothing is written to disk; no pre-conversion of the whole dataset.
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
 *                         on demand. GLB tiles are passed through. No files written.
 */
import fs   from 'node:fs/promises';
import fss  from 'node:fs';
import path from 'node:path';
import { buildExplicitFromUrl, transcodeToExplicit } from 'implicit-to-explicit';
import { pipeB3dmAsGlb, pntsToGlb, b3dmToGlb2 } from '3dtiles-tools';

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
    `tile/${uri}?tool=implicit-to-explicit&${baseParam}`
  );

  res.writeHead(200, CORS_JSON);
  res.end(JSON.stringify(out));
}

async function serveI2ETile(relPath, u, res) {
  const dir = u.searchParams.get('dir');
  const url = u.searchParams.get('url');

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
    `tile/${uri}?tool=upgrade&${baseParam}`
  );

  res.writeHead(200, CORS_JSON); res.end(JSON.stringify(out));
}

async function serveUpgradeTile(relPath, u, res) {
  const dir = u.searchParams.get('dir');
  const url = u.searchParams.get('url');
  const ext = path.extname(relPath.split('?')[0]).toLowerCase();

  if (url) {
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

// ── Router ────────────────────────────────────────────────────────────────────

const PREFIX = '/3dtiles-tools/';

export async function handle3dtilesTools(req, res, u) {
  if (!u.pathname.startsWith(PREFIX)) return false;
  const tool    = u.searchParams.get('tool');
  const subPath = u.pathname.slice(PREFIX.length);

  try {
    if (subPath === 'tileset.json') {
      if      (tool === 'implicit-to-explicit') await serveI2ETileset(u, res);
      else if (tool === 'upgrade')              await serveUpgradeTileset(u, res);
      else { res.writeHead(400, CORS_ERR); res.end(JSON.stringify({ error: `unknown tool "${tool}" — use implicit-to-explicit or upgrade` })); }
      return true;
    }
    if (subPath.startsWith('tile/')) {
      const relPath = subPath.slice('tile/'.length);
      if      (tool === 'implicit-to-explicit') await serveI2ETile(relPath, u, res);
      else if (tool === 'upgrade')              await serveUpgradeTile(relPath, u, res);
      else { res.writeHead(400, CORS_ERR); res.end(JSON.stringify({ error: `unknown tool "${tool}"` })); }
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
