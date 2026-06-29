/**
 * gltf-compress.js — on-the-fly glTF/GLB *encoding* (the compress half of the per-tile pipeline).
 *
 * The mirror of gltf-decompress.js: where that DECODES draco/meshopt/KTX2 for renderers that lack the
 * transcoders, this ENCODES them to shrink tiles over the wire. The big wins, measured:
 *   • EXT_meshopt_compression  → ~37% of raw  (works on POINTS — the right choice for COPC/Potree
 *                                 point-cloud stream tiles, which have no indices)
 *   • KHR_draco_mesh_compression → meshes only (Draco skips non-indexed/POINTS primitives — a no-op
 *                                 for point clouds, useful for b3dm/glTF mesh tiles)
 *
 * KTX2 *encode* needs the native `toktx`/`ktx` binary (no in-process WASM encoder ships with
 * gltf-transform), so it is intentionally NOT wired here — decode stays in-process (Basis+pngjs in
 * gltf-decompress.js), encode is a documented future add when a native binary is acceptable.
 *
 *   const { glb, encoded } = await compressGlb(buf, { meshopt:true });   // default for point tiles
 *   const { glb }          = await compressGlb(buf, { draco:true });     // mesh tiles
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { draco as dracoFn, meshopt as meshoptFn } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';

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
 * Encode a GLB's geometry. `opts`: { meshopt?, draco? }. meshopt is the default — it compresses POINTS
 * (point clouds) as well as meshes; draco only compresses indexed (mesh) primitives.
 * @returns {Promise<{glb:Buffer, encoded:{meshopt:boolean,draco:boolean}}>}
 */
export async function compressGlb(buf, opts = {}) {
  const { meshopt = !opts.draco, draco = false } = opts;
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const reader = await readIO();
  const doc = await reader.readBinary(bytes);
  const encoded = { meshopt: false, draco: false };

  // Draco first (mesh primitives), then meshopt (everything, incl. POINTS). They target the same
  // primitives, so apply only one per request to avoid double-encoding; meshopt is the general choice.
  if (draco) {
    await doc.transform(dracoFn());
    encoded.draco = true;
    const glb = Buffer.from(await (await dracoIO()).writeBinary(doc));
    return { glb, encoded };
  }
  if (meshopt) {
    await doc.transform(meshoptFn({ encoder: MeshoptEncoder }));
    encoded.meshopt = true;
    const glb = Buffer.from(await (await meshoptIO()).writeBinary(doc));
    return { glb, encoded };
  }
  // nothing requested → re-serialize uncompressed (no-op passthrough)
  const glb = Buffer.from(await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(doc));
  return { glb, encoded };
}
