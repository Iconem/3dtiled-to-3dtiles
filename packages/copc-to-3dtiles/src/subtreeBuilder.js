/**
 * subtreeBuilder.js
 *
 * Builds 3D Tiles 1.1 binary subtree files (.subtree) per the spec:
 * https://github.com/CesiumGS/3d-tiles/blob/1.1/specification/ImplicitTiling/README.adoc
 *
 * Binary layout (24-byte header, little-endian):
 *   [0–3]   magic            UINT32  = 0x74627573 ("subt" LE)
 *   [4–7]   version          UINT32  = 1
 *   [8–15]  jsonByteLength   UINT64
 *   [16–23] binaryByteLength UINT64
 *   [24..]  JSON (padded to 8-byte boundary with 0x20 spaces)
 *   [..]    binary buffer (padded to 8-byte boundary with 0x00)
 *
 * The JSON references buffer views by index. Buffer 0 has no `uri`
 * — it refers to the binary chunk embedded in this same file.
 *
 * Availability bitstreams:
 *   - tileAvailability: one bit per node in BFS-Morton order, levels 0..subtreeLevels-1
 *     total bits = (8^subtreeLevels - 1) / 7
 *   - contentAvailability: same shape as tileAvailability
 *   - childSubtreeAvailability: one bit per node at depth subtreeLevels
 *     total bits = 8^subtreeLevels
 *
 * Within each level, tiles are ordered by Morton (Z-order) index, not BFS sibling order.
 */

export function keyToCoords(key) {
  const parts = key.split('-').map(Number);
  return { level: parts[0], x: parts[1], y: parts[2], z: parts[3] };
}

/**
 * Encode (x, y, z) to Morton index by interleaving bits.
 * Each coordinate contributes up to 21 bits (enough for level 21).
 */
function mortonEncode(x, y, z) {
  let result = 0n;
  const bx = BigInt(x), by = BigInt(y), bz = BigInt(z);
  for (let i = 0; i < 21; i++) {
    result |= ((bx >> BigInt(i)) & 1n) << BigInt(3 * i);
    result |= ((by >> BigInt(i)) & 1n) << BigInt(3 * i + 1);
    result |= ((bz >> BigInt(i)) & 1n) << BigInt(3 * i + 2);
  }
  return Number(result);
}

function setBit(arr, i) {
  arr[i >> 3] |= (1 << (i & 7));
}

function pad8(n) {
  const r = n % 8;
  return r === 0 ? n : n + (8 - r);
}

/**
 * Build a .subtree binary buffer for a subtree rooted at `rootKey`.
 *
 * @param {string}            rootKey       e.g. "0-0-0-0"
 * @param {Map<string,object>} nodeMap       full COPC node map
 * @param {number}            subtreeLevels number of levels per subtree
 * @returns {Buffer}
 */
