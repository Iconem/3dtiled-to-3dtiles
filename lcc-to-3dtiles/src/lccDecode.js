/**
 * lccDecode.js  (lcc-to-3dtiles)
 *
 * Decoders for the XGRIDS LCC (Lixel CyberColor) format. See docs-references/lcc-format.md.
 *
 * Data.bin per-splat = 32 bytes, UNCOMPRESSED (the meta "encoding: COMPRESS" refers to the
 * quantized field encoding, not stream compression — verified: LODSize / PointsCount == 32).
 * Layout (reverse-engineered + validated against the Guan_Temple sample, v3.0):
 *   0–11  position  3× float32 (used directly)
 *   12–14 color RGB 3× uint8  → /255  (display color)
 *   15    opacity   uint8     → /255  (this is the colour's alpha channel)
 *   16–19 rotation  uint32    → 10-10-10-2 "smallest-three" (whitepaper DecodeRotation)
 *   20–25 scale     3× uint16 → lerp(scaleMin[k], scaleMax[k], v/65535)  (LINEAR scene units)
 *   26–31 padding   zeros
 */

export const LCC_STRIDE = 32;

// Whitepaper rotation decode (10-10-10-2 smallest-three).
const QLUT = [3,0,1,2, 0,3,1,2, 0,1,3,2, 0,1,2,3];
const SQRT2 = Math.SQRT2;
const RSQRT2 = Math.SQRT1_2;

/** uint32 → quaternion xyzw (matches the whitepaper DecodeRotation / QLut). */
export function decodeRotation(enc) {
  const px = (enc & 1023) / 1023;
  const py = ((enc >>> 10) & 1023) / 1023;
  const pz = ((enc >>> 20) & 1023) / 1023;
  const pw = ((enc >>> 30) & 3) / 3;
  const idx = Math.round(pw * 3);
  const x = px * SQRT2 - RSQRT2;
  const y = py * SQRT2 - RSQRT2;
  const z = pz * SQRT2 - RSQRT2;
  const w = Math.sqrt(Math.max(0, 1 - (x*x + y*y + z*z)));
  const q = [x, y, z, w];
  // Reinsert the (dropped) largest component into its slot, output xyzw.
  return [q[QLUT[idx*4]], q[QLUT[idx*4+1]], q[QLUT[idx*4+2]], q[QLUT[idx*4+3]]];
}

/**
 * Decode `count` splats from a Data.bin slice into renderer-ready arrays for buildSpzBuffer.
 * @param {Buffer} buf   the whole Data.bin
 * @param {number} byteOffset  start of this run (from Index.bin LODOffset)
 * @param {number} count        splats in this run (LOD PointsCount)
 * @param {number[]} scaleMin   meta attributes.scale.min (3)
 * @param {number[]} scaleMax   meta attributes.scale.max (3)
 *
 * SCALE decode: uint16/65535 interpolated **geometrically** (log-space) between min and max:
 *   scale = min · (max/min)^t   (= exp(lerp(ln min, ln max, t)))
 * Scales span ~5 orders of magnitude (0.0001..8 m), so the quantization is logarithmic — linear
 * lerp gives a 3.3 m median (absurd for a building); geometric gives ~0.026 m (correct).
 * (Newer/compressed v5 LCC vector-quantizes scale into a codebook LUT inside shcoef.bin
 * [`scaleEnc>>14 & 0x1FFFF` → texelFetch], per the LCC-Web-SDK shader; this v3.0 sample's
 * shcoef.bin is pure per-splat SH (64 B/splat, no LUT), so geometric interpolation is used.)
 */
export function decodeSplats(buf, byteOffset, count, scaleMin, scaleMax) {
  const positions = new Float32Array(count * 3);
  const alphas    = new Float32Array(count);
  const rgb       = new Float32Array(count * 3);
  const scales    = new Float32Array(count * 3);
  const rotations = new Float32Array(count * 4);
  // Precompute log endpoints for geometric interpolation (guard non-positive → linear).
  const lg = (mn, mx) => (mn > 0 && mx > 0) ? [Math.log(mn), Math.log(mx) - Math.log(mn), true] : [mn, mx - mn, false];
  const [lx0, lxd, lxg] = lg(scaleMin[0], scaleMax[0]);
  const [ly0, lyd, lyg] = lg(scaleMin[1], scaleMax[1]);
  const [lz0, lzd, lzg] = lg(scaleMin[2], scaleMax[2]);

  for (let i = 0; i < count; i++) {
    const o = byteOffset + i * LCC_STRIDE;
    positions[i*3]   = buf.readFloatLE(o);
    positions[i*3+1] = buf.readFloatLE(o + 4);
    positions[i*3+2] = buf.readFloatLE(o + 8);

    rgb[i*3]   = buf[o + 12] / 255;
    rgb[i*3+1] = buf[o + 13] / 255;
    rgb[i*3+2] = buf[o + 14] / 255;
    alphas[i]  = buf[o + 15] / 255;

    const q = decodeRotation(buf.readUInt32LE(o + 16));
    rotations[i*4]   = q[0]; rotations[i*4+1] = q[1];
    rotations[i*4+2] = q[2]; rotations[i*4+3] = q[3];

    const u0 = buf.readUInt16LE(o + 20) / 65535;
    const u1 = buf.readUInt16LE(o + 22) / 65535;
    const u2 = buf.readUInt16LE(o + 24) / 65535;
    scales[i*3]   = lxg ? Math.exp(lx0 + lxd * u0) : lx0 + lxd * u0;
    scales[i*3+1] = lyg ? Math.exp(ly0 + lyd * u1) : ly0 + lyd * u1;
    scales[i*3+2] = lzg ? Math.exp(lz0 + lzd * u2) : lz0 + lzd * u2;
  }
  return { positions, alphas, rgb, scales, rotations };
}
