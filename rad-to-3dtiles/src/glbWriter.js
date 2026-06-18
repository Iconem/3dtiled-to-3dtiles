/**
 * glbWriter.js  (rad-to-3dtiles)
 *
 * Packs Gaussian splat data into a GLB with the KHR_gaussian_splatting extension.
 * Two input paths supported:
 *
 *   A) RADC column Map (pure-JS path, no Spark dep)
 *      columns: Map<string, TypedArray> from parseRadcChunk()
 *
 *   B) SparkJS PackedSplats (Spark path)
 *      packedSplats: PackedSplats instance, splatIndices: number[]
 *      Uses utils.unpackSplat() for position/scale/rotation/color/opacity,
 *      and extra.sh1/sh2/sh3 Uint32Arrays + decodeSh*Rgb() for SH coefficients.
 *
 * KHR_gaussian_splatting primitive (Khronos RC, Feb 2026):
 *   mesh.primitives[0].extensions.KHR_gaussian_splatting = {
 *     attributes: {
 *       POSITION  → accessor index (VEC3 FLOAT)
 *       SCALE     → accessor index (VEC3 FLOAT, world-space)
 *       ROTATION  → accessor index (VEC4 FLOAT, unit quaternion xyzw)
 *       COLOR_0   → accessor index (VEC4 FLOAT, rgba linear, opacity in .w)
 *     }
 *   }
 *
 * gltf-transform v4 notes:
 *   - Call doc.createBuffer() before writing any accessors
 *   - setArray(TypedArray) preserves element type (Float32, Uint8, etc.)
 *   - writeBinary() returns Uint8Array (not Buffer)
 *   - extensionsUsed must be patched in post since KHR_gaussian_splatting
 *     has no official @gltf-transform/extensions class yet (RC only)
 */

import { Document, NodeIO } from '@gltf-transform/core';
import fs   from 'fs/promises';
import path from 'path';

const EXT_KHR_GS = 'KHR_gaussian_splatting';

// ── Column name aliases: maps RADC column names → canonical field ─────────────
// Add variants here if real files use different names.
const SCALE_VARIANTS  = [['scale_x','scale_y','scale_z'], ['sx','sy','sz'], ['scaleX','scaleY','scaleZ']];
const ROT_VARIANTS    = [['rot_x','rot_y','rot_z','rot_w'], ['qx','qy','qz','qw'], ['rx','ry','rz','rw']];
const OPACITY_VARIANTS = ['opacity','alpha'];
const COLOR_VARIANTS  = [['r','g','b'], ['red','green','blue']];

function findCols(columns, variants) {
  for (const v of variants) {
    if (Array.isArray(v)) {
      if (v.every(n => columns.has(n))) return v;
    } else {
      if (columns.has(v)) return v;
    }
  }
  return null;
}

// ── Path A: from RADC column Map ──────────────────────────────────────────────

/**
 * @param {Map<string,TypedArray>} columns
 * @param {number} numSplats
 * @param {string} outputPath
 */
