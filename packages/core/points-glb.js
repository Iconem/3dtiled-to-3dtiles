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

/*
 * How COLOR_0 is stored. glTF allows float, normalized unsigned short and normalized unsigned byte;
 * VEC4 throughout (a vertex attribute element must be 4-byte aligned, which rules out VEC3 shorts).
 *   u16  8 B/point. Default: lossless for 8-bit sRGB sources (every linearised 8-bit value is a
 *        distinct 16-bit one) and within 1/65535 for 16-bit ones.
 *   u8   4 B/point. Linear in 8 bits: the darkest sRGB values merge (sRGB 0–17 land on 0–1), so
 *        shadows band. For memory-bound clients.
 *   f32  16 B/point. What every tile used to carry.
 * Server-wide default from POINT_COLORS; per request through /stream's &colors=.
 */
export const COLOR_ENCODINGS = ['u16', 'u8', 'f32'];
const envColors = typeof process !== 'undefined' ? process.env?.POINT_COLORS : undefined;
export const DEFAULT_COLOR_ENCODING = COLOR_ENCODINGS.includes(envColors) ? envColors : 'u16';

/** sRGB-encoded [0,1] → linear [0,1] (IEC 61966-2-1). */
export function srgbToLinear(c) {
  return SRGB_TO_LINEAR[Math.round((c <= 0 ? 0 : c >= 1 ? 1 : c) * 65535)];
}

/** The scalar attributes a tile may carry, by the name a client asks for them. */
export const POINT_ATTRIBUTES = { intensity: '_INTENSITY', classification: '_CLASSIFICATION' };

/**
 * Which of a source's scalar attributes go into a tile. `spec` is what the client asked for: a comma list of
 * `intensity` and `classification`, or `all`; nothing asked means none, so a tile stays as light as its points and
 * colours (each adds 4 bytes a point: glTF aligns vertex attributes to 4 bytes). Names the source lacks are simply absent.
 * @param {Record<string, ArrayLike<number>>|null|undefined} all the source's attributes, by glTF name
 * @param {string|null|undefined} spec
 */
export function pickAttributes(all, spec) {
  if (!all || !spec) return {};
  const names = new Set(spec.split(',').map((s) => s.trim().toLowerCase()));
  const every = names.has('all') || names.has('1') || names.has('true');
  const wanted = Object.entries(POINT_ATTRIBUTES).filter(([n]) => every || names.has(n)).map(([, k]) => k);
  return Object.fromEntries(wanted.filter((k) => all[k]).map((k) => [k, all[k]]));
}

/**
 * @param {Float32Array} posLocal interleaved (E,N,U) dataset coords, tile-local
 * @param {Float32Array|null} colors interleaved rgba [0,1], or null → white
 * @param {number} count
 * @param {{swizzle?:boolean, srgb?:boolean, colors?:'u16'|'u8'|'f32'}} [opts] swizzle (default true) applies the (E,N,U)→(E,U,−N)
 *   Y-up convention used by the COPC/Potree point paths. Pass {swizzle:false} to store positions
 *   verbatim — e.g. splat-centroid tiles, whose source positions are already in the glTF frame
 *   the converter's box transform expects.
 *   srgb (default true): the rgb in `colors` is display-encoded and is linearised on write, as glTF
 *   requires. Pass {srgb:false} only for colours that are already linear (splat centroids).
 *   colors: COLOR_0 storage (see COLOR_ENCODINGS above), default DEFAULT_COLOR_ENCODING.
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
  const enc = COLOR_ENCODINGS.includes(opts.colors) ? opts.colors : DEFAULT_COLOR_ENCODING;
  const acc = doc.createAccessor().setType('VEC4');
  if (enc === 'f32') acc.setArray(col);
  else {
    const max = enc === 'u8' ? 255 : 65535, n = count * 4;
    const out = enc === 'u8' ? new Uint8Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.round(col[i] * max);
    acc.setArray(out).setNormalized(true);
  }
  p.setAttribute('COLOR_0', acc);
  // Scalar point attributes the source carries, as glTF custom attributes (`_INTENSITY` as the LAS uint16, `_CLASSIFICATION`
  // as the LAS uint8, raw and not normalized): a client that reads them (Blender, QGIS, a style) ramps them itself, and one
  // that does not ignores them. Intensity is not turned into COLOR_0: its range is scanner-specific, so a fixed mapping is wrong.
  for (const [name, arr] of Object.entries(opts.attributes ?? {})) {
    if (!arr || arr.length < count) continue;
    p.setAttribute(name, doc.createAccessor().setType('SCALAR').setArray(arr.length === count ? arr : arr.subarray(0, count)));
  }
  mesh.addPrimitive(p);
  doc.createScene().addChild(doc.createNode('tile').setMesh(mesh));
  return new NodeIO().writeBinary(doc);
}
