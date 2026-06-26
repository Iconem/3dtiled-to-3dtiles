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
import { fileURLToPath } from 'node:url';

import { parseRadHeader, buildNodeTable, parseRadcChunk } from './radHeader.js';
import { buildTileset } from './tilesetBuilder.js';
// Shared, parallel-friendly encoder from core (async gzip on the libuv threadpool) +
// bounded-concurrency map — same import lcc uses. Replaces rad's inline synchronous
// SPZ-v2/GLB encoder (verified byte-identical to the prior gzipSync output).
import { buildSplatTileGlb, computeBounds, parallelMap, defaultConcurrency } from '../../core/index.js';

// Conversion options (settable per-call by `convert()`; the CLI shim builds them from argv).
//  scaleMult        --scale=N           uniform σ multiplier (A/B splat size)
//  alphaScale       --alpha-scale=N     final opacity multiplier on the decoded alpha
//  geScale          --ge-scale=N        global geometricError multiplier
//  geLayer          --ge-layer=N        per-depth GE stretch (leafGE + (GE−leafGE)×layer)
//  geBasis          --ge-basis=…        'spatial' (default; bboxDiag/∛count) | 'featuresize' (legacy)
//  opacityMin       --opacity-filter=N  OPT-IN: drop splats with alpha < N (default 0 = off, matches SparkJS)
//  scaleOutlierMult --max-scale-mult=N  OPT-IN: drop splats with maxScale > median×N (default 0 = off)
const OPTS = { scaleMult: 1, alphaScale: 1, geScale: 1, geLayer: 1, geBasis: 'spatial', opacityMin: 0, scaleOutlierMult: 0, centroidsOnly: false };

/** Parse `--flag=value` argv into an opts object (for the CLI shim). */
function parseArgvOpts(argv) {
  const num = (k, d, allowZero) => { const f = argv.find(a => a.startsWith(`--${k}=`)); const v = f ? parseFloat(f.slice(k.length + 3)) : d; return (isFinite(v) && (allowZero ? v >= 0 : v > 0)) ? v : d; };
  const gb = argv.find(a => a.startsWith('--ge-basis='));
  return {
    scaleMult:        num('scale', 1),
    alphaScale:       num('alpha-scale', 1),
    geScale:          num('ge-scale', 1),
    geLayer:          num('ge-layer', 1),
    geBasis:          (gb && gb.slice('--ge-basis='.length).toLowerCase() === 'featuresize') ? 'featuresize' : 'spatial',
    opacityMin:       num('opacity-filter', 0, true),
    scaleOutlierMult: num('max-scale-mult', 0, true),
    centroidsOnly:    argv.includes('--centroids-only'),
  };
}

const ensureDir = d => fs.mkdir(d, { recursive: true });

// ── RAD scale-decode log range (mirrored from @sparkjsdev/spark) ──────────────
// Default ln-scale quantisation bounds for `decodeScales` when the RAD chunk's
// splatEncoding omits lnScaleMin/Max. (The SPZ-v2/GLB encoder itself now lives in
// the shared core — see the import above.)
const LN_SCALE_MIN      = -12;
const LN_SCALE_MAX      = 9;

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

// ── SPZ-v2/GLB encoder + bounds: now imported from the shared core (see top import). ──

// ── Cheap centers-only bounds (for streaming tileset construction) ─────────────

/**
 * Decode ONLY the `center` column of a chunk and return its AABB + splat count.
 * This is the cheap pass the streaming adapter uses to build the tileset tree
 * without the full decode + SPZ encode + gzip of every tile.
 * Mirrors the default (unfiltered) convert bounds, since filtering is opt-in/off by default.
 */
export function chunkBounds(buf, chunk, payloadBase) {
  const { count, props } = parseRadcChunk(buf, chunk, payloadBase, ['center']);
  const positions = decodeF32LeBytes(props.get('center'), 3, count);
  const b = computeBounds(positions, count);
  return { bounds: [b.cx, b.cy, b.cz, b.hx, b.hy, b.hz], count };
}

