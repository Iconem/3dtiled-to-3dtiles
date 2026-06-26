/**
 * upgrade.js — 3D Tiles 1.0 → 1.1 per-tile converters (fast, zero-copy where possible).
 *
 *   b3dm → glb  : compute the GLB byte-offset inside the b3dm and return a slice — O(1), no decode.
 *   pnts → glb  : parse pnts feature table, write a minimal GLB in one Buffer.alloc — no @gltf-transform.
 *
 * These are the per-tile helpers used by the streaming tile handler.
 * The heavy "walk the whole tileset + write to disk" path (upgradeTileset) is kept for CLI use.
 */
import fs   from 'node:fs/promises';
import fss  from 'node:fs';
import path from 'node:path';
import gltfPipeline from 'gltf-pipeline';

const { processGlb } = gltfPipeline;

/**
 * Upgrade a legacy glTF 1.0 GLB (version 1) buffer to glTF 2.0 (version 2) via gltf-pipeline.
 * gltf-pipeline's processGlb runs updateVersion (1.0→2.0) + KHR_techniques_webgl handling.
 * Returns a glTF 2.0 GLB Buffer that Three.js / 3DTRjs can load.
 */
export async function glbV1toV2(glbV1) {
  const { glb } = await processGlb(glbV1, { keepUnusedElements: true });
  return Buffer.from(glb);
}

// ── b3dm ─────────────────────────────────────────────────────────────────────

/**
 * Return the byte offset of the embedded GLB inside a b3dm file/buffer.
 * b3dm header layout (all uint32LE, 28 bytes total):
 *   magic(4) version(4) byteLength(4) ftJSONLen(4) ftBinLen(4) btJSONLen(4) btBinLen(4)
 */
export function b3dmGlbOffset(buf) {
  if (buf.toString('ascii', 0, 4) !== 'b3dm') throw new Error('Not a b3dm file');
  return 28 + buf.readUInt32LE(12) + buf.readUInt32LE(16) + buf.readUInt32LE(20) + buf.readUInt32LE(24);
}

/** Slice the embedded GLB out of a b3dm Buffer (zero-copy view, no version check). */
export function b3dmToGlb(buf) {
  return buf.slice(b3dmGlbOffset(buf));
}

/**
 * Extract the embedded GLB from a b3dm Buffer, upgrading glTF 1.0 → 2.0 on the fly
 * AND baking any CESIUM_RTC center into a node translation. Returns a plain glTF 2.0
 * GLB Buffer loadable by both CesiumJS and Three.js/3DTRjs.
 *
 * We serve GLB directly (bypassing each renderer's native b3dm loader), so the b3dm's
 * RTC_CENTER / CESIUM_RTC offset — which Three.js does NOT support — must be folded in
 * here, else the mesh renders at the local origin instead of its real (ECEF) position.
 */
export async function b3dmToGlb2(buf) {
  let glb = buf.slice(b3dmGlbOffset(buf));
  if (glb.readUInt32LE(4) === 1) glb = await glbV1toV2(glb);
  return bakeCesiumRtc(glb);
}

// ── CESIUM_RTC → node translation ──────────────────────────────────────────────

/** Re-serialize a glTF 2.0 JSON object + BIN buffer into a GLB Buffer. */
function repackGlb(json, bin) {
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBuf.length & 3)) & 3;
  const binLen  = bin ? bin.length : 0;
  const binPad  = bin ? (4 - (binLen & 3)) & 3 : 0;
  const total = 12 + 8 + jsonBuf.length + jsonPad + (bin ? 8 + binLen + binPad : 0);
  const out = Buffer.allocUnsafe(total);
  let o = 0;
  out.writeUInt32LE(0x46546C67, o); o += 4;            // 'glTF'
  out.writeUInt32LE(2,           o); o += 4;            // version 2
  out.writeUInt32LE(total,       o); o += 4;
  out.writeUInt32LE(jsonBuf.length + jsonPad, o); o += 4;
  out.writeUInt32LE(0x4E4F534A,  o); o += 4;            // 'JSON'
  jsonBuf.copy(out, o); o += jsonBuf.length;
  out.fill(0x20, o, o + jsonPad); o += jsonPad;
  if (bin) {
    out.writeUInt32LE(binLen + binPad, o); o += 4;
    out.writeUInt32LE(0x004E4942,      o); o += 4;      // 'BIN\0'
    bin.copy(out, o); o += binLen;
    out.fill(0, o, o + binPad);
  }
  return out;
}

