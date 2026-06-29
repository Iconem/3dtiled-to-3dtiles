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
import { detectFormatByName, compressGlb, decompressGlb } from '../core/index.js';

// Per-tile glTF-Transform op applied to every streamed tile GLB, the streaming counterpart of the
// /gltf proxy (which only reaches *explicit* tilesets). Because /stream builds each tile GLB itself,
// this also covers the implicit COPC/Potree octrees that /gltf cannot URL-rewrite.
//   transform=meshopt    → EXT_meshopt_compression (works on POINTS — shrinks point tiles to ~37%)
//   transform=draco      → KHR_draco_mesh_compression (mesh tiles only; no-op on point clouds)
//   transform=decompress → decode draco+meshopt+KTX2 (for consumers like blosm that can't read them)
// &tex=jpg|png chooses the KTX2 decode output (decompress only). No-op transforms pass the GLB through.
async function applyTransform(glb, transform, tex) {
  if (!glb || !transform) return glb;
  try {
    if (transform === 'decompress') return (await decompressGlb(glb, { texFormat: tex === 'png' ? 'png' : 'jpg' })).glb;
    if (transform === 'meshopt' || transform === 'draco') return (await compressGlb(glb, { [transform]: true })).glb;
  } catch (e) { console.warn(`[stream] transform=${transform} failed:`, e.message); }
  return glb;
}
const TRANSFORMS = new Set(['meshopt', 'draco', 'decompress']);

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
function tagContentUris(node, suffix) {
  if (Array.isArray(node)) { for (const v of node) tagContentUris(v, suffix); return; }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'uri' && typeof v === 'string' && (v.startsWith('tile/') || v.startsWith('subtrees/'))) node[k] = v + suffix;
    else tagContentUris(v, suffix);
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
    // Unified live knobs (Axis B): hierarchy=eager|lazy (default lazy) + prefetch=<N levels>.
    // octree adapters also honor &tiling (default implicit). Non-octree (sog/lcc) ignore the lot.
    // Back-compat: &lazy=1 still forces lazy. hierarchy=lazy ⇒ I3S lazy fragments.
    const hierarchy = u.searchParams.get('hierarchy') || (/(^|&)lazy=(1|true)/.test(u.search) ? 'lazy' : null);
    // prefetch: 0 = warm nothing · N≥1 = warm N hierarchy levels in the background · -1 = warm ALL
    // (lazy cold start + full background drain). Applies to cache=none only. Default 1.
    const prefetch = u.searchParams.has('prefetch') ? Math.trunc(Number(u.searchParams.get('prefetch')) || 0) : undefined;
    const lazy = hierarchy ? hierarchy !== 'eager' : (u.searchParams.get('lazy') === '1' || u.searchParams.get('lazy') === 'true');
    // centroids: tiled-splat formats (sog/lcc/rad) emit glTF POINTS of splat centres instead of full
    // gaussians — a cheap preview. Affects the tileset (drops the KHR_gaussian_splatting requirement)
    // and each tile, so it must ride along on the child tile URIs too.
    const centroids = u.searchParams.get('centroids') === '1' || u.searchParams.get('centroids') === 'true';
    // transform: per-tile glTF-Transform op; rides along on child tile URIs so /stream/tile carries it.
    const transform = TRANSFORMS.has(u.searchParams.get('transform')) ? u.searchParams.get('transform') : null;
    const tex = u.searchParams.get('tex') === 'png' ? 'png' : 'jpg';
    const ts = await adapter.tileset(url, { tiling: u.searchParams.get('tiling'), lazy, hierarchy, prefetch, centroids });
    tagContentUris(ts.root, `&format=${fmt}` + (centroids ? '&centroids=1' : '')
      + (transform ? `&transform=${transform}` + (transform === 'decompress' && tex === 'png' ? '&tex=png' : '') : ''));
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(ts));
    return true;
  }
  const m = u.pathname.match(/^\/stream\/tile\/(.+)\.glb$/);
  if (m && adapter.tileRe.test(m[1])) {
    const centroids = u.searchParams.get('centroids') === '1' || u.searchParams.get('centroids') === 'true';
    let glb = await adapter.tile(url, m[1], { centroids });
    if (!glb) { res.writeHead(404, CORS); res.end('no such node'); return true; }
    const transform = TRANSFORMS.has(u.searchParams.get('transform')) ? u.searchParams.get('transform') : null;
    if (transform) glb = await applyTransform(glb, transform, u.searchParams.get('tex'));
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
