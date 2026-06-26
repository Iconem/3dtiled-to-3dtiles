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

const PORT = Number(process.env.PORT) || 3001;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };

// Keep the server alive through bad input. laz-perf's WASM build installs its OWN process-level
// 'uncaughtException'/'unhandledRejection' handlers that RE-THROW (killing the process) when it
// aborts on a non-LAS buffer — e.g. someone hits /copc with a JSON metadata.json. We override those
// with logging handlers so one bad request can't take the whole tile-server down.
process.removeAllListeners('uncaughtException');
process.removeAllListeners('unhandledRejection');
process.on('uncaughtException',  e => console.error('[tile-server] uncaughtException:', e?.message || e));
process.on('unhandledRejection', e => console.error('[tile-server] unhandledRejection:', e?.message || e));

http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const u = new URL(req.url, `http://localhost:${PORT}`);
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
  console.log(`  stream   (true range-streaming) /stream/tileset.json?url=<SRC>[&format=copc|potree]`);
  console.log(`  copc     /copc/tileset.json?url=<COPC_URL>`);
  console.log(`  potree   /potree/tileset.json?url=<metadata.json URL>`);
  console.log(`  convert  (preprocess+cache, any fmt) /convert/tileset.json?url=<SRC>[&format=<fmt>][&centroids=1]`);
  console.log(`  3dtiles-self-contained  /3dtiles-self-contained/tileset.json?url=<path-or-URL.3tz|.3dtiles>`);
  console.log(`  3dtiles-tools  /3dtiles-tools/tileset.json?tool=implicit-to-explicit|upgrade&dir=<path>[&base=<url>]`);
});
