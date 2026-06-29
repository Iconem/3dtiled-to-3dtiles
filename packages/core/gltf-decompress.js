/**
 * gltf-decompress.js — on-the-fly glTF/GLB decompression via glTF-Transform.
 *
 * Decodes the three compressed payloads a mesh tile commonly ships with, for renderers/pipelines that
 * lack the transcoders:
 *   • KHR_draco_mesh_compression   → raw geometry      (draco3dgltf WASM decoder)
 *   • EXT_meshopt_compression      → raw geometry      (meshoptimizer WASM decoder)
 *   • KHR_texture_basisu (KTX2)    → PNG textures       (Basis transcoder + pngjs, NO sharp)
 *
 * No `sharp`/libvips — KTX2 is transcoded to RGBA via the Basis WASM transcoder (shipped with `three`)
 * and PNG-encoded with pure-JS `pngjs`. This is the "decompress" half of the planned generic per-tile
 * glTF-Transform pipeline tool; encode ops (draco/ktx2/webp/simplify…) are a later addition.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder } from 'meshoptimizer';
import { PNG } from 'pngjs';

const require = createRequire(import.meta.url);

// ── lazy singletons ────────────────────────────────────────────────────────────
let _decodeIO = null;
async function decodeIO() {
  if (_decodeIO) return _decodeIO;
  await MeshoptDecoder.ready;
  _decodeIO = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'meshopt.decoder': MeshoptDecoder,
  });
  return _decodeIO;
}
// A plain writer with no encoder dependencies → geometry is serialized uncompressed.
const writeIO = () => new NodeIO().registerExtensions(ALL_EXTENSIONS);

let _basis = null;
async function basisModule() {
  if (_basis) return _basis;
  // `three` is an ESM package, so `require()` of this UMD emscripten file yields {} (its
  // `module.exports = BASIS` is dead in ESM). Load it by evaluating the source in a CJS shim; pass
  // __dirname so emscripten locates `basis_transcoder.wasm` beside it.
  const file = require.resolve('three/examples/jsm/libs/basis/basis_transcoder.js');
  const src = readFileSync(file, 'utf8');
  const shim = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', '__filename', '__dirname', src)(
    shim, shim.exports, require, file, dirname(file));
  const BASIS = shim.exports;
  if (typeof BASIS !== 'function') throw new Error('basis_transcoder load failed (not a factory)');
  const mod = await BASIS();          // emscripten factory → Module (after ready)
  mod.initializeBasis();
  _basis = mod;
  return mod;
}

const cTFRGBA32 = 13;   // basis transcoder_texture_format: uncompressed RGBA8888

/** KTX2 bytes → PNG bytes (RGBA via Basis transcode, level 0 / layer 0 / face 0). */
async function ktx2ToPng(ktx2Bytes) {
  const mod = await basisModule();
  const file = new mod.KTX2File(ktx2Bytes);
  try {
    if (!file.startTranscoding()) throw new Error('KTX2File.startTranscoding failed');
    const w = file.getWidth(), h = file.getHeight();
    const size = file.getImageTranscodedSizeInBytes(0, 0, 0, cTFRGBA32);   // (level, layer, face, format)
    const rgba = new Uint8Array(size);
    if (!file.transcodeImage(rgba, 0, 0, 0, cTFRGBA32, 0, -1, -1)) throw new Error('KTX2File.transcodeImage failed');
    const png = new PNG({ width: w, height: h });
    png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    return { png: PNG.sync.write(png), w, h };
  } finally {
    file.close(); file.delete();
  }
}

/**
 * Decompress a GLB buffer. Returns a new (uncompressed) GLB Buffer.
 * @param {Buffer|Uint8Array} buf
 * @param {{draco?:boolean, meshopt?:boolean, ktx?:boolean}} [opts]  (all default true)
 * @returns {Promise<{glb:Buffer, decoded:{draco:boolean,meshopt:boolean,ktx:number}}>}
 */
export async function decompressGlb(buf, opts = {}) {
  const { draco = true, meshopt = true, ktx = true } = opts;
  const io = await decodeIO();
  const doc = await io.readBinary(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  const decoded = { draco: false, meshopt: false, ktx: 0 };

  // Geometry: read() already decoded Draco/Meshopt into accessors. Dispose the extensions so the
  // plain writer emits uncompressed geometry (no encoder needed, no re-compress round-trip).
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    const n = ext.extensionName;
    if (draco && n === 'KHR_draco_mesh_compression') { ext.dispose(); decoded.draco = true; }
    else if (meshopt && n === 'EXT_meshopt_compression') { ext.dispose(); decoded.meshopt = true; }
  }

  // Textures: transcode each KTX2 image to PNG, then drop the KHR_texture_basisu extension.
  if (ktx) {
    for (const tex of doc.getRoot().listTextures()) {
      if (tex.getMimeType() !== 'image/ktx2') continue;
      const img = tex.getImage();
      if (!img) continue;
      try {
        const { png } = await ktx2ToPng(img instanceof Uint8Array ? img : new Uint8Array(img));
        tex.setImage(png); tex.setMimeType('image/png');
        if (!tex.getURI || !tex.getURI()) { /* embedded — fine */ } else tex.setURI(tex.getURI().replace(/\.ktx2$/i, '.png'));
        decoded.ktx++;
      } catch (e) { console.warn('[gltf-decompress] KTX2 decode failed for a texture:', e.message); }
    }
    const bu = doc.getRoot().listExtensionsUsed().find(e => e.extensionName === 'KHR_texture_basisu');
    if (bu && decoded.ktx > 0) bu.dispose();
  }

  const glb = Buffer.from(await writeIO().writeBinary(doc));
  return { glb, decoded };
}