export function buildSubtreeBuffer(rootKey, nodeMap, subtreeLevels) {
  const { level: rootLevel, x: rootX, y: rootY, z: rootZ } = keyToCoords(rootKey);

  // tileAvailability + contentAvailability: (8^N - 1)/7 bits
  const tileCount = (Math.pow(8, subtreeLevels) - 1) / 7;
  // childSubtreeAvailability: 8^N bits (nodes one level below the subtree)
  const childSubtreeCount = Math.pow(8, subtreeLevels);

  const tileBits        = new Uint8Array(Math.ceil(tileCount / 8));
  const contentBits     = new Uint8Array(Math.ceil(tileCount / 8));
  const childBits       = new Uint8Array(Math.ceil(childSubtreeCount / 8));

  // Walk all levels of the subtree, in Morton order per level
  let bitIndex = 0; // running index into tileAvailability / contentAvailability
  for (let d = 0; d < subtreeLevels; d++) {
    const absLevel = rootLevel + d;
    const stride   = Math.pow(2, d); // cells per axis at this depth within subtree
    const totalAtLevel = stride * stride * stride; // = 8^d

    for (let m = 0; m < totalAtLevel; m++) {
      // Decode Morton index m into (dx, dy, dz) relative to subtree root at this depth
      const { x: dx, y: dy, z: dz } = mortonDecode(m);
      const ax = rootX * stride + dx;
      const ay = rootY * stride + dy;
      const az = rootZ * stride + dz;
      const key = `${absLevel}-${ax}-${ay}-${az}`;

      if (nodeMap.has(key)) {
        setBit(tileBits,    bitIndex);
        setBit(contentBits, bitIndex); // every COPC node has a .glb
      }
      bitIndex++;
    }
  }

  // childSubtreeAvailability: nodes at depth rootLevel + subtreeLevels
  const childLevel  = rootLevel + subtreeLevels;
  const childStride = Math.pow(2, subtreeLevels);
  for (let m = 0; m < childSubtreeCount; m++) {
    const { x: dx, y: dy, z: dz } = mortonDecode(m);
    const ax = rootX * childStride + dx;
    const ay = rootY * childStride + dy;
    const az = rootZ * childStride + dz;
    const key = `${childLevel}-${ax}-${ay}-${az}`;
    if (nodeMap.has(key)) setBit(childBits, m);
  }

  // Pack binary: three bufferViews, all in one buffer (no uri = internal binary chunk)
  const tileOffset    = 0;
  const contentOffset = pad8(tileBits.byteLength);
  const childOffset   = pad8(contentOffset + contentBits.byteLength);
  const binaryLen     = pad8(childOffset + childBits.byteLength);

  const binaryBuf = Buffer.alloc(binaryLen, 0);
  Buffer.from(tileBits.buffer).copy(binaryBuf,    tileOffset);
  Buffer.from(contentBits.buffer).copy(binaryBuf, contentOffset);
  Buffer.from(childBits.buffer).copy(binaryBuf,   childOffset);

  // JSON
  const json = {
    buffers: [{ byteLength: binaryLen }],         // buffer 0 = internal binary chunk (no uri)
    bufferViews: [
      { buffer: 0, byteOffset: tileOffset,    byteLength: tileBits.byteLength    },  // bv 0
      { buffer: 0, byteOffset: contentOffset, byteLength: contentBits.byteLength }, // bv 1
      { buffer: 0, byteOffset: childOffset,   byteLength: childBits.byteLength   }  // bv 2
    ],
    tileAvailability:         { bitstream: 0 },  // bv index
    contentAvailability:      [{ bitstream: 1 }], // array, bv index
    childSubtreeAvailability: { bitstream: 2 }   // bv index
  };

  const jsonBytes  = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPadLen = pad8(jsonBytes.byteLength) - jsonBytes.byteLength;
  const jsonPadded = Buffer.concat([jsonBytes, Buffer.alloc(jsonPadLen, 0x20)]); // pad with spaces
  const jsonLen    = jsonPadded.byteLength;

  // 24-byte header: magic(uint32) + version(uint32) + jsonByteLength(uint64) + binaryByteLength(uint64)
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0x74627573, 0); // magic "subt"
  header.writeUInt32LE(1, 4);          // version
  writeUInt64LE(header,  8, jsonLen);
  writeUInt64LE(header, 16, binaryLen);

  return Buffer.concat([header, jsonPadded, binaryBuf]);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Decode Morton index m into { x, y, z } by extracting interleaved bits.
 */
function mortonDecode(m) {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < 10; i++) {   // ← 10 is enough (2^10 per axis = level 10 max)
    // The loop runs 21 iterations. For i >= 11, the shift m >> (3*i) has 3*i >= 33 — but JavaScript's >> operator only uses the low 5 bits of the shift amount (it's a 32-bit op), so >> 33 silently becomes >> 1, >> 34 becomes >> 2, etc. This scrambles the decoded coordinates, producing nonsense keys like 1-1-0-1024 that are never found in nodeMap, so those bits never get set in the availability bitstream. The subtree ends up saying only 0-0-0-0 and 1-0-0-0 exist, so Cesium stops traversing after the first two nodes.
    // 10 iterations handles nodes up to x/y/z = 1023 per axis (level 10), which covers any real COPC dataset. After this fix you need to regenerate the subtrees — the GLBs themselves are fine.
    // Note the mortonEncode function uses BigInt so it doesn't have this problem; only mortonDecode is affected.

    x |= ((m >> (3 * i))     & 1) << i;
    y |= ((m >> (3 * i + 1)) & 1) << i;
    z |= ((m >> (3 * i + 2)) & 1) << i;
  }
  return { x, y, z };
}

function writeUInt64LE(buf, offset, value) {
  const lo = value >>> 0;
  const hi = Math.floor(value / 0x100000000) >>> 0;
  buf.writeUInt32LE(lo, offset);
  buf.writeUInt32LE(hi, offset + 4);
}
