#!/usr/bin/env node
/**
 * implicit-to-explicit — Convert a 3D Tiles 1.1 IMPLICIT octree/quadtree tileset to EXPLICIT.
 *
 * Supports both OCTREE and QUADTREE subdivision schemes, local dirs and remote https:// URLs.
 *
 * CLI:  node index.js <tilesetDir|tilesetUrl>  [outFile]
 *   Local dir: reads subtrees from disk, writes tileset-explicit.json
 *   Remote URL: reads subtrees via fetch, prints explicit JSON to stdout
 *
 * JS API:
 *   transcodeToExplicit(dir, outFile?)   local
 *   buildExplicitFromUrl(tilesetUrl, { maxLevels }?)   remote → returns { tileset, avail, baseUrl }
 *     maxLevels caps the expansion (levels 0 … maxLevels-1): a depth-limited export must not read
 *     every subtree of a deep octree first.
 */

import fs   from 'fs/promises';
import path from 'path';
import { keyToCoords, coordsToKey, cubeToBox, octreeSubCube, buildExplicitTree, loadSubtree, subtreeBufferUri, fetchSource, fetchSourceJson } from '3dtiles-convert-core';

// ── Morton decode (BigInt, safe for any level) ─────────────────────────────────

function mortonDecode3D(m) {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < 21; i++) {
    x |= Number((m >> BigInt(3*i))   & 1n) << i;
    y |= Number((m >> BigInt(3*i+1)) & 1n) << i;
    z |= Number((m >> BigInt(3*i+2)) & 1n) << i;
  }
  return { x, y, z };
}

function mortonDecode2D(m) {           // QUADTREE: interleave x (even bits) and y (odd bits)
  let x = 0, y = 0;
  for (let i = 0; i < 31; i++) {
    x |= Number((m >> BigInt(2*i))   & 1n) << i;
    y |= Number((m >> BigInt(2*i+1)) & 1n) << i;
  }
  return { x, y, z: 0 };
}

const mortonDecode = (scheme, m) => scheme === 'QUADTREE' ? mortonDecode2D(m) : mortonDecode3D(m);
const childCount   = (scheme, d) => scheme === 'QUADTREE' ? 4 ** d : 8 ** d;

// ── Availability collector ─────────────────────────────────────────────────────

/**
 * Returns { avail: Set<key>, content: Set<key> }
 *   avail   — tileAvailability: nodes that exist (for hierarchy traversal + bounding volumes)
 *   content — contentAvailability: nodes that have actual tile content files
 * These differ in sparse datasets where interior nodes exist for traversal but have no file.
 */
/**
 * Walks every subtree, at most `concurrency` reads at a time: a tree of 25 levels has tens of thousands of them, and
 * firing them all at once buried the server that generates them (a Potree source's subtrees come from its .hrc chunks)
 * under a queue nothing else could get through. `onSubtree(key, { content, buffers })` hears each subtree as soon as it
 * is read, with the content keys it declares, so a caller can start on them before the walk ends; `onProgress(read)`
 * counts the subtrees read so far.
 */
async function collectAvailability(uriTemplate, scheme, subtreeLevels, availableLevels, readSubtree, { onSubtree = null, onProgress = null, concurrency = 8, signal = null } = {}) {
  const avail   = new Set();
  const content = new Set();
  const subtrees = new Set();                  // keys of the subtree files actually read
  const buffers = new Map();                   // subtree key → the external buffers it names (uris as written)
  let active = 0, read = 0;
  const waiters = [];
  const acquire = async () => { while (active >= concurrency) await new Promise((r) => waiters.push(r)); active++; };
  const release = () => { active--; waiters.shift()?.(); };

  async function walk(rootLevel, rootX, rootY, rootZ) {
    if (availableLevels !== null && rootLevel >= availableLevels) return;
    signal?.throwIfAborted();

    const uri = uriTemplate
      .replace('{level}', rootLevel).replace('{x}', rootX)
      .replace('{y}', rootY).replace('{z}', rootZ);

    const rootKey = coordsToKey(rootLevel, rootX, rootY, rootZ);
    await acquire();
    let sub;
    try {
      const buf = await readSubtree(uri);
      if (!buf) return;
      sub = await loadSubtree(buf, async (bufferUri) => {
        const bytes = await readSubtree(subtreeBufferUri(uri, bufferUri));
        if (!bytes) throw new Error(`subtree ${uri}: buffer ${bufferUri} not found`);
        return bytes;
      });
    } finally { release(); }
    subtrees.add(rootKey);
    if (sub.bufferUris.length) buffers.set(rootKey, sub.bufferUris);
    const localContent = [];

    let bit = 0;
    for (let d = 0; d < subtreeLevels; d++) {
      const absLevel = rootLevel + d;
      if (availableLevels !== null && absLevel >= availableLevels) break;
      const stride = 2 ** d;
      const n = childCount(scheme, d);
      for (let m = 0; m < n; m++) {
        const { x, y, z } = mortonDecode(scheme, BigInt(m));
        const key = coordsToKey(absLevel, rootX*stride + x, rootY*stride + y, rootZ*stride + z);
        if (sub.tileBit(bit)) avail.add(key);
        if (sub.contentBit(bit)) { content.add(key); localContent.push(key); }
        bit++;
      }
    }
    onProgress?.(++read);
    onSubtree?.(rootKey, { content: localContent, buffers: sub.bufferUris });

    const childLevel  = rootLevel + subtreeLevels;
    if (availableLevels !== null && childLevel >= availableLevels) return;
    const childStride = 2 ** subtreeLevels;
    const nc = childCount(scheme, subtreeLevels);
    const tasks = [];
    for (let m = 0; m < nc; m++) {
      if (!sub.childBit(m)) continue;
      const { x, y, z } = mortonDecode(scheme, BigInt(m));
      tasks.push(walk(childLevel, rootX*childStride + x, rootY*childStride + y, rootZ*childStride + z));
    }
    // Every branch settles before the first failure is reported: a branch still running when its sibling failed
    // would otherwise reject with nobody listening.
    const failed = (await Promise.allSettled(tasks)).find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
  }

  await walk(0, 0, 0, 0);
  return { avail, content, subtrees, buffers };
}