/**
 * If a GLB declares CESIUM_RTC, fold its center into a wrapper node translation and
 * strip the extension — so plain glTF 2.0 loaders (Three.js) place the mesh correctly.
 *
 * Subtlety: a 3D Tiles renderer applies the glTF Y-up→Z-up rotation (RX+90°: (x,y,z)→(x,−z,y))
 * to the WHOLE glTF, including our wrapper node. RTC_CENTER, however, is an ECEF offset that must
 * NOT be rotated (in native b3dm it's applied outside the up-axis). If we stored the raw center,
 * the renderer would place geometry at UpAxis·RTC — a ~6378 km-magnitude vector rotated 90°, i.e.
 * flung thousands of km away (bboxes look right, tiles render empty). So we pre-rotate the center
 * by the INVERSE up-axis (RX−90°: (x,y,z)→(x,z,−y)); the renderer's RX+90° then restores the true
 * RTC. The (small, relative) mesh vertices still get RX+90° applied — correct, as in native b3dm.
 * No-op (returns the input) when CESIUM_RTC is absent.
 */
export function bakeCesiumRtc(glb) {
  if (glb.readUInt32LE(0) !== 0x46546C67) return glb;   // not a GLB
  const jsonLen   = glb.readUInt32LE(12);
  const jsonStart = 20;                                  // 12 header + 8 chunk header
  let json;
  try { json = JSON.parse(glb.slice(jsonStart, jsonStart + jsonLen).toString('utf8')); }
  catch { return glb; }

  const rtc = json.extensions?.CESIUM_RTC?.center;
  if (!rtc) return glb;

  const scene = json.scenes?.[json.scene ?? 0];
  if (!scene) return glb;
  json.nodes = json.nodes || [];
  const wrapper = json.nodes.length;
  // RX(−90°): (x,y,z) → (x, z, −y) — pre-rotate so the renderer's RX(+90°) yields the true RTC.
  json.nodes.push({ translation: [rtc[0], rtc[2], -rtc[1]], children: scene.nodes ?? [] });
  scene.nodes = [wrapper];

  delete json.extensions.CESIUM_RTC;
  if (Object.keys(json.extensions).length === 0) delete json.extensions;
  const strip = a => (a ? a.filter(e => e !== 'CESIUM_RTC') : a);
  if (json.extensionsUsed)     { json.extensionsUsed = strip(json.extensionsUsed);         if (!json.extensionsUsed.length)     delete json.extensionsUsed; }
  if (json.extensionsRequired) { json.extensionsRequired = strip(json.extensionsRequired); if (!json.extensionsRequired.length) delete json.extensionsRequired; }

  // Extract the BIN chunk (unchanged) and repack with the new JSON.
  const binStart = jsonStart + jsonLen;
  let bin = null;
  if (binStart + 8 <= glb.length) {
    const binLen = glb.readUInt32LE(binStart);
    bin = glb.slice(binStart + 8, binStart + 8 + binLen);
  }
  return repackGlb(json, bin);
}

/**
 * Read a local .b3dm file and write its embedded GLB to a Node http.ServerResponse,
 * upgrading glTF 1.0 → 2.0 and baking CESIUM_RTC into a node translation (see b3dmToGlb2).
 * (We parse the GLB to bake RTC, so this isn't zero-copy — fine for local disk reads.)
 */
export async function pipeB3dmAsGlb(filePath, res) {
  const buf = await fs.readFile(filePath);
  const glb = await b3dmToGlb2(buf);
  res.setHeader('Content-Type', 'model/gltf-binary');
  res.setHeader('Content-Length', String(glb.length));
  res.end(glb);
}

// ── pnts ─────────────────────────────────────────────────────────────────────

/**
 * Fast native GLB builder for a POINTS cloud.
 * Writes a minimal GLB in a single Buffer.alloc — no @gltf-transform, no JSON round-trip overhead.
 *
 * @param {Float32Array} positions  interleaved XYZ (count × 3), tile-local or RTC-relative
 * @param {Uint8Array|null} colorsU8  RGBA [0,255] interleaved (count × 4), or null
 * @param {number} count
 * @param {number[]|null} rtcCenter  [x,y,z] → node.translation, or null
 * @returns {Buffer}
 */
