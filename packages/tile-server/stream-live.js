/**
 * stream-live.js — unified `/stream` dispatcher for TRUE online range-streaming. The ONE HTTP surface
 * for every format's range adapter (2026-07-02: the old direct /copc, /potree, /sog, /lcc, /rad, /i3s
 * endpoints were removed — they were a strict subset of what this already does).
 *
 * One front-door over the per-format range adapters (the format-specific range logic is irreducible —
 * a COPC LAZ chunk, a Potree octree-node byte range, etc. — but the entry point is unified):
 *
 *   GET /stream/tileset.json?url=<SRC>&format=<fmt>[&cache=none|hierarchy][&prefetch=N][&tiling=…]
 *   GET /stream/tile/<key>.glb?url=<SRC>&format=<fmt>       → one range-built tile from that adapter
 *   GET /stream/subtrees/<key>.subtree?url=<SRC>&format=<fmt>  → implicit-tiling subtree (octree fmts)
 *   GET /stream/threemx/node/<path>.json?url=<SRC>          → 3MX lazy-fragment continuation (one .3mxb)
 *   GET /stream/rad/subtree/<chunkIndex>.json?url=<SRC>     → RAD cache=none depth-cut continuation
 *
 * I3S has no persisted spatial index to make a lazy/partial hierarchy read meaningful (see its
 * file-header comments), so it always fully materializes its explicit tree regardless of `cache=` —
 * matching the Potree 1.x `tiling=explicit` simplification. (2026-07-02: this removed its
 * `/stream/i3s/node,tile/…` lazy-fragment continuation routes.) RAD USED to be in the same boat and
 * had its own `/stream/rad/subtree/…` route removed the same day — reinstated once a cheaper per-chunk
 * topology read (see rad-live.js) made a depth-bounded lazy scan worth it again for cache=none. 3MX is
 * a genuine DAG with no persisted spatial index at all, so it keeps its own lazy continuation (above)
 * regardless of cache mode — the same shape RAD/I3S used to share, just for a format where "scan
 * everything eagerly" isn't cheap even once.
 *
 * threemx and geosplats (2026-07-02) moved here from their own standalone /threemx, /geosplats
 * endpoints — same ADAPTERS-registry pattern as every other format, so they now get cache=/prefetch=/
 * /tiles too. geosplats keeps a few of its own tuning query params (lod/frame/euler/scale/yaw/alt),
 * threaded through like tiling/centroids below.
 *
 * vs `/convert` (preprocess + cache: converts the whole dataset once, then serves static — works for
 * EVERY format, not just the ones with a range adapter); for formats without one, `/stream` returns
 * 501 pointing you at `/convert`.
 *
 * The tileset's relative content URIs (`tile/<key>.glb?url=…`) get `&format=<fmt>` appended so the
 * follow-up `/stream/tile/...` requests carry the format and dispatch to the same adapter.
 */
import { copcTileset, copcTile, copcSubtree, copcTileRe, copcDrain } from './copc-live.js';
import { potreeTileset, potreeTile, potreeSubtree, potreeTileRe, potreeDrain } from './potree-live.js';
import { sogTileset, sogTile, sogTileRe } from './sog-live.js';
import { lccTileset, lccTile, lccTileRe } from './lcc-live.js';
import { radTileset, radTile, radTileRe, radSubtree } from './rad-live.js';
import { i3sTileset, i3sTile, i3sTileRe } from './i3s-live.js';
import { threemxTileset, threemxTile, threemxTileRe, threemxNode } from './threemx-live.js';
import { geosplatsTileset, geosplatsTile, geosplatsTileRe } from './geosplats-live.js';
import { handleSelfContained } from './3dtiles-self-contained.js';
import { detectFormatByName, compressGlb, decompressGlb, applyPlacement, curvedParam } from '../core/index.js';

