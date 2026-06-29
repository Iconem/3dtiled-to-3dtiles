/**
 * bing-live.js — live **Bing Maps 3D (`tf=3dv4`) → OGC 3D Tiles** streaming middleware.
 *
 * Bing's `tf=3dv4` endpoint returns a **standard GLB** (Draco geometry + KTX2 textures) with the **ECEF
 * placement baked into the glTF node matrix** — so it drops into a 3D Tiles scene with NO extra
 * transform. There is no Bing manifest, so we synthesize the tree ourselves: a **quadtree of quadkeys**
 * emitted as lazy explicit fragments (like the RAD/I3S adapters), with **availability discovered by
 * HTTP-probing** each quadkey. Bounding volumes are geographic `region`s derived from the quadkey.
 *
 *   GET /bing/tileset.json?root=<quadkey>&g=<genid>&maxLevel=<L>[&decompress=1]
 *   GET /bing/node/<quadkey>.json?...          (lazy fragment — external-tileset boundary)
 *   GET /bing/tile/<quadkey>.glb?g=<genid>[&decompress=1]
 *
 * Tiles are served as-is by default (Cesium handles Draco+KTX2); `decompress=1` routes them through the
 * glTF-Transform decompressor (Draco/meshopt/KTX2→PNG) for renderers without those transcoders.
 * (User holds the Bing licensing; this is purely the technical format path.)
 */
import { decompressGlb, sendJson, sendGlb, sendErr, CORS } from '../core/index.js';

const BING_HOST = 't.ssl.ak.tiles.virtualearth.net';
const DEFAULT_G = '15530';            // working generation id (drifts; override with &g=). Any root quadkey
                                      // works (full-world coverage) — pass &root=<quadkey>. (Bing's newer
                                      // `td1`/`st1-{lod}-{x}-{y}` manifest addressing is a future upgrade.)
const BING_SUB_DEPTH = 3;             // quadtree levels per lazy fragment
const D2R = Math.PI / 180;
const bingUrl = (qk, g) => `https://${BING_HOST}/tiles/mtx${qk}?g=${g}&tf=3dv4&n=z&form=web3d`;

// ── Bing quadkey ↔ tile math (Bing Maps Tile System) ───────────────────────────
function quadkeyToTileXY(qk) {
  let x = 0, y = 0; const lod = qk.length;
  for (let i = lod; i > 0; i--) { const mask = 1 << (i - 1); const c = qk[lod - i];
    if (c === '1') x |= mask; else if (c === '2') y |= mask; else if (c === '3') { x |= mask; y |= mask; } }
  return { tileX: x, tileY: y, lod };
}
const clip = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
function pixelToLatLon(px, py, lod) {
  const mapSize = 256 * 2 ** lod;
  const x = clip(px, 0, mapSize - 1) / mapSize - 0.5;
  const y = 0.5 - clip(py, 0, mapSize - 1) / mapSize;
  const lat = 90 - 360 * Math.atan(Math.exp(-y * 2 * Math.PI)) / Math.PI;
  const lon = 360 * x;
  return { lat, lon };
}
// quadkey → 3D Tiles geographic `region` [W,S,E,N (rad), minH, maxH (m)].
function quadkeyRegion(qk) {
  const { tileX, tileY, lod } = quadkeyToTileXY(qk);
  const a = pixelToLatLon(tileX * 256, tileY * 256, lod);
  const b = pixelToLatLon((tileX + 1) * 256, (tileY + 1) * 256, lod);
  return [Math.min(a.lon, b.lon) * D2R, Math.min(a.lat, b.lat) * D2R,
          Math.max(a.lon, b.lon) * D2R, Math.max(a.lat, b.lat) * D2R, -500, 9000];
}
const geAt = (lod) => 1e7 / 2 ** lod;          // monotonic-decreasing geometric error (tunable)
const childQuadkeys = (qk) => ['0', '1', '2', '3'].map(d => qk + d);

// ── availability probe (cached) ────────────────────────────────────────────────
const probeCache = new Map();   // `${g}:${qk}` → bool
async function probe(qk, g) {
  const key = `${g}:${qk}`;
  if (probeCache.has(key)) return probeCache.get(key);
  let ok = false;
  try {
    const r = await fetch(bingUrl(qk, g));
    if (r.ok) { const buf = Buffer.from(await r.arrayBuffer()); ok = buf.length > 8 && buf.toString('latin1', 0, 4) === 'glTF'; }
  } catch { /* network → treat as absent */ }
  probeCache.set(key, ok);
  return ok;
}

