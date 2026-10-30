/**
 * plainLas.js  (copc-to-3dtiles)
 *
 * Support for **plain, non-COPC** .las / .laz files — i.e. files that lack the
 * COPC info VLR and therefore have NO native octree / LoD hierarchy.
 *
 * Strategy: read all points, then emit a flat tiling — one or more sibling
 * POINTS tiles under a single root, chunked to ≤ MAX_POINTS_PER_TILE so RAM and
 * per-GLB size stay bounded. There is NO level-of-detail: every tile sits at the
 * root and all are always rendered. The same scale/offset + Y-up handling as the
 * COPC path is applied (positions go through buildPointsGlb's E,U,−N swizzle).
 *
 * Decoding:
 *   - LAS  (uncompressed): point records start at header.pointDataOffset.
 *   - LAZ  (compressed):   Las.PointData.decompressFile (laz-perf WASM) → records.
 *   Compression flag = high bit (0x80) of the raw point-data-record-format byte
 *   at file offset 104 (Las.Header.parse masks it off with & 0b1111).
 *
 * STATUS: UNTESTED end-to-end — the repo has no plain (non-COPC) LAS/LAZ sample.
 * Logic mirrors the validated COPC view/getter path; validate on a real file.
 */

import fs   from 'fs/promises';
import path from 'path';
import { Las, Getter } from 'copc';
import { buildPointsGlb } from '../../core/index.js';

const MAX_POINTS_PER_TILE = 2_000_000; // keep per-tile RAM + GLB size bounded

/**
 * Read all points from a plain LAS/LAZ file into a single Las.View.
 * Returns { view, header }. `view.getter('X')` etc. give CRS-scaled values.
 */
async function readAllPoints(filename) {
  const get = Getter.create(filename);

  // Header: read enough bytes to cover both 1.2 (227) and 1.4 (375) headers.
  const headBytes = await get(0, 375);
  const header = Las.Header.parse(headBytes);

  // Detect LAZ via the compression bit (0x80) of the raw format byte at 104.
  const rawFormatByte = headBytes[104];
  const isCompressed = (rawFormatByte & 0x80) !== 0;

  const { pointCount, pointDataRecordLength, pointDataOffset } = header;

  let recordsBuffer; // uncompressed interleaved point records
  if (isCompressed) {
    // laz-perf's decompressFile decodes the WHOLE file at once — it does not
    // expose per-chunk streaming for plain (non-COPC) LAZ. So peak RAM here is
    // ~filesize + (pointCount * pointDataRecordLength) for the decoded buffer
    // (e.g. ~380 MB decoded for a 10 M-point file). The ≤MAX_POINTS_PER_TILE
    // chunking below bounds per-GLB memory, not this decode buffer. For very
    // large LAZ inputs that exceeds available RAM, re-export as COPC (which
    // supports bounded per-node range reads via the octree path).
    const fileBytes = await get(0, (await fs.stat(filename)).size);
    recordsBuffer = await Las.PointData.decompressFile(fileBytes);
  } else {
    const byteLen = pointCount * pointDataRecordLength;
    recordsBuffer = await get(pointDataOffset, pointDataOffset + byteLen);
  }

  // Build a Las.View over the uncompressed records. View.create wants a buffer
  // whose point i lives at i*pointDataRecordLength, which is exactly what both
  // the sliced LAS records and decompressFile output give us.
  const view = Las.View.create(recordsBuffer, header);
  return { view, header };
}

/**
 * Build the per-tile local POSITION/COLOR arrays for points [start, end) and
 * write a POINTS GLB. Mirrors writeTileGlb's COPC logic exactly (RGB → grey
 * intensity → white; positions relative to `origin`; Y-up swizzle in buildGlb).
 */
async function writePlainTile(view, start, end, origin, outPath) {
  const count = end - start;
  const [cx, cy, cz] = origin;
  const getX = view.getter('X'), getY = view.getter('Y'), getZ = view.getter('Z');

  // Pass dataset-local (E,N,U); buildPointsGlb applies the (E,U,−N) swizzle.
  const local = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const j = start + i;
    local[i*3]   = getX(j) - cx;
    local[i*3+1] = getY(j) - cy;
    local[i*3+2] = getZ(j) - cz;
  }

  const dims = view.dimensions;
  let colors = null;
  if (dims.Red && dims.Green && dims.Blue) {
    const getR = view.getter('Red'), getG = view.getter('Green'), getB = view.getter('Blue');
    const scale = dims.Red.size === 2 ? 1 / 65535 : 1 / 255;
    colors = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const j = start + i;
      colors[i*4]   = getR(j) * scale;
      colors[i*4+1] = getG(j) * scale;
      colors[i*4+2] = getB(j) * scale;
      colors[i*4+3] = 1.0;
    }
  } // no RGB: null → buildPointsGlb fills white (intensity as grey rendered near-black)

  const glb = await buildPointsGlb(local, colors, count);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, glb);
}