export function buildPointsGlbFast(positions, colorsU8, count, rtcCenter) {
  const posBytes = count * 12;  // float32 × 3
  const colBytes = colorsU8 ? count * 4 : 0;  // uint8 × 4
  const binTotal = posBytes + colBytes;

  // Compute AABB for the required POSITION min/max
  let minX=Infinity,minY=Infinity,minZ=Infinity, maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity;
  for (let i = 0; i < count; i++) {
    const x = positions[i*3], y = positions[i*3+1], z = positions[i*3+2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  const bufferViews = [
    { buffer: 0, byteOffset: 0,        byteLength: posBytes, target: 34962 },
  ];
  const accessors = [
    { bufferView: 0, byteOffset: 0, componentType: 5126 /* FLOAT */, count, type: 'VEC3',
      min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  ];
  const attributes = { POSITION: 0 };

  if (colorsU8) {
    bufferViews.push({ buffer: 0, byteOffset: posBytes, byteLength: colBytes, target: 34962 });
    accessors.push({ bufferView: 1, byteOffset: 0, componentType: 5121 /* UNSIGNED_BYTE */, count, type: 'VEC4', normalized: true });
    attributes.COLOR_0 = 1;
  }

  const nodeObj = { mesh: 0 };
  if (rtcCenter) nodeObj.translation = rtcCenter;

  const gltfObj = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [nodeObj],
    meshes: [{ primitives: [{ attributes, mode: 0 /* POINTS */ }] }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: binTotal }],
  };

  const jsonBuf = Buffer.from(JSON.stringify(gltfObj), 'utf8');
  const jsonPad = (4 - (jsonBuf.length & 3)) & 3;
  const binPad  = (4 - (binTotal & 3)) & 3;

  const totalLen = 12                          // GLB header
    + 8 + jsonBuf.length + jsonPad             // JSON chunk
    + (binTotal > 0 ? 8 + binTotal + binPad : 0); // BIN chunk

  const out = Buffer.allocUnsafe(totalLen);
  let o = 0;

  // GLB header
  out.writeUInt32LE(0x46546C67, o); o += 4;   // magic 'glTF'
  out.writeUInt32LE(2,           o); o += 4;   // version 2
  out.writeUInt32LE(totalLen,    o); o += 4;   // total byte length

  // JSON chunk
  out.writeUInt32LE(jsonBuf.length + jsonPad, o); o += 4;
  out.writeUInt32LE(0x4E4F534A,               o); o += 4; // 'JSON'
  jsonBuf.copy(out, o); o += jsonBuf.length;
  out.fill(0x20, o, o + jsonPad); o += jsonPad;           // space padding

  if (binTotal > 0) {
    // BIN chunk
    out.writeUInt32LE(binTotal + binPad, o); o += 4;
    out.writeUInt32LE(0x004E4942,        o); o += 4;      // 'BIN\0'
    Buffer.from(positions.buffer, positions.byteOffset, posBytes).copy(out, o); o += posBytes;
    if (colorsU8) { Buffer.from(colorsU8.buffer, colorsU8.byteOffset, colBytes).copy(out, o); o += colBytes; }
    out.fill(0, o, o + binPad); o += binPad;
  }

  return out;
}

/**
 * Parse a pnts Buffer → GLB Buffer (fast native builder).
 * Preserves RTC_CENTER as a node translation so Cesium positions the cloud correctly.
 */
export function pntsToGlb(buf) {
  if (buf.toString('ascii', 0, 4) !== 'pnts') throw new Error('Not a pnts file');
  const ftJSONLen = buf.readUInt32LE(12);
  const ftBinLen  = buf.readUInt32LE(16);
  const ftBinStart = 28 + ftJSONLen;

  const ft    = JSON.parse(buf.slice(28, 28 + ftJSONLen).toString('utf8').replace(/[\x00\s]+$/, ''));
  const ftBin = buf.slice(ftBinStart, ftBinStart + ftBinLen);
  const count = ft.POINTS_LENGTH;

  // ── Positions ──
  let positions;
  if (ft.POSITION !== undefined) {
    const off = ft.POSITION.byteOffset ?? 0;
    // Copy to own buffer (ftBin is a slice of the input buf — might be GC'd)
    positions = new Float32Array(count * 3);
    new Float32Array(ftBin.buffer, ftBin.byteOffset + off, count * 3).forEach((v, i) => { positions[i] = v; });
  } else if (ft.POSITION_QUANTIZED !== undefined) {
    const off = ft.POSITION_QUANTIZED.byteOffset ?? 0;
    const raw = new Uint16Array(ftBin.buffer, ftBin.byteOffset + off, count * 3);
    const [ox, oy, oz] = ft.QUANTIZED_VOLUME_OFFSET;
    const [sx, sy, sz] = ft.QUANTIZED_VOLUME_SCALE;
    positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i*3  ] = ox + (raw[i*3  ] / 65535) * sx;
      positions[i*3+1] = oy + (raw[i*3+1] / 65535) * sy;
      positions[i*3+2] = oz + (raw[i*3+2] / 65535) * sz;
    }
  } else {
    throw new Error('pnts: no POSITION or POSITION_QUANTIZED');
  }

  // ── Colors → Uint8Array RGBA [0,255] ──
  let colors = null;
  if (ft.RGBA !== undefined) {
    const off = ft.RGBA.byteOffset ?? 0;
    colors = new Uint8Array(count * 4);
    new Uint8Array(ftBin.buffer, ftBin.byteOffset + off, count * 4).forEach((v, i) => { colors[i] = v; });
  } else if (ft.RGB !== undefined) {
    const off = ft.RGB.byteOffset ?? 0;
    const rgb = new Uint8Array(ftBin.buffer, ftBin.byteOffset + off, count * 3);
    colors = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
      colors[i*4]=rgb[i*3]; colors[i*4+1]=rgb[i*3+1]; colors[i*4+2]=rgb[i*3+2]; colors[i*4+3]=255;
    }
  } else if (ft.RGB565 !== undefined) {
    const off = ft.RGB565.byteOffset ?? 0;
    const raw = new Uint16Array(ftBin.buffer, ftBin.byteOffset + off, count);
    colors = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
      const v = raw[i];
      colors[i*4  ] = ((v >> 11) & 0x1f) * 255 / 31;
      colors[i*4+1] = ((v >>  5) & 0x3f) * 255 / 63;
      colors[i*4+2] =  (v        & 0x1f) * 255 / 31;
      colors[i*4+3] = 255;
    }
  } else if (ft.CONSTANT_RGBA !== undefined) {
    const [r, g, b, a] = ft.CONSTANT_RGBA;
    colors = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) { colors[i*4]=r; colors[i*4+1]=g; colors[i*4+2]=b; colors[i*4+3]=a; }
  }

  const rtcCenter = ft.RTC_CENTER ?? null;
  return buildPointsGlbFast(positions, colors, count, rtcCenter);
}

