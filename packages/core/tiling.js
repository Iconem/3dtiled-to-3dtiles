/**
 * 3dtiles-convert-core/tiling — shared OGC 3D Tiles octree tiling helpers, used by both the offline
 * converters and the live tile-server, for IMPLICIT (subtree files) and EXPLICIT (nested tree) output.
 *
 * Node key convention: "level-x-y-z" (dash-separated decimals), the COPC/3D-Tiles octree coordinate.
 */

export function keyToCoords(key) {
  const p = key.split('-').map(Number);
  return { level: p[0], x: p[1], y: p[2], z: p[3] };
}
export const coordsToKey = (level, x, y, z) => `${level}-${x}-${y}-${z}`;

/** The 8 octant child keys of a node (3D Tiles OCTREE: childIndex bit0→x, bit1→y, bit2→z). */
export function octreeChildKeys(key) {
  const { level, x, y, z } = keyToCoords(key);
  const out = [];
  for (let i = 0; i < 8; i++) out.push(coordsToKey(level + 1, 2*x + (i & 1), 2*y + ((i >> 1) & 1), 2*z + ((i >> 2) & 1)));
  return out;
}

/** Axis-aligned sub-cube of `rootCube` ([x0,y0,z0,x1,y1,z1]) at octree cell (level,x,y,z). */
export function octreeSubCube(rootCube, level, x, y, z) {
  const [x0, y0, z0, x1, y1, z1] = rootCube;
  const n = 2 ** level, dx = (x1-x0)/n, dy = (y1-y0)/n, dz = (z1-z0)/n;
  return [x0 + x*dx, y0 + y*dy, z0 + z*dz, x0 + (x+1)*dx, y0 + (y+1)*dy, z0 + (z+1)*dz];
}

/** A sub-cube → 3D Tiles `box` (centre + 3 half-axis vectors), optionally relative to `origin`. */
export function cubeToBox(cube, origin = [0, 0, 0]) {
  const [x0, y0, z0, x1, y1, z1] = cube;
  const cx = (x0+x1)/2 - origin[0], cy = (y0+y1)/2 - origin[1], cz = (z0+z1)/2 - origin[2];
  const hx = Math.max((x1-x0)/2, 1e-9), hy = Math.max((y1-y0)/2, 1e-9), hz = Math.max((z1-z0)/2, 1e-9);
  return [cx, cy, cz, hx, 0, 0, 0, hy, 0, 0, 0, hz];
}

/**
 * Build an EXPLICIT 3D Tiles tile tree by recursing from `rootKey`.
 * @param {string} rootKey
 * @param {object} cb
 *   cb.exists(key)            → bool: is this node present? (root assumed present)
 *   cb.boxOf(key)             → 12-number 3D Tiles box
 *   cb.geometricErrorOf(key)  → number
 *   cb.contentUriOf(key)      → string | null (null = no content for this node)
 *   cb.childKeysOf(key)       → string[]  (default: octreeChildKeys)
 *   cb.refine                 → 'ADD' | 'REPLACE' (default 'ADD')
 * @returns {object} the root tile
 */
export function buildExplicitTree(rootKey, cb) {
  const childKeysOf = cb.childKeysOf || octreeChildKeys;
  const refine = cb.refine || 'ADD';
  const make = (key) => {
    const tile = { boundingVolume: { box: cb.boxOf(key) }, geometricError: cb.geometricErrorOf(key), refine };
    const uri = cb.contentUriOf(key);
    if (uri) tile.content = { uri };
    const kids = [];
    for (const ck of childKeysOf(key)) if (cb.exists(ck)) kids.push(make(ck));
    if (kids.length) tile.children = kids;
    return tile;
  };
  return make(rootKey);
}

// ── IMPLICIT tiling: 3D Tiles 1.1 binary .subtree files ──────────────────────────
// Spec: github.com/CesiumGS/3d-tiles/blob/1.1/specification/ImplicitTiling

function mortonEncode(x, y, z) {       // BigInt (no 32-bit shift overflow), up to level 21
  let r = 0n; const bx = BigInt(x), by = BigInt(y), bz = BigInt(z);
  for (let i = 0; i < 21; i++) { r |= ((bx >> BigInt(i)) & 1n) << BigInt(3*i); r |= ((by >> BigInt(i)) & 1n) << BigInt(3*i+1); r |= ((bz >> BigInt(i)) & 1n) << BigInt(3*i+2); }
  return r;
}
function mortonDecodeBig(m) {          // BigInt decode — correct for any level (no >>32 wrap)
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < 21; i++) { x |= Number((m >> BigInt(3*i)) & 1n) << i; y |= Number((m >> BigInt(3*i+1)) & 1n) << i; z |= Number((m >> BigInt(3*i+2)) & 1n) << i; }
  return { x, y, z };
}
const setBit = (arr, i) => { arr[i >> 3] |= (1 << (i & 7)); };
const pad8 = n => { const r = n % 8; return r === 0 ? n : n + (8 - r); };
function writeUInt64LE(buf, off, v) { buf.writeUInt32LE(v >>> 0, off); buf.writeUInt32LE(Math.floor(v / 0x100000000) >>> 0, off + 4); }