/**
 * Convert a plain (non-COPC) LAS/LAZ file to a flat 3D Tiles 1.1 tileset.
 *
 * @param {string} inputPath
 * @param {string} outDir
 * @param {(copcLike:object, filename:string, origin:number[]) => Promise<{transform,hasGeoref}>} buildEcefTransform
 * @param {(cube:number[]) => number[]} bboxToBox
 * @param {number} [concurrency]
 */
export async function convertPlainLas(inputPath, outDir, buildEcefTransform, bboxToBox, concurrency = 1) {
  console.log(`Loading plain LAS/LAZ (no COPC octree): ${inputPath}`);
  console.log('  NOTE: plain LAS/LAZ has no native LoD — emitting a flat single/chunked tiling.');

  const { view, header } = await readAllPoints(inputPath);
  const count = view.pointCount;
  const [minX, minY, minZ] = header.min;
  const [maxX, maxY, maxZ] = header.max;
  console.log(`  ${count} points`);

  // Shared local frame: subtract the bbox centre (same convention as COPC path).
  const origin = [(minX+maxX)/2, (minY+maxY)/2, (minZ+maxZ)/2];

  // Georef: reuse the COPC WKT-from-file path via a small copc-like shim. We pass
  // the parsed VLR list so buildEcefTransform can read the LASF_Projection/2112 WKT.
  const vlrs = await Las.Vlr.walk(inputPath, header).catch(() => []);
  const copcLike = { vlrs, header: { ...header, vlrs } };
  const { transform, hasGeoref } = await buildEcefTransform(copcLike, inputPath, origin);

  // Flat tiling: chunk into ≤ MAX_POINTS_PER_TILE sibling tiles.
  const nTiles = Math.max(1, Math.ceil(count / MAX_POINTS_PER_TILE));
  console.log(`Writing GLBs... (${nTiles} tile(s), parallel: ${concurrency} lanes)`);

  const chunks = [];
  for (let t = 0; t < nTiles; t++) {
    const start = t * MAX_POINTS_PER_TILE;
    const end = Math.min(count, start + MAX_POINTS_PER_TILE);
    chunks.push({ t, start, end });
  }

  // Parallelise across chunks (bounded). Each task touches only its slice.
  const children = new Array(nTiles);
  let done = 0;
  const half = [ (maxX-minX)/2, (maxY-minY)/2, (maxZ-minZ)/2 ];
  const rootError = Math.sqrt((maxX-minX)**2 + (maxY-minY)**2 + (maxZ-minZ)**2);
  await runBounded(chunks, async ({ t, start, end }) => {
    const uri = `tiles/${t}.glb`;
    await writePlainTile(view, start, end, origin, path.join(outDir, uri));
    children[t] = {
      // All chunks share the same box (the whole dataset); no LoD between them.
      boundingVolume: { box: bboxToBox([minX,minY,minZ,maxX,maxY,maxZ]) },
      geometricError: 0,
      content: { uri },
    };
    done++;
    process.stdout.write(`\r  ${done}/${nTiles}`);
  }, concurrency);
  process.stdout.write(`\r  ${done}/${nTiles} tiles\n`);

  const root = {
    boundingVolume: { box: bboxToBox([minX,minY,minZ,maxX,maxY,maxZ]) },
    refine: 'ADD',
    geometricError: rootError,
    children,
  };
  if (transform) root.transform = transform;

  const tileset = { asset: { version: '1.1' }, geometricError: rootError, root };
  await fs.writeFile(path.join(outDir, 'tileset.json'), JSON.stringify(tileset, null, 2));
  console.log(`\nDone → ${outDir}/tileset.json  (plain LAS/LAZ, flat tiling, NO LoD)`);
  if (!hasGeoref) console.log('  (no CRS found — local coordinate output)');
}

/** Minimal bounded-concurrency runner (avoids importing parallelMap result array). */
async function runBounded(items, fn, concurrency) {
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
}
