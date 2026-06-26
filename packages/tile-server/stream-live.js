/**
 * stream-live.js — unified `/stream` dispatcher for TRUE online range-streaming.
 *
 * One front-door over the per-format range adapters (the format-specific range logic is irreducible —
 * a COPC LAZ chunk, a Potree octree-node byte range, etc. — but the entry point is unified):
 *
 *   GET /stream/tileset.json?url=<SRC>[&format=<fmt>]   → tileset from the format's range adapter
 *   GET /stream/tile/<key>.glb?url=<SRC>&format=<fmt>   → one range-built tile from that adapter
 *
 * vs `/convert` (preprocess + cache: converts the whole dataset once, then serves static — works for
 * EVERY format). `/stream` only serves formats that have a range adapter (copc, potree today; lcc/rad
 * next — see README roadmap); for the rest it returns 501 pointing you at `/convert`.
 *
 * The tileset's relative content URIs (`tile/<key>.glb?url=…`) get `&format=<fmt>` appended so the
 * follow-up `/stream/tile/...` requests carry the format and dispatch to the same adapter.
 */
import { copcTileset, copcTile, copcTileRe } from './copc-live.js';
import { potreeTileset, potreeTile, potreeTileRe } from './potree-live.js';
import { sogTileset, sogTile, sogTileRe } from './sog-live.js';
import { lccTileset, lccTile, lccTileRe } from './lcc-live.js';
import { detectFormatByName } from '../core/index.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };

// format → range adapter. Add an entry here as each format gains a streaming adapter.
// Streamable iff the source lets us build the tileset WITHOUT decoding geometry: COPC/Potree (octree
// boxes), SOG (lod-meta tree), LCC (grid cell boxes from index.bin). RAD persists no tile bounds and
// isn't spatially tiled → use /convert (see docs-references/rad-format-notes.md).
const ADAPTERS = {
  copc:   { tileset: copcTileset,   tile: copcTile,   tileRe: copcTileRe },
  potree: { tileset: potreeTileset, tile: potreeTile, tileRe: potreeTileRe },
  sog:    { tileset: sogTileset,    tile: sogTile,    tileRe: sogTileRe },
  lcc:    { tileset: lccTileset,    tile: lccTile,    tileRe: lccTileRe },
};
export const streamableFormats = Object.keys(ADAPTERS);

// Append &format=<fmt> to every relative content URI so /stream/tile requests reach the right adapter.
function tagContentUris(node, fmt) {
  if (Array.isArray(node)) { for (const v of node) tagContentUris(v, fmt); return; }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'uri' && typeof v === 'string' && v.startsWith('tile/')) node[k] = v + `&format=${fmt}`;
    else tagContentUris(v, fmt);
  }
}

/** Try to handle a /stream/* request. Returns true iff it owned the response. */
export async function handleStream(req, res, u) {
  if (!u.pathname.startsWith('/stream/')) return false;
  const url = u.searchParams.get('url');
  if (!url) { res.writeHead(400, CORS); res.end('missing ?url=<source url>'); return true; }
  const name = url.split('?')[0].split('/').pop() || '';
  const fmt = u.searchParams.get('format') || detectFormatByName(name);
  const adapter = ADAPTERS[fmt];
  if (!adapter) {
    res.writeHead(501, CORS);
    res.end(`no live-stream adapter for "${fmt || name}" yet (streamable: ${streamableFormats.join(', ')}). Use /convert for any format.`);
    return true;
  }

  if (u.pathname === '/stream/tileset.json') {
    const ts = await adapter.tileset(url);
    tagContentUris(ts.root, fmt);
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(ts));
    return true;
  }
  const m = u.pathname.match(/^\/stream\/tile\/(.+)\.glb$/);
  if (m && adapter.tileRe.test(m[1])) {
    const glb = await adapter.tile(url, m[1]);
    if (!glb) { res.writeHead(404, CORS); res.end('no such node'); return true; }
    res.writeHead(200, { 'Content-Type': 'model/gltf-binary', ...CORS });
    res.end(glb);
    return true;
  }
  res.writeHead(404, CORS); res.end('not found');
  return true;
}
