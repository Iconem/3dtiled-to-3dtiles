/**
 * tile-task.js (i3s-to-3dtiles) — one I3S node → its GLB file, as the converter's thread or a tile worker runs it
 * (core's convertTiles). It reads the node's geometry and texture itself, so nothing but the task's description
 * crosses threads, and hands back the box of what it wrote: the converter nests the tile tree from those.
 */
import fs from 'fs/promises';
import { decodeDefaultGeometry, readMaybeGzip, geodeticToEcef } from './i3sParse.js';
import { buildGlb } from './glbBuild.js';

/**
 * @param a { inDir, idx, res (geometry resource id), bufIdx, schema, isGeographic, isPoint, center (the node's OBB
 *            centre), originEcef, EAST, NORTH, UP (the tileset's one ENU frame), hasMaterial,
 *            texture: { resource, name, ext, mimeType } | null (null: no browser-native raster format on offer), outPath }
 * @returns { found, written, textureSkipped, aabb: {min,max} | null } — `aabb` in the tileset's ENU frame
 */
export async function i3sNodeToFile({ inDir, res, bufIdx, schema, isGeographic, isPoint, center, originEcef, EAST, NORTH, UP, hasMaterial, texture: tex, outPath }) {
  const buf = await readMaybeGzip(inDir, `nodes/${res}/geometries/${bufIdx}.bin`)
    .catch(() => readMaybeGzip(inDir, `geometries/${res}.bin`).catch(() => null));
  if (!buf) return { found: false, written: false, textureSkipped: false, aabb: null };
  const g = decodeDefaultGeometry(buf, schema);
  if (!(g.vertexCount > 0)) return { found: true, written: false, textureSkipped: false, aabb: null };

  const toEnu = (e) => { const dx=e[0]-originEcef[0], dy=e[1]-originEcef[1], dz=e[2]-originEcef[2];
    return [dx*EAST[0]+dy*EAST[1]+dz*EAST[2], dx*NORTH[0]+dy*NORTH[1]+dz*NORTH[2], dx*UP[0]+dy*UP[1]+dz*UP[2]]; };
  const aabb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const expand = (x, y, z) => { const a = aabb; if (x<a.min[0])a.min[0]=x; if(y<a.min[1])a.min[1]=y; if(z<a.min[2])a.min[2]=z; if(x>a.max[0])a.max[0]=x; if(y>a.max[1])a.max[1]=y; if(z>a.max[2])a.max[2]=z; };

  // I3S geographic vertices = (Δlon°, Δlat°, Δheight_m) rel. to the node OBB centre →
  // per-vertex geodetic → ECEF → local ENU metres (East,North,Up). The bounding box is stored
  // in the tileset ENU frame (E,N,U); the glTF POSITION is pre-swizzled to (E, U, −N) so the
  // renderer's glTF-Y-up → tileset-Z-up RX(+90°) yields (E,N,U), and the root ENU→ECEF transform
  // places it upright on the globe. (Storing ECEF axes instead left content tilted ~40° vs the
  // local horizon — the "boxes rotated / plane perpendicular to ground" artefact.)
  let positions = g.position;
  if (isGeographic) {
    const c = center;
    positions = new Float32Array(g.vertexCount * 3);
    for (let i = 0; i < g.vertexCount; i++) {
      const e = geodeticToEcef([c[0] + g.position[i*3], c[1] + g.position[i*3+1], c[2] + g.position[i*3+2]]);
      const u = toEnu(e);                                  // (East, North, Up) — tileset frame
      expand(u[0], u[1], u[2]);                            // box in tileset ENU frame
      positions[i*3] = u[0]; positions[i*3+1] = u[2]; positions[i*3+2] = -u[1];  // glTF: (E, U, −N)
    }
  } else {
    for (let i = 0; i < g.vertexCount; i++) expand(positions[i*3], positions[i*3+1], positions[i*3+2]);
  }
  let texture;
  if (hasMaterial && tex) {
    // Real extension, not a generic `.bin` — a texture's on-disk/in-archive name carries its
    // actual format (`.jpg`/`.png`), unlike geometry (always literally `<n>.bin`). See
    // i3s-live.js's serveTileGlb for the live-mode verification of this.
    try { texture = { bytes: await readMaybeGzip(inDir, `nodes/${tex.resource}/textures/${tex.name}.${tex.ext}`), mimeType: tex.mimeType }; }
    catch { /* texture resource missing — fall back to untextured */ }
  }
  const glb = await buildGlb({ mode: isPoint ? 'POINTS' : 'TRIANGLES', positions, normals: g.normal, colors: g.color, uvs: g.uv0, texture });
  await fs.writeFile(outPath, glb);
  return { found: true, written: true, textureSkipped: hasMaterial && !tex, aabb };
}
