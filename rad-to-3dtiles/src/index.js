#!/usr/bin/env node
/**
 * rad-to-3dtiles
 *
 * Converts a SparkJS .RAD Gaussian Splat LoD file to OGC 3D Tiles 1.1
 * using KHR_gaussian_splatting_compression_spz_2 GLB tiles.
 *
 * Usage:
 *   node src/index.js <input.rad> <outDir>
 */

import fs   from 'fs/promises';
import path from 'path';
import { gzipSync } from 'zlib';

import { parseRadHeader, buildNodeTable, parseRadcChunk } from './radHeader.js';
import { buildTileset } from './tilesetBuilder.js';

const argv = process.argv.slice(2);
const radPath = argv.find(a => !a.startsWith('--'));
const outDir  = argv.filter(a => !a.startsWith('--'))[1];
// Optional uniform multiplier applied to every splat scale (σ) before encoding.
// Use to A/B-test splat size, e.g. --scale=0.5 halves the gaussian footprint.
const SCALE_MULT = (() => {
  const f = argv.find(a => a.startsWith('--scale='));
  const v = f ? parseFloat(f.slice('--scale='.length)) : 1;
  return (isFinite(v) && v > 0) ? v : 1;
})();

// Geometric-error global scale (mirrors 3DTiles-Inspector "Geometric Error" slider).
// Default 1 — the raw featureSize-based per-depth error is already the right
// magnitude (coit root ≈ 1.1, matching the 3DGS-PLY-3DTiles-Converter reference's
// ≈ 2.07 for a comparable scene). An earlier default of 16 over-inflated GE so every
// tile's SSE always exceeded the threshold → full-detail-everywhere refinement
// regardless of camera distance (the "high-res tiles not at focus" + spiky artifact).
// That hack was compensating for the (now-fixed) half-opacity lodOpacity bug.
// Override: --ge-scale=N
const GE_SCALE = (() => {
  const f = argv.find(a => a.startsWith('--ge-scale='));
  const v = f ? parseFloat(f.slice('--ge-scale='.length)) : 1;
  return (isFinite(v) && v > 0) ? v : 1;
})();

// Layer multiplier (mirrors 3DTiles-Inspector "Layer Multiplier" slider, and the
// reference converter's `errorTargetLayerMultiplier`). Stretches the per-depth GE
// range: GE(d) = leafGE + (GE(d) − leafGE) × layerMult. Default 1 — matches the
// reference, where sibling levels refine together with naturally-halving error.
// Override: --ge-layer=N
const GE_LAYER = (() => {
  const f = argv.find(a => a.startsWith('--ge-layer='));
  const v = f ? parseFloat(f.slice('--ge-layer='.length)) : 1;
  return (isFinite(v) && v > 0) ? v : 1;
})();

// Opacity filter — OPT-IN, default OFF (0). SparkJS renders the RAD with NO splat
// filtering, so by default we don't either: discarding splats changes the data and
// throws away legitimate content. Enable only if you specifically want to drop faint
// splats, e.g. --opacity-filter=0.05 (matches the reference PLY converter's default).
const OPACITY_MIN = (() => {
  const f = argv.find(a => a.startsWith('--opacity-filter='));
  const v = f ? parseFloat(f.slice('--opacity-filter='.length)) : 0;
  return (isFinite(v) && v >= 0) ? v : 0;
})();

// Scale-outlier filter — OPT-IN, default OFF (0). Drops splats whose max-axis scale
// exceeds per-chunk median(maxScale) × this. Only enable for data with known giant
// "floating noise" splats, e.g. --max-scale-mult=30. Off by default to match SparkJS.
const SCALE_OUTLIER_MULT = (() => {
  const f = argv.find(a => a.startsWith('--max-scale-mult='));
  const v = f ? parseFloat(f.slice('--max-scale-mult='.length)) : 0;
  return (isFinite(v) && v >= 0) ? v : 0;
})();

if (!radPath || !outDir) {
  console.error('Usage: node src/index.js <input.rad> <outDir> [--scale=N] [--ge-scale=N] [--ge-layer=N] [--opacity-filter=N] [--max-scale-mult=N]');
  process.exit(1);
}

