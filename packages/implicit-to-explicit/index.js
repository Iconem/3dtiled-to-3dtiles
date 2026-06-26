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
 *   buildExplicitFromUrl(tilesetUrl)     remote → returns { tileset, avail, baseUrl }
 */

import fs   from 'fs/promises';
import path from 'path';
import { keyToCoords, coordsToKey, cubeToBox, octreeSubCube, buildExplicitTree } from '3dtiles-convert-core';

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

// ── Binary .subtree parser ─────────────────────────────────────────────────────

// Availability can be a Uint8Array bitstream OR a sentinel {constant:0|1}.
// constant=0 → all bits 0 (nothing available); constant=1 → all bits 1 (all available).
const getBit = (arr, i) => {
  if (arr.constant !== undefined) return arr.constant === 1;
  return ((arr[i >> 3] >> (i & 7)) & 1) === 1;
};

function parseSubtree(buf) {
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x74627573) throw new Error(`bad subtree magic 0x${magic.toString(16)}`);
  const jsonLen   = Number(buf.readBigUInt64LE(8));
  const binaryLen = Number(buf.readBigUInt64LE(16));
  const raw = buf.slice(24, 24 + jsonLen).toString('utf8').replace(/[\x00\x20]+$/, '');
  const json   = JSON.parse(raw);
  const binary = buf.slice(24 + jsonLen, 24 + jsonLen + binaryLen);

  // Resolve an availability reference to either a Uint8Array or {constant:0|1}
  const resolve = (ref) => {
    if (!ref) return { constant: 0 };
    if (ref.constant !== undefined) return { constant: ref.constant };
    const v = json.bufferViews[ref.bitstream];
    if (!v) return { constant: 0 };
    return new Uint8Array(binary.buffer, binary.byteOffset + (v.byteOffset ?? 0), v.byteLength);
  };

  const ca = json.contentAvailability;
  return {
    tileAvail:   resolve(json.tileAvailability),
    contentAvail: resolve(Array.isArray(ca) ? ca[0] : ca),
    childAvail:  resolve(json.childSubtreeAvailability),
  };
}

// ── Availability collector ─────────────────────────────────────────────────────

/**
 * Returns { avail: Set<key>, content: Set<key> }
 *   avail   — tileAvailability: nodes that exist (for hierarchy traversal + bounding volumes)
 *   content — contentAvailability: nodes that have actual tile content files
 * These differ in sparse datasets where interior nodes exist for traversal but have no file.
 */
async function collectAvailability(uriTemplate, scheme, subtreeLevels, availableLevels, readSubtree) {
  const avail   = new Set();
  const content = new Set();

  async function walk(rootLevel, rootX, rootY, rootZ) {
    if (availableLevels !== null && rootLevel >= availableLevels) return;

    const uri = uriTemplate
      .replace('{level}', rootLevel).replace('{x}', rootX)
      .replace('{y}', rootY).replace('{z}', rootZ);

    const buf = await readSubtree(uri);
    if (!buf) return;

    const { tileAvail, contentAvail, childAvail } = parseSubtree(buf);

    let bit = 0;
    for (let d = 0; d < subtreeLevels; d++) {
      const absLevel = rootLevel + d;
      if (availableLevels !== null && absLevel >= availableLevels) break;
      const stride = 2 ** d;
      const n = childCount(scheme, d);
      for (let m = 0; m < n; m++) {
        const { x, y, z } = mortonDecode(scheme, BigInt(m));
        const key = coordsToKey(absLevel, rootX*stride + x, rootY*stride + y, rootZ*stride + z);
        if (getBit(tileAvail,    bit)) avail.add(key);
        if (getBit(contentAvail, bit)) content.add(key);
        bit++;
      }
    }

    const childLevel  = rootLevel + subtreeLevels;
    if (availableLevels !== null && childLevel >= availableLevels) return;
    const childStride = 2 ** subtreeLevels;
    const nc = childCount(scheme, subtreeLevels);
    const tasks = [];
    for (let m = 0; m < nc; m++) {
      if (!getBit(childAvail, m)) continue;
      const { x, y, z } = mortonDecode(scheme, BigInt(m));
      tasks.push(walk(childLevel, rootX*childStride + x, rootY*childStride + y, rootZ*childStride + z));
    }
    await Promise.all(tasks);
  }

  await walk(0, 0, 0, 0);
  return { avail, content };
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
export async function buildExplicitFromUrl(tilesetUrl) {
  const r = await fetch(tilesetUrl);
  if (!r.ok) throw new Error(`fetch ${tilesetUrl} → ${r.status}`);
  const raw = await r.json();
  const baseUrl = tilesetUrl.replace(/\/[^/]+$/, '/');

  const { tileset } = await _buildExplicitTileset(raw, async (uri) => {
    const u = new URL(uri, baseUrl).href;
    try {
      const resp = await fetch(u);
      if (!resp.ok) return null;
      return Buffer.from(await resp.arrayBuffer());
    } catch { return null; }
  });

  return { tileset, baseUrl };
}

// ── Core: build explicit tileset from parsed JSON + readSubtree callback ──────

async function _buildExplicitTileset(raw, readSubtree) {
  const imp = raw.root?.implicitTiling;
  if (!imp) {
    // Already explicit — return as-is
    return { tileset: raw };
  }

  const scheme        = imp.subdivisionScheme || 'OCTREE';
  const subtreeLevels = imp.subtreeLevels;
  const availLevels   = imp.availableLevels ?? null;
  const subtreeUri    = imp.subtrees.uri;
  const contentUri    = raw.root.content?.uri ?? null;

  console.log(`[i→e] ${scheme} subtreeLevels=${subtreeLevels} availableLevels=${availLevels ?? 'walk'} …`);
  const { avail, content } = await collectAvailability(subtreeUri, scheme, subtreeLevels, availLevels, readSubtree);
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
  return { tileset, avail, content };
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