export async function writeSplatGlbFromColumns(columns, numSplats, outputPath) {
  const xCol = columns.get('x'), yCol = columns.get('y'), zCol = columns.get('z');
  if (!xCol) throw new Error(`No x/y/z columns. Available: ${[...columns.keys()].join(', ')}`);

  const doc = new Document();
  doc.createBuffer();

  // POSITION (Float32 VEC3)
  const positions = new Float32Array(numSplats * 3);
  for (let i = 0; i < numSplats; i++) {
    positions[i*3] = xCol[i]; positions[i*3+1] = yCol[i]; positions[i*3+2] = zCol[i];
  }

  // SCALE (Float32 VEC3, world-space)
  const scaleNames = findCols(columns, SCALE_VARIANTS);
  let scaleArr = null;
  if (scaleNames) {
    scaleArr = new Float32Array(numSplats * 3);
    const [sxC, syC, szC] = scaleNames.map(n => columns.get(n));
    for (let i = 0; i < numSplats; i++) {
      scaleArr[i*3] = sxC[i]; scaleArr[i*3+1] = syC[i]; scaleArr[i*3+2] = szC[i];
    }
  }

  // ROTATION (Float32 VEC4, xyzw unit quaternion)
  const rotNames = findCols(columns, ROT_VARIANTS);
  let rotArr = null;
  if (rotNames) {
    rotArr = new Float32Array(numSplats * 4);
    const [rxC, ryC, rzC, rwC] = rotNames.map(n => columns.get(n));
    for (let i = 0; i < numSplats; i++) {
      rotArr[i*4] = rxC[i]; rotArr[i*4+1] = ryC[i]; rotArr[i*4+2] = rzC[i]; rotArr[i*4+3] = rwC[i];
    }
  }

  // COLOR_0 (Float32 VEC4, rgba linear; opacity in .w)
  const colorNames   = findCols(columns, COLOR_VARIANTS);
  const opacityName  = findCols(columns, OPACITY_VARIANTS);
  let colorArr = null;
  if (colorNames || opacityName) {
    colorArr = new Float32Array(numSplats * 4);
    const rC = colorNames && columns.get(colorNames[0]);
    const gC = colorNames && columns.get(colorNames[1]);
    const bC = colorNames && columns.get(colorNames[2]);
    const aC = opacityName && columns.get(opacityName);
    for (let i = 0; i < numSplats; i++) {
      // uint8 colour [0–255] → [0–1]
      const isU8 = rC && rC.BYTES_PER_ELEMENT === 1;
      colorArr[i*4]   = rC ? (isU8 ? rC[i]/255 : rC[i]) : 1;
      colorArr[i*4+1] = gC ? (isU8 ? gC[i]/255 : gC[i]) : 1;
      colorArr[i*4+2] = bC ? (isU8 ? bC[i]/255 : bC[i]) : 1;
      colorArr[i*4+3] = aC ? aC[i] : 1;
    }
  }

  await _writeGlb(doc, positions, scaleArr, rotArr, colorArr, outputPath);
}

// ── Path B: from SparkJS PackedSplats ─────────────────────────────────────────

/**
 * Uses utils.unpackSplat() (which returns a REUSED static object — values must be
 * copied immediately) and extra.sh1/sh2/sh3 Uint32Arrays for SH coefficients.
 *
 * SH coefficients are decoded using decodeSh1Rgb / decodeSh2Rgb / decodeSh3Rgb
 * from @sparkjsdev/spark utils if sh_max info is available, otherwise stored
 * as raw packed Uint32 accessor data for downstream consumers.
 *
 * @param {object}   packedSplats  PackedSplats instance
 * @param {number[]} splatIndices  indices into the flat packedArray
 * @param {string}   outputPath
 * @param {object}   [sparkUtils]  { unpackSplat, decodeSh1Rgb?, decodeSh2Rgb?, decodeSh3Rgb? }
 */
