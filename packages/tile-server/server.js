#!/usr/bin/env node
/**
 * tile-server — a "TiTiler for 3D": live <format> → OGC 3D Tiles middleware. CORS open.
 *
 * One primary entry point, /tiles, over ONE axis — what the middleware caches (see README
 * "Architecture: the materialization continuum") — dispatching in-process (no redirect) to whichever
 * of the two underlying modes the requested cache level needs:
 *
 *   GET /tiles/tileset.json?url=<SRC>&format=<fmt>&cache=<none|hierarchy|full>[&prefetch=N][&tiling=…]
 *
 *   TRUE online range-streaming (nothing pre-converted — range-read the hierarchy, then one byte
 *   range per tile), for cache=none|hierarchy. Per-format range adapters, unified under /stream — the
 *   ONE HTTP surface for these; there is no per-format /copc, /potree, etc. anymore:
 *     GET /stream/tileset.json?url=<SRC>&format=<fmt>[&cache=none|hierarchy][&prefetch=N]
 *
 *   PREPROCESS + cache (convert the WHOLE dataset once on first hit, then serve static), for
 *   cache=full — works for EVERY format the meta-converter supports:
 *     GET /convert/tileset.json?url=<SRC>[&format=<fmt>][&centroids=1]
 *
 * Run:  PORT=3001 node packages/tile-server/server.js   (npm run serve:tiles | serve:live)
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';

// Machine-local secrets (API keys for proxied providers, e.g. VEXCEL_API_KEY) live in the gitignored
// .local/tile-server.env as KEY=value lines. Real environment variables win.
try {
  const envFile = readFileSync(new URL('../../.local/tile-server.env', import.meta.url), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2];
  }
} catch { /* no local env file */ }

// This server's job is to proxy/transcode arbitrary PUBLIC open-data tilesets, and many government /
// research hosts (e.g. data.geopf.fr) serve valid data behind expired or misconfigured TLS certs that
// `node-fetch` (used inside the `copc` library) hard-rejects — curl, browsers, and undici accept them.
// Since this is a read-only dev proxy that sends no credentials, relax TLS verification process-wide so
// those sources load. Set TLS_REJECT_UNAUTHORIZED=1 in the env to opt back into strict verification.
if (process.env.TLS_REJECT_UNAUTHORIZED !== '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  process.removeAllListeners('warning'); // silence the one-time Node insecure-TLS warning spam
}

import { handleHomepage } from './homepage-live.js';
import { progressGet, httpStatusOf, tileWorkerCount } from '../core/index.js';

// The format adapters and the tools pull in a heavy module graph (splat-transform, loaders.gl, 3d-tiles-tools: 10–15 s on
// a cold start), so they load after the port is bound, not before: the desktop app and a health check get an answer at
// once, and the first request that needs a module waits for that module alone. They are all warmed right after listen.
const lazy = (load, name) => { let mod; return (...args) => (mod ??= load()).then((m) => m[name](...args)); };
const MODULES = {
  stream: () => import('./stream-live.js'), convert: () => import('./convert-live.js'), selfContained: () => import('./3dtiles-self-contained.js'),
  tools: () => import('./3dtiles-tools-live.js'), gltf: () => import('./gltf-live.js'), bing: () => import('./bing-live.js'),
  extract: () => import('./extract-live.js'), proxy: () => import('./proxy-live.js'), exportLive: () => import('./export-live.js'),
  aggregate: () => import('./aggregate-live.js'), stats: () => import('./stats-live.js'),
};
const handleStream = lazy(MODULES.stream, 'handleStream');
const handleConvert = lazy(MODULES.convert, 'handleConvert');
const handleSelfContained = lazy(MODULES.selfContained, 'handleSelfContained');
const handle3dtilesTools = lazy(MODULES.tools, 'handle3dtilesTools');
const handleGltf = lazy(MODULES.gltf, 'handleGltf');
const handleBing = lazy(MODULES.bing, 'handleBing');
const handleExtract = lazy(MODULES.extract, 'handleExtract');
const handleProxy = lazy(MODULES.proxy, 'handleProxy');
const handleExport = lazy(MODULES.exportLive, 'handleExport');
const handleAggregate = lazy(MODULES.aggregate, 'handleAggregate');
const handleStats = lazy(MODULES.stats, 'handleStats');

