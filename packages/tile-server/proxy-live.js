/**
 * proxy-live.js — generic CORS proxy for otherwise-inaccessible-from-the-browser 3D Tiles sources.
 *
 * Some open-data hosts (Agisoft Cloud's `cloud.agisoft.com/api/...tileset.json`) don't send
 * `Access-Control-Allow-Origin` on ANY response — not the tileset.json, not the child tilesets, not the
 * tile GLBs — even though the data is public. Confirmed by curl against the real Agisoft Jam tileset:
 * no `access-control-allow-origin` header anywhere, and its `content.uri`s are RELATIVE ("Data/d000.glb",
 * "Data/e0000/tileset.json") — so a naive byte-passthrough of just the root would still 404/CORS-fail on
 * every child once the browser resolves those relative URIs against `/proxy`'s own path instead of the
 * original host. So this proxy is tileset-aware: for a JSON response that looks like a 3D Tiles tileset
 * (`asset` + `root`), it recursively rewrites every `content.uri` (and legacy `content.url`) to an
 * absolute `/proxy?url=<resolved-absolute-source>` — same trick as `/gltf`'s `rewriteTree` — so children
 * keep flowing back through this same proxy however deep the tree goes. Anything else (a tile GLB, a
 * non-tileset JSON, a subtree binary) is streamed through byte-for-byte.
 *
 *   GET /proxy?url=<absolute source URL>
 *
 * No credential/header forwarding beyond a plain GET — this is for public read-only tilesets (the access
 * token, if any, already lives in the query string of `url`), not an authenticated-request relay.
 *
 * Query-string inheritance: Agisoft Cloud's own access token lives on the tileset.json URL
 * (`?access=<token>`), but every child `content.uri` is a bare relative path with NO token of its own
 * ("Data/a.glb") — confirmed live: that path 302-redirects (denied) without the token, 200s with it.
 * So a resolved child URI that doesn't carry its own query string inherits the PARENT's — same as how a
 * browser would resolve a relative link, since query strings aren't part of path resolution at all.
 */
import { CORS, sendErr } from '../core/index.js';

/**
 * Hosts whose API key is added HERE, from the server's environment, on the way out — the rewritten
 * child URIs sent to the browser never carry it (and any key a response echoes is stripped), so a
 * key-protected provider can sit in a public mosaic without leaking its key.
 */
const HOST_KEYS = {
  'api.vexcelgroup.com': { param: 'api_key', env: 'VEXCEL_API_KEY' },
};
function withKey(url) {
  const u = new URL(url);
  const k = HOST_KEYS[u.hostname];
  const v = k && process.env[k.env];
  if (v && !u.searchParams.has(k.param)) u.searchParams.set(k.param, v);
  return u.href;
}
function withoutKey(url) {
  try {
    const u = new URL(url);
    const k = HOST_KEYS[u.hostname];
    if (k) u.searchParams.delete(k.param);
    return u.href;
  } catch { return url; }
}

const isAbsUri = (u) => /^https?:\/\//i.test(u);
function resolveUri(uri, srcUrl) {
  if (isAbsUri(uri)) return uri;
  const [relPath, relQuery] = uri.split('?');
  const [srcPath, srcQuery] = srcUrl.split('?');
  const dir = srcPath.slice(0, srcPath.lastIndexOf('/') + 1);
  const query = relQuery ?? srcQuery;
  return dir + relPath + (query ? `?${query}` : '');
}

function rewriteTree(node, srcUrl) {
  if (!node || typeof node !== 'object') return;
  const content = node.content;
  if (content && typeof content === 'object') {
    const uri = content.uri ?? content.url;
    if (typeof uri === 'string' && !/\{level\}|\{x\}|\{y\}|\{z\}/.test(uri)) {
      const abs = withoutKey(resolveUri(uri, srcUrl));
      const rewritten = `/proxy?url=${encodeURIComponent(abs)}`;
      if ('uri' in content) content.uri = rewritten; else content.url = rewritten;
    }
  }
  for (const c of node.children || []) rewriteTree(c, srcUrl);
}

export async function handleProxy(req, res, u) {
  if (u.pathname !== '/proxy') return false;
  const url = u.searchParams.get('url') && withoutKey(u.searchParams.get('url'));
  if (!url) { sendErr(res, 400, 'missing ?url=<source URL>'); return true; }
  if (!/^https?:\/\//i.test(url)) { sendErr(res, 400, 'url must be absolute http(s)'); return true; }

  try {
    const upstream = await fetch(withKey(url));
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const buf = Buffer.from(await upstream.arrayBuffer());

    if (/json/i.test(contentType) || url.split('?')[0].endsWith('.json')) {
      let json;
      try { json = JSON.parse(buf.toString('utf8')); } catch { json = null; }
      if (json && json.asset && json.root) {
        rewriteTree(json.root, url);
        res.writeHead(upstream.status, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify(json));
        return true;
      }
    }
    res.writeHead(upstream.status, { 'Content-Type': contentType, ...CORS });
    res.end(buf);
  } catch (e) {
    sendErr(res, 502, `proxy fetch failed: ${e.message}`);
  }
  return true;
}
