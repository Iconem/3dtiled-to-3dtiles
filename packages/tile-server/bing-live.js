/**
 * bing-live.js — live **Bing Maps 3D (`tf=3dv4`) → OGC 3D Tiles** streaming middleware.
 *
 * Bing serves a standard implicit-tiling dataset rooted at the `td1` manifest: a root with 4 per-face
 * children (the web-mercator quadrants), each a QUADTREE with templates `mtx{face}-{level}-{x}-{reverseY}`
 * (tile GLBs — standard Draco+KTX2, ECEF baked into the node matrix) and `st{face}-…` (subtree
 * availability — standard `subt` binaries). Two Bing extensions sit on it:
 *   • MICROSOFT_reverse_y_template_uri  — URIs index by reverseY = 2^level − 1 − y
 *   • MICROSOFT_webmercator_subdivision — tiles subdivide a face's region in **Web Mercator** (lat is
 *                                          non-linear), which Cesium can't reproduce for implicit `region`s
 *
 * Cesium implements neither, and the webmercator one is the killer: if we pass Bing's implicit tiling
 * through, Cesium subdivides each face's latitude *linearly*, so deep tiles get wrong regions and are
 * culled (— "zoom to Rome shows nothing"). So we **convert to explicit lazy fragments**: walk Bing's
 * `st` subtree availability ourselves and emit explicit 3D Tiles tiles whose bounding `region` is computed
 * with the correct web-mercator math (lon linear, lat = atan(sinh(mercator-y))). Fragments are lazy —
 * each `/bing/fragment` covers a few levels and external-refs deeper fragments — so the tree builds on
 * demand. Tiles/subtrees are fetched from Bing with y→reverseY; no API key needed.
 *
 *   GET /bing/tileset.json[?g=<genid>]
 *   GET /bing/fragment/<face>-<level>-<x>-<y>.json?g=<genid>
 *   GET /bing/tile/<face>-<level>-<x>-<y>.glb?g=<genid>[&decompress=1]
 *
 * User holds the Bing licensing; this is purely the technical format path.
 */
import { decompressGlb, sendJson, sendGlb, sendErr, CORS } from '../core/index.js';

const BING_HOST = 't.ssl.ak.tiles.virtualearth.net';
const DEFAULT_G = '15530';
const LEVELS_PER_FRAGMENT = 3;              // explicit levels emitted per lazy fragment
const bingApi = (name, g) => `https://${BING_HOST}/tiles/${name}?g=${g}&cmt=cmpr3d&tf=3dv4&n=z&fallback=none`;
const reverseY = (level, y) => (2 ** level) - 1 - y;

// web-mercator <-> latitude (radians)
const merc = (lat) => Math.asinh(Math.tan(lat));
const invMerc = (m) => Math.atan(Math.sinh(m));

async function fetchBing(name, g) {
  const r = await fetch(bingApi(name, g));
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer());
}

// ── td1 manifest (face regions + subtreeLevels), cached per genid ────────────────
const manifestCache = new Map();
async function getManifest(g) {
  if (manifestCache.has(g)) return manifestCache.get(g);
  const buf = await fetchBing('td1', g);
  if (!buf) throw new Error('bing td1 fetch failed');
  const td = JSON.parse(buf.toString('utf8').replace(/^﻿/, ''));
  const faces = [];
  for (const c of td.root.children || []) {
    const f = (c.content?.uri?.match(/mtx(\d+)-/) || [])[1];
    if (f == null) continue;
    const rg = c.boundingVolume.region;                  // [W,S,E,N,minH,maxH] radians
    faces.push({ face: +f, region: rg, subtreeLevels: c.implicitTiling?.subtreeLevels || 7,
                 availableLevels: c.implicitTiling?.availableLevels || 21 });
  }
  const m = { faces, rootGE: td.geometricError || 786432 };
  manifestCache.set(g, m);
  return m;
}

// ── subtree availability (cached) ────────────────────────────────────────────────
const subtreeCache = new Map();
function morton2(x, y) { let m = 0; for (let i = 0; i < 16; i++) m |= ((x >> i) & 1) << (2 * i) | ((y >> i) & 1) << (2 * i + 1); return m; }
async function getSubtree(face, sL, sX, sY, g) {       // sL is a subtree-root level (multiple of subtreeLevels)
  const key = `${g}:${face}-${sL}-${sX}-${sY}`;
  if (subtreeCache.has(key)) return subtreeCache.get(key);
  const buf = await fetchBing(`st${face}-${sL}-${sX}-${reverseY(sL, sY)}`, g);   // y→reverseY
  let parsed = null;
  if (buf && buf.toString('latin1', 0, 4) === 'subt') {
    const jl = Number(buf.readBigUInt64LE(8));
    const json = JSON.parse(buf.toString('utf8', 24, 24 + jl));
    const binOff = 24 + jl + ((8 - (jl % 8)) % 8);
    const bin = buf.subarray(binOff);
    const bv = json.bufferViews || [];
    const view = i => (i == null ? null : bin.subarray(bv[i].byteOffset, bv[i].byteOffset + bv[i].byteLength));
    parsed = {
      tile: { bits: view(json.tileAvailability?.bitstream), const: json.tileAvailability?.constant },
      content: { bits: view(json.contentAvailability?.[0]?.bitstream), const: json.contentAvailability?.[0]?.constant },
      child: { bits: view(json.childSubtreeAvailability?.bitstream), const: json.childSubtreeAvailability?.constant },
    };
  }
  subtreeCache.set(key, parsed);
  return parsed;
}
const getBit = (a, i) => a.bits ? ((a.bits[i >> 3] >> (i & 7)) & 1) : (a.const ? 1 : 0);

