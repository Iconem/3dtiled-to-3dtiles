/**
 * @3dtiled/core — SPZ v2 encoder + KHR_gaussian_splatting_compression_spz_2 GLB writer.
 *
 * Canonical, deduplicated copy (was copied into rad/sog/lcc). Byte-identical to SparkJS's
 * SpzWriter; SPZ **v2** (3-byte "first-three" rotations — what the _spz_2 extension is locked to).
 *
 * Parallelism: `buildSpzBuffer` is **async** and uses `zlib.gzip` (libuv threadpool, off the main
 * thread) instead of `gzipSync`, so many tiles gzipped via `parallelMap` run concurrently.
 *
 * Inputs are renderer-ready linear values: positions xyz, alphas[0,1], rgb[0,1], scales (linear),
 * rotations (unit quaternion xyzw). Pass null for missing channels.
 */
import zlib from 'zlib';
import { promisify } from 'util';
import { isMainThread } from 'node:worker_threads';
import { buildPointsGlb } from './points-glb.js';

// On the main thread gzip goes to libuv's pool so many tiles compress at once. A tile worker is a thread of its own,
// and the pool (4 threads, shared by the whole process) would only queue its tiles behind every other worker's: it
// compresses in place. Same bytes.
const gzip = isMainThread ? promisify(zlib.gzip) : async (buf) => zlib.gzipSync(buf);

const SPZ_MAGIC = 0x5053474E, SPZ_VERSION = 2, SH_C0 = 0.28209479177387814;
const SPZ_FRAC_BITS = 12, SPZ_FRACTION = 1 << SPZ_FRAC_BITS;

const clamp255 = v => Math.max(0, Math.min(255, Math.round(v)));
function writeInt24LE(buf, o, v) { const u = v & 0xFFFFFF; buf[o]=u&0xFF; buf[o+1]=(u>>8)&0xFF; buf[o+2]=(u>>16)&0xFF; }
const scaleRgb = r => clamp255(((r - 0.5) / (SH_C0 / 0.15) + 0.5) * 255);
const encodeScaleVal = s => s <= 0 ? 0 : clamp255((Math.log(s) + 10.0) * 16.0);
function encodeQuat(buf, o, qx, qy, qz, qw) {
  const len = Math.sqrt(qx*qx+qy*qy+qz*qz+qw*qw) || 1;
  let x=qx/len, y=qy/len, z=qz/len; if (qw < 0) { x=-x; y=-y; z=-z; }
  buf[o]=clamp255(x*127.5+127.5); buf[o+1]=clamp255(y*127.5+127.5); buf[o+2]=clamp255(z*127.5+127.5);
}

/** Build the gzip-compressed SPZ v2 payload (19 bytes/splat). Async (parallel-friendly gzip). */
export async function buildSpzBuffer(positions, alphas, rgb, scales, rotations, count) {
  const raw = Buffer.alloc(16 + count * 19);
  raw.writeUInt32LE(SPZ_MAGIC, 0); raw.writeUInt32LE(SPZ_VERSION, 4); raw.writeUInt32LE(count, 8);
  raw.writeUInt8(0, 12); raw.writeUInt8(SPZ_FRAC_BITS, 13); raw.writeUInt8(0, 14); raw.writeUInt8(0, 15);
  const posB=16, aB=16+count*9, gB=16+count*10, sB=16+count*13, rB=16+count*16, MAX=8388607;
  for (let i = 0; i < count; i++) {
    writeInt24LE(raw, posB+i*9,   Math.max(-MAX, Math.min(MAX, Math.round(positions[i*3]   * SPZ_FRACTION))));
    writeInt24LE(raw, posB+i*9+3, Math.max(-MAX, Math.min(MAX, Math.round(positions[i*3+1] * SPZ_FRACTION))));
    writeInt24LE(raw, posB+i*9+6, Math.max(-MAX, Math.min(MAX, Math.round(positions[i*3+2] * SPZ_FRACTION))));
    raw[aB+i] = clamp255((alphas ? alphas[i] : 1) * 255);
    raw[gB+i*3]=scaleRgb(rgb?rgb[i*3]:0.5); raw[gB+i*3+1]=scaleRgb(rgb?rgb[i*3+1]:0.5); raw[gB+i*3+2]=scaleRgb(rgb?rgb[i*3+2]:0.5);
    raw[sB+i*3]=encodeScaleVal(scales?scales[i*3]:0.01); raw[sB+i*3+1]=encodeScaleVal(scales?scales[i*3+1]:0.01); raw[sB+i*3+2]=encodeScaleVal(scales?scales[i*3+2]:0.01);
    encodeQuat(raw, rB+i*3, rotations?rotations[i*4]:0, rotations?rotations[i*4+1]:0, rotations?rotations[i*4+2]:0, rotations?rotations[i*4+3]:1);
  }
  return gzip(raw);
}

