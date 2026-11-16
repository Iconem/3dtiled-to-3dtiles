// The per-tile glTF transforms of the live server (core/gltf-tiles.js): a tile with nothing to decode is passed on
// as it came, KTX2 can be kept, the KTX2 encode declares its extension, and a tile worker returns the same bytes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Document, NodeIO } from '@gltf-transform/core';
import { PNG } from 'pngjs';
import { compressGlb, decompressGlb, decompressTile, compressTile, glbNeedsDecode, setTileWorkers, tilePool } from '../core/index.js';

const glbJson = (b) => JSON.parse(Buffer.from(b).toString('utf8', 20, 20 + Buffer.from(b).readUInt32LE(12)));

async function meshGlb({ textured = false } = {}) {
  const doc = new Document(), buf = doc.createBuffer(), n = 300;
  const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), idx = new Uint16Array((n - 2) * 3);
  for (let i = 0; i < n; i++) { pos.set([i % 17, (i * 7) % 13, (i * 3) % 11], i * 3); uv.set([(i % 17) / 17, (i % 13) / 13], i * 2); }
  for (let i = 0; i < n - 2; i++) idx.set([i, i + 1, i + 2], i * 3);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buf))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(uv).setBuffer(buf))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(idx).setBuffer(buf));
  if (textured) {
    const png = new PNG({ width: 16, height: 16 });
    for (let i = 0; i < png.data.length; i += 4) png.data.set([i % 255, (i * 3) % 255, 80, 255], i);
    prim.setMaterial(doc.createMaterial().setBaseColorTexture(doc.createTexture().setImage(PNG.sync.write(png)).setMimeType('image/png')));
  }
  doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)));
  return Buffer.from(await new NodeIO().writeBinary(doc));
}

test('a tile with nothing to decode is returned as it came', async () => {
  const plain = await meshGlb();
  assert.equal(glbNeedsDecode(plain), false);
  assert.equal(await decompressTile(plain, {}), plain);            // the same Buffer, not a rewrite
  assert.equal((await decompressGlb(plain, {})).untouched, true);
  assert.equal(glbNeedsDecode(Buffer.from('not a glb at all, but long enough')), true);   // in doubt: decode
});

test('compressed geometry is detected and decoded; an op that is off leaves it', async () => {
  const plain = await meshGlb();
  for (const op of ['meshopt', 'draco']) {
    const { glb } = await compressGlb(plain, { [op]: true });
    const ext = op === 'draco' ? 'KHR_draco_mesh_compression' : 'EXT_meshopt_compression';
    assert.ok(glbJson(glb).extensionsUsed.includes(ext));
    assert.equal(glbNeedsDecode(glb), true);
    assert.equal(glbNeedsDecode(glb, { [op]: false }), false);
    const out = await decompressTile(glb, {});
    assert.ok(!(glbJson(out).extensionsUsed || []).includes(ext));
  }
});

test('the KTX2 encode declares KHR_texture_basisu, and tex=ktx2 keeps the textures on decode', async () => {
  const { glb, encoded } = await compressGlb(await meshGlb({ textured: true }), { draco: true, ktx: true });
  assert.equal(encoded.ktx, 1);
  const json = glbJson(glb);
  assert.ok(json.extensionsUsed.includes('KHR_texture_basisu') && json.extensionsRequired.includes('KHR_texture_basisu'));
  assert.equal(json.images[0].mimeType, 'image/ktx2');

  const kept = glbJson(await decompressTile(glb, { texFormat: 'ktx2' }));
  assert.equal(kept.images[0].mimeType, 'image/ktx2');
  assert.ok(!kept.extensionsUsed.includes('KHR_draco_mesh_compression'));
  assert.equal(glbNeedsDecode(await decompressTile(glb, { texFormat: 'ktx2' }), { texFormat: 'ktx2' }), false);

  const jpg = glbJson(await decompressTile(glb, {}));
  assert.equal(jpg.images[0].mimeType, 'image/jpeg');
  assert.ok(!(jpg.extensionsUsed || []).includes('KHR_texture_basisu'));
});

test('a tile worker returns the bytes this thread would', async () => {
  const plain = await meshGlb({ textured: true });
  const packed = await compressTile(plain, { meshopt: true });
  const here = await decompressTile(packed, {});
  const was = setTileWorkers(2);
  try {
    assert.ok(tilePool());
    assert.deepEqual(await compressTile(plain, { meshopt: true }), packed);
    assert.deepEqual(await decompressTile(packed, {}), here);
  } finally { setTileWorkers(was); await tilePool(2)?.destroy(); }
});