// ── Tileset tree walker ───────────────────────────────────────────────────────

async function walkTiles(node, visit) {
  if (node.content?.uri) await visit(node);
  if (node.children) await Promise.all(node.children.map(c => walkTiles(c, visit)));
}

// ── CLI/offline batch upgrade ─────────────────────────────────────────────────

/**
 * Upgrade a 3D Tiles 1.0 explicit tileset in-place (writes .glb files alongside b3dm/pnts).
 * Asset version is bumped to "1.1". Content URIs in tileset.json are rewritten.
 */
export async function upgradeTileset(tilesetDir, opts = {}) {
  const tilesetFile = opts.tilesetFile ?? 'tileset.json';
  const raw = JSON.parse(await fs.readFile(path.join(tilesetDir, tilesetFile), 'utf8'));
  if (raw.root?.implicitTiling) throw new Error('implicitTiling — run implicit-to-explicit first');

  let upgraded = 0, skipped = 0;
  await walkTiles(raw.root, async (tile) => {
    const uri = tile.content.uri;
    const ext = path.extname(uri).toLowerCase();
    if (ext !== '.b3dm' && ext !== '.pnts') { skipped++; return; }
    const srcPath = path.join(tilesetDir, uri);
    const glbUri  = uri.replace(/\.(b3dm|pnts)$/i, '.glb');
    if (!opts.dryRun) {
      const srcBuf = await fs.readFile(srcPath);
      const glb = ext === '.b3dm' ? b3dmToGlb(srcBuf) : pntsToGlb(srcBuf);
      await fs.writeFile(path.join(tilesetDir, glbUri), glb);
    }
    tile.content.uri = glbUri;
    upgraded++;
  });

  if (raw.asset?.version === '1.0') raw.asset.version = '1.1';
  if (!opts.dryRun) await fs.writeFile(path.join(tilesetDir, opts.outFile ?? tilesetFile), JSON.stringify(raw, null, 2), 'utf8');
  return { upgraded, skipped };
}
