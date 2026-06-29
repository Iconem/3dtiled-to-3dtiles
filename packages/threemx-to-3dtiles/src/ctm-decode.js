/**
 * ctm-decode.js — OpenCTM decoder for Node (vendored jcmellado/js-openctm, MIT).
 *
 * The vendored `vendor/ctm.js` + `vendor/lzma.js` are browser globals (`var CTM`, `var LZMA`). They
 * have no DOM/worker dependencies, so we load them by concatenating into one Function scope (LZMA
 * first so CTM sees it) and returning `CTM`. Handles RAW / MG1 (LZMA, lossless) / MG2 (quantized).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
let _CTM = null;
function getCTM() {
  if (_CTM) return _CTM;
  const lzma = readFileSync(join(dir, 'vendor', 'lzma.js'), 'utf8');
  const ctm = readFileSync(join(dir, 'vendor', 'ctm.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  _CTM = new Function(`${lzma}\n${ctm}\nreturn CTM;`)();
  return _CTM;
}

/**
 * Decode an OpenCTM buffer → geometry arrays.
 * @param {Buffer|Uint8Array} buf
 * @returns {{vertexCount:number, triangleCount:number, positions:Float32Array, indices:Uint32Array,
 *            normals:?Float32Array, uvs:?Float32Array}}
 */
export function decodeCTM(buf) {
  const CTM = getCTM();
  // js-openctm's CTM.Stream reads via String.charCodeAt → it expects a binary (latin1) string.
  const bin = Buffer.isBuffer(buf) ? buf.toString('latin1') : Buffer.from(buf).toString('latin1');
  const stream = new CTM.Stream(bin);
  const file = new CTM.File(stream);
  const h = file.header, b = file.body;
  return {
    vertexCount: h.vertexCount,
    triangleCount: h.triangleCount,
    positions: b.vertices,
    indices: b.indices,
    normals: b.normals || null,
    uvs: (b.uvMaps && b.uvMaps[0]) ? b.uvMaps[0].uv : null,
  };
}
