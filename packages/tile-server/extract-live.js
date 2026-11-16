/**
 * extract-live.js — **generic 3D Tiles bbox crop / subsample extract**, the HTTP side. Since every adapter here emits
 * 3D Tiles, the extractor ingests *3D Tiles* (any source — our /stream COPC/Potree/SOG/LCC/RAD/I3S outputs, /bing,
 * /threemx, or an external tileset) and branches by content type:
 *   • POINTS / splat centres → LAS, COPC   (GET /extract/las, /extract/copc)
 *   • TRIANGLES (mesh)       → merged GLB  (GET /extract/glb)
 *   • splats                 → SPZ, GLB, SOG, PLY (GET /extract/splat)
 *   • anything               → a cropped tileset.json, or a zip of the tiles (GET /extract/tileset, /extract/zip)
 *
 *   GET /extract/{las|copc|glb|splat|tileset|zip}?url=<tileset.json>&bbox=<west,south,minH,east,north,maxH>[&maxGE=<m>][&maxDepth=N]
 *
 * The walk, the box test and the writers are core/extract-core.js, which has no Node imports: the viewer runs the
 * same code in the browser when there is no tile server (apps/viewer/src/lib/browserExtract.ts). What is here is what
 * only a server has: fetching with retries, decompressing Draco/meshopt/KTX2 tiles before they are read, a temp file
 * for the LAS, and PDAL for COPC.
 */
