#!/usr/bin/env node
/**
 * tile-server — a "TiTiler for 3D": live <format> → OGC 3D Tiles middleware. CORS open.
 *
 * Two complementary modes (see README "Vision: towards a TiTiler for 3D"):
 *
 *   TRUE online range-streaming (nothing pre-converted — range-read the hierarchy, then one byte
 *   range per tile). Per-format range adapters, unified under /stream:
 *     GET /stream/tileset.json?url=<SRC>[&format=<fmt>]   (copc, potree today; lcc/rad next)
 *     GET /copc/...   GET /potree/...                     (the adapters directly)
 *
 *   PREPROCESS + cache (convert the WHOLE dataset once on first hit, then serve static) — works for
 *   EVERY format the meta-converter supports:
 *     GET /convert/tileset.json?url=<SRC>[&format=<fmt>][&centroids=1]
 *
 * Run:  PORT=3001 node packages/tile-server/server.js   (npm run serve:tiles | serve:live)
 */
import http from 'node:http';

// This server's job is to proxy/transcode arbitrary PUBLIC open-data tilesets, and many government /
// research hosts (e.g. data.geopf.fr) serve valid data behind expired or misconfigured TLS certs that
// `node-fetch` (used inside the `copc` library) hard-rejects — curl, browsers, and undici accept them.
// Since this is a read-only dev proxy that sends no credentials, relax TLS verification process-wide so
// those sources load. Set TLS_REJECT_UNAUTHORIZED=1 in the env to opt back into strict verification.
if (process.env.TLS_REJECT_UNAUTHORIZED !== '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  process.removeAllListeners('warning'); // silence the one-time Node insecure-TLS warning spam
}

import { handleCopc } from './copc-live.js';
import { handlePotree } from './potree-live.js';
import { handleSog } from './sog-live.js';
import { handleLcc } from './lcc-live.js';
import { handleRad } from './rad-live.js';
import { handleI3s } from './i3s-live.js';
import { handleStream } from './stream-live.js';
import { handleConvert } from './convert-live.js';
import { handleSelfContained } from './3dtiles-self-contained.js';
import { handle3dtilesTools } from './3dtiles-tools-live.js';
import { handleGltf } from './gltf-live.js';
import { handleBing } from './bing-live.js';
import { handleThreemx } from './threemx-live.js';

// Port resolution order: --port <n> (CLI, wins) → TILE_PORT → PORT → 3001. The CLI/TILE_PORT escape
// hatches matter under dev harnesses that inject PORT=<vite port> into the whole `pnpm run dev` process
// (which would otherwise collide the tile-server onto vite's port); `serve:tiles` passes --port 3001.
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
//   GET /tiles/tileset.json?url=<SRC>&format=<fmt>&cache=<none|hierarchy|full>[&prefetch=N][&tiling=…]
//   • cache=none      → nothing cached: live, lazy hierarchy (default)        → /stream (hierarchy=lazy)
//   • cache=hierarchy → full tree in RAM, tiles per-request                   → /stream (hierarchy=eager)
//   • cache=full      → whole dataset (tree + all tiles) converted to disk    → /convert
// (There is no "prebuilt" mode: a tileset built offline is served by pointing the viewer directly at
//  its output tileset.json — the middleware has no role and can't know the input→output link.)
// Routed via 307 so child URIs resolve under the real handler's prefix (no rewriting needed).
function handleTiles(req, res, u) {
  if (!u.pathname.startsWith('/tiles/')) return false;
  const cache = (u.searchParams.get('cache') || 'none').toLowerCase();
  const rest = u.pathname.slice('/tiles/'.length);
  const target = new URL(u.href);
  if (cache === 'full') {
    target.pathname = `/convert/${rest}`;
  } else if (cache === 'none' || cache === 'hierarchy') {
    target.pathname = `/stream/${rest}`;
    if (!target.searchParams.has('hierarchy')) target.searchParams.set('hierarchy', cache === 'hierarchy' ? 'eager' : 'lazy');
  } else {
    res.writeHead(400, CORS); res.end(`unknown cache "${cache}" — use none | hierarchy | full`); return true;
  }
  res.writeHead(307, { Location: target.pathname + target.search, ...CORS });
  res.end();
  return true;
}

