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
import { copcTileset, copcTile, copcSubtree, copcTileRe } from './copc-live.js';
import { potreeTileset, potreeTile, potreeSubtree, potreeTileRe } from './potree-live.js';
import { sogTileset, sogTile, sogTileRe } from './sog-live.js';
import { lccTileset, lccTile, lccTileRe } from './lcc-live.js';
import { radTileset, radTile, radTileRe } from './rad-live.js';
import { i3sTileset, i3sTile, i3sTileRe } from './i3s-live.js';
import { handleSelfContained } from './3dtiles-self-contained.js';
import { detectFormatByName } from '../core/index.js';

// Package formats are already 3D Tiles inside a single file — they don't "convert" geometry, they
// stream a tileset out of a .3tz/.3dtiles container. /stream delegates them to the self-contained
// handler (range-reads for .3tz, sql.js for .3dtiles). Accept explicit format= aliases or the extension.
const PACKAGE_FORMATS = new Set(['3tz', '3dtiles-pkg', '3dtiles', 'package', 'pkg']);
const isPackageUrl = (url) => /\.(3tz|3dtiles)(\?|$)/i.test(url);

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
const COORD_RE = /^\d+-\d+-\d+-\d+$/;

// format → range adapter. Add an entry here as each format gains a streaming adapter.
// Streamable iff the source lets us build the tileset WITHOUT a full geometry convert: COPC/Potree
// (octree boxes), SOG (lod-meta tree), LCC (grid cell boxes from index.bin). RAD has no persisted
// per-tile bounds, but a cheap centers-only pass yields them without the full SPZ encode — so it
// streams too (decode each chunk's center column for the tree, full-encode tiles on demand).
// COPC/Potree are octrees → support &tiling=implicit|explicit (default implicit) + on-the-fly subtrees.
const ADAPTERS = {
  copc:   { tileset: copcTileset,   tile: copcTile,   subtree: copcSubtree,   tileRe: copcTileRe,   octree: true },
  potree: { tileset: potreeTileset, tile: potreeTile, subtree: potreeSubtree, tileRe: potreeTileRe, octree: true },
  sog:    { tileset: sogTileset,    tile: sogTile,    tileRe: sogTileRe },
  lcc:    { tileset: lccTileset,    tile: lccTile,    tileRe: lccTileRe },
  rad:    { tileset: radTileset,    tile: radTile,    tileRe: radTileRe },
  i3s:    { tileset: i3sTileset,    tile: i3sTile,    tileRe: i3sTileRe },
};
export const streamableFormats = Object.keys(ADAPTERS);

// Append &format=<fmt> to every relative content/subtree URI (so the follow-up /stream/{tile,subtrees}
// requests carry the format and dispatch to the same adapter). Handles both the explicit nested-tree
// uris and the implicit `{level}-{x}-{y}-{z}` templates.
function tagContentUris(node, fmt) {
  if (Array.isArray(node)) { for (const v of node) tagContentUris(v, fmt); return; }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'uri' && typeof v === 'string' && (v.startsWith('tile/') || v.startsWith('subtrees/'))) node[k] = v + `&format=${fmt}`;
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

  // Package formats (.3tz / .3dtiles): delegate to the self-contained handler. We remap the
  // /stream/<key> path to /3dtiles-self-contained/<key> and hand off; that handler reads the
  // container (range-reads for .3tz, sql.js for .3dtiles) and rewrites content URIs to itself.
  if (PACKAGE_FORMATS.has(fmt) || isPackageUrl(url)) {
    const key = u.pathname.slice('/stream/'.length) || 'tileset.json';
    const u2 = new URL(u.href);
    u2.pathname = `/3dtiles-self-contained/${key}`;
    return handleSelfContained(req, res, u2);
  }

  const adapter = ADAPTERS[fmt];
  if (!adapter) {
    res.writeHead(501, CORS);
    res.end(`no live-stream adapter for "${fmt || name}" yet (streamable: ${streamableFormats.join(', ')}). Use /convert for any format.`);
    return true;
  }

  if (u.pathname === '/stream/tileset.json') {
    // octree adapters honor &tiling (default implicit); non-octree (sog/lcc) ignore it.
    const ts = await adapter.tileset(url, { tiling: u.searchParams.get('tiling') });
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
  const s = u.pathname.match(/^\/stream\/subtrees\/(.+)\.subtree$/);
  if (s && adapter.subtree && COORD_RE.test(s[1])) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', ...CORS });
    res.end(await adapter.subtree(url, s[1]));
    return true;
  }
  res.writeHead(404, CORS); res.end('not found');
  return true;
}