// Port resolution order: --port <n> (CLI, wins) → TILE_PORT → PORT → 3001. The CLI/TILE_PORT escape
// hatches matter under dev harnesses that inject PORT=<vite port> into the whole `pnpm run dev` process
// (which would otherwise collide the tile-server onto vite's port); `serve:tiles` passes --port 3001.
/**
 * Started by the desktop app, the server leaves with it. Windows does not end a child when its parent is killed or
 * crashes, and the orphan of an old build was adopted by the next launch, which then ran old code and shared the
 * orphan's queue. `TILED_PARENT_PID` names the process to follow; a server started by hand has none.
 */
const parentPid = Number(process.env.TILED_PARENT_PID);
if (parentPid) {
  setInterval(() => {
    try { process.kill(parentPid, 0); }
    catch { console.log(`[tile-server] parent process ${parentPid} is gone, exiting`); process.exit(0); }
  }, 5000).unref();
}

const _argPort = (() => { const i = process.argv.indexOf('--port'); return i >= 0 ? Number(process.argv[i + 1]) : NaN; })();
const PORT = _argPort || Number(process.env.TILE_PORT) || Number(process.env.PORT) || 3001;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };

// Keep the server alive through bad input. laz-perf's WASM build installs its OWN process-level
// 'uncaughtException'/'unhandledRejection' handlers that RE-THROW (killing the process) when it
// aborts on a non-LAS buffer — e.g. someone hits /copc with a JSON metadata.json. We override those
// with logging handlers so one bad request can't take the whole tile-server down.
process.removeAllListeners('uncaughtException');
process.removeAllListeners('unhandledRejection');
process.on('uncaughtException',  e => console.error('[tile-server] uncaughtException:', e?.message || e));
process.on('unhandledRejection', e => console.error('[tile-server] unhandledRejection:', e?.message || e));

// Unified entry over ONE axis — what the middleware caches (see README "Architecture: the
// materialization continuum"). Point at a source, pick how much to cache:
//   • cache=none      → nothing cached: live, lazy hierarchy (default)        → /stream
//   • cache=hierarchy → full tree in RAM, tiles per-request                   → /stream
//   • cache=full      → whole dataset (tree + all tiles) converted to disk    → /convert
// (There is no "prebuilt" mode: a tileset built offline is served by pointing the viewer directly at
//  its output tileset.json — the middleware has no role and can't know the input→output link.)
// Dispatches in-process (no redirect) — /stream reads `cache=` itself, so the query string just
// carries straight through unchanged; only the path prefix is rewritten.
async function handleTiles(req, res, u) {
  if (!u.pathname.startsWith('/tiles/')) return false;
  const cache = (u.searchParams.get('cache') || 'none').toLowerCase();
  if (cache !== 'none' && cache !== 'hierarchy' && cache !== 'full') {
    res.writeHead(400, CORS); res.end(`unknown cache "${cache}" — use none | hierarchy | full`); return true;
  }
  const rest = u.pathname.slice('/tiles/'.length);
  const u2 = new URL(u.href);
  u2.pathname = cache === 'full' ? `/convert/${rest}` : `/stream/${rest}`;
  return cache === 'full' ? handleConvert(req, res, u2) : handleStream(req, res, u2);
}

