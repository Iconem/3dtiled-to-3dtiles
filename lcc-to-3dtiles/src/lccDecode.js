/**
 * lccDecode.js  (lcc-to-3dtiles)
 *
 * Decoders for the XGRIDS LCC (Lixel CyberColor) format. See docs-references/lcc-format.md.
 *
 * Data.bin per-splat = 32 bytes (two RGBA32UI texels in the SDK's `splatData`), UNCOMPRESSED.
 * Layout is AUTHORITATIVE — extracted from the official xgrids/LCC-Web-SDK v0.6.1 vertex shader
 * (`sdk/lcc-web-sdk.js`, the non-`LCC_COMPRESSED` `decodeCov(uint r,g,b)` + main unpack):
 *
 *   pixel0 (bytes 0–15):  position = uintBitsToFloat(pixel0.xyz);  color = pixel0.w
 *     0–11  position  3× float32                       (used directly)
 *     12    R  · 13 G · 14 B · 15 A(opacity)  uint8/255 (decodeColor: (color>>0,8,16,24)&255)
 *   pixel1 (bytes 16–31): decodeCov(pixel1.r=u32@16, pixel1.g=u32@20, pixel1.b=u32@24)
 *     scale = mix(scaleMin, scaleMax, value·(1/65535))  — value = uvec3(r, r>>16, g)&0xFFFF, so:
 *     16–17 scale.x  uint16   ┐
 *     18–19 scale.y  uint16   ├ LINEAR interpolation (GLSL `mix`), NOT geometric/log
 *     20–21 scale.z  uint16   ┘
 *     rotateEnc = ((b&0xFFFF)<<16) | ((g>>16)&0xFFFF)  ==  uint32 LE @ byte 22:
 *     22–25 rotation uint32   → 10-10-10-2 "smallest-three" (calculateCov / QUAT_TAB)
 *     26–27 semantic id (decodeSemantic: (b>>16)&0xFFFF);  28–31 padding
 *
 * NOTE: an earlier reverse-engineered guess (rotation@16, scale@20–25 geometric) was WRONG on
 * both offset and interpolation — it put scale where the rotation is. The SDK shader above is
 * the ground truth: scale@16–21 LINEAR, rotation@22–25.
 */

export const LCC_STRIDE = 32;

// Whitepaper rotation decode (10-10-10-2 smallest-three).
const QLUT = [3,0,1,2, 0,3,1,2, 0,1,3,2, 0,1,2,3];
const SQRT2 = Math.SQRT2;
const RSQRT2 = Math.SQRT1_2;

/** uint32 → quaternion xyzw (matches the SDK calculateCov / QUAT_TAB decode). */
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
 * @param {number[]} scaleMin   meta attributes.scale.min (3)  → compressedScaleMin uniform
 * @param {number[]} scaleMax   meta attributes.scale.max (3)  → compressedScaleMax uniform
 *
 * SCALE decode: uint16 (at bytes 16/18/20) LINEARLY interpolated between min and max, exactly as
 * the SDK shader does: `scale = mix(compressedScaleMin, compressedScaleMax, value/65535)`. The
 * result is the linear per-axis std-dev in scene units (what buildSpzBuffer expects; it applies
 * ln itself). Validated on Guan_Temple: p50 ≈ 3 cm for a 325 m-diagonal temple. (The COMPRESSED
 * variant — meta `encoding: COMPRESS` with a populated shcoef.bin scale LUT — instead does
 * `scaleK=(scaleEnc>>14)&0x1FFFF` → texelFetch(lutScaleTexture); not used by these v3.0 samples,
 * whose shcoef.bin is pure per-splat SH.)
 */
export function decodeSplats(buf, byteOffset, count, scaleMin, scaleMax) {
  const positions = new Float32Array(count * 3);
  const alphas    = new Float32Array(count);
  const rgb       = new Float32Array(count * 3);
  const scales    = new Float32Array(count * 3);
  const rotations = new Float32Array(count * 4);
  const dx = scaleMax[0] - scaleMin[0], dy = scaleMax[1] - scaleMin[1], dz = scaleMax[2] - scaleMin[2];

  for (let i = 0; i < count; i++) {
    const o = byteOffset + i * LCC_STRIDE;
    positions[i*3]   = buf.readFloatLE(o);
    positions[i*3+1] = buf.readFloatLE(o + 4);
    positions[i*3+2] = buf.readFloatLE(o + 8);

    rgb[i*3]   = buf[o + 12] / 255;
    rgb[i*3+1] = buf[o + 13] / 255;
    rgb[i*3+2] = buf[o + 14] / 255;
    alphas[i]  = buf[o + 15] / 255;

    // scale = mix(min, max, u/65535) — bytes 16/18/20, LINEAR (SDK decodeCov).
    scales[i*3]   = scaleMin[0] + dx * (buf.readUInt16LE(o + 16) / 65535);
    scales[i*3+1] = scaleMin[1] + dy * (buf.readUInt16LE(o + 18) / 65535);
    scales[i*3+2] = scaleMin[2] + dz * (buf.readUInt16LE(o + 20) / 65535);

    // rotation = uint32 LE @ byte 22  (== SDK's ((b&0xFFFF)<<16)|((g>>16)&0xFFFF)).
    const q = decodeRotation(buf.readUInt32LE(o + 22));
    rotations[i*4]   = q[0]; rotations[i*4+1] = q[1];
    rotations[i*4+2] = q[2]; rotations[i*4+3] = q[3];
  }
  return { positions, alphas, rgb, scales, rotations };
}
