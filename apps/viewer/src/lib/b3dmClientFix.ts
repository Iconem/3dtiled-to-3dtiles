// 3d-tiles-renderer's own client-side b3dm parsing (B3DMLoaderBase.parse, in
// node_modules/3d-tiles-renderer/src/core/renderer/loaders/B3DMLoaderBase.js) hits two real-world
// spec-violations that our server-side upgrade tool (packages/3dtiles-tools/upgrade.js) already
// fixes for tiles routed through the tile-server's ?tool=upgrade proxy — but a DIRECTLY loaded
// tileset (no transform selected) never goes through that proxy, so 3d-tiles-renderer's own
// internal parser hits the same two bugs independently:
//
//  1. Marseille_Cesium's root.b3dm (and similar) predate the 28-byte spec header — they pack as
//     few as 12 bytes (magic+version+byteLength, no feature/batch table fields at all) before the
//     glTF starts. B3DMLoaderBase.parse blindly trusts the 28-byte field layout, so it reads the
//     glTF's own magic bytes (0x46546C67 = 'glTF' = 1179937895 decimal) as a length field, producing
//     a garbage offset — the exact "RangeError: Invalid typed array length: 1179937895" reported.
//  2. Clermont's mesh_*.b3dm tiles declare a material `extensions` block (KHR_materials_unlit) that
//     isn't listed in the top-level extensionsUsed array. Three.js's GLTFLoader only instantiates an
//     extension's handler plugin when extensionsUsed names it, so GLTFParser.loadMaterial crashes on
//     `undefined.getMaterialType()`.
//
// Both are fixed identically to upgrade.js's b3dmGlbOffset/fixGlbExtensionsUsed, just reimplemented
// against ArrayBuffer/DataView (browser) instead of Node's Buffer, and installed as a monkey-patch
// on B3DMLoaderBase.prototype.parse — the shared base class that both 3d-tiles-renderer's own
// TilesRenderer.parseTile() default AND B3DMLoader (three) call into, so patching it here fixes
// every b3dm tile loaded anywhere in the app, not just ones routed through a particular plugin.
import { B3DMLoaderBase } from '3d-tiles-renderer/core';

const GLTF_MAGIC = 0x46546c67; // 'glTF'

function isGlbOrJsonStart(view: DataView, off: number): boolean {
  return off + 4 <= view.byteLength && (view.getUint32(off, true) === GLTF_MAGIC || view.getUint8(off) === 0x7b /* '{' */);
}

/**
 * Reconstruct a spec-compliant 28-byte-header b3dm buffer from a legacy one whose glTF payload
 * starts earlier than the 28-byte mark implies. No-op (returns the input unchanged) for
 * already-compliant b3dm buffers, INCLUDING ones with real, non-empty feature/batch table data —
 * only kicks in when the spec-implied offset doesn't actually point at a glTF/JSON start.
 */
function normalizeLegacyB3dmHeader(buffer: ArrayBuffer): ArrayBuffer {
  if (buffer.byteLength < 12) return buffer;
  const view = new DataView(buffer);
  if (buffer.byteLength >= 28) {
    const specOffset = 28
      + view.getUint32(12, true) + view.getUint32(16, true)
      + view.getUint32(20, true) + view.getUint32(24, true);
    if (isGlbOrJsonStart(view, specOffset)) return buffer; // already spec-compliant
  }
  let legacyOffset = -1;
  for (const off of [12, 16, 20, 24]) {
    if (isGlbOrJsonStart(view, off)) { legacyOffset = off; break; }
  }
  if (legacyOffset < 0) return buffer; // unrecognized layout — let the original parser surface its own error

  // Whatever legacy fields occupied bytes [8, legacyOffset) aren't feature/batch table lengths in
  // the current spec's sense (upgrade.js's Node-side fix discards them the same way, via a zero-copy
  // slice past the offset) — rebuild a canonical header with all-zero feature/batch table lengths so
  // downstream parsing sees "no feature/batch tables", matching that behavior exactly instead of
  // misinterpreting stale legacy bytes as spec-shaped lengths.
  const glbPayload = buffer.slice(legacyOffset);
  const out = new ArrayBuffer(28 + glbPayload.byteLength);
  const outBytes = new Uint8Array(out);
  outBytes.set(new Uint8Array(buffer, 0, 8), 0); // magic + version, unchanged
  new DataView(out).setUint32(8, out.byteLength, true); // byteLength, recomputed
  // bytes [12, 28) stay zero — synthetic zero-length feature/batch table fields
  outBytes.set(new Uint8Array(glbPayload), 28);
  return out;
}

