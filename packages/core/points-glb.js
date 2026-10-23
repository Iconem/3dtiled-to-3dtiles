/**
 * @3dtiled/core — glTF POINTS GLB writer (point clouds). POSITION + COLOR_0.
 * Inputs are tile-local coords; Y-up convention (store East, Up, −North) so CesiumJS's
 * glTF→Z-up RX(+90°) yields (East, North, Up). Returns the GLB bytes (caller writes/queues).
 */
import { Document, NodeIO } from '@gltf-transform/core';

/*
 * glTF 2.0 defines COLOR_0 as LINEAR. Point-cloud sources (LAS/COPC Red/Green/Blue, Potree RGB) store
 * display-encoded sRGB, and writing those values straight through made every spec-following client —
 * 3DTilesRendererJS, CesiumJS — render our point clouds washed out toward white. Found by rendering
 * the same Potree dataset through /stream and through 3DTRjs's PotreePlugin (which linearises its
 * own colours) side by side: identical geometry, visibly paler colours on the /stream side.
 *
 * A 16-bit table: inputs are 8- or 16-bit integers divided down, so this is exact for 8-bit sources
 * and within 1/65535 for 16-bit ones, and it keeps a per-channel pow() out of the tile hot path.
 */
const SRGB_TO_LINEAR = (() => {
  const t = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) { const c = i / 65535; t[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
  return t;
})();

/** sRGB-encoded [0,1] → linear [0,1] (IEC 61966-2-1). */
export function srgbToLinear(c) {
  return SRGB_TO_LINEAR[Math.round((c <= 0 ? 0 : c >= 1 ? 1 : c) * 65535)];
}

/**
 * @param {Float32Array} posLocal interleaved (E,N,U) dataset coords, tile-local
 * @param {Float32Array|null} colors interleaved rgba [0,1], or null → white
 * @param {number} count
 * @param {{swizzle?:boolean, srgb?:boolean}} [opts] swizzle (default true) applies the (E,N,U)→(E,U,−N)
 *   Y-up convention used by the COPC/Potree point paths. Pass {swizzle:false} to store positions
 *   verbatim — e.g. splat-centroid tiles, whose source positions are already in the glTF frame
 *   the converter's box transform expects.
 *   srgb (default true): the rgb in `colors` is display-encoded and is linearised on write, as glTF
 *   requires. Pass {srgb:false} only for colours that are already linear (splat centroids).
 * @returns {Promise<Uint8Array>} GLB bytes
 */
export async function buildPointsGlb(posLocal, colors, count, opts = {}) {
  const swizzle = opts.swizzle !== false;
  const doc = new Document(); doc.createBuffer();
  const mesh = doc.createMesh('points');
  const p = doc.createPrimitive().setMode(0 /* POINTS */);
  const positions = new Float32Array(count * 3);
  if (swizzle) for (let i = 0; i < count; i++) { positions[i*3]=posLocal[i*3]; positions[i*3+1]=posLocal[i*3+2]; positions[i*3+2]=-posLocal[i*3+1]; }
  else positions.set(posLocal.subarray(0, count * 3));
  p.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions));
  let col = colors || (() => { const c = new Float32Array(count*4); c.fill(1); return c; })();
  if (colors && opts.srgb !== false) {
    col = Float32Array.from(colors);                 // never mutate the caller's buffer
    for (let i = 0, n = Math.min(count * 4, col.length); i < n; i += 4) {
      col[i] = srgbToLinear(col[i]); col[i+1] = srgbToLinear(col[i+1]); col[i+2] = srgbToLinear(col[i+2]);
    }
  }
  p.setAttribute('COLOR_0', doc.createAccessor().setType('VEC4').setArray(col));
  mesh.addPrimitive(p);
  doc.createScene().addChild(doc.createNode('tile').setMesh(mesh));
  return new NodeIO().writeBinary(doc);
}
