/**
 * glbWriter.js  (copc-to-3dtiles)
 *
 * Writes a COPC point data view as a glTF 2.0 GLB POINTS primitive.
 * Uses gltf-transform v4 with raw typed arrays via setArray().
 *
 * Points are stored in tile-local coordinates (subtract tile centre)
 * to keep float32 precision. The global offset is in the tileset.json
 * root transform.
 *
 * Attributes emitted:
 *   POSITION   Float32Array  VEC3   required
 *   COLOR_0    Float32Array  VEC4   if Red/Green/Blue present (normalised [0,1])
 *   _INTENSITY Uint16Array   SCALAR if Intensity present and no color
 *   _CLASSIFICATION Uint8Array SCALAR if Classification present
 *   _RETURN_NUMBER  Uint8Array SCALAR if ReturnNumber present
 */

import { Document, NodeIO } from '@gltf-transform/core';
import { srgbToLinear } from '../../core/index.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * @param {object}   view        COPC point data view
 * @param {number[]} tileCenter  [cx, cy, cz] in dataset CRS
 * @param {string}   outputPath
 */
export async function writeTileGlb(view, tileCenter, outputPath) {
  const count = view.pointCount;
  if (count === 0) return;

  const dims = view.dimensions;
  const [cx, cy, cz] = tileCenter;

  const doc = new Document();
  doc.createBuffer(); // required by gltf-transform v4 before writing binary

  const mesh = doc.createMesh('points');
  const prim = doc.createPrimitive().setMode(0 /* POINTS */);

  // ── POSITION ──────────────────────────────────────────────────────────────
  const positions = new Float32Array(count * 3);
  const getX = view.getter('X');
  const getY = view.getter('Y');
  const getZ = view.getter('Z');
  // glTF 2.0 is Y-up right-handed.  CesiumJS applies RX(+90°) to convert glTF
  // content to 3D Tiles Z-up local space: (x,y,z) → (x,−z,y).
  // To get (East_rel, North_rel, Up_rel) in 3D Tiles space we must pre-rotate
  // by RX(−90°): store (East, Up, −North) so that after CesiumJS's correction:
  //   (East, Up, −North) → (East, North, Up)  ✓
  for (let i = 0; i < count; i++) {
    positions[i * 3]     =  getX(i) - cx;  // East   → glTF X
    positions[i * 3 + 1] =  getZ(i) - cz;  // Up     → glTF Y  (Y-up)
    positions[i * 3 + 2] = -(getY(i) - cy); // −North → glTF Z
  }
  prim.setAttribute('POSITION',
    doc.createAccessor().setType('VEC3').setArray(positions));

  // ── COLOR_0 ───────────────────────────────────────────────────────────────
  // Priority: RGB → intensity-as-grey → flat white.
  // Always written as Float32 VEC4 so CesiumJS picks it up without a style rule.
  {
    const colors = new Float32Array(count * 4);
    if (dims.Red && dims.Green && dims.Blue) {
      const getR = view.getter('Red');
      const getG = view.getter('Green');
      const getB = view.getter('Blue');
      // LAS RGB is uint16 (0–65535) or uint8 depending on point format
      const scale = dims.Red.size === 2 ? 1 / 65535 : 1 / 255;
      for (let i = 0; i < count; i++) {
        colors[i * 4]     = getR(i) * scale;
        colors[i * 4 + 1] = getG(i) * scale;
        colors[i * 4 + 2] = getB(i) * scale;
        colors[i * 4 + 3] = 1.0;
      }
    } else if (dims.Intensity) {
      const getI = view.getter('Intensity');
      // Uint16 intensity → normalised grey  [0,1]
      for (let i = 0; i < count; i++) {
        const g = getI(i) / 65535;
        colors[i * 4]     = g;
        colors[i * 4 + 1] = g;
        colors[i * 4 + 2] = g;
        colors[i * 4 + 3] = 1.0;
      }
    } else {
      colors.fill(1.0); // white
    }
    // glTF COLOR_0 is linear; LAS RGB (and the intensity-as-grey display mapping) is sRGB-encoded.
    // Same fix as core/points-glb.js — without it every spec-following client renders washed out.
    for (let i = 0; i < count * 4; i += 4) {
      colors[i] = srgbToLinear(colors[i]); colors[i + 1] = srgbToLinear(colors[i + 1]); colors[i + 2] = srgbToLinear(colors[i + 2]);
    }
    prim.setAttribute('COLOR_0',
      doc.createAccessor().setType('VEC4').setArray(colors));
  }

  mesh.addPrimitive(prim);
  doc.createScene().addChild(doc.createNode('tile').setMesh(mesh));

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const io = new NodeIO();
  // writeBinary returns Uint8Array in gltf-transform v4
  const glb = await io.writeBinary(doc);
  await fs.writeFile(outputPath, glb);
}
