/**
 * gltf-live.js — on-the-fly **glTF-Transform pipeline** over an existing 3D Tiles tileset.
 *
 * The generic per-tile transform tool (see README "Factory / composability"). Proxies an explicit
 * tileset and runs a glTF-Transform op chain on EACH tile GLB as it's requested — today the
 * **decompress** ops (Draco / EXT_meshopt / KTX2→PNG), tomorrow encode/simplify ops. Streaming model
 * like `/3dtiles-tools`: the tileset JSON is rewritten once (cheap), tiles transformed on demand.
 *
 *   GET /gltf/tileset.json?url=<tileset.json URL>&ops=decompress
 *   GET /gltf/tile.glb?url=<absolute tile GLB URL>&ops=decompress
 *
 * `ops` = comma list: `decompress` (= draco+meshopt+ktx) | `draco` | `meshopt` | `ktx`.
 * Works on EXPLICIT tilesets with concrete tile URIs (Bing GLB, 3MX, external mesh 3D Tiles). Implicit
 * `{level}-{x}-{y}` templates can't be per-tile-rewritten, so those pass through untouched.
 */
import { decompressGlb, sendJson, sendGlb, sendErr, CORS } from '../core/index.js';

const opsToOpts = (ops) => {
  const set = new Set((ops || 'decompress').split(',').map(s => s.trim()));
  if (set.has('decompress')) return { draco: true, meshopt: true, ktx: true };
  return { draco: set.has('draco'), meshopt: set.has('meshopt'), ktx: set.has('ktx') };
};

async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
const baseOf = (url) => url.slice(0, url.lastIndexOf('/') + 1);
const isAbs = (u) => /^https?:\/\//i.test(u) || u.startsWith('/');
const resolve = (uri, base) => isAbs(uri) ? uri : base + uri;

// Rewrite every content.uri in the tree → route through /gltf. External tilesets (.json) recurse via
// /gltf/tileset.json; tile GLBs go through /gltf/tile.glb. Query-string URIs (our own stream adapters'
// `tile/x.glb?url=…`) are absolutized by joining to the upstream base. Implicit templates are skipped.
function rewriteTree(node, base, ops) {
  if (!node || typeof node !== 'object') return;
  if (node.content && typeof node.content.uri === 'string') {
    const uri = node.content.uri;
    if (!/\{level\}|\{x\}|\{y\}|\{z\}/.test(uri)) {          // skip implicit templates
      const enc = encodeURIComponent(resolve(uri, base));
      const isExternal = /\.json$/i.test(uri.split('?')[0]);   // external tileset vs tile GLB
      node.content.uri = isExternal ? `tileset.json?url=${enc}&ops=${ops}` : `tile.glb?url=${enc}&ops=${ops}`;
    }
  }
  for (const c of node.children || []) rewriteTree(c, base, ops);
}

export async function handleGltf(req, res, u) {
  if (!u.pathname.startsWith('/gltf/')) return false;
  const url = u.searchParams.get('url');
  const ops = u.searchParams.get('ops') || 'decompress';
  if (!url) { sendErr(res, 400, 'missing ?url='); return true; }

  try {
    if (u.pathname === '/gltf/tileset.json') {
      const ts = JSON.parse((await fetchBuf(url)).toString('utf8'));
      if (ts.root) rewriteTree(ts.root, baseOf(url), ops);
      sendJson(res, ts);
      return true;
    }
    if (u.pathname === '/gltf/tile.glb') {
      const { glb } = await decompressGlb(await fetchBuf(url), opsToOpts(ops));
      sendGlb(res, glb);
      return true;
    }
    sendErr(res, 404, 'not found');
  } catch (e) {
    console.error('[gltf-live]', e.message);
    if (!res.headersSent) sendErr(res, 500, e.message); else res.end();
  }
  return true;
}