http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const u = new URL(req.url, `http://localhost:${PORT}`);
    if (u.pathname === '/progress') {                // server-side progress of cache=hierarchy/full ops
      const snap = progressGet(u.searchParams.get('key') || '');
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      return res.end(JSON.stringify(snap || { done: 0, total: 0, finished: false }));
    }
    if (await handleHomepage(req, res, u)) return;    // / , /openapi.json, /playground (+ /docs alias)
    if (await handleTiles(req, res, u)) return;      // unified /tiles?cache= continuum entry (in-process, no redirect)
    if (await handleStream(req, res, u)) return;     // unified true-streaming dispatcher (copc/potree/sog/lcc/rad/i3s)
    if (await handleConvert(req, res, u)) return;    // any <fmt> → 3D Tiles live (preprocess + cache)
    if (await handleSelfContained(req, res, u)) return;   // .3tz / .3dtiles self-contained packages
    if (await handle3dtilesTools(req, res, u)) return;    // /3dtiles-tools?tool=implicit-to-explicit|upgrade
    if (await handleGltf(req, res, u)) return;            // /gltf?ops=decompress — per-tile glTF-Transform pipeline
    if (await handleBing(req, res, u)) return;            // /bing — Bing Maps 3D (tf=3dv4 GLB) → 3D Tiles
    if (await handleExtract(req, res, u)) return;         // /extract/las — bbox crop of a point cloud → LAS
    if (await handleProxy(req, res, u)) return;            // /proxy?url= — generic CORS-open passthrough for public sources
    if (await handleAggregate(req, res, u)) return;
    if (await handleExport(req, res, u)) return;           // /export — materialise a tileset to a local folder (opt-in, loopback)        // /aggregate?urls= — meta-tileset over N child tilesets
    if (await handleStats(req, res, u)) return;            // /stats + /hierarchy — depth/breadth stats & graph page
    res.writeHead(404, CORS); res.end('not found — see / for a full list of endpoints, or /playground to try them interactively');
  } catch (e) {
    console.error('[tile-server]', e.stack || e.message);
    // A handler may have already started streaming a response — don't double-send headers (that throw
    // was itself crashing the server with ERR_HTTP_HEADERS_SENT).
    // A source read that failed says so to the client (core/source-fetch.js): the file is not there, or the host did not
    // answer. An export takes the first for a gap in the source and retries the second; anything else is our own error.
    if (!res.headersSent) res.writeHead(httpStatusOf(e), CORS);
    res.end(res.headersSent ? '' : String(e.message || e));
  }
// HOST=127.0.0.1 (the desktop app) stays off the network, so Windows asks no firewall question.
}).listen(PORT, process.env.HOST || undefined, () => {
  console.log(`tile-server on http://localhost:${PORT} (${process.uptime().toFixed(1)} s after start)`);
  // TILED_WORKERS (off by default): COPC and Potree tiles are decoded and encoded on worker threads, see core/parallel.js
  console.log(tileWorkerCount() ? `  tile workers: ${tileWorkerCount()} threads (TILED_WORKERS=${process.env.TILED_WORKERS})` : '  tile workers: off (TILED_WORKERS=auto|<n> to decode and encode point tiles on worker threads)');
  const t0 = Date.now();
  Promise.all(Object.values(MODULES).map((load) => load())).then(() => console.log(`  modules loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`), (e) => console.error('[tile-server] a module failed to load:', e));
  console.log(`  playground  interactive API reference (Scalar, driven by /openapi.json) → /playground (alias: /docs)`);
  console.log(`  tiles    (unified, no redirect) /tiles/tileset.json?url=<SRC>&format=<fmt>&cache=<none|hierarchy|full>[&prefetch=N][&tiling=implicit|explicit]`);
  console.log(`  stream   (cache=none/hierarchy; copc/potree/sog/lcc/rad/i3s/threemx/geosplats) /stream/tileset.json?url=<SRC>&format=<fmt>[&cache=none|hierarchy][&prefetch=N]`);
  console.log(`  convert  (preprocess+cache, any fmt) /convert/tileset.json?url=<SRC>[&format=<fmt>][&centroids=1]`);
  console.log(`  3dtiles-self-contained  /3dtiles-self-contained/tileset.json?url=<path-or-URL.3tz|.3dtiles>`);
  console.log(`  3dtiles-tools  /3dtiles-tools/tileset.json?tool=implicit-to-explicit|upgrade&dir=<path>[&base=<url>]`);
  console.log(`  gltf     (per-tile glTF-Transform) /gltf/tileset.json?url=<tileset>&ops=decompress  (Draco/meshopt/KTX2 decode)`);
  console.log(`  bing     Bing Maps 3D (td1 implicit manifest) → /bing/tileset.json?g=<genid>[&decompress=1]`);
  console.log(`  extract  bbox+GE crop/extract → /extract/{las|glb|copc|tileset|zip|splat}?url=<tileset.json>&bbox=...`);
  console.log(`  proxy    generic CORS-open passthrough → /proxy?url=<absolute source URL>`);
  console.log(`  export   materialise any tileset into a local folder → POST /export {url,outDir} ${process.env.TILED_ALLOW_EXPORT === '1' ? '(enabled, loopback only)' : '(disabled — set TILED_ALLOW_EXPORT=1)'}`);
  console.log(`  aggregate  meta-tileset over N child tilesets → /aggregate/tileset.json?urls=<u1>,<u2>,… (mix /stream, /convert, remote 3D Tiles)`);
});