// Per-tile glTF-Transform op applied to every streamed tile GLB, the streaming counterpart of the
// /gltf proxy (which only reaches *explicit* tilesets). Because /stream builds each tile GLB itself,
// this also covers the implicit COPC/Potree octrees that /gltf cannot URL-rewrite.
//   transform=meshopt    → EXT_meshopt_compression (works on POINTS — shrinks point tiles to ~37%)
//   transform=draco      → KHR_draco_mesh_compression (mesh tiles only; no-op on point clouds)
//   transform=ktx        → KHR_texture_basisu (KTX2 ETC1S) textures, in-process WASM (mesh tiles w/ textures)
//   transform=ktx-uastc  → KTX2 UASTC (higher quality / larger)
//   transform=decompress → decode draco+meshopt+KTX2 (for consumers like blosm that can't read them)
// &tex=jpg|png chooses the KTX2 decode output (decompress only). No-op transforms pass the GLB through.
async function applyTransform(glb, transform, tex) {
  if (!glb || !transform) return glb;
  try {
    if (transform === 'decompress') return (await decompressGlb(glb, { texFormat: (tex === 'png' || tex === 'webp') ? tex : 'jpg' })).glb;
    if (transform === 'meshopt' || transform === 'draco') return (await compressGlb(glb, { [transform]: true })).glb;
    if (transform === 'ktx') return (await compressGlb(glb, { ktx: true })).glb;
    if (transform === 'ktx-uastc') return (await compressGlb(glb, { ktx: true, uastc: true })).glb;
  } catch (e) { console.warn(`[stream] transform=${transform} failed:`, e.message); }
  return glb;
}
const TRANSFORMS = new Set(['meshopt', 'draco', 'ktx', 'ktx-uastc', 'decompress']);

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
  copc:      { tileset: copcTileset,      tile: copcTile,      subtree: copcSubtree, tileRe: copcTileRe,      octree: true, drain: copcDrain },
  potree:    { tileset: potreeTileset,    tile: potreeTile,    subtree: potreeSubtree, tileRe: potreeTileRe, octree: true, drain: potreeDrain },
  sog:       { tileset: sogTileset,       tile: sogTile,       tileRe: sogTileRe },
  lcc:       { tileset: lccTileset,       tile: lccTile,       tileRe: lccTileRe },
  rad:       { tileset: radTileset,       tile: radTile,       tileRe: radTileRe },
  i3s:       { tileset: i3sTileset,       tile: i3sTile,       tileRe: i3sTileRe },
  threemx:   { tileset: threemxTileset,   tile: threemxTile,   tileRe: threemxTileRe },
  geosplats: { tileset: geosplatsTileset, tile: geosplatsTile, tileRe: geosplatsTileRe },
};
export const streamableFormats = Object.keys(ADAPTERS);

// cache=refine: open lazily with nothing prefetched, then drain the whole hierarchy in the background
// as soon as a client asks for a tile below the root, i.e. once it refines into the dataset. What a
// mosaic's `&cache=hierarchy` asks of its children: only the datasets someone zooms into pay for a
// drain, and nobody waits on it (cache=hierarchy blocks the root answer for the whole drain).
// Source URL → its adapter's drain, until the first refining tile request starts it.
const drainOnRefine = new Map();
// depth of a tile token: "level-x-y-z" (implicit, COPC keys) or a Potree 1.x name ("r", "r04", …)
const tokenLevel = (tok) => (/^r[0-7]*$/.test(tok) ? tok.length - 1 : Number(tok.split('-')[0]) || 0);

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

// 3MX is an arbitrary DAG with no persisted spatial index (unlike RAD/I3S, which dropped this same kind
// of route once eager-scanning turned out to be cheap) — discovering its tree at all means fetching
// every .3mxb, so it genuinely needs a lazy per-node continuation. Namespaced under /stream/threemx/…
// since the shape (one child .3mxb → one fragment) doesn't fit the generic tile/subtree routes below.
async function handleThreemxNode(u, res) {
  const n = u.pathname.match(/^\/stream\/threemx\/node\/(.+)\.json$/);
  if (!n) return false;
  const url = u.searchParams.get('url');
  if (!url) { res.writeHead(400, CORS); res.end('missing ?url=<source url>'); return true; }
  const frag = await threemxNode(url, decodeURIComponent(n[1]));
  if (!frag) { res.writeHead(404, CORS); res.end('no such node'); return true; }
  // threemx-live.js bakes absolute /stream/tile/…&format=threemx URIs itself (a relative "tile/…" here
  // would resolve against THIS fragment's own path, not /stream/) — no tagContentUris needed.
  res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(frag));
  return true;
}