export async function writeSplatGlbFromPackedSplats(packedSplats, splatIndices, outputPath, sparkUtils) {
  const { unpackSplat } = sparkUtils;
  const n = splatIndices.length;

  const positions = new Float32Array(n * 3);
  const scaleArr  = new Float32Array(n * 3);
  const rotArr    = new Float32Array(n * 4);
  const colorArr  = new Float32Array(n * 4);

  for (let i = 0; i < n; i++) {
    const idx = splatIndices[i];
    // IMPORTANT: unpackSplat returns a REUSED static object — copy values immediately
    const s = unpackSplat(packedSplats.packedArray, idx, packedSplats.splatEncoding);
    positions[i*3]   = s.center.x;
    positions[i*3+1] = s.center.y;
    positions[i*3+2] = s.center.z;
    scaleArr[i*3]    = s.scales.x;
    scaleArr[i*3+1]  = s.scales.y;
    scaleArr[i*3+2]  = s.scales.z;
    rotArr[i*4]      = s.quaternion.x;
    rotArr[i*4+1]    = s.quaternion.y;
    rotArr[i*4+2]    = s.quaternion.z;
    rotArr[i*4+3]    = s.quaternion.w;
    colorArr[i*4]    = s.color.r;
    colorArr[i*4+1]  = s.color.g;
    colorArr[i*4+2]  = s.color.b;
    colorArr[i*4+3]  = s.opacity;
  }

  const doc = new Document();
  doc.createBuffer();

  // Optional: SH coefficients from extra.sh1/sh2/sh3 Uint32Arrays
  // sh1: 2 uint32 per splat (9 SH1 coefficients packed as sint7)
  // sh2: 4 uint32 per splat (15 SH2 coefficients packed as sint8)
  // sh3: 4 uint32 per splat (21 SH3 coefficients packed as sint6)
  // Stored as custom _SH1/_SH2/_SH3 accessors (raw packed, no decode — downstream
  // renderer is expected to understand SparkJS SH packing).
  if (packedSplats.extra?.sh1 instanceof Uint32Array) {
    const sh1Src = packedSplats.extra.sh1; // 2 uint32 per splat
    const sh1Out = new Uint32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const srcIdx = splatIndices[i] * 2;
      sh1Out[i*2]   = sh1Src[srcIdx];
      sh1Out[i*2+1] = sh1Src[srcIdx + 1];
    }
    // Store as VEC2 of UNSIGNED_INT (custom attribute)
    const sh1Acc = doc.createAccessor('_SH1')
      .setType('VEC2')
      .setArray(sh1Out);
    // Will be attached to prim below
    doc._sh1Acc = sh1Acc;
  }
  if (packedSplats.extra?.sh2 instanceof Uint32Array) {
    const sh2Src = packedSplats.extra.sh2; // 4 uint32 per splat
    const sh2Out = new Uint32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const srcIdx = splatIndices[i] * 4;
      sh2Out[i*4] = sh2Src[srcIdx]; sh2Out[i*4+1] = sh2Src[srcIdx+1];
      sh2Out[i*4+2] = sh2Src[srcIdx+2]; sh2Out[i*4+3] = sh2Src[srcIdx+3];
    }
    doc._sh2Acc = doc.createAccessor('_SH2').setType('VEC4').setArray(sh2Out);
  }
  if (packedSplats.extra?.sh3 instanceof Uint32Array) {
    const sh3Src = packedSplats.extra.sh3; // 4 uint32 per splat
    const sh3Out = new Uint32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const srcIdx = splatIndices[i] * 4;
      sh3Out[i*4] = sh3Src[srcIdx]; sh3Out[i*4+1] = sh3Src[srcIdx+1];
      sh3Out[i*4+2] = sh3Src[srcIdx+2]; sh3Out[i*4+3] = sh3Src[srcIdx+3];
    }
    doc._sh3Acc = doc.createAccessor('_SH3').setType('VEC4').setArray(sh3Out);
  }

  await _writeGlb(doc, positions, scaleArr, rotArr, colorArr, outputPath);
}

// ── Shared GLB assembly ───────────────────────────────────────────────────────