import { createReadStream, existsSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import * as splat from '@playcanvas/splat-transform';
import { decompressGlb, CORS, fetchSource } from '../core/index.js';
import { IDENT, parseBbox, extractTilesetJson, extractZip, extractLas, extractMeshDocument, extractSplats } from '../core/extract-core.js';

// Resolve the PDAL binary for /extract/copc. Prefer $PDAL_BIN, then the pixi-global shim (`pixi global
// install pdal` → ~/.pixi/bin/pdal[.exe]), then `pdal` on PATH. pixi is the right installer here — PDAL
// is a conda-forge native binary, not a pip package (uv is Python-only).
function resolvePdal() {
  if (process.env.PDAL_BIN) return process.env.PDAL_BIN;
  const ext = process.platform === 'win32' ? '.exe' : '';
  const pixi = join(homedir(), '.pixi', 'bin', `pdal${ext}`);
  if (existsSync(pixi)) return pixi;
  return 'pdal';                                             // fall back to PATH
}
const PDAL_BIN = resolvePdal();

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
// splat-transform 3.x reads into lazy chunk sources backed by this pool; a tile is small, so it is read whole.
const splatPool = splat.createChunkDataPool();

// What the shared extractor is handed on a server: tiles fetched with the server's retries, and decompressed
// (Draco, meshopt, KTX2) before glTF-Transform reads them.
const deps = {
  fetchBytes: fetchSource,
  readGlb: async (bytes) => io.readBinary(new Uint8Array((await decompressGlb(bytes, {})).glb)),
  Document, splat, splatPool,
  warn: (msg) => console.warn('[extract-live]', msg),
};

// write a chunk respecting backpressure (so the response buffer can't grow unbounded → stays out-of-core)
const writeChunk = (res, buf) => (res.write(buf) ? Promise.resolve() : new Promise((r) => res.once('drain', r)));
const fail = (res, e) => { console.error('[extract-live]', e.message); if (!res.headersSent) { res.writeHead(500, CORS); res.end(e.message); } else res.end(); };

export async function handleExtract(req, res, u) {
  if (!u.pathname.startsWith('/extract/')) return false;
  const kind = { '/extract/las': 'las', '/extract/glb': 'glb', '/extract/copc': 'copc', '/extract/tileset': 'tileset', '/extract/zip': 'zip', '/extract/splat': 'splat' }[u.pathname] || null;
  const url = u.searchParams.get('url');
  const bboxStr = u.searchParams.get('bbox');
  const maxGE = u.searchParams.has('maxGE') ? Number(u.searchParams.get('maxGE')) : 0;       // 0 = finest
  const maxDepth = u.searchParams.has('maxDepth') ? Number(u.searchParams.get('maxDepth')) : 99;
  if (!kind || !url || !bboxStr) {
    res.writeHead(400, CORS); res.end('GET /extract/{las|copc|glb|tileset}?url=<tileset.json>&bbox=west,south,minH,east,north,maxH[&maxGE=m][&maxDepth=N]'); return true;
  }
  const bb = parseBbox(bboxStr);
  if (!bb) { res.writeHead(400, CORS); res.end('bbox needs 6 numbers (deg,deg,m,deg,deg,m)'); return true; }
  // Optional viewer-applied extra modelMatrix (col-major 16): Z-offset nudge / local-frame ENU placement.
  // Seeds the traversal world chain so the dump matches the on-screen (shifted) position. Identity if absent/bad.
  let initM = IDENT;
  const mStr = u.searchParams.get('matrix');
  if (mStr) { const m = mStr.split(',').map(Number); if (m.length === 16 && !m.some(Number.isNaN)) initM = m; }
  const o = { url, bb, maxGE, maxDepth, initM, deps };

  try {
    // tileset mode: no decode/merge — a filtered tileset referencing only the in-bbox tiles (each leaf keeps its
    // world transform and points at the original tile). Works for splats too.
    if (kind === 'tileset') {
      const { tileset, tiles } = await extractTilesetJson(o);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="crop-tileset.json"',
        'X-Extract-Tiles': String(tiles), 'Access-Control-Expose-Headers': 'X-Extract-Tiles', ...CORS });
      res.end(JSON.stringify(tileset)); return true;
    }

    // splat mode: the in-bbox SPLAT tiles merged into ONE supersplat-ingestable file (.spz/.glb/.sog/.ply);
    // per-splat clip is on by default, &clip=0 keeps whole tiles.
    if (kind === 'splat') {
      const clip = u.searchParams.get('clip') !== '0' && u.searchParams.get('clip') !== 'false';
      const r = await extractSplats({ ...o, format: u.searchParams.get('format'), clip, rx: u.searchParams.get('rx') });
      if (!r) { res.writeHead(404, CORS); res.end('no splat tiles in bbox (is this a splat source?)'); return true; }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${r.name}"`,
        'X-Extract-Tiles': String(r.tiles), 'X-Extract-Splats': String(r.splats), 'X-Extract-Splats-Raw': String(r.raw), 'X-Extract-Clipped': String(r.clipped),
        'Access-Control-Expose-Headers': 'X-Extract-Tiles,X-Extract-Splats,X-Extract-Splats-Raw,X-Extract-Clipped', ...CORS });
      res.end(Buffer.from(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength)); return true;
    }

    // zip mode: out-of-core single-download bundle — each in-bbox tile (one at a time) and a self-contained
    // tileset.json, in a STORE-mode zip. Works for mesh/splat/points; no decode/merge.
    if (kind === 'zip') {
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="crop.zip"', ...CORS });
      await extractZip(o, { write: (b) => writeChunk(res, b) });
      res.end(); return true;
    }

    const enu = u.searchParams.has('enu');
    // Disk-free out-of-core LAS: 2-pass (pass 1 counts + bbox for the header, pass 2 streams records).
    // No temp file, O(1) RAM — at the cost of traversing/decoding tiles twice. (?stream=1 on /extract/las)
    if (kind === 'las' && (u.searchParams.get('stream') === '1' || u.searchParams.get('stream') === 'true')) {
      await extractLas({ ...o, enu, twoPass: true, onCounted: ({ points }) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="crop.las"',
          'X-Extract-Points': String(points), 'Access-Control-Expose-Headers': 'X-Extract-Points', ...CORS });
      } }, { write: (b) => writeChunk(res, b) });
      res.end(); return true;
    }

    // ── OUT-OF-CORE LAS: points go to a temp file tile by tile (O(1) RAM), its header rewritten at the end.
    // ECEF offset = bbox centre so quantized int32 stays in range.
    if (kind === 'las' || kind === 'copc') {
      const tmp = join(tmpdir(), `dump-${Date.now()}-${Math.floor(performance.now())}.las`);
      const fh = await open(tmp, 'w');
      let r;
      try { r = await extractLas({ ...o, enu }, { write: async (b) => { await fh.write(b); }, rewrite: async (pos, b) => { await fh.write(b, 0, b.length, pos); } }); }
      finally { await fh.close(); }
      const hdr = { 'X-Extract-Points': String(r.points), 'X-Extract-Tiles': String(r.tiles), 'Access-Control-Expose-Headers': 'X-Extract-Points,X-Extract-Tiles,X-Extract-Primitives', ...CORS };
      if (kind === 'las') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="crop.las"', ...hdr });
        const stream = createReadStream(tmp); stream.pipe(res); stream.on('close', () => unlink(tmp).catch(() => {}));
        return true;
      }
      // copc: shell out to pdal (needs the LAS on disk anyway) → COPC LAZ, then stream it.
      const copc = tmp.replace(/\.las$/, '.copc.laz');
      const cleanup = () => { unlink(tmp).catch(() => {}); unlink(copc).catch(() => {}); };
      const p = spawn(PDAL_BIN, ['translate', tmp, copc], { stdio: ['ignore', 'ignore', 'pipe'] });
      let perr = '';
      p.stderr.on('data', d => { perr += d; });
      p.on('error', () => { cleanup(); if (!res.headersSent) { res.writeHead(501, CORS); res.end('pdal not installed — /extract/copc needs PDAL. Install with `pixi global install pdal` (or set PDAL_BIN). Or use /extract/las and convert with `pdal translate crop.las out.copc.laz`.'); } });
      p.on('close', (code) => {
        if (code !== 0) { cleanup(); if (!res.headersSent) { res.writeHead(500, CORS); res.end('pdal failed: ' + perr.slice(0, 300)); } return; }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="crop.copc.laz"', ...hdr });
        const stream = createReadStream(copc); stream.pipe(res); stream.on('close', cleanup);
      });
      return true;
    }

    // glb: the triangle primitives that touch the box, merged (in memory), vertices in ECEF.
    const { document, primitives, tiles } = await extractMeshDocument(o);
    const merged = Buffer.from(await io.writeBinary(document));
    res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Disposition': 'attachment; filename="crop.glb"',
      'X-Extract-Primitives': String(primitives), 'X-Extract-Tiles': String(tiles), 'Access-Control-Expose-Headers': 'X-Extract-Points,X-Extract-Tiles,X-Extract-Primitives', ...CORS });
    res.end(merged);
  } catch (e) { fail(res, e); }
  return true;
}