/**
 * Build a 3D Tiles 1.1 binary `.subtree` rooted at `rootKey`.
 * @param {string} rootKey
 * @param {{has:(key:string)=>boolean}} avail  anything with .has(key) over "level-x-y-z" keys
 * @param {number} subtreeLevels
 * @returns {Buffer}
 */
export function buildSubtreeBuffer(rootKey, avail, subtreeLevels) {
  const { level: rootLevel, x: rootX, y: rootY, z: rootZ } = keyToCoords(rootKey);
  const tileCount = (Math.pow(8, subtreeLevels) - 1) / 7;          // levels 0..N-1
  const childSubtreeCount = Math.pow(8, subtreeLevels);            // nodes at depth N
  const tileBits = new Uint8Array(Math.ceil(tileCount / 8));
  const contentBits = new Uint8Array(Math.ceil(tileCount / 8));
  const childBits = new Uint8Array(Math.ceil(childSubtreeCount / 8));

  let bitIndex = 0;
  for (let d = 0; d < subtreeLevels; d++) {
    const absLevel = rootLevel + d, stride = 2 ** d, totalAtLevel = stride*stride*stride;
    for (let m = 0; m < totalAtLevel; m++) {
      const { x: dx, y: dy, z: dz } = mortonDecodeBig(BigInt(m));
      if (avail.has(coordsToKey(absLevel, rootX*stride + dx, rootY*stride + dy, rootZ*stride + dz))) {
        setBit(tileBits, bitIndex); setBit(contentBits, bitIndex);
      }
      bitIndex++;
    }
  }
  const childLevel = rootLevel + subtreeLevels, childStride = 2 ** subtreeLevels;
  for (let m = 0; m < childSubtreeCount; m++) {
    const { x: dx, y: dy, z: dz } = mortonDecodeBig(BigInt(m));
    if (avail.has(coordsToKey(childLevel, rootX*childStride + dx, rootY*childStride + dy, rootZ*childStride + dz))) setBit(childBits, m);
  }

  const tileOffset = 0, contentOffset = pad8(tileBits.byteLength), childOffset = pad8(contentOffset + contentBits.byteLength);
  const binaryLen = pad8(childOffset + childBits.byteLength);
  const binaryBuf = Buffer.alloc(binaryLen, 0);
  Buffer.from(tileBits.buffer).copy(binaryBuf, tileOffset);
  Buffer.from(contentBits.buffer).copy(binaryBuf, contentOffset);
  Buffer.from(childBits.buffer).copy(binaryBuf, childOffset);

  const json = {
    buffers: [{ byteLength: binaryLen }],
    bufferViews: [
      { buffer: 0, byteOffset: tileOffset, byteLength: tileBits.byteLength },
      { buffer: 0, byteOffset: contentOffset, byteLength: contentBits.byteLength },
      { buffer: 0, byteOffset: childOffset, byteLength: childBits.byteLength },
    ],
    tileAvailability: { bitstream: 0 },
    contentAvailability: [{ bitstream: 1 }],
    childSubtreeAvailability: { bitstream: 2 },
  };
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPadded = Buffer.concat([jsonBytes, Buffer.alloc(pad8(jsonBytes.byteLength) - jsonBytes.byteLength, 0x20)]);
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0x74627573, 0); header.writeUInt32LE(1, 4);
  writeUInt64LE(header, 8, jsonPadded.byteLength); writeUInt64LE(header, 16, binaryLen);
  return Buffer.concat([header, jsonPadded, binaryBuf]);
}

/** Subtree root keys for a tree of `maxLevel`: every present node at level % subtreeLevels === 0. */
export function subtreeRootKeys(avail, maxLevel, subtreeLevels) {
  const roots = new Set(['0-0-0-0']);
  for (const key of avail.keys ? avail.keys() : avail) {
    const { level } = keyToCoords(key);
    if (level % subtreeLevels === 0) roots.add(key);
  }
  return roots;
}