// RAD's cache=none continuation (see rad-live.js's file header + scanBoundedTopology comment) — a
// depth-cut external-tileset reference, same idea as threemx's node continuation above but for a
// format that DOES have real per-chunk bounds/topology once you bother reading them, just too many
// chunks to read them all up front for a fast first response.
async function handleRadSubtree(u, res) {
  const n = u.pathname.match(/^\/stream\/rad\/subtree\/(\d+)\.json$/);
  if (!n) return false;
  const url = u.searchParams.get('url');
  if (!url) { res.writeHead(400, CORS); res.end('missing ?url=<source url>'); return true; }
  const centroids = u.searchParams.get('centroids') === '1' || u.searchParams.get('centroids') === 'true';
  const ts = await radSubtree(url, n[1], { centroids });
  res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(ts));
  return true;
}

/** Try to handle a /stream/* request. Returns true iff it owned the response. */
export async function handleStream(req, res, u) {
  if (!u.pathname.startsWith('/stream/')) return false;
  if (await handleThreemxNode(u, res)) return true;
  if (await handleRadSubtree(u, res)) return true;
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
    // Unified live knobs (Axis B): cache=none|hierarchy (default none) + prefetch=<N levels>.
    // octree adapters also honor &tiling (default implicit). Non-octree (sog/lcc) ignore the lot.
    const cache = u.searchParams.get('cache');
    const hierarchy = cache === 'hierarchy' ? 'eager' : cache === 'none' || cache === 'refine' ? 'lazy' : null;
    // prefetch: 0 = warm nothing · N≥1 = warm N hierarchy levels in the background · -1 = warm ALL
    // (lazy cold start + full background drain). Applies to cache=none only. Default 1.
    const prefetch = cache === 'refine' ? 0
      : u.searchParams.has('prefetch') ? Math.trunc(Number(u.searchParams.get('prefetch')) || 0) : undefined;
    if (cache === 'refine' && adapter.drain && !drainOnRefine.has(url) && !drainOnRefine.has(`done:${url}`)) drainOnRefine.set(url, adapter.drain);
    const lazy = hierarchy !== 'eager';   // cache= absent or none → lazy (the default)
    // centroids: tiled-splat formats (sog/lcc/rad) emit glTF POINTS of splat centres instead of full
    // gaussians — a cheap preview. Affects the tileset (drops the KHR_gaussian_splatting requirement)
    // and each tile, so it must ride along on the child tile URIs too.
    const centroids = u.searchParams.get('centroids') === '1' || u.searchParams.get('centroids') === 'true';
    // transform: per-tile glTF-Transform op; rides along on child tile URIs so /stream/tile carries it.
    const transform = TRANSFORMS.has(u.searchParams.get('transform')) ? u.searchParams.get('transform') : null;
    const tex = u.searchParams.get('tex') === 'png' ? 'png' : 'jpg';
    // geosplats-only tuning knobs (ignored by every other adapter, same pattern as tiling/centroids above).
    const geosplatsOpts = fmt === 'geosplats' ? {
      lod: u.searchParams.has('lod') ? Number(u.searchParams.get('lod')) : undefined,
      frame: u.searchParams.get('frame') || undefined,
      euler: u.searchParams.get('euler') === '1',
      scale: u.searchParams.has('scale') ? Number(u.searchParams.get('scale')) : undefined,
      yaw: u.searchParams.has('yaw') ? Number(u.searchParams.get('yaw')) : undefined,
      alt: u.searchParams.has('alt') ? Number(u.searchParams.get('alt')) : undefined,
    } : null;
    // crs: EPSG:<n> for point clouds whose file declares no CRS (copc/potree; ignored elsewhere).
    const crs = u.searchParams.get('crs') || undefined;
    // curved: on|off overrides copc-live's extent rule for placing points on the ellipsoid (default auto).
    const curved = curvedParam(u.searchParams.get('curved'));
    // depth=0: the root tile only (no children, no hierarchy drain) — what /aggregate needs to place a
    // child; honoured by copc-live's curved explicit tree, ignored where the root is already cheap.
    const depth = u.searchParams.has('depth') ? Math.max(0, Math.trunc(Number(u.searchParams.get('depth')))) : undefined;
    const ts = await adapter.tileset(url, { tiling: u.searchParams.get('tiling'), lazy, hierarchy, prefetch, centroids, crs, curved, depth, ...geosplatsOpts });
    // User-directed globe placement (&lon=&lat=[&alt=][&heading=][&scale=]): attach a LOCAL dataset to
    // a real location so ANY 3D Tiles client (Cesium for Unreal/Unity, QGIS, native CesiumJS) streams
    // it in place — no viewer-side reorientation needed. Composes ON TOP of the adapter's own
    // local-upright root transform (SOG RX(−90), RAD RX(180), LCC upright, …), so each format's up-axis
    // convention stays normalized at the tileset level. Skipped when the source is already
    // georeferenced (its own placement wins) and for geosplats (own georef params: frame/yaw/alt).
    if (fmt !== 'geosplats') applyPlacement(ts.root, u.searchParams, `stream:${fmt}`);
    // colors: COLOR_0 storage of point tiles (u16 default, u8, f32; core/points-glb.js), carried to the tiles
    const colorsQ = /^(u16|u8|f32)$/.test(u.searchParams.get('colors') || '') ? `&colors=${u.searchParams.get('colors')}` : '';
    tagContentUris(ts.root, `&format=${fmt}` + colorsQ + (centroids ? '&centroids=1' : '') + (crs ? `&crs=${encodeURIComponent(crs)}` : '') + (curved ? `&curved=${curved}` : '')
      + (transform ? `&transform=${transform}` + (transform === 'decompress' && tex === 'png' ? '&tex=png' : '') : ''));
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(ts));
    return true;
  }
  const m = u.pathname.match(/^\/stream\/tile\/(.+)\.glb$/);
  if (m && adapter.tileRe.test(m[1])) {
    const drain = drainOnRefine.get(url);
    if (drain && tokenLevel(m[1]) >= 1) {
      drainOnRefine.delete(url);
      drainOnRefine.set(`done:${url}`, null);
      drain(url).catch((e) => { drainOnRefine.delete(`done:${url}`); console.warn(`[stream] cache=refine drain failed for ${url.split('?')[0].slice(-80)}: ${e.message}`); });
    }
    const centroids = u.searchParams.get('centroids') === '1' || u.searchParams.get('centroids') === 'true';
    let glb = await adapter.tile(url, m[1], { centroids, crs: u.searchParams.get('crs') || undefined, curved: curvedParam(u.searchParams.get('curved')),
      colors: u.searchParams.get('colors') || undefined });
    if (!glb) { res.writeHead(404, CORS); res.end('no such node'); return true; }
    const transform = TRANSFORMS.has(u.searchParams.get('transform')) ? u.searchParams.get('transform') : null;
    if (transform) glb = await applyTransform(glb, transform, u.searchParams.get('tex'));
    res.writeHead(200, { 'Content-Type': 'model/gltf-binary', ...CORS });
    res.end(glb);
    return true;
  }
  const s = u.pathname.match(/^\/stream\/subtrees\/(.+)\.subtree$/);
  if (s && adapter.subtree && COORD_RE.test(s[1])) {
    // Awaited before the headers: a failed hierarchy read must be an error, not a 200 with an empty body, which a client
    // takes for a subtree it cannot parse and never asks for again.
    const subtree = await adapter.subtree(url, s[1]);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', ...CORS });
    res.end(subtree);
    return true;
  }
  res.writeHead(404, CORS); res.end('not found');
  return true;
}