/**
 * Single-pass per-chunk reader for the streaming adapter: decode the `center` column for bounds AND
 * the `child_count`/`child_start` columns for LoD-tree topology from ONE chunk buffer. Merging both
 * (vs. buildNodeTable + chunkBounds in two passes) halves the decompressions over a big RAD, and lets
 * the caller feed a per-chunk buffer (range-fetched) instead of the whole file.
 *
 * @param chunkBuf  a Buffer holding just this chunk (so payloadBase=0, chunk.offset=0), OR the full file
 * @param chunk     { offset, bytes } — use {offset:0} with a per-chunk buffer
 * @param payloadBase  0 for a per-chunk buffer
 * @param chunkSize  header.chunkSize (splats per chunk)
 * @param ci         this chunk's index
 * @param totalChunks header.chunks.length
 * @returns { bounds:[cx,cy,cz,hx,hy,hz], count, children:number[] }
 */
export function chunkBoundsAndTopology(chunkBuf, chunk, payloadBase, chunkSize, ci, totalChunks) {
  const { count, props } = parseRadcChunk(chunkBuf, chunk, payloadBase, ['center', 'child_count', 'child_start']);
  const positions = decodeF32LeBytes(props.get('center'), 3, count);
  const b = computeBounds(positions, count);

  const children = [];
  const ccBuf = props.get('child_count'), csBuf = props.get('child_start');
  if (ccBuf && csBuf) {
    const ccView = new DataView(ccBuf.buffer, ccBuf.byteOffset, ccBuf.byteLength);
    const csView = new DataView(csBuf.buffer, csBuf.byteOffset, csBuf.byteLength);
    const SCAN = Math.min(count, 1000);   // coarse splats reference all child chunks (BhattLod order)
    const set = new Set();
    for (let i = 0; i < SCAN; i++) {
      const cc = ccView.getUint16(i * 2, true), cs = csView.getUint32(i * 4, true);
      if (cc > 0 && cs > 0) { const c = Math.floor(cs / chunkSize); if (c > ci && c < totalChunks) set.add(c); }
    }
    children.push(...[...set].sort((a, b) => a - b));
  }
  return { bounds: [b.cx, b.cy, b.cz, b.hx, b.hy, b.hz], count, children };
}

// ── Per-chunk GLB encoder (returns the buffer; shared by offline + streaming) ──

/**
 * Decode one RAD chunk fully and encode it to an SPZ-v2 GLB Buffer.
 * Returns { glb, bounds, featureSize, count, kept } — no file I/O.
 * `opts` overrides OPTS for this call (e.g. centroidsOnly); omitted keys keep current OPTS.
 */
export async function encodeChunkGlb(buf, chunk, payloadBase, opts = {}) {
  const prevOpts = { ...OPTS };
  Object.assign(OPTS, opts);
  try {
    return await _encodeChunkGlb(buf, chunk, payloadBase);
  } finally {
    Object.assign(OPTS, prevOpts);
  }
}

// ── Per-chunk GLB writer ──────────────────────────────────────────────────────

async function writeChunkGlb(buf, chunk, payloadBase, outputPath) {
  const { glb, bounds, featureSize, count, kept } = await _encodeChunkGlb(buf, chunk, payloadBase);
  await ensureDir(path.dirname(outputPath));
  await fs.writeFile(outputPath, glb);
  return { bounds, featureSize, count, kept };
}