http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const u = new URL(req.url, `http://localhost:${PORT}`);
    if (handleTiles(req, res, u)) return;            // unified /tiles?mode= continuum entry
    if (await handleStream(req, res, u)) return;     // unified true-streaming dispatcher
    if (await handleCopc(req, res, u)) return;       // COPC → 3D Tiles live (range-streamed)
    if (await handlePotree(req, res, u)) return;     // Potree 2.0 → 3D Tiles live (range-streamed)
    if (await handleSog(req, res, u)) return;        // streamed-SOG → 3D Tiles live (chunk-on-demand)
    if (await handleLcc(req, res, u)) return;        // LCC → 3D Tiles live (grid boxes + range-read runs)
    if (await handleRad(req, res, u)) return;        // RAD → 3D Tiles live (centers-only tree + on-demand encode)
    if (await handleI3s(req, res, u)) return;        // I3S/SLPK → 3D Tiles live (loaders.gl; OBB tree + on-demand geometry)
    if (await handleConvert(req, res, u)) return;    // any <fmt> → 3D Tiles live (preprocess + cache)
    if (await handleSelfContained(req, res, u)) return;   // .3tz / .3dtiles self-contained packages
    if (await handle3dtilesTools(req, res, u)) return;    // /3dtiles-tools?tool=implicit-to-explicit|upgrade
    if (await handleGltf(req, res, u)) return;            // /gltf?ops=decompress — per-tile glTF-Transform pipeline
    if (await handleBing(req, res, u)) return;            // /bing — Bing Maps 3D (tf=3dv4 GLB) → 3D Tiles
    if (await handleThreemx(req, res, u)) return;         // /threemx — Bentley/Acute3D 3MX → 3D Tiles
    res.writeHead(404, CORS); res.end('not found — try /stream, /copc, /potree, /sog, /lcc, /convert, /3dtiles-self-contained, or /3dtiles-tools');
  } catch (e) {
    console.error('[tile-server]', e.stack || e.message);
    // A handler may have already started streaming a response — don't double-send headers (that throw
    // was itself crashing the server with ERR_HTTP_HEADERS_SENT).
    if (!res.headersSent) res.writeHead(500, CORS);
    res.end(res.headersSent ? '' : String(e.message || e));
  }
}).listen(PORT, () => {
  console.log(`tile-server on http://localhost:${PORT}`);
  console.log(`  tiles    (unified) /tiles/tileset.json?url=<SRC>&format=<fmt>&cache=<none|hierarchy|full>[&prefetch=N][&tiling=implicit|explicit]`);
  console.log(`  stream   (cache=none/hierarchy) /stream/tileset.json?url=<SRC>[&format=][&hierarchy=lazy|eager][&prefetch=N]`);
  console.log(`  copc     /copc/tileset.json?url=<COPC_URL>`);
  console.log(`  potree   /potree/tileset.json?url=<metadata.json URL>`);
  console.log(`  convert  (preprocess+cache, any fmt) /convert/tileset.json?url=<SRC>[&format=<fmt>][&centroids=1]`);
  console.log(`  3dtiles-self-contained  /3dtiles-self-contained/tileset.json?url=<path-or-URL.3tz|.3dtiles>`);
  console.log(`  3dtiles-tools  /3dtiles-tools/tileset.json?tool=implicit-to-explicit|upgrade&dir=<path>[&base=<url>]`);
  console.log(`  gltf     (per-tile glTF-Transform) /gltf/tileset.json?url=<tileset>&ops=decompress  (Draco/meshopt/KTX2 decode)`);
  console.log(`  bing     Bing Maps 3D → /bing/tileset.json?root=<quadkey>&g=<genid>[&decompress=1]`);
  console.log(`  threemx  Bentley 3MX → /threemx/tileset.json?url=<Scene.3mx | root.3mxb>`);
});