const ensureDir = d => fs.mkdir(d, { recursive: true });

// ── Constants (mirrored from @sparkjsdev/spark SpzWriter) ─────────────────────
const SPZ_MAGIC         = 0x5053474E; // "NGSP" stored as little-endian uint32
// SPZ payload version. We emit **v2** — the version the
// KHR_gaussian_splatting_compression_spz_2 extension is locked to, and what
// CesiumJS's bundled Niantic spz decoder expects. v2 stores rotations as 3 bytes
// ("first-three": x,y,z with w≥0 recovered); v3 uses a 4-byte "smallest-three"
// packing. Emitting v3 under the spz_2 extension mis-strided the rotation block in
// the v2 decoder, which is what made converted splats render wrong in CesiumJS.
// SparkJS version-dispatches and reads v2 too, so the 3DTRJS path also works.
const SPZ_VERSION       = 2;
const LN_SCALE_MIN      = -12;
const LN_SCALE_MAX      = 9;
const SH_C0             = 0.28209479177387814; // 1/(2*sqrt(π))
const SPZ_FRAC_BITS     = 12;
const SPZ_FRACTION      = 1 << SPZ_FRAC_BITS;  // 4096

// ── RAD column decoders ───────────────────────────────────────────────────────

/**
 * Decode f32_lebytes: 4-plane byte-transposed float32 (N floats × dims).
 * Plane layout: [byte0 of all x][byte1 of all x]...[byte0 of all y]...
 */
function decodeF32LeBytes(data, dims, count) {
  const stride = count * dims;
  const result = new Float32Array(count * dims);
  const view = new DataView(new ArrayBuffer(4));
  for (let i = 0; i < count; i++) {
    for (let d = 0; d < dims; d++) {
      const idx = count * d + i;
      view.setUint32(0,
        (data[idx] | (data[idx+stride]<<8) | (data[idx+2*stride]<<16) | (data[idx+3*stride]<<24)) >>> 0,
        true);
      result[i*dims+d] = view.getFloat32(0, true);
    }
  }
  return result;
}

/** Convert IEEE 754 half-float bits to float32. */
function halfToFloat(h) {
  const s = (h >> 15) & 1, e = (h >> 10) & 0x1F, m = h & 0x3FF;
  if (e === 0) return (s ? -1 : 1) * m * 5.960464477539063e-8;
  if (e === 31) return m ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * (1 + m / 1024) * Math.pow(2, e - 15);
}

/**
 * Decode f16 column: INTERLEAVED little-endian float16 — splat i's two bytes are
 * consecutive: [lo0,hi0, lo1,hi1, …]. (Verified empirically: reading this planar
 * produced ~2.5% inf/NaN and values up to ±65504; interleaved gives clean [0,1.6].)
 * RAD's "plain" encodings (f16/oct88r8/ln_0r8) are interleaved; only the
 * explicitly-named f32_lebytes is byte-transposed and r8_delta is per-channel planar.
 */
function decodeF16(raw, count) {
  const result = new Float32Array(count);
  for (let i = 0; i < count; i++)
    result[i] = halfToFloat(raw[i*2] | (raw[i*2 + 1] << 8));
  return result;
}

/**
 * Decode r8_delta column: channel-planar uint8 with delta accumulation.
 * [R deltas 0..N-1][G deltas N..2N-1][B deltas 2N..3N-1]
 * First value per channel is absolute; subsequent values are signed deltas.
 * Returns Float32Array rgb interleaved [r0,g0,b0, r1,g1,b1, ...] in [0,1].
 */
function decodeRgbDelta(raw, count) {
  const result = new Float32Array(count * 3);
  for (let c = 0; c < 3; c++) {
    let val = raw[c * count] & 0xFF;
    result[c] = val / 255;
    for (let i = 1; i < count; i++) {
      val = (val + raw[c * count + i]) & 0xFF;
      result[i * 3 + c] = val / 255;
    }
  }
  return result;
}

