/**
 * lepccDecode.js — pure-JS port of Esri LEPCC's XYZ position decoder (github.com/Esri/lepcc,
 * Apache-2.0). Scope: DECODE ONLY, and only the `bt_XYZ` blob type (LEPCC.cpp's `LEPCC::Decode`),
 * since I3S PointCloud layers with `defaultGeometrySchema.encoding: "lepcc-xyz"` only need this path
 * — RGB/Intensity/FlagBytes (ClusterRGB.cpp/Intensity.cpp/FlagBytes.cpp) are separate LEPCC blob
 * types this repo's point-cloud datasets don't use (verified: Moro_Bay_LiDAR and USGSNYC_2014_LiDAR
 * both declare only a `position` vertexAttribute).
 *
 * Ported from (line-for-line correspondence kept close on purpose, for auditability):
 *   LEPCC.cpp        LEPCC::Decode / Decode_CutInSegments      → decodeLepccXyz / decodeCutInSegments
 *   BitStuffer2.cpp  BitStuffer2::Decode / BitUnStuff           → bitStufferDecode / bitUnStuff
 *   Common.cpp       Common::ComputeChecksumFletcher32          → fletcher32
 *
 * File layout (all little-endian, verified against real ArcGIS-hosted node geometries — see
 * decodeLepccXyz's header comment for the byte offsets):
 *   TopHeader (16B): char fileKey[10]="LEPCC     ", uint16 version, uint32 checkSum
 *   Header1   (88B): int64 blobSize, Extent3D{lower,upper}(6×f64), Point3D maxError(3×f64),
 *                    uint32 numPoints, uint32 reserved
 *   then 4 "cut in segments" bit-stuffed uint32 arrays, in order: yDelta, numPointsPerRow, xDelta, z.
 *
 * BitStuffer2's packing treats the byte stream as consecutive little-endian uint32 words and packs
 * each value LSB-first at the current bit cursor (low bits of the value into the low bits of the
 * cursor position within the word, carrying into the next word when a value straddles a word
 * boundary) — i.e. NOT a byte-at-a-time bit reader. This only matches LEPCC's own "unstuff", not a
 * generic MSB-first bitstream, so it's transcribed faithfully below rather than written as a
 * from-scratch bit reader.
 */

function fletcher32(buf, start, end) {
  let sum1 = 0xffff, sum2 = 0xffff;
  let i = start;
  let words = (end - start) >> 1;
  while (words) {
    let tlen = words >= 359 ? 359 : words;
    words -= tlen;
    do {
      sum1 = (sum1 + (buf[i++] << 8)) >>> 0;
      sum1 = (sum1 + buf[i++]) >>> 0;
      sum2 = (sum2 + sum1) >>> 0;
    } while (--tlen);
    sum1 = (sum1 & 0xffff) + (sum1 >>> 16);
    sum2 = (sum2 & 0xffff) + (sum2 >>> 16);
  }
  if ((end - start) & 1) {
    sum1 = (sum1 + (buf[i] << 8)) >>> 0;
    sum2 = (sum2 + sum1) >>> 0;
  }
  sum1 = (sum1 & 0xffff) + (sum1 >>> 16);
  sum2 = (sum2 & 0xffff) + (sum2 >>> 16);
  return ((sum2 << 16) | sum1) >>> 0;
}

function decodeUInt(buf, o, numBytes) {
  if (numBytes === 1) return [buf.readUInt8(o), o + 1];
  if (numBytes === 2) return [buf.readUInt16LE(o), o + 2];
  return [buf.readUInt32LE(o), o + 4];
}

// BitStuffer2::BitUnStuff (the lerc2Version>=3 path — the only one LEPCC's Decode_CutInSegments uses).
// Unpacks `numElements` values of `numBits` bits each from consecutive little-endian uint32 words.
function bitUnStuff(buf, o, numElements, numBits) {
  const numUInts = (numElements * numBits + 31) >>> 5;
  const numBytesTotal = numUInts * 4;
  const numBitsTail = (numElements * numBits) & 31;
  const numBytesTail = numBitsTail > 0 ? (numBitsTail + 7) >> 3 : 0;
  const numBytesUsed = numBytesTotal - (numBytesTail > 0 ? 4 - numBytesTail : 0);

  // last word must be zero-padded before unstuffing (mirrors `m_tmpBitStuffVec[numUInts-1] = 0`)
  const words = new Uint32Array(numUInts);
  for (let i = 0, p = o; i < numUInts; i++, p += 4) {
    const remaining = numBytesUsed - i * 4;
    if (remaining >= 4) words[i] = buf.readUInt32LE(p);
    else if (remaining > 0) {
      let v = 0;
      for (let b = 0; b < remaining; b++) v |= buf.readUInt8(p + b) << (8 * b);
      words[i] = v >>> 0;
    }
  }

  const out = new Uint32Array(numElements);
  const nb = 32 - numBits;
  let wi = 0, bitPos = 0;
  for (let i = 0; i < numElements; i++) {
    if (nb - bitPos >= 0) {
      out[i] = (words[wi] << (nb - bitPos)) >>> nb;
      bitPos += numBits;
      if (bitPos === 32) { wi++; bitPos = 0; }
    } else {
      const lo = words[wi++] >>> bitPos;
      const hiShift = 64 - numBits - bitPos; // always in [1,31] here: bitPos>0 and numBits<=32 in this branch
      const hi = (words[wi] << hiShift) >>> nb;
      out[i] = (lo | hi) >>> 0;
      bitPos -= nb;
    }
  }
  return [out, numBytesUsed];
}