async function _encodeChunkGlb(buf, chunk, payloadBase) {
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
      alphas[i] = Math.max(0, Math.min(1, (lodOp ? raw[i] * 2 : raw[i]) * OPTS.alphaScale));
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
    // Per-chunk scale-outlier threshold = median(maxScale) × OPTS.scaleOutlierMult.
    let scaleCap = Infinity;
    if (scales && OPTS.scaleOutlierMult > 0 && count > 0) {
      const maxS = new Float64Array(count);
      for (let i = 0; i < count; i++) maxS[i] = Math.max(scales[i*3], scales[i*3+1], scales[i*3+2]);
      const sorted = Float64Array.from(maxS).sort();
      const median = sorted[sorted.length >> 1] || 0;
      if (median > 0) scaleCap = median * OPTS.scaleOutlierMult;
    }
    const keep = new Uint8Array(count);
    let kept = 0;
    for (let i = 0; i < count; i++) {
      if (OPTS.opacityMin > 0 && alphas[i] < OPTS.opacityMin) continue;
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
  if (scales && OPTS.scaleMult !== 1) {
    for (let i = 0; i < scales.length; i++) scales[i] *= OPTS.scaleMult;
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
  const glb    = await buildSplatTileGlb({ positions: posArr, alphas: alphaArr, rgb, scales, rotations }, count2, bounds, OPTS.centroidsOnly);

  return { glb, bounds, featureSize, count, kept: count2 };
}

// ── Main ──────────────────────────────────────────────────────────────────────

/** Uniform in-process entry: convert a monolithic .RAD LoD file → 3D Tiles splat tileset. */
export async function convert(radPath, outDir, opts = {}) {
  if (!radPath || !outDir) throw new Error('Usage: rad-to-3dtiles <input.rad> <outDir> [--scale=N] [--ge-scale=N] [--ge-layer=N] [--ge-basis=spatial|featuresize] [--opacity-filter=N] [--max-scale-mult=N]');
  Object.assign(OPTS, opts);   // per-call options (defaults preserved for any omitted)
  await ensureDir(path.join(outDir, 'tiles'));

  console.log(`Loading .RAD: ${radPath}`);
  const radBuf = await fs.readFile(radPath);
  const { header, payloadBase, isStreaming } = parseRadHeader(radBuf);

  if (isStreaming) {
    throw new Error(
      `"${radPath}" is a streaming manifest RAD file. ` +
      `Chunk data is not embedded — download the full monolithic RAD file.`
    );
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
  // Each node decodes its own chunk from the in-memory radBuf (read-only), encodes
  // (async gzip on the libuv threadpool) and writes its own GLB, then records its
  // bounds + featureSize on the node — all independent, so we fan them through
  // bounded-concurrency parallelMap. radBuf is already fully loaded; peak memory is
  // bounded by concurrency × one tile's decoded arrays. Output is unchanged: each
  // node writes the same bytes to the same path regardless of order.
  const concurrency = defaultConcurrency();
  await parallelMap(nodes, async (node) => {
    const chunk    = header.chunks[node.chunkIndex];
    const tilePath = path.join(outDir, 'tiles', `node_${node.nodeIndex}.glb`);
    const { bounds, featureSize, kept } = await writeChunkGlb(radBuf, chunk, payloadBase, tilePath);
    node.bounds         = [bounds.cx, bounds.cy, bounds.cz, bounds.hx, bounds.hy, bounds.hz];
    node.geometricError = featureSize;   // legacy featureSize basis (--ge-basis=featuresize)
    node.splatCount     = kept;          // for the default spatial GE basis (diag / ∛count)
  }, { concurrency, onProgress: (d, t) => { if (d % 50 === 0 || d === t) process.stdout.write(`\r  ${d}/${t}`); } });
  console.log(`\r  ${nodes.length}/${nodes.length} tiles`);

  const tileset = buildTileset(nodes, { tileUriTemplate: 'tiles/node_{index}.glb', geScale: OPTS.geScale, geLayer: OPTS.geLayer, geBasis: OPTS.geBasis });
  // Declare GLB extensions so Cesium knows to enable them — but only in splat mode.
  // centroids mode emits plain glTF POINTS tiles, which need no extension advertisement.
  if (!OPTS.centroidsOnly) {
    tileset.extensions     = {
      '3DTILES_content_gltf': {
        extensionsUsed:     ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
        extensionsRequired: ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
      }
    };
    tileset.extensionsUsed = ['3DTILES_content_gltf'];
  }

  await fs.writeFile(path.join(outDir, 'tileset.json'), JSON.stringify(tileset, null, 2));

  const treeDepth = nodes.reduce((m, n) => Math.max(m, n.depth ?? 0), 0);
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`\nDone → ${outDir}/tileset.json`);
  console.log(`  REPLACE tileset, ${treeDepth + 1} levels, ${OPTS.centroidsOnly ? 'glTF POINTS centroids' : 'KHR_gaussian_splatting_compression_spz_2'}`);
  console.log(`  Actual time: ${elapsed < 60 ? elapsed.toFixed(1)+'s' : (elapsed/60).toFixed(1)+' min'} (${(elapsed/(header.count/1e6)).toFixed(1)}s/M splats)`);
  return { format: 'rad', outDir, tiles: nodes.length, levels: treeDepth + 1 };
}

// ── CLI shim: run only when invoked directly (not when imported by the meta-converter) ──
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const pos = argv.filter(a => !a.startsWith('--'));
  convert(pos[0], pos[1], parseArgvOpts(argv))
    .then(() => process.exit(0))            // force-exit: gzip/fs may hold async handles open
    .catch(e => { console.error(e); process.exit(1); });
}