/**
 * Decode ln_0r8 scales column: channel-PLANAR uint8 log-encoded — [all sx][all sy][all sz].
 * Authoritative per SparkJS `encode_ln_0r8` (rust/spark-lib/src/rad.rs): outer loop over
 * dimension, inner over splats → planar output. (NB: only `f16` and `oct88r8` are
 * interleaved; `ln_0r8`/`r8_delta` are planar, `f32_lebytes` is byte+dim transposed.)
 * 0 → near-zero, 1..255 → exp(lnMin + (v-1)/254 * (lnMax-lnMin))
 * Returns Float32Array scales interleaved [sx0,sy0,sz0, ...].
 */
function decodeScales(raw, count, lnMin, lnMax) {
  const lnRange = (lnMax - lnMin) / 254;
  const result = new Float32Array(count * 3);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < count; i++) {
      const v = raw[c * count + i];
      result[i * 3 + c] = v === 0 ? 1e-10 : Math.exp(lnMin + (v - 1) * lnRange);
    }
  }
  return result;
}

/**
 * Decode oct88r8 orientation column → quaternion xyzw.
 * INTERLEAVED: splat i's three bytes are consecutive [u,v,angle per splat].
 * Authoritative per SparkJS `encode_quat_oct88r8` (rust/spark-lib/src/rad.rs): it loops
 * per-splat pushing 3 bytes each → interleaved. Reading it planar produced garbage
 * rotations (the "spiky" RAD render). Per-splat math matches `decodeQuatOctXy88R8`.
 */
function decodeOrientationToQuat(raw, count) {
  const result = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const quantU = raw[i*3], quantV = raw[i*3 + 1], angleInt = raw[i*3 + 2];
    let fx = (quantU / 255 - 0.5) * 2;
    let fy = (quantV / 255 - 0.5) * 2;
    const fz = 1 - (Math.abs(fx) + Math.abs(fy));
    const t = Math.max(-fz, 0);
    fx += fx >= 0 ? -t : t;
    fy += fy >= 0 ? -t : t;
    const len = Math.sqrt(fx*fx + fy*fy + fz*fz) || 1;
    const theta = (angleInt / 255) * Math.PI;
    const sinH = Math.sin(theta * 0.5);
    result[i*4]   = (fx/len) * sinH;
    result[i*4+1] = (fy/len) * sinH;
    result[i*4+2] = (fz/len) * sinH;
    result[i*4+3] = Math.cos(theta * 0.5);
  }
  return result;
}

// ── SPZ encoder ───────────────────────────────────────────────────────────────

function clamp255(v) { return Math.max(0, Math.min(255, Math.round(v))); }

/** Write a signed int24 value as 3 bytes little-endian. */
function writeInt24LE(buf, offset, v) {
  const u = v & 0xFFFFFF; // two's complement 24-bit
  buf[offset]   = u & 0xFF;
  buf[offset+1] = (u >> 8) & 0xFF;
  buf[offset+2] = (u >> 16) & 0xFF;
}

/**
 * Encode an RGB float [0,1] value using SpzWriter.scaleRgb transform.
 * SPZ stores DC colour in SH basis: v = ((r - 0.5) / (SH_C0/0.15) + 0.5) * 255
 */
function scaleRgb(r) {
  return clamp255(((r - 0.5) / (SH_C0 / 0.15) + 0.5) * 255);
}

/**
 * Encode a linear scale to SPZ uint8 using the standard SPZ formula:
 *   byte = round((ln(s) + 10) * 16)
 * Decoder reads: ln_scale = byte/16 - 10  →  exp(ln_scale)
 * Range: e^(-10)≈4.5e-5 (byte 0) to e^(5.9375)≈379 (byte 255).
 */
function encodeScaleVal(s) {
  if (s <= 0) return 0;
  return clamp255((Math.log(s) + 10.0) * 16.0);
}