export function computeBounds(positions, count) {
  let a=Infinity,b=Infinity,c=Infinity,d=-Infinity,e=-Infinity,f=-Infinity;
  for (let i=0;i<count;i++){const x=positions[i*3],y=positions[i*3+1],z=positions[i*3+2];if(!isFinite(x))continue;if(x<a)a=x;if(x>d)d=x;if(y<b)b=y;if(y>e)e=y;if(z<c)c=z;if(z>f)f=z;}
  if(!isFinite(a)||!isFinite(d)) return {minX:0,minY:0,minZ:0,maxX:0,maxY:0,maxZ:0,cx:0,cy:0,cz:0,hx:0.001,hy:0.001,hz:0.001};
  return {minX:a,minY:b,minZ:c,maxX:d,maxY:e,maxZ:f,cx:(a+d)/2,cy:(b+e)/2,cz:(c+f)/2,hx:Math.max((d-a)/2,0.001),hy:Math.max((e-b)/2,0.001),hz:Math.max((f-c)/2,0.001)};
}

/**
 * Emit one splat tile's GLB — either the KHR_gaussian_splatting SPZ-v2 GLB (default) or, when
 * `centroidsOnly` is set, a plain glTF **POINTS** GLB of the splat centroids (POSITION + COLOR_0,
 * dropping scale/rotation/opacity-as-gaussian). Positions are stored verbatim (no swizzle) so the
 * centroid tile occupies the exact same frame as the SPZ tile — the converter's existing box
 * transform applies unchanged. Lets point-cloud-only 3D Tiles renderers display splat scenes.
 *
 * @param {{positions:Float32Array, alphas:?Float32Array, rgb:?Float32Array, scales:?Float32Array, rotations:?Float32Array}} arrays
 * @param {number} count
 * @param {object} bounds  result of computeBounds(positions, count)
 * @param {boolean} [centroidsOnly=false]
 * @returns {Promise<Uint8Array|Buffer>} GLB bytes
 */
export async function buildSplatTileGlb(arrays, count, bounds, centroidsOnly = false) {
  const { positions, alphas, rgb, scales, rotations } = arrays;
  if (centroidsOnly) {
    const colors = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      colors[i*4]   = rgb ? rgb[i*3]   : 1;
      colors[i*4+1] = rgb ? rgb[i*3+1] : 1;
      colors[i*4+2] = rgb ? rgb[i*3+2] : 1;
      colors[i*4+3] = alphas ? alphas[i] : 1;
    }
    return buildPointsGlb(positions, colors, count, { swizzle: false, srgb: false });   // inputs are already linear
  }
  return buildSpzGlb(await buildSpzBuffer(positions, alphas, rgb, scales, rotations, count), count, bounds);
}

/** Assemble a KHR_gaussian_splatting_compression_spz_2 GLB from a gzipped SPZ payload. */
export function buildSpzGlb(spzBuf, count, bounds) {
  const gltf = {
    asset:{version:'2.0'},
    extensionsUsed:['KHR_materials_unlit','KHR_gaussian_splatting','KHR_gaussian_splatting_compression_spz_2'],
    extensionsRequired:['KHR_gaussian_splatting','KHR_gaussian_splatting_compression_spz_2'],
    buffers:[{byteLength:spzBuf.byteLength}], bufferViews:[{buffer:0,byteOffset:0,byteLength:spzBuf.byteLength}],
    accessors:[{componentType:5126,count,type:'VEC3',min:[bounds.minX,bounds.minY,bounds.minZ],max:[bounds.maxX,bounds.maxY,bounds.maxZ]},
      {componentType:5121,normalized:true,count,type:'VEC4'},{componentType:5126,count,type:'VEC3'},{componentType:5126,count,type:'VEC4'}],
    materials:[{extensions:{KHR_materials_unlit:{}}}],
    meshes:[{primitives:[{attributes:{POSITION:0,COLOR_0:1,'KHR_gaussian_splatting:SCALE':2,'KHR_gaussian_splatting:ROTATION':3},material:0,mode:0,
      extensions:{KHR_gaussian_splatting:{extensions:{KHR_gaussian_splatting_compression_spz_2:{bufferView:0}}}}}]}],
    nodes:[{mesh:0}], scenes:[{nodes:[0]}], scene:0,
  };
  const j=JSON.stringify(gltf); const jBuf=Buffer.concat([Buffer.from(j,'utf8'),Buffer.alloc((4-(j.length%4))%4,0x20)]);
  const bBuf=Buffer.concat([spzBuf,Buffer.alloc((4-(spzBuf.byteLength%4))%4,0)]);
  const total=12+8+jBuf.byteLength+8+bBuf.byteLength; const glb=Buffer.alloc(total); let o=0;
  glb.writeUInt32LE(0x46546C67,o);o+=4; glb.writeUInt32LE(2,o);o+=4; glb.writeUInt32LE(total,o);o+=4;
  glb.writeUInt32LE(jBuf.byteLength,o);o+=4; glb.writeUInt32LE(0x4E4F534A,o);o+=4; jBuf.copy(glb,o);o+=jBuf.byteLength;
  glb.writeUInt32LE(bBuf.byteLength,o);o+=4; glb.writeUInt32LE(0x004E4942,o);o+=4; bBuf.copy(glb,o);
  return glb;
}
