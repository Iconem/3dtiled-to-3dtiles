/**
 * splat-tile.js — the CPU half of a live splat tile (LCC, RAD, streamed SOG, GeoSplats): fetched bytes → GLB, with
 * no network and no cached context, so that it runs the same on the server's thread (the *-live.js modules) and on a
 * tile worker (tile-tasks-splats.js, behind TILED_WORKERS).
 */
import { readFile as readSplatFile, readSog, MemoryReadFileSystem } from '@playcanvas/splat-transform';
import { decodeSplats } from '../lcc-to-3dtiles/src/lccDecode.js';
import { encodeChunkGlb } from '../rad-to-3dtiles/src/index.js';
import { buildSplatTileGlb, computeBounds } from '../core/index.js';

const SH_C0 = 0.28209479177387814;

/** Renderer-ready splat arrays ({ positions, alphas, rgb, scales, rotations }) → the _spz_2 GLB every splat tile here is. */
export const splatArraysGlb = (arrays, count, centroids = false) => buildSplatTileGlb(arrays, count, computeBounds(arrays.positions, count), centroids);

/** One LCC data range (`pts` splats) → GLB. */
export function lccSplatGlb(buf, pts, scaleMin, scaleMax, centroids = false) {
  const { positions, alphas, rgb, scales, rotations } = decodeSplats(buf, 0, pts, scaleMin, scaleMax);
  return splatArraysGlb({ positions, alphas, rgb, scales, rotations }, pts, centroids);
}

/** One RAD chunk → GLB (`local`, `base`: where the chunk sits in `cbuf`, as rad-live.js reads it). */
export async function radChunkGlb(cbuf, local, base, centroids = false) {
  return (await encodeChunkGlb(cbuf, local, base, { centroidsOnly: centroids })).glb;
}

/** One streamed-SOG chunk (its meta.json and WebP files, by name) → the decoded table's columns, as plain typed arrays. */
export async function sogChunkColumns(files) {
  const fileSystem = new MemoryReadFileSystem();
  for (const [name, bytes] of Object.entries(files)) { fileSystem.set(name, bytes); fileSystem.set('./' + name, bytes); }
  const table = (await readSplatFile({ filename: 'meta.json', inputFormat: 'sog', options: {}, params: [], fileSystem }))[0];
  const out = { numRows: table.numRows };
  for (const name of SOG_COLUMNS) { const d = table.getColumnByName(name)?.data; if (d) out[name] = d; }
  return out;
}
const SOG_COLUMNS = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity'];

// readSog yields a PLY-convention DataTable (SH-DC colour, logit opacity, ln scale, quat rot_0=w). Convert
// to the renderer-ready linear arrays buildSplatTileGlb wants and emit a KHR_gaussian_splatting_compression
// _spz_2 GLB — the SAME format every other splat tile in this repo uses (the uncompressed writeGlb variant
// is not read by our viewer's GaussianSplat plugin, which is why those tiles failed to load).
function dataTableToSplatGlb(dt) {
  const n = dt.numRows;
  const col = (nm) => dt.getColumnByName(nm)?.data;
  const x=col('x'), y=col('y'), z=col('z'), op=col('opacity');
  const s0=col('scale_0'), s1=col('scale_1'), s2=col('scale_2');
  const c0=col('f_dc_0'), c1=col('f_dc_1'), c2=col('f_dc_2');
  const r0=col('rot_0'), r1=col('rot_1'), r2=col('rot_2'), r3=col('rot_3');   // rot_0 = w
  const positions=new Float32Array(n*3), alphas=new Float32Array(n), rgb=new Float32Array(n*3), scales=new Float32Array(n*3), rotations=new Float32Array(n*4);
  const cl01=(v)=>v<0?0:v>1?1:v;
  for (let i=0;i<n;i++){
    positions[i*3]=x[i]; positions[i*3+1]=y[i]; positions[i*3+2]=z[i];
    alphas[i]= op ? 1/(1+Math.exp(-op[i])) : 1;                               // logit → [0,1]
    rgb[i*3]  = c0 ? cl01(0.5+SH_C0*c0[i]) : 0.5;                             // SH-DC → linear colour
    rgb[i*3+1]= c1 ? cl01(0.5+SH_C0*c1[i]) : 0.5;
    rgb[i*3+2]= c2 ? cl01(0.5+SH_C0*c2[i]) : 0.5;
    scales[i*3]  = s0 ? Math.exp(s0[i]) : 0.01;                               // ln → linear
    scales[i*3+1]= s1 ? Math.exp(s1[i]) : 0.01;
    scales[i*3+2]= s2 ? Math.exp(s2[i]) : 0.01;
    rotations[i*4]= r1?r1[i]:0; rotations[i*4+1]= r2?r2[i]:0; rotations[i*4+2]= r3?r3[i]:0; rotations[i*4+3]= r0?r0[i]:1;  // xyzw
  }
  return buildSplatTileGlb({ positions, alphas, rgb, scales, rotations }, n, computeBounds(positions, n));
}


/** One MapTiler GeoSplats octant bundle (`files`: [name, size] in the order they are concatenated in `buf`) → GLB. */
export async function geosplatsBundleGlb(buf, files) {
  const fs = new MemoryReadFileSystem();
  let off = 0;
  for (const [name, size] of files) { fs.set(name, buf.subarray(off, off + size)); off += size; }
  return dataTableToSplatGlb(await readSog(fs, 'meta.json'));
}