// bounding region for a tile at (face, level, x, y) — y is Cesium's bottom-up index.
function tileRegion(faceMeta, level, x, y) {
  const [fW, fS, fE, fN, minH, maxH] = faceMeta.region;
  const n = 2 ** level;
  const lonW = fW + (fE - fW) * (x / n), lonE = fW + (fE - fW) * ((x + 1) / n);
  const mB = merc(fS), mT = merc(fN);                    // face mercator-y span (y is from south)
  const latS = invMerc(mB + (mT - mB) * (y / n)), latN = invMerc(mB + (mT - mB) * ((y + 1) / n));
  return [lonW, latS, lonE, latN, minH ?? -500, maxH ?? 9000];
}
const geAt = (rootGE, level) => rootGE / 2 ** level;

// Build a lazy explicit fragment rooted at (face, L, x, y): emit up to LEVELS_PER_FRAGMENT levels of
// explicit tiles from the subtree availability, external-ref deeper fragments at the cutoff.
async function buildFragment(faceMeta, L, x, y, g, isRoot) {
  const SL = faceMeta.subtreeLevels;
  const cut = L + LEVELS_PER_FRAGMENT;                   // stop emitting explicit tiles at this level
  const tileNode = async (level, tx, ty) => {
    const sroot = Math.floor(level / SL) * SL;
    const st = await getSubtree(faceMeta.face, sroot, Math.floor(tx / 2 ** (level - sroot)), Math.floor(ty / 2 ** (level - sroot)), g);
    if (!st) return null;
    const d = level - sroot, lx = tx - Math.floor(tx / 2 ** d) * 2 ** d, ly = ty - Math.floor(ty / 2 ** d) * 2 ** d;
    const tIdx = (4 ** d - 1) / 3 + morton2(lx, ly);
    if (!getBit(st.tile, tIdx)) return null;             // tile not in tree
    const region = tileRegion(faceMeta, level, tx, ty);
    const tile = { boundingVolume: { region }, geometricError: geAt(rootGEof(faceMeta), level), refine: 'REPLACE' };
    if (getBit(st.content, tIdx)) tile.content = { uri: `/bing/tile/${faceMeta.face}-${level}-${tx}-${ty}.glb?g=${g}` };
    if (level >= cut) {                                  // hand off to a deeper lazy fragment
      tile.children = [{ boundingVolume: { region }, geometricError: geAt(rootGEof(faceMeta), level) * 0.5, refine: 'REPLACE',
                         content: { uri: `/bing/fragment/${faceMeta.face}-${level}-${tx}-${ty}.json?g=${g}` } }];
      return tile;
    }
    const kids = [];
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const c = await tileNode(level + 1, tx * 2 + dx, ty * 2 + dy);
      if (c) kids.push(c);
    }
    if (kids.length) tile.children = kids;
    return tile;
  };
  const root = await tileNode(L, x, y);
  if (!root) return null;
  if (isRoot) root.geometricError = rootGEof(faceMeta);
  return { asset: { version: '1.1', gltfUpAxis: 'Z' }, geometricError: root.geometricError, root, extensionsUsed: ['3DTILES_content_gltf'] };
}
const rootGEof = (faceMeta) => faceMeta._rootGE;

/** Root tileset: 4 faces, each an external-ref to its root fragment (lazy). */
export async function bingTileset(g = DEFAULT_G) {
  const m = await getManifest(g);
  const children = m.faces.map(f => {
    f._rootGE = m.rootGE / 2;                            // face GE (half the world root)
    return { boundingVolume: { region: f.region }, geometricError: f._rootGE, refine: 'REPLACE',
             content: { uri: `/bing/fragment/${f.face}-0-0-0.json?g=${g}` } };
  });
  const region = [-Math.PI, -invMerc(Math.PI), Math.PI, invMerc(Math.PI), -500, 9000];   // whole web-mercator world
  // gltfUpAxis:'Z' — Bing GLBs bake absolute ECEF (Z-up) in the node matrix; without this Cesium applies
  // its default glTF Y-up→Z-up rotation to that ECEF transform → content lands ~Earth-radius off + rotated.
  return { asset: { version: '1.1', gltfUpAxis: 'Z' }, geometricError: m.rootGE,
           root: { boundingVolume: { region }, geometricError: m.rootGE, refine: 'REPLACE', children },
           extensionsUsed: ['3DTILES_content_gltf'] };
}

/** Try to handle a /bing/* request. Returns true iff it owned the response. */
export async function handleBing(req, res, u) {
  if (!u.pathname.startsWith('/bing/')) return false;
  const g = u.searchParams.get('g') || DEFAULT_G;
  const decompress = u.searchParams.get('decompress') === '1' || u.searchParams.get('decompress') === 'true';
  try {
    if (u.pathname === '/bing/tileset.json') { sendJson(res, await bingTileset(g)); return true; }

    const frag = u.pathname.match(/^\/bing\/fragment\/(\d+)-(\d+)-(\d+)-(\d+)\.json$/);
    if (frag) {
      const [, face, L, x, y] = frag.map(Number);
      const m = await getManifest(g);
      const fm = m.faces.find(f => f.face === face);
      if (!fm) { sendErr(res, 404, 'no such face'); return true; }
      fm._rootGE = m.rootGE / 2;
      const ts = await buildFragment(fm, L, x, y, g, L === 0);
      if (!ts) { sendErr(res, 404, 'empty fragment'); return true; }
      sendJson(res, ts); return true;
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