// ── Bounding volume helpers ────────────────────────────────────────────────────

function regionSubRect(rootRegion, level, x, y) {
  const [west, south, east, north, minH, maxH] = rootRegion;
  const dLon = (east  - west)  / (2 ** level);
  const dLat = (north - south) / (2 ** level);
  return [west + x*dLon, south + y*dLat, west + (x+1)*dLon, south + (y+1)*dLat, minH, maxH];
}

// ── Explicit tree builder ──────────────────────────────────────────────────────

function quadtreeChildKeys(key) {
  const { level, x, y } = keyToCoords(key);
  return [
    coordsToKey(level+1, 2*x,   2*y,   0),
    coordsToKey(level+1, 2*x+1, 2*y,   0),
    coordsToKey(level+1, 2*x,   2*y+1, 0),
    coordsToKey(level+1, 2*x+1, 2*y+1, 0),
  ];
}

/**
 * Build an explicit tile tree from an implicit tileset object + availability set.
 *
 * @param {object} imp   the root.implicitTiling block
 * @param {object} bv    root.boundingVolume  ({ box: [...] } or { region: [...] })
 * @param {object} root  the root tile object (for refine, geometricError)
 * @param {Set<string>} avail
 * @param {(key:string)=>string|null} contentUriOf  null = no content
 * @returns {object} explicit root tile
 */
function buildExplicit(imp, bv, root, avail, contentUriOf) {
  const scheme = imp.subdivisionScheme;
  const isQuad = scheme === 'QUADTREE';
  const childKeysOf = isQuad ? quadtreeChildKeys : undefined; // undefined → octreeChildKeys default

  const callbacks = {
    refine: root.refine || 'ADD',
    exists: (key) => avail.has(key),
    contentUriOf,
    childKeysOf,
    geometricErrorOf: (key) => {
      const { level } = keyToCoords(key);
      return (root.geometricError || 0) / (2 ** level);
    },
  };

  if (bv.region) {
    const rootRegion = bv.region;
    callbacks.boxOf = (key) => {
      const { level, x, y } = keyToCoords(key);
      const [w, s, e, n, minH, maxH] = regionSubRect(rootRegion, level, x, y);
      return { region: [w, s, e, n, minH, maxH] };
    };
    // buildExplicitTree uses box, but we need region — do it manually
    return buildExplicitTreeRegion('0-0-0-0', callbacks);
  } else {
    // box bounding volume (OCTREE local-frame datasets)
    const box = bv.box;
    const cx = box[0], cy = box[1], cz = box[2];
    const hx = box[3], hy = box[7], hz = box[11];
    const rootCube = [cx-hx, cy-hy, cz-hz, cx+hx, cy+hy, cz+hz];
    callbacks.boxOf = (key) => {
      const { level, x, y, z } = keyToCoords(key);
      return cubeToBox(octreeSubCube(rootCube, level, x, y, z), [cx, cy, cz]);
    };
    return buildExplicitTree('0-0-0-0', callbacks);
  }
}

/** Like buildExplicitTree but supports region bounding volumes. */
function buildExplicitTreeRegion(rootKey, cb) {
  const childKeysOf = cb.childKeysOf || octreeChildKeysDefault;
  const refine = cb.refine || 'ADD';
  const make = (key) => {
    const bvRaw = cb.boxOf(key); // may be {region:[...]} or {box:[...]}
    const bv = bvRaw.region ? { region: bvRaw.region } : { box: bvRaw };
    const tile = { boundingVolume: bv, geometricError: cb.geometricErrorOf(key), refine };
    const uri = cb.contentUriOf(key);
    if (uri) tile.content = { uri };
    const kids = [];
    for (const ck of childKeysOf(key)) if (cb.exists(ck)) kids.push(make(ck));
    if (kids.length) tile.children = kids;
    return tile;
  };
  return make(rootKey);
}
function octreeChildKeysDefault(key) {
  const { level, x, y, z } = keyToCoords(key);
  const out = [];
  for (let i = 0; i < 8; i++) out.push(coordsToKey(level+1, 2*x+(i&1), 2*y+((i>>1)&1), 2*z+((i>>2)&1)));
  return out;
}

