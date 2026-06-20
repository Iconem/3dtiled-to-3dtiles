/**
 * spzGlb.js  (sog-to-3dtiles)
 *
 * SPZ **v2** encoder + KHR_gaussian_splatting_compression_spz_2 GLB writer.
 * Byte-for-byte identical to the proven rad-to-3dtiles encoder (verified against
 * SparkJS SpzWriter and CesiumJS's bundled Niantic decoder). v2 = 3-byte
 * "first-three" rotations, which is what the `_spz_2` extension is locked to.
 *
 * Inputs are renderer-ready linear values:
 *   positions  Float32  xyz interleaved (scene units)
 *   alphas     Float32  opacity [0,1]
 *   rgb        Float32  display rgb [0,1] interleaved (or null → grey)
 *   scales     Float32  LINEAR per-axis sizes interleaved (or null)
 *   rotations  Float32  unit quaternion xyzw interleaved (or null → identity)
 */

import { gzipSync } from 'zlib';

const SPZ_MAGIC     = 0x5053474E; // "NGSP" LE
const SPZ_VERSION   = 2;          // spz_2 extension is locked to SPZ v2 (3-byte rotations)
const SH_C0         = 0.28209479177387814;
const SPZ_FRAC_BITS = 12;
const SPZ_FRACTION  = 1 << SPZ_FRAC_BITS;

function clamp255(v) { return Math.max(0, Math.min(255, Math.round(v))); }

function writeInt24LE(buf, offset, v) {
  const u = v & 0xFFFFFF;
  buf[offset]   = u & 0xFF;
  buf[offset+1] = (u >> 8) & 0xFF;
  buf[offset+2] = (u >> 16) & 0xFF;
}

/** display rgb [0,1] → SPZ DC byte (SparkJS SpzWriter.scaleRgb). */
function scaleRgb(r) { return clamp255(((r - 0.5) / (SH_C0 / 0.15) + 0.5) * 255); }

/** linear scale → SPZ uint8 (standard SPZ: round((ln s + 10) × 16)). */
function encodeScaleVal(s) { return s <= 0 ? 0 : clamp255((Math.log(s) + 10.0) * 16.0); }

/** quaternion xyzw → SPZ v2 first-three (3 bytes; w canonicalised ≥ 0, recovered on decode). */
function encodeQuat(buf, offset, qx, qy, qz, qw) {
  const len = Math.sqrt(qx*qx + qy*qy + qz*qz + qw*qw) || 1;
  let x = qx/len, y = qy/len, z = qz/len;
  if (qw < 0) { x = -x; y = -y; z = -z; }
  buf[offset]   = clamp255(x * 127.5 + 127.5);
  buf[offset+1] = clamp255(y * 127.5 + 127.5);
  buf[offset+2] = clamp255(z * 127.5 + 127.5);
}

/** Build the gzip-compressed SPZ v2 payload (19 bytes/splat). */
export function buildSpzBuffer(positions, alphas, rgb, scales, rotations, count) {
  const raw = Buffer.alloc(16 + count * 19);
  raw.writeUInt32LE(SPZ_MAGIC,   0);
  raw.writeUInt32LE(SPZ_VERSION, 4);
  raw.writeUInt32LE(count,       8);
  raw.writeUInt8(0,              12); // shDegree (DC only)
  raw.writeUInt8(SPZ_FRAC_BITS,  13);
  raw.writeUInt8(0,              14); // flagAntiAlias
  raw.writeUInt8(0,              15);

  const posBase   = 16;
  const alphaBase = 16 + count * 9;
  const rgbBase   = 16 + count * 10;
  const scaleBase = 16 + count * 13;
  const rotBase   = 16 + count * 16;
  const MAX_I24   = 8388607;

  for (let i = 0; i < count; i++) {
    writeInt24LE(raw, posBase + i*9,   Math.max(-MAX_I24, Math.min(MAX_I24, Math.round(positions[i*3]   * SPZ_FRACTION))));
    writeInt24LE(raw, posBase + i*9+3, Math.max(-MAX_I24, Math.min(MAX_I24, Math.round(positions[i*3+1] * SPZ_FRACTION))));
    writeInt24LE(raw, posBase + i*9+6, Math.max(-MAX_I24, Math.min(MAX_I24, Math.round(positions[i*3+2] * SPZ_FRACTION))));

    raw[alphaBase + i] = clamp255((alphas ? alphas[i] : 1) * 255);

    raw[rgbBase + i*3]   = scaleRgb(rgb ? rgb[i*3]   : 0.5);
    raw[rgbBase + i*3+1] = scaleRgb(rgb ? rgb[i*3+1] : 0.5);
    raw[rgbBase + i*3+2] = scaleRgb(rgb ? rgb[i*3+2] : 0.5);

    raw[scaleBase + i*3]   = encodeScaleVal(scales ? scales[i*3]   : 0.01);
    raw[scaleBase + i*3+1] = encodeScaleVal(scales ? scales[i*3+1] : 0.01);
    raw[scaleBase + i*3+2] = encodeScaleVal(scales ? scales[i*3+2] : 0.01);

    encodeQuat(raw, rotBase + i*3,
      rotations ? rotations[i*4]   : 0,
      rotations ? rotations[i*4+1] : 0,
      rotations ? rotations[i*4+2] : 0,
      rotations ? rotations[i*4+3] : 1);
  }
  return gzipSync(raw);
}

