/**
 * bing-live.js — live **Bing Maps 3D (`tf=3dv4`) → OGC 3D Tiles** streaming middleware.
 *
 * Bing serves a standard **implicit-tiling** 3D Tiles dataset rooted at the `td1` manifest: a root with
 * per-face children, each using QUADTREE implicit tiling with templates `mtx{face}-{level}-{x}-{reverseY}`
 * (tile GLBs) and `st{face}-{level}-{x}-{reverseY}` (subtree availability — standard `subt` binaries).
 * The tile GLBs are standard (Draco + KTX2) with the **ECEF placement baked into the glTF node matrix**.
 *
 * Two Bing-specific extensions sit on the manifest:
 *   • MICROSOFT_reverse_y_template_uri  — URIs index tiles/subtrees by reverseY = 2^level − 1 − y
 *   • MICROSOFT_webmercator_subdivision — child tiles subdivide in Web Mercator (not cartographic)
 * Cesium doesn't implement either, so we **proxy + normalise**: fetch `td1`, strip those `extensionsRequired`,
 * rewrite the `mtx`/`st` templates to route through `/bing/{tile,subtree}/{face}-{level}-{x}-{y}` with a
 * standard `{y}`, and flip `y→reverseY` when fetching from Bing. Subtree *availability* bitstreams are
 * standard morton(x,y) — passed through untouched. (The webmercator subdivision only affects the bounding
 * regions Cesium uses for culling/LOD; geometry is ECEF-baked, so it still renders in the right place.)
 *
 *   GET /bing/tileset.json[?g=<genid>][&decompress=1]
 *   GET /bing/subtree/<face>-<level>-<x>-<y>.subtree?g=<genid>
 *   GET /bing/tile/<face>-<level>-<x>-<y>.glb?g=<genid>[&decompress=1]
 *
 * (Replaces the former mtx-quadkey HTTP-probe quadtree, which couldn't discover Bing's deep-only tiles —
 * intermediate LODs return 0 bytes, so probing from a shallow root pruned the whole tree.)
 * User holds the Bing licensing; this is purely the technical format path.
 */
import { decompressGlb, sendJson, sendGlb, sendErr, CORS } from '../core/index.js';

const BING_HOST = 't.ssl.ak.tiles.virtualearth.net';
const DEFAULT_G = '15530';            // working generation id (drifts; override with &g=)
const bingApi = (name, g) => `https://${BING_HOST}/tiles/${name}?g=${g}&cmt=cmpr3d&tf=3dv4&n=z&fallback=none`;
const reverseY = (level, y) => (2 ** level) - 1 - y;          // MICROSOFT_reverse_y_template_uri

// Rewrite a Bing implicit template (`mtx0-{level}-{x}-{reverseY}` / `st0-…`) → a proxy template that
// uses a STANDARD {y}; the proxy flips y→reverseY when it fetches from Bing.
function rewriteTemplate(uri, kind, ext, g) {
  const m = /^(?:mtx|st)(\d+)-/.exec(uri);
  const face = m ? m[1] : '0';
  return `/bing/${kind}/${face}-{level}-{x}-{y}${ext}?g=${g}`;
}
function rewriteNode(node, g) {
  if (!node || typeof node !== 'object') return;
  if (node.content && typeof node.content.uri === 'string' && /^(?:mtx)\d+-/.test(node.content.uri))
    node.content.uri = rewriteTemplate(node.content.uri, 'tile', '.glb', g);
  const sub = node.implicitTiling && node.implicitTiling.subtrees;
  if (sub && typeof sub.uri === 'string' && /^(?:st)\d+-/.test(sub.uri))
    sub.uri = rewriteTemplate(sub.uri, 'subtree', '.subtree', g);
  for (const c of node.children || []) rewriteNode(c, g);
}

async function fetchBing(name, g) {
  const r = await fetch(bingApi(name, g));
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer());
}

/** Fetch the `td1` manifest and normalise it into a Cesium-consumable implicit 3D Tiles tileset. */
export async function bingTileset(g = DEFAULT_G) {
  const buf = await fetchBing('td1', g);
  if (!buf) throw new Error('bing td1 manifest fetch failed');
  const ts = JSON.parse(buf.toString('utf8').replace(/^﻿/, ''));
  const isMs = e => typeof e === 'string' && e.startsWith('MICROSOFT_');
  if (Array.isArray(ts.extensionsRequired)) ts.extensionsRequired = ts.extensionsRequired.filter(e => !isMs(e));
  if (Array.isArray(ts.extensionsUsed)) ts.extensionsUsed = ts.extensionsUsed.filter(e => !isMs(e));
  if (!ts.extensionsRequired?.length) delete ts.extensionsRequired;
  if (!ts.extensionsUsed?.length) delete ts.extensionsUsed;
  rewriteNode(ts.root, g);
  return ts;
}

/** Try to handle a /bing/* request. Returns true iff it owned the response. */
export async function handleBing(req, res, u) {
  if (!u.pathname.startsWith('/bing/')) return false;
  const g = u.searchParams.get('g') || DEFAULT_G;
  const decompress = u.searchParams.get('decompress') === '1' || u.searchParams.get('decompress') === 'true';
  try {
    if (u.pathname === '/bing/tileset.json') { sendJson(res, await bingTileset(g)); return true; }

    const sub = u.pathname.match(/^\/bing\/subtree\/(\d+)-(\d+)-(\d+)-(\d+)\.subtree$/);
    if (sub) {
      const [, face, level, x, y] = sub;
      const buf = await fetchBing(`st${face}-${level}-${x}-${reverseY(+level, +y)}`, g);   // y→reverseY
      if (!buf) { sendErr(res, 404, 'no Bing subtree'); return true; }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', ...CORS }); res.end(buf);
      return true;
    }

    const tile = u.pathname.match(/^\/bing\/tile\/(\d+)-(\d+)-(\d+)-(\d+)\.glb$/);
    if (tile) {
      const [, face, level, x, y] = tile;
      const buf = await fetchBing(`mtx${face}-${level}-${x}-${reverseY(+level, +y)}`, g);   // y→reverseY
      if (!buf || buf.length < 8 || buf.toString('latin1', 0, 4) !== 'glTF') { sendErr(res, 404, 'no Bing tile'); return true; }
      sendGlb(res, decompress ? (await decompressGlb(buf, { draco: true, meshopt: true, ktx: true })).glb : buf);
      return true;
    }
    sendErr(res, 404, 'not found');
  } catch (e) {
    console.error('[bing-live]', e.message);
    if (!res.headersSent) sendErr(res, 500, e.message); else res.end();
  }
  return true;
}