/**
 * Encode quaternion xyzw to SPZ **v2** "first-three" format — 3 bytes/splat.
 *
 * This is what the `KHR_gaussian_splatting_compression_spz_2` extension is locked
 * to (SPZ v2), and what CesiumJS's bundled Niantic spz decoder expects. SparkJS
 * version-dispatches and reads it via its 3-byte branch (`byte/127.5 - 1`), so the
 * 3DTRJS 3DGS-plugin path also renders it correctly.
 *
 * Niantic `packQuaternionFirstThree`: normalise, flip so w ≥ 0, store x,y,z as
 *   byte = round(comp · 127.5 + 127.5)   →   decode: comp = byte/127.5 − 1,
 *   w = sqrt(max(0, 1 − x² − y² − z²)).
 *
 * (SPZ v3 instead packs a 4-byte "smallest-three" quaternion for higher accuracy;
 * see git history of this file. We emit v2 to match the extension contract.)
 */
function encodeQuat(buf, offset, qx, qy, qz, qw) {
  const len = Math.sqrt(qx*qx + qy*qy + qz*qz + qw*qw) || 1;
  let x = qx/len, y = qy/len, z = qz/len;
  if (qw < 0) { x = -x; y = -y; z = -z; } // canonicalise so w ≥ 0 (recovered on decode)
  buf[offset]   = clamp255(x * 127.5 + 127.5);
  buf[offset+1] = clamp255(y * 127.5 + 127.5);
  buf[offset+2] = clamp255(z * 127.5 + 127.5);
}

/**
 * Build gzip-compressed SPZ v2 buffer from decoded per-splat arrays.
 * Layout: header(16) + positions(N×9) + alpha(N) + rgb(N×3) + scales(N×3) + rotations(N×3)
 * (19 bytes/splat — v2 stores 3-byte "first-three" rotations, not v3's 4-byte packing.)
 * Scale encoding: byte = round((ln(s) + 10) × 16)  — SPZ standard, range ~e^-10 to e^6
 */
function buildSpzBuffer(positions, alphas, rgb, scales, rotations, count) {
  const raw       = Buffer.alloc(16 + count * 19);

  raw.writeUInt32LE(SPZ_MAGIC,   0);
  raw.writeUInt32LE(SPZ_VERSION, 4);
  raw.writeUInt32LE(count,       8);
  raw.writeUInt8(0,              12); // shDegree = 0
  raw.writeUInt8(SPZ_FRAC_BITS,  13);
  raw.writeUInt8(0,              14); // flagAntiAlias
  raw.writeUInt8(0,              15);

  const posBase   = 16;
  const alphaBase = 16 + count * 9;
  const rgbBase   = 16 + count * 10;
  const scaleBase = 16 + count * 13;
  const rotBase   = 16 + count * 16;

  const MAX_I24 = 8388607;
  const MAX_WORLD = MAX_I24 / SPZ_FRACTION; // ≈ ±2048 units with 12 fractional bits
  let clipped = 0;

  for (let i = 0; i < count; i++) {
    const px = positions[i*3], py = positions[i*3+1], pz = positions[i*3+2];
    if (Math.abs(px) > MAX_WORLD || Math.abs(py) > MAX_WORLD || Math.abs(pz) > MAX_WORLD) clipped++;
    writeInt24LE(raw, posBase + i*9,
      Math.max(-MAX_I24, Math.min(MAX_I24, Math.round(px * SPZ_FRACTION))));
    writeInt24LE(raw, posBase + i*9 + 3,
      Math.max(-MAX_I24, Math.min(MAX_I24, Math.round(py * SPZ_FRACTION))));
    writeInt24LE(raw, posBase + i*9 + 6,
      Math.max(-MAX_I24, Math.min(MAX_I24, Math.round(pz * SPZ_FRACTION))));

    raw[alphaBase + i] = clamp255(alphas[i] * 255);

    raw[rgbBase + i*3]   = scaleRgb(rgb ? rgb[i*3]   : 0.5);
    raw[rgbBase + i*3+1] = scaleRgb(rgb ? rgb[i*3+1] : 0.5);
    raw[rgbBase + i*3+2] = scaleRgb(rgb ? rgb[i*3+2] : 0.5);

    raw[scaleBase + i*3]   = encodeScaleVal(scales ? scales[i*3]   : 0.01);
    raw[scaleBase + i*3+1] = encodeScaleVal(scales ? scales[i*3+1] : 0.01);
    raw[scaleBase + i*3+2] = encodeScaleVal(scales ? scales[i*3+2] : 0.01);

    // Output is 3 bytes/splat (v2); the decoded input quaternion is still xyzw (4-wide).
    encodeQuat(raw, rotBase + i*3,
      rotations ? rotations[i*4]   : 0,
      rotations ? rotations[i*4+1] : 0,
      rotations ? rotations[i*4+2] : 0,
      rotations ? rotations[i*4+3] : 1);
  }

  if (clipped > 0) {
    console.warn(`⚠ ${clipped}/${count} splats exceed the SPZ ±${MAX_WORLD.toFixed(0)}-unit ` +
      `position range and were clamped. A tile spans >${(2*MAX_WORLD).toFixed(0)} units; ` +
      `split into smaller tiles or rescale to avoid collapsed splats.`);
  }

  return gzipSync(raw);
}