/** Compute AABB from interleaved positions → { cx,cy,cz, hx,hy,hz, min/max per axis }. */
export function computeBounds(positions, count) {
  let minX=Infinity,minY=Infinity,minZ=Infinity,maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity;
  for (let i = 0; i < count; i++) {
    const x=positions[i*3], y=positions[i*3+1], z=positions[i*3+2];
    if (!isFinite(x)) continue;
    if (x<minX)minX=x; if (x>maxX)maxX=x;
    if (y<minY)minY=y; if (y>maxY)maxY=y;
    if (z<minZ)minZ=z; if (z>maxZ)maxZ=z;
  }
  if (!isFinite(minX) || !isFinite(maxX))
    return { minX:0,minY:0,minZ:0,maxX:0,maxY:0,maxZ:0, cx:0,cy:0,cz:0, hx:0.001,hy:0.001,hz:0.001 };
  return {
    minX,minY,minZ,maxX,maxY,maxZ,
    cx:(minX+maxX)/2, cy:(minY+maxY)/2, cz:(minZ+maxZ)/2,
    hx:Math.max((maxX-minX)/2,0.001), hy:Math.max((maxY-minY)/2,0.001), hz:Math.max((maxZ-minZ)/2,0.001),
  };
}

/** Build a KHR_gaussian_splatting_compression_spz_2 GLB (placeholder accessors + SPZ bufferView). */
export function buildSpzGlb(spzBuf, count, bounds) {
  const gltf = {
    asset: { version: '2.0' },
    extensionsUsed:     ['KHR_materials_unlit', 'KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
    extensionsRequired: ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
    buffers:     [{ byteLength: spzBuf.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: spzBuf.byteLength }],
    accessors: [
      { componentType: 5126, count, type: 'VEC3',
        min: [bounds.minX, bounds.minY, bounds.minZ], max: [bounds.maxX, bounds.maxY, bounds.maxZ] },
      { componentType: 5121, normalized: true, count, type: 'VEC4' },
      { componentType: 5126, count, type: 'VEC3' },
      { componentType: 5126, count, type: 'VEC4' },
    ],
    materials: [{ extensions: { KHR_materials_unlit: {} } }],
    meshes: [{ primitives: [{
      attributes: { 'POSITION':0, 'COLOR_0':1, 'KHR_gaussian_splatting:SCALE':2, 'KHR_gaussian_splatting:ROTATION':3 },
      material: 0, mode: 0,
      extensions: { KHR_gaussian_splatting: { extensions: { KHR_gaussian_splatting_compression_spz_2: { bufferView: 0 } } } },
    }]}],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  };
  const jsonStr = JSON.stringify(gltf);
  const jBuf = Buffer.concat([Buffer.from(jsonStr,'utf8'), Buffer.alloc((4-(jsonStr.length%4))%4, 0x20)]);
  const bBuf = Buffer.concat([spzBuf, Buffer.alloc((4-(spzBuf.byteLength%4))%4, 0)]);
  const total = 12 + 8 + jBuf.byteLength + 8 + bBuf.byteLength;
  const glb = Buffer.alloc(total);
  let off = 0;
  glb.writeUInt32LE(0x46546C67, off); off+=4;
  glb.writeUInt32LE(2,          off); off+=4;
  glb.writeUInt32LE(total,      off); off+=4;
  glb.writeUInt32LE(jBuf.byteLength, off); off+=4;
  glb.writeUInt32LE(0x4E4F534A, off); off+=4;
  jBuf.copy(glb, off); off += jBuf.byteLength;
  glb.writeUInt32LE(bBuf.byteLength, off); off+=4;
  glb.writeUInt32LE(0x004E4942, off); off+=4;
  bBuf.copy(glb, off);
  return glb;
}