// BitStuffer2::Decode — header byte (numBits + type-of-numElements + lut flag) then the payload.
function bitStufferDecode(buf, o) {
  const numBitsByte = buf.readUInt8(o); o += 1;
  const bits67 = numBitsByte >> 6;
  const nb = bits67 === 0 ? 4 : 3 - bits67;
  const doLut = (numBitsByte & (1 << 5)) !== 0;
  const numBits = numBitsByte & 31;

  let numElements;
  [numElements, o] = decodeUInt(buf, o, nb);

  if (doLut)
    // Not observed in any real I3S lepcc-xyz blob (Moro_Bay_LiDAR, USGSNYC_2014_LiDAR both decode
    // fully via the simple path) — LUT mode is an encoder-side size optimization; out of scope until
    // a real dataset needs it, so fail loudly rather than silently mis-decode.
    throw new Error('lepccDecode: BitStuffer2 LUT mode not implemented (no known I3S dataset needs it)');

  let dataVec;
  if (numBits > 0) {
    let bytesUsed;
    [dataVec, bytesUsed] = bitUnStuff(buf, o, numElements, numBits);
    o += bytesUsed;
  } else {
    dataVec = new Uint32Array(numElements); // all zero
  }
  return [dataVec, o];
}

// LEPCC::Decode_CutInSegments — a bit-stuffed array of per-section minimums, followed by each
// section's zero-based residuals; recombined into the flat delta array.
function decodeCutInSegments(buf, o) {
  let sectionMinVec;
  [sectionMinVec, o] = bitStufferDecode(buf, o);
  const numSections = sectionMinVec.length;
  const out = [];
  for (let i = 0; i < numSections; i++) {
    let zeroBased;
    [zeroBased, o] = bitStufferDecode(buf, o);
    const minElem = sectionMinVec[i];
    for (let j = 0; j < zeroBased.length; j++) out.push(zeroBased[j] + minElem);
  }
  return [out, o];
}

/**
 * Decode a LEPCC XYZ blob (I3S `nodes/<n>/geometries/<i>.bin` when
 * `defaultGeometrySchema.encoding` is `lepcc-xyz`) into flat `[x,y,z, x,y,z, ...]` doubles.
 *
 * Verified against real ArcGIS-hosted nodes (both Moro_Bay_LiDAR and USGSNYC_2014_LiDAR
 * SceneServers): decoded byte count lands exactly on the header's `blobSize`, the Fletcher-32
 * checksum matches, and decoded coordinates fall inside the blob's own extent header (and the
 * layer's `store.extent`).
 *
 * @param {Buffer} buf - one node's raw geometry blob (already gunzipped if applicable)
 * @returns {{ position: Float64Array, vertexCount: number }}
 */
export function decodeLepccXyz(buf) {
  if (buf.length < 10 || buf.toString('ascii', 0, 10) !== 'LEPCC     ')
    throw new Error('lepccDecode: missing LEPCC file key');

  const version = buf.readUInt16LE(10);
  const checkSum = buf.readUInt32LE(12);
  if (version > 1) throw new Error(`lepccDecode: unsupported LEPCC version ${version}`);

  let o = 16;
  const blobSize = Number(buf.readBigInt64LE(o)); o += 8;
  const lx = buf.readDoubleLE(o); o += 8;
  const ly = buf.readDoubleLE(o); o += 8;
  const lz = buf.readDoubleLE(o); o += 8;
  const ux = buf.readDoubleLE(o); o += 8;
  const uy = buf.readDoubleLE(o); o += 8;
  const uz = buf.readDoubleLE(o); o += 8;
  const ex = buf.readDoubleLE(o); o += 8;
  const ey = buf.readDoubleLE(o); o += 8;
  const ez = buf.readDoubleLE(o); o += 8;
  const numPoints = buf.readUInt32LE(o); o += 4;
  o += 4; // reserved

  if (blobSize > buf.length)
    throw new Error(`lepccDecode: blobSize ${blobSize} exceeds buffer length ${buf.length}`);

  const computedChecksum = fletcher32(buf, 16, blobSize);
  if (computedChecksum !== checkSum)
    throw new Error(`lepccDecode: checksum mismatch (expected ${checkSum}, computed ${computedChecksum})`);

  let yDeltaVec, numPointsPerRowVec, xDeltaVec, zVec;
  [yDeltaVec, o] = decodeCutInSegments(buf, o);
  [numPointsPerRowVec, o] = decodeCutInSegments(buf, o);
  [xDeltaVec, o] = decodeCutInSegments(buf, o);
  [zVec, o] = decodeCutInSegments(buf, o);

  if (o !== blobSize)
    throw new Error(`lepccDecode: decoded ${o} bytes, expected blobSize ${blobSize}`);

  const cwx = 2 * ex, cwy = 2 * ey, cwz = 2 * ez;
  const position = new Float64Array(numPoints * 3);
  let iy = 0, cnt = 0;
  const nRows = yDeltaVec.length;
  for (let i = 0; i < nRows; i++) {
    iy += yDeltaVec[i];
    let ix = 0;
    const nPts = numPointsPerRowVec[i];
    for (let j = 0; j < nPts; j++) {
      ix += xDeltaVec[cnt];
      const iz = zVec[cnt];
      const x = Math.min(lx + ix * cwx, ux);
      const y = Math.min(ly + iy * cwy, uy);
      const z = Math.min(lz + iz * cwz, uz);
      position[cnt * 3] = x; position[cnt * 3 + 1] = y; position[cnt * 3 + 2] = z;
      cnt++;
    }
  }

  if (cnt !== numPoints)
    throw new Error(`lepccDecode: reconstructed ${cnt} points, header says ${numPoints}`);

  return { position, vertexCount: numPoints };
}