// ── Content URI template expansion ────────────────────────────────────────────

function expandContentUri(template, level, x, y, z) {
  return template
    .replace('{level}', level).replace('{x}', x)
    .replace('{y}', y).replace('{z}', z);
}

// ── Local tileset transcoder ──────────────────────────────────────────────────

export async function transcodeToExplicit(tilesetDir, outFile) {
  const raw = JSON.parse(await fs.readFile(path.join(tilesetDir, 'tileset.json'), 'utf8'));
  const { tileset } = await _buildExplicitTileset(raw, async (uri) => {
    try { return await fs.readFile(path.join(tilesetDir, uri)); }
    catch { return null; }
  });
  const dest = outFile ?? path.join(tilesetDir, 'tileset-explicit.json');
  await fs.writeFile(dest, JSON.stringify(tileset, null, 2), 'utf8');
  console.log(`Written → ${dest}`);
  return dest;
}

// ── Remote tileset builder ─────────────────────────────────────────────────────

/**
 * Build an explicit tileset JSON from a remote implicit tileset URL.
 * Returns { tileset (the explicit JSON object), baseUrl, contentUriTemplate }.
 */
export async function buildExplicitFromUrl(tilesetUrl, { maxLevels = null, onSubtreeFailure = null, onSubtree = null, onProgress = null, signal = null } = {}) {
  const raw = await fetchSourceJson(tilesetUrl, { signal });
  const baseUrl = tilesetUrl.replace(/\/[^/]+$/, '/');

  const { tileset, avail, content, subtrees, buffers, availLevels } = await _buildExplicitTileset(raw, async (uri) => {
    // A subtree still unread after retries prunes its whole branch, so the caller hears about it:
    // `onSubtreeFailure({ uri, status, error })` may throw to stop.
    const u = new URL(uri, baseUrl).href;
    try { return await fetchSource(u, { signal }); }
    catch (e) {
      if (signal?.aborted) throw e;
      onSubtreeFailure?.({ uri: u, status: e.status, error: String(e.message || e) });
      return null;
    }
  }, maxLevels, { onSubtree, onProgress, signal });

  // avail/content/subtrees: coordinate keys ("level-x-y-z") — what a copy that STAYS implicit needs
  return { tileset, baseUrl, raw, avail, content, subtrees, buffers, availLevels };
}

// ── Core: build explicit tileset from parsed JSON + readSubtree callback ──────

async function _buildExplicitTileset(raw, readSubtree, maxLevels = null, walkOpts = {}) {
  const imp = raw.root?.implicitTiling;
  if (!imp) {
    // Already explicit — return as-is
    return { tileset: raw };
  }

  const scheme        = imp.subdivisionScheme || 'OCTREE';
  const subtreeLevels = imp.subtreeLevels;
  const declared      = imp.availableLevels ?? null;
  const availLevels   = maxLevels == null ? declared : Math.min(declared ?? Infinity, maxLevels);
  const subtreeUri    = imp.subtrees.uri;
  const contentUri    = raw.root.content?.uri ?? null;

  console.log(`[i→e] ${scheme} subtreeLevels=${subtreeLevels} availableLevels=${availLevels ?? 'walk'} …`);
  const { avail, content, subtrees, buffers } = await collectAvailability(subtreeUri, scheme, subtreeLevels, availLevels, readSubtree, walkOpts);
  console.log(`[i→e] ${avail.size} tile nodes, ${content.size} with content`);

  // content Set drives actual URI assignment; avail Set drives hierarchy existence
  const contentUriOf = contentUri
    ? (key) => {
        if (!content.has(key)) return null;
        const {level,x,y,z} = keyToCoords(key);
        return expandContentUri(contentUri, level, x, y, z);
      }
    : () => null;

  const explicitRoot = buildExplicit(imp, raw.root.boundingVolume, raw.root, avail, contentUriOf);
  if (raw.root.transform) explicitRoot.transform = raw.root.transform;

  const tileset = {
    asset: raw.asset,
    geometricError: raw.geometricError ?? raw.root.geometricError,
    root: explicitRoot,
  };
  return { tileset, avail, content, subtrees, buffers, availLevels };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const isCli = process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).pathname;

if (isCli) {
  const [,, src, outFile] = process.argv;
  if (!src) { console.error('Usage: implicit-to-explicit <tilesetDir|tilesetUrl> [outFile]'); process.exit(1); }
  const run = src.startsWith('http')
    ? buildExplicitFromUrl(src).then(({tileset}) => console.log(JSON.stringify(tileset, null, 2)))
    : transcodeToExplicit(path.resolve(src), outFile ? path.resolve(outFile) : undefined);
  run.catch(e => { console.error(e.message); process.exit(1); });
}