// ── lazy fragment: BING_SUB_DEPTH quadtree levels rooted at `rootQk`, external refs at the boundary ──
async function buildBingFragment(rootQk, g, maxLevel, isRoot, decompress) {
  const dq = decompress ? '&decompress=1' : '';
  const build = async (qk, d) => {
    const tile = { boundingVolume: { region: quadkeyRegion(qk) }, geometricError: geAt(qk.length), refine: 'REPLACE' };
    if (await probe(qk, g)) tile.content = { uri: `/bing/tile/${qk}.glb?g=${g}${dq}` };
    if (qk.length < maxLevel) {
      const kids = [];
      const avail = await Promise.all(childQuadkeys(qk).map(async c => (await probe(c, g)) ? c : null));
      for (const c of avail) {
        if (!c) continue;
        if (d + 1 >= BING_SUB_DEPTH) kids.push({ boundingVolume: { region: quadkeyRegion(c) }, geometricError: geAt(c.length), refine: 'REPLACE', content: { uri: `/bing/node/${c}.json?g=${g}&maxLevel=${maxLevel}${dq}` } });
        else { const t = await build(c, d + 1); if (t) kids.push(t); }
      }
      if (kids.length) tile.children = kids;
    }
    return tile;
  };
  const root = await build(rootQk, 0);
  // Content GLBs carry their own ECEF node matrix → identity tileset transform (no root transform).
  return { asset: { version: '1.1' }, geometricError: isRoot ? geAt(rootQk.length) * 2 : root.geometricError, root,
           extensionsUsed: ['3DTILES_content_gltf'] };
}

// Pure builders for the /stream-style dispatcher.
export const bingTileRe = /^[0-3]+$/;
export async function bingTileset(url, opts = {}) {
  const root = opts.root || '0';            // quadkey AOI root (default: hemisphere quadrant '0')
  const g = opts.g || DEFAULT_G;
  const maxLevel = opts.maxLevel || (root.length + 6);
  return buildBingFragment(root, g, maxLevel, true, opts.decompress);
}
export async function bingNode(qk, opts = {}) {
  return buildBingFragment(qk, opts.g || DEFAULT_G, opts.maxLevel || (qk.length + 6), false, opts.decompress);
}
export async function bingTile(qk, opts = {}) {
  const r = await fetch(bingUrl(qk, opts.g || DEFAULT_G));
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'glTF') return null;   // 0-byte = no coverage
  if (!opts.decompress) return buf;
  const { glb } = await decompressGlb(buf, { draco: true, meshopt: true, ktx: true });
  return glb;
}

/** Try to handle a /bing/* request. Returns true iff it owned the response. */
export async function handleBing(req, res, u) {
  if (!u.pathname.startsWith('/bing/')) return false;
  const g = u.searchParams.get('g') || DEFAULT_G;
  const maxLevel = u.searchParams.has('maxLevel') ? Number(u.searchParams.get('maxLevel')) : undefined;
  const decompress = u.searchParams.get('decompress') === '1' || u.searchParams.get('decompress') === 'true';
  try {
    if (u.pathname === '/bing/tileset.json') {
      sendJson(res, await bingTileset(null, { root: u.searchParams.get('root') || '0', g, maxLevel, decompress }));
      return true;
    }
    const n = u.pathname.match(/^\/bing\/node\/([0-3]+)\.json$/);
    if (n) { sendJson(res, await bingNode(n[1], { g, maxLevel, decompress })); return true; }
    const m = u.pathname.match(/^\/bing\/tile\/([0-3]+)\.glb$/);
    if (m) {
      const glb = await bingTile(m[1], { g, decompress });
      if (!glb) { sendErr(res, 404, 'no Bing coverage at this quadkey'); return true; }
      sendGlb(res, glb);
      return true;
    }
    sendErr(res, 404, 'not found');
  } catch (e) {
    console.error('[bing-live]', e.message);
    if (!res.headersSent) sendErr(res, 500, e.message); else res.end();
  }
  return true;
}