function repackGlb(json: any, bin: Uint8Array | null): Uint8Array {
  const jsonBuf = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBuf.length & 3)) & 3;
  const binLen = bin ? bin.length : 0;
  const binPad = bin ? (4 - (binLen & 3)) & 3 : 0;
  const total = 12 + 8 + jsonBuf.length + jsonPad + (bin ? 8 + binLen + binPad : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint32(o, GLTF_MAGIC, true); o += 4;
  view.setUint32(o, 2, true); o += 4; // version 2
  view.setUint32(o, total, true); o += 4;
  view.setUint32(o, jsonBuf.length + jsonPad, true); o += 4;
  view.setUint32(o, 0x4e4f534a, true); o += 4; // 'JSON'
  out.set(jsonBuf, o); o += jsonBuf.length;
  out.fill(0x20, o, o + jsonPad); o += jsonPad;
  if (bin) {
    view.setUint32(o, binLen + binPad, true); o += 4;
    view.setUint32(o, 0x004e4942, true); o += 4; // 'BIN\0'
    out.set(bin, o); o += binLen;
    out.fill(0, o, o + binPad);
  }
  return out;
}

/** Backfill extensionsUsed with every extension actually referenced. No-op if nothing is missing. */
function fixGlbExtensionsUsed(glbBytes: Uint8Array): Uint8Array {
  const view = new DataView(glbBytes.buffer, glbBytes.byteOffset, glbBytes.byteLength);
  if (glbBytes.byteLength < 20 || view.getUint32(0, true) !== GLTF_MAGIC) return glbBytes; // not a GLB
  const jsonLen = view.getUint32(12, true);
  const jsonStart = 20;
  let json: any;
  try { json = JSON.parse(new TextDecoder().decode(glbBytes.subarray(jsonStart, jsonStart + jsonLen))); }
  catch { return glbBytes; }

  // Lille's b3dm-embedded glTFs crashed here with "(json.materials || []).forEach is not a
  // function" — `|| []` only substitutes when the field is missing/falsy, not when it's present but
  // malformed (e.g. an object instead of an array, seen in some real-world exports). Array.isArray
  // guards against both cases.
  const asArray = (v: any): any[] => (Array.isArray(v) ? v : []);
  const used = new Set<string>(asArray(json.extensionsUsed));
  const before = used.size;
  const collect = (obj: any) => { if (obj?.extensions) Object.keys(obj.extensions).forEach((k) => used.add(k)); };
  collect(json);
  asArray(json.materials).forEach(collect);
  asArray(json.meshes).forEach((m: any) => asArray(m?.primitives).forEach(collect));
  asArray(json.nodes).forEach(collect);
  asArray(json.textures).forEach(collect);
  if (used.size === before) return glbBytes; // nothing to fix

  json.extensionsUsed = [...used];

  const binStart = jsonStart + jsonLen;
  let bin: Uint8Array | null = null;
  if (binStart + 8 <= glbBytes.byteLength) {
    const binLen = view.getUint32(binStart, true);
    bin = glbBytes.subarray(binStart + 8, binStart + 8 + binLen);
  }
  return repackGlb(json, bin);
}

let installed = false;

/** Idempotent — safe to call from multiple component instances/mounts. */
export function installB3dmClientFixes(): void {
  if (installed) return;
  installed = true;
  const proto = B3DMLoaderBase.prototype as any;
  const originalParse = proto.parse;
  proto.parse = function patchedParse(buffer: ArrayBuffer) {
    const result = originalParse.call(this, normalizeLegacyB3dmHeader(buffer));
    result.glbBytes = fixGlbExtensionsUsed(result.glbBytes);
    return result;
  };
}
