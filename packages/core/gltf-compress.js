/**
 * gltf-compress.js — on-the-fly glTF/GLB *encoding* (the compress half of the per-tile pipeline).
 *
 * The mirror of gltf-decompress.js: where that DECODES draco/meshopt/KTX2 for renderers that lack the
 * transcoders, this ENCODES them to shrink tiles over the wire. The big wins, measured:
 *   • EXT_meshopt_compression  → ~37% of raw  (works on POINTS — the right choice for COPC/Potree
 *                                 point-cloud stream tiles, which have no indices)
 *   • KHR_draco_mesh_compression → meshes only (Draco skips non-indexed/POINTS primitives — a no-op
 *                                 for point clouds, useful for b3dm/glTF mesh tiles)
 *   • KHR_texture_basisu (KTX2)  → textures, ETC1S (default) or UASTC, IN-PROCESS via the `ktx2-encoder`
 *                                 WASM basis encoder + our pngjs/jpeg-js source decoder — NO native
 *                                 `toktx` binary (the route gltf-transform's CLI would otherwise force).
 *
 *   const { glb, encoded } = await compressGlb(buf, { meshopt:true });        // default for point tiles
 *   const { glb }          = await compressGlb(buf, { draco:true });          // mesh geometry
 *   const { glb }          = await compressGlb(buf, { ktx:true });            // textures → KTX2 ETC1S
 *   const { glb }          = await compressGlb(buf, { ktx:true, uastc:true }); // textures → KTX2 UASTC
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { draco as dracoFn, meshopt as meshoptFn } from '@gltf-transform/functions';
import { ktx2 as ktx2Fn } from 'ktx2-encoder/gltf-transform';
import draco3d from 'draco3dgltf';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

// KTX2 encode needs raw RGBA; `ktx2-encoder` requires an imageDecoder in Node (no browser ImageDecoder).
// Decode the source PNG/JPEG with the pure-JS codecs we already ship (no sharp/native).
const imageDecoder = (b) => {
  if (b[0] === 0x89 && b[1] === 0x50) { const p = PNG.sync.read(Buffer.from(b)); return Promise.resolve({ width: p.width, height: p.height, data: new Uint8Array(p.data) }); }
  const j = jpeg.decode(Buffer.from(b), { useTArray: true, formatAsRGBA: true });
  return Promise.resolve({ width: j.width, height: j.height, data: new Uint8Array(j.data) });
};

// ── lazy singletons ──────────────────────────────────────────────────────────────
let _meshoptIO = null;
async function meshoptIO() {
  if (_meshoptIO) return _meshoptIO;
  await MeshoptEncoder.ready; await MeshoptDecoder.ready;
  _meshoptIO = new NodeIO().registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
  return _meshoptIO;
}
let _dracoIO = null;
async function dracoIO() {
  if (_dracoIO) return _dracoIO;
  _dracoIO = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'draco3d.decoder': await draco3d.createDecoderModule(),
  });
  return _dracoIO;
}
// A reader that can decode anything already compressed (so we can re-encode mixed inputs).
let _readIO = null;
async function readIO() {
  if (_readIO) return _readIO;
  await MeshoptDecoder.ready;
  _readIO = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'meshopt.decoder': MeshoptDecoder,
  });
  return _readIO;
}

/**
 * Encode a GLB. `opts`: { meshopt?, draco?, ktx?, uastc? }.
 *   - geometry: `draco` (mesh primitives only) OR `meshopt` (everything incl. POINTS). `meshopt` is the
 *     default ONLY when no other op is requested.
 *   - textures: `ktx` → KHR_texture_basisu (ETC1S by default; `uastc:true` for UASTC), in-process WASM.
 * ktx composes with a geometry op (e.g. {draco:true, ktx:true}).
 * @returns {Promise<{glb:Buffer, encoded:{meshopt:boolean,draco:boolean,ktx:number}}>}
 */
export async function compressGlb(buf, opts = {}) {
  const { draco = false, ktx = false, uastc = false } = opts;
  const meshopt = opts.meshopt ?? (!draco && !ktx);      // default geometry op only if nothing else asked
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const reader = await readIO();
  const doc = await reader.readBinary(bytes);
  const encoded = { meshopt: false, draco: false, ktx: 0 };

  // Textures first (independent of geometry): PNG/JPEG → KTX2 via the WASM basis encoder.
  if (ktx) {
    try {
      await doc.transform(ktx2Fn({ imageDecoder, isUASTC: !!uastc }));
      encoded.ktx = doc.getRoot().listTextures().filter(t => t.getMimeType() === 'image/ktx2').length;
    } catch (e) { console.warn('[gltf-compress] KTX2 encode failed:', e.message); }
  }
  // Geometry: draco (mesh) OR meshopt (general). Apply at most one; both target the same primitives.
  if (draco) {
    await doc.transform(dracoFn());
    encoded.draco = true;
    return { glb: Buffer.from(await (await dracoIO()).writeBinary(doc)), encoded };
  }
  if (meshopt) {
    await doc.transform(meshoptFn({ encoder: MeshoptEncoder }));
    encoded.meshopt = true;
    return { glb: Buffer.from(await (await meshoptIO()).writeBinary(doc)), encoded };
  }
  // ktx-only (or no-op) → write with a plain ALL_EXTENSIONS IO (includes KHR_texture_basisu for output).
  return { glb: Buffer.from(await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(doc)), encoded };
}