/**
 * Build a GLB matching the KHR_gaussian_splatting_compression_spz_2 reference format.
 *
 * CesiumJS requires:
 *  1. Placeholder accessor stubs for POSITION, COLOR_0, KHR_gaussian_splatting:SCALE,
 *     KHR_gaussian_splatting:ROTATION — no bufferView on the accessors; the SPZ
 *     bufferView provides the actual data via the extension.
 *  2. A material with KHR_materials_unlit (otherwise the splat shading doesn't fire).
 *  3. All four attributes listed on the primitive.
 *
 * @param {Buffer} spzBuf  gzip-compressed SPZ payload
 * @param {number} count   splat count (for accessor.count)
 * @param {object} bounds  { minX, minY, minZ, maxX, maxY, maxZ }
 */
function buildSpzGlb(spzBuf, count, bounds) {
  const gltf = {
    asset: { version: '2.0' },
    extensionsUsed:     ['KHR_materials_unlit', 'KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
    extensionsRequired: ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
    buffers:     [{ byteLength: spzBuf.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: spzBuf.byteLength }],
    // Placeholder accessors — no bufferView; actual data comes from the SPZ extension.
    // POSITION min/max are the real tile bounds so CesiumJS can cull correctly.
    accessors: [
      { componentType: 5126, count, type: 'VEC3',
        min: [bounds.minX, bounds.minY, bounds.minZ],
        max: [bounds.maxX, bounds.maxY, bounds.maxZ] }, // 0 POSITION
      { componentType: 5121, normalized: true, count, type: 'VEC4' },  // 1 COLOR_0
      { componentType: 5126, count, type: 'VEC3' },                    // 2 SCALE
      { componentType: 5126, count, type: 'VEC4' },                    // 3 ROTATION
    ],
    materials: [{ extensions: { KHR_materials_unlit: {} } }],
    meshes: [{
      primitives: [{
        attributes: {
          'POSITION':                    0,
          'COLOR_0':                     1,
          'KHR_gaussian_splatting:SCALE':    2,
          'KHR_gaussian_splatting:ROTATION': 3,
        },
        material: 0,
        mode: 0,
        extensions: {
          KHR_gaussian_splatting: {
            extensions: {
              KHR_gaussian_splatting_compression_spz_2: { bufferView: 0 }
            }
          }
        }
      }]
    }],
    nodes:  [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };

  const jsonStr = JSON.stringify(gltf);
  const jsonPad = (4 - (jsonStr.length % 4)) % 4;
  const jBuf    = Buffer.concat([Buffer.from(jsonStr, 'utf8'), Buffer.alloc(jsonPad, 0x20)]);
  const binPad  = (4 - (spzBuf.byteLength % 4)) % 4;
  const bBuf    = Buffer.concat([spzBuf, Buffer.alloc(binPad, 0)]);
  const total   = 12 + 8 + jBuf.byteLength + 8 + bBuf.byteLength;

  const glb = Buffer.alloc(total);
  let off = 0;
  glb.writeUInt32LE(0x46546C67, off); off += 4; // magic "glTF"
  glb.writeUInt32LE(2,          off); off += 4;
  glb.writeUInt32LE(total,      off); off += 4;
  glb.writeUInt32LE(jBuf.byteLength, off); off += 4;
  glb.writeUInt32LE(0x4E4F534A, off); off += 4; // "JSON"
  jBuf.copy(glb, off); off += jBuf.byteLength;
  glb.writeUInt32LE(bBuf.byteLength, off); off += 4;
  glb.writeUInt32LE(0x004E4942, off); off += 4; // "BIN\0"
  bBuf.copy(glb, off);
  return glb;
}

/** Compute AABB from decoded positions. */
function computeBounds(positions, count) {
  let minX=Infinity, minY=Infinity, minZ=Infinity;
  let maxX=-Infinity, maxY=-Infinity, maxZ=-Infinity;
  for (let i = 0; i < count; i++) {
    const x = positions[i*3], y = positions[i*3+1], z = positions[i*3+2];
    if (!isFinite(x)) continue;
    if (x<minX) minX=x; if (x>maxX) maxX=x;
    if (y<minY) minY=y; if (y>maxY) maxY=y;
    if (z<minZ) minZ=z; if (z>maxZ) maxZ=z;
  }
  // Empty tile, or all positions non-finite: min/max never updated, which would
  // yield NaN centre and Infinity accessor min/max → invalid glTF. Return a
  // degenerate-but-finite box at the origin instead.
  if (!isFinite(minX) || !isFinite(maxX)) {
    return {
      minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0,
      cx: 0, cy: 0, cz: 0, hx: 0.001, hy: 0.001, hz: 0.001,
    };
  }
  const cx = (minX+maxX)/2, cy = (minY+maxY)/2, cz = (minZ+maxZ)/2;
  return {
    minX, minY, minZ, maxX, maxY, maxZ,
    cx, cy, cz,
    hx: Math.max((maxX-minX)/2, 0.001),
    hy: Math.max((maxY-minY)/2, 0.001),
    hz: Math.max((maxZ-minZ)/2, 0.001),
  };
}

// ── Per-chunk GLB writer ──────────────────────────────────────────────────────

async function writeChunkGlb(buf, chunk, payloadBase, outputPath) {
  const { meta, count, props } = parseRadcChunk(buf, chunk, payloadBase,
    ['center', 'alpha', 'rgb', 'scales', 'orientation']);

  // RAD stores its quantisation ranges + flags under `splatEncoding` (per-chunk,
  // mirrored from the root header) — NOT `encoding`. Reading `meta.encoding`
  // (which never exists) silently fell back to defaults, which crucially MISSED
  // `lodOpacity: true`. SparkJS's unpackSplat (verified) does
  // `opacity = stored/255; if (lodOpacity) opacity *= 2` — i.e. RAD stores HALF
  // the real opacity in LoD files. Missing the ×2 rendered every splat at half
  // opacity, so the large coarse splats could not blend and the sharp needle
  // splats showed through as spikes (the "thin/spiky" artifact). lnScaleMin/Max
  // happen to match the fallback here, but sourcing them correctly is also robust
  // for RAD files with different ranges.
  const enc    = meta.splatEncoding ?? {};
  const lnMin  = enc.lnScaleMin  ?? LN_SCALE_MIN;
  const lnMax  = enc.lnScaleMax  ?? LN_SCALE_MAX;
  const lodOp  = enc.lodOpacity  ?? false;

  // Raw RAD coordinates — NO global-centroid subtraction. Subtracting a float
  // offset before int24 quantisation buys nothing (RAD scenes already sit near
  // the origin) and would just be an extra lossy step; keeping the native frame
  // also means a real root transform could place the tileset later if needed.
  const positions = decodeF32LeBytes(props.get('center'), 3, count);

  const alphas = new Float32Array(count);
  if (props.has('alpha')) {
    const raw = decodeF16(props.get('alpha'), count);
    for (let i = 0; i < count; i++)
      alphas[i] = Math.max(0, Math.min(1, lodOp ? raw[i] * 2 : raw[i]));
  } else {
    alphas.fill(1);
  }

  let rgb       = props.has('rgb')         ? decodeRgbDelta(props.get('rgb'), count)               : null;
  let scales    = props.has('scales')      ? decodeScales(props.get('scales'), count, lnMin, lnMax) : null;
  let rotations = props.has('orientation') ? decodeOrientationToQuat(props.get('orientation'), count) : null;

  // ── Noise / outlier filtering ──────────────────────────────────────────────
  // SparkJS's native renderer hides faint and giant "floating noise" splats via
  // view-dependent LoD; our baked HLOD renders whatever a tile contains, so they
  // show up as haze (low opacity) and bright spikes (giant anisotropic scale) and
  // inflate the bounding volume. Filter them here, matching the reference converter.
  let posArr = positions, alphaArr = alphas, count2 = count;
  {
    // Per-chunk scale-outlier threshold = median(maxScale) × SCALE_OUTLIER_MULT.
    let scaleCap = Infinity;
    if (scales && SCALE_OUTLIER_MULT > 0 && count > 0) {
      const maxS = new Float64Array(count);
      for (let i = 0; i < count; i++) maxS[i] = Math.max(scales[i*3], scales[i*3+1], scales[i*3+2]);
      const sorted = Float64Array.from(maxS).sort();
      const median = sorted[sorted.length >> 1] || 0;
      if (median > 0) scaleCap = median * SCALE_OUTLIER_MULT;
    }
    const keep = new Uint8Array(count);
    let kept = 0;
    for (let i = 0; i < count; i++) {
      if (OPACITY_MIN > 0 && alphas[i] < OPACITY_MIN) continue;
      if (scales && isFinite(scaleCap)) {
        const ms = Math.max(scales[i*3], scales[i*3+1], scales[i*3+2]);
        if (ms > scaleCap) continue;
      }
      keep[i] = 1; kept++;
    }
    // Only compact if anything was dropped (and never drop a whole tile to empty).
    if (kept < count && kept > 0) {
      const np = new Float32Array(kept*3), na = new Float32Array(kept);
      const nr = rgb ? new Float32Array(kept*3) : null;
      const ns = scales ? new Float32Array(kept*3) : null;
      const nq = rotations ? new Float32Array(kept*4) : null;
      let j = 0;
      for (let i = 0; i < count; i++) {
        if (!keep[i]) continue;
        np[j*3]=positions[i*3]; np[j*3+1]=positions[i*3+1]; np[j*3+2]=positions[i*3+2];
        na[j]=alphas[i];
        if (nr){nr[j*3]=rgb[i*3];nr[j*3+1]=rgb[i*3+1];nr[j*3+2]=rgb[i*3+2];}
        if (ns){ns[j*3]=scales[i*3];ns[j*3+1]=scales[i*3+1];ns[j*3+2]=scales[i*3+2];}
        if (nq){nq[j*4]=rotations[i*4];nq[j*4+1]=rotations[i*4+1];nq[j*4+2]=rotations[i*4+2];nq[j*4+3]=rotations[i*4+3];}
        j++;
      }
      posArr = np; alphaArr = na; rgb = nr; scales = ns; rotations = nq; count2 = kept;
    }
  }

  // Optional uniform splat-size multiplier (CLI --scale). Applied before encoding
  // so both the SPZ scale bytes and the featureSize-based geometricError track it.
  if (scales && SCALE_MULT !== 1) {
    for (let i = 0; i < scales.length; i++) scales[i] *= SCALE_MULT;
  }

  // Rendering-error proxy ≈ SparkJS BhattLod featureSize: the characteristic
  // splat size at this LoD. BhattLod merges splats coarsening upward, so a node's
  // mean splat extent shrinks with depth — a natural, monotonic geometric error
  // that needs no artificial clamp. Use ~3σ (max axis) as the visible feature size.
  let featureSize = 0.1;
  if (scales && count2 > 0) {
    let sum = 0;
    for (let i = 0; i < count2; i++)
      sum += Math.max(scales[i*3], scales[i*3+1], scales[i*3+2]);
    featureSize = (sum / count2) * 3.0;
  }

  // Bounds computed on the FILTERED set — dropping the giant noise splats shrinks
  // the bounding volume to the real geometry (no more inflated 15000m boxes).
  const bounds = computeBounds(posArr, count2);
  const spzBuf = buildSpzBuffer(posArr, alphaArr, rgb, scales, rotations, count2);
  const glb    = buildSpzGlb(spzBuf, count2, bounds);
  await ensureDir(path.dirname(outputPath));
  await fs.writeFile(outputPath, glb);

  return { bounds, featureSize, count, kept: count2 };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function convert() {
  await ensureDir(path.join(outDir, 'tiles'));

  console.log(`Loading .RAD: ${radPath}`);
  const radBuf = await fs.readFile(radPath);
  const { header, payloadBase, isStreaming } = parseRadHeader(radBuf);

  if (isStreaming) {
    console.error(
      `Error: "${radPath}" is a streaming manifest RAD file.\n` +
      `  Chunk data is not embedded — download the full monolithic RAD file.`
    );
    process.exit(1);
  }

  console.log(`  ${header.chunks.length} chunks, ${(header.count/1e6).toFixed(2)}M splats`);
  const comment = JSON.parse(header.comment || '{}');
  console.log(`  BhattLod base: ${JSON.stringify(comment.method ?? 'unknown')}`);

  // Rough time estimate from past runs (~RAD_SEC_PER_M_SPLATS s per 1M splats:
  // dominated by per-chunk decode + SPZ gzip; coit 50M ≈ 4 min). Just a ballpark.
  const t0 = Date.now();
  const RAD_SEC_PER_M_SPLATS = 5;
  const estSec = (header.count / 1e6) * RAD_SEC_PER_M_SPLATS;
  console.log(`  Est. processing time: ~${estSec < 60 ? Math.ceil(estSec)+'s' : Math.ceil(estSec/60)+' min'} (rough, ${RAD_SEC_PER_M_SPLATS}s/M splats)`);

  console.log('Building node topology...');
  const nodes = buildNodeTable(header.chunks, radBuf, payloadBase, header.chunkSize ?? 65536);

  // Write GLBs in the native RAD frame (no centroid subtraction). Each node's
  // own-splat AABB and its featureSize-based geometric error are recorded; the
  // tileset builder nests bounding volumes bottom-up afterwards.
  console.log('Writing GLBs (SPZ-compressed KHR_gaussian_splatting_compression_spz_2)...');
  let done = 0;
  for (const node of nodes) {
    const chunk    = header.chunks[node.chunkIndex];
    const tilePath = path.join(outDir, 'tiles', `node_${node.nodeIndex}.glb`);
    const { bounds, featureSize } = await writeChunkGlb(radBuf, chunk, payloadBase, tilePath);
    node.bounds         = [bounds.cx, bounds.cy, bounds.cz, bounds.hx, bounds.hy, bounds.hz];
    node.geometricError = featureSize;
    done++;
    if (done % 50 === 0 || done === nodes.length)
      process.stdout.write(`\r  ${done}/${nodes.length}`);
  }
  console.log(`\r  ${done}/${nodes.length} tiles`);

  const tileset = buildTileset(nodes, { tileUriTemplate: 'tiles/node_{index}.glb', geScale: GE_SCALE, geLayer: GE_LAYER });
  // Declare GLB extensions so Cesium knows to enable them
  tileset.extensions     = {
    '3DTILES_content_gltf': {
      extensionsUsed:     ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
      extensionsRequired: ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
    }
  };
  tileset.extensionsUsed = ['3DTILES_content_gltf'];

  await fs.writeFile(path.join(outDir, 'tileset.json'), JSON.stringify(tileset, null, 2));

  const treeDepth = nodes.reduce((m, n) => Math.max(m, n.depth ?? 0), 0);
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`\nDone → ${outDir}/tileset.json`);
  console.log(`  REPLACE tileset, ${treeDepth + 1} levels, KHR_gaussian_splatting_compression_spz_2`);
  console.log(`  Actual time: ${elapsed < 60 ? elapsed.toFixed(1)+'s' : (elapsed/60).toFixed(1)+' min'} (${(elapsed/(header.count/1e6)).toFixed(1)}s/M splats)`);

  process.exit(0); // force-exit: gzip/fs may hold async handles open
}

convert().catch(e => { console.error(e); process.exit(1); });
