/**
 * @3dtiled/core — glTF POINTS GLB writer (point clouds). POSITION + COLOR_0.
 * Inputs are tile-local coords; Y-up convention (store East, Up, −North) so CesiumJS's
 * glTF→Z-up RX(+90°) yields (East, North, Up). Returns the GLB bytes (caller writes/queues).
 */
import { Document, NodeIO } from '@gltf-transform/core';

/**
 * @param {Float32Array} posLocal interleaved (E,N,U) dataset coords, tile-local
 * @param {Float32Array|null} colors interleaved rgba [0,1], or null → white
 * @param {number} count
 * @param {{swizzle?:boolean}} [opts] swizzle (default true) applies the (E,N,U)→(E,U,−N) Y-up
 *   convention used by the COPC/Potree point paths. Pass {swizzle:false} to store positions
 *   verbatim — e.g. splat-centroid tiles, whose source positions are already in the glTF frame
 *   the converter's box transform expects.
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
  const col = colors || (() => { const c = new Float32Array(count*4); c.fill(1); return c; })();
  p.setAttribute('COLOR_0', doc.createAccessor().setType('VEC4').setArray(col));
  mesh.addPrimitive(p);
  doc.createScene().addChild(doc.createNode('tile').setMesh(mesh));
  return new NodeIO().writeBinary(doc);
}
