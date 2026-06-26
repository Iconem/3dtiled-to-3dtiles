/**
 * to-explicit-live.js — /to-explicit middleware.
 *
 * Transcodes an implicit 3D Tiles 1.1 octree tileset (subtree files on disk) to an explicit
 * JSON tileset on the fly, caching the result in memory per directory.
 *
 * GET /to-explicit/tileset.json?dir=<absoluteOrRelativePath>[&base=<url>]
 *   → explicit tileset.json
 *
 * ?base=<url>: when present, all content URIs in the output are prefixed with this URL
 *   so that Cesium (which resolves relative URIs relative to the tileset URL) can fetch
 *   the actual .glb tiles from the Vite dev server.
 *   Example: &base=http://localhost:3000/sample-data/output/potree/lion_p2
 *
 * If the tileset directory already has a tileset-explicit.json, it is served directly
 * without re-transcoding (allows pre-baked explicit tilesets too).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { transcodeToExplicit } from 'implicit-to-explicit';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Content-Type': 'application/json' };

// Simple in-memory cache: dir → JSON string of explicit tileset
const cache = new Map();

async function getExplicit(dir) {
  if (cache.has(dir)) return cache.get(dir);

  // Check for pre-baked tileset-explicit.json
  const prebaked = path.join(dir, 'tileset-explicit.json');
  try {
    const text = await fs.readFile(prebaked, 'utf8');
    cache.set(dir, text);
    return text;
  } catch { /* fall through to transcode */ }

  // Transcode on demand (writes tileset-explicit.json as side effect)
  await transcodeToExplicit(dir, prebaked);
  const text = await fs.readFile(prebaked, 'utf8');
  cache.set(dir, text);
  return text;
}

/**
 * Rewrite all `content.uri` strings in an explicit tileset tree to be absolute URLs.
 * Mutates in place; returns the object for chaining.
 */
function rewriteUris(node, base) {
  if (!node) return node;
  if (node.content?.uri && !node.content.uri.startsWith('http')) {
    node.content.uri = base.replace(/\/$/, '') + '/' + node.content.uri;
  }
  if (node.children) node.children.forEach(c => rewriteUris(c, base));
  return node;
}

/** Try to handle a /to-explicit/* request. Returns true iff it owned the response. */
export async function handleToExplicit(req, res, u) {
  if (!u.pathname.startsWith('/to-explicit/')) return false;
  const dir = u.searchParams.get('dir');
  if (!dir) { res.writeHead(400, CORS); res.end(JSON.stringify({ error: 'missing ?dir=' })); return true; }

  const abs = path.resolve(dir);
  const base = u.searchParams.get('base') || null;
  try {
    const jsonStr = await getExplicit(abs);
    if (base) {
      // Rewrite content URIs to absolute URLs — parse, mutate, re-serialize
      const obj = JSON.parse(jsonStr);
      rewriteUris(obj.root, base);
      res.writeHead(200, CORS);
      res.end(JSON.stringify(obj));
    } else {
      res.writeHead(200, CORS);
      res.end(jsonStr);
    }
  } catch (e) {
    res.writeHead(500, CORS);
    res.end(JSON.stringify({ error: e.message }));
  }
  return true;
}