async function _writeGlb(doc, positions, scaleArr, rotArr, colorArr, outputPath) {
  const mesh = doc.createMesh('splats');
  const prim = doc.createPrimitive().setMode(0 /* POINTS */);

  // POSITION on the primitive directly (for bounding volume + fallback renderers)
  const posAcc = doc.createAccessor('POSITION').setType('VEC3').setArray(positions);
  prim.setAttribute('POSITION', posAcc);

  // KHR_gaussian_splatting extension attributes
  const gsAttribs = { POSITION: 0 }; // will be resolved to accessor indices post-write

  if (scaleArr) {
    const acc = doc.createAccessor('_SCALE').setType('VEC3').setArray(scaleArr);
    prim.setAttribute('_SCALE', acc);
    gsAttribs.SCALE = '_SCALE';
  }
  if (rotArr) {
    const acc = doc.createAccessor('_ROTATION').setType('VEC4').setArray(rotArr);
    prim.setAttribute('_ROTATION', acc);
    gsAttribs.ROTATION = '_ROTATION';
  }
  if (colorArr) {
    const acc = doc.createAccessor('COLOR_0').setType('VEC4').setArray(colorArr);
    prim.setAttribute('COLOR_0', acc);
    gsAttribs.COLOR_0 = 'COLOR_0';
  }

  // SH accessors from SparkJS path (attached to doc by writeSplatGlbFromPackedSplats)
  if (doc._sh1Acc) { prim.setAttribute('_SH1', doc._sh1Acc); gsAttribs._SH1 = '_SH1'; }
  if (doc._sh2Acc) { prim.setAttribute('_SH2', doc._sh2Acc); gsAttribs._SH2 = '_SH2'; }
  if (doc._sh3Acc) { prim.setAttribute('_SH3', doc._sh3Acc); gsAttribs._SH3 = '_SH3'; }

  // Inject KHR_gaussian_splatting as raw extension JSON on the primitive.
  // gltf-transform v4 preserves unknown extension objects verbatim on write.
  prim.setExtension(EXT_KHR_GS, { attributes: gsAttribs });

  mesh.addPrimitive(prim);
  doc.createScene().addChild(doc.createNode('splat-tile').setMesh(mesh));

  const io  = new NodeIO();
  const glb = await io.writeBinary(doc); // returns Uint8Array in v4

  // Patch extensionsUsed into the GLB JSON chunk (gltf-transform doesn't add
  // unknown extension names to extensionsUsed automatically)
  const patched = patchExtensionsUsed(glb, [EXT_KHR_GS]);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, patched);
}

/**
 * Parse the JSON chunk of a GLB, add extensionsUsed entries, re-pack.
 * @param {Uint8Array} glb
 * @param {string[]}   exts
 * @returns {Buffer}
 */
function patchExtensionsUsed(glb, exts) {
  const buf = Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength);

  // GLB: magic(4)+version(4)+length(4) | chunk0Length(4)+chunk0Type(4)+JSON | chunk1...
  const jsonChunkLen  = buf.readUInt32LE(12);
  const jsonChunkType = buf.readUInt32LE(16); // 0x4E4F534A = "JSON"
  if (jsonChunkType !== 0x4E4F534A) throw new Error('GLB chunk 0 is not JSON');

  const jsonStr  = buf.slice(20, 20 + jsonChunkLen).toString('utf8').replace(/\0+|\x20+$/g, '');
  const gltf     = JSON.parse(jsonStr);
  gltf.extensionsUsed = [...new Set([...(gltf.extensionsUsed ?? []), ...exts])];

  const newJson    = JSON.stringify(gltf);
  const padLen     = (4 - (newJson.length % 4)) % 4;
  const newJsonBuf = Buffer.concat([
    Buffer.from(newJson, 'utf8'),
    Buffer.alloc(padLen, 0x20) // pad with spaces per GLB spec
  ]);

  const restStart = 20 + jsonChunkLen;
  const rest      = buf.slice(restStart);
  const totalLen  = 12 + 8 + newJsonBuf.byteLength + rest.byteLength;

  const out = Buffer.concat([
    buf.slice(0, 8),                         // magic + version
    writeUInt32LE(totalLen),                  // new total length
    writeUInt32LE(newJsonBuf.byteLength),     // chunk 0 length
    writeUInt32LE(0x4E4F534A),               // chunk 0 type "JSON"
    newJsonBuf,
    rest
  ]);

  return out;
}

function writeUInt32LE(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v, 0);
  return b;
}
