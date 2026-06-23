/**
 * glbWriter.js (potree-to-3dtiles)
 *
 * Writes a point set as a glTF 2.0 GLB POINTS primitive (POSITION + COLOR_0).
 * Inputs are tile-LOCAL world coords (caller subtracts the tile centre for float32
 * precision; the centre goes into the tile transform). Same Y-up convention as the
 * COPC path: store (East, Up, −North) so CesiumJS's glTF→Z-up RX(+90°) yields
 * (East, North, Up).
 */
import { Document, NodeIO } from '@gltf-transform/core';
import fs from 'fs/promises';
import path from 'path';

/**
 * @param {Float32Array} posLocal  interleaved (x,y,z) in dataset CRS, already tile-local
 * @param {Float32Array|null} colors  interleaved rgba [0,1], or null → white
 * @param {number} count
 * @param {string} outputPath
 */
export async function writePointsGlb(posLocal, colors, count, outputPath) {
  const doc = new Document();
  doc.createBuffer();
  const mesh = doc.createMesh('points');
  const prim = doc.createPrimitive().setMode(0 /* POINTS */);

  // (East, Up, −North): dataset (x=E, y=N, z=U) → glTF (x, z, −y)
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i*3]   =  posLocal[i*3];
    positions[i*3+1] =  posLocal[i*3+2];
    positions[i*3+2] = -posLocal[i*3+1];
  }
  prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions));

  const col = colors || (() => { const c = new Float32Array(count*4); c.fill(1); return c; })();
  prim.setAttribute('COLOR_0', doc.createAccessor().setType('VEC4').setArray(col));

  mesh.addPrimitive(prim);
  doc.createScene().addChild(doc.createNode('tile').setMesh(mesh));
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const glb = await new NodeIO().writeBinary(doc);
  await fs.writeFile(outputPath, glb);
}
