// Point tiles carry the source's scalar attributes as glTF custom attributes, raw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeIO } from '@gltf-transform/core';
import { buildPointsGlb, pickAttributes } from '../core/index.js';

test('buildPointsGlb writes _INTENSITY and _CLASSIFICATION as raw scalar accessors', async () => {
  const n = 3;
  const glb = await buildPointsGlb(new Float32Array(n * 3), null, n, { attributes: { _INTENSITY: Uint16Array.from([7, 65535, 300]), _CLASSIFICATION: Uint8Array.from([2, 6, 2]), _SHORT: new Uint8Array(1) } });
  const prim = (await new NodeIO().readBinary(glb)).getRoot().listMeshes()[0].listPrimitives()[0];
  assert.deepEqual([...prim.getAttribute('_INTENSITY').getArray()], [7, 65535, 300]);
  assert.equal(prim.getAttribute('_INTENSITY').getNormalized(), false);
  assert.deepEqual([...prim.getAttribute('_CLASSIFICATION').getArray()], [2, 6, 2]);
  assert.equal(prim.getAttribute('_SHORT'), null, 'an attribute shorter than the points is left out');
  assert.ok(prim.getAttribute('COLOR_0'));
});

test('pickAttributes: none unless asked, by name or all, only what the source has', () => {
  const all = { _INTENSITY: new Uint16Array(2), _CLASSIFICATION: new Uint8Array(2) };
  assert.deepEqual(Object.keys(pickAttributes(all, null)), []);
  assert.deepEqual(Object.keys(pickAttributes(all, '')), []);
  assert.deepEqual(Object.keys(pickAttributes(all, 'intensity')), ['_INTENSITY']);
  assert.deepEqual(Object.keys(pickAttributes(all, 'classification, Intensity')), ['_INTENSITY', '_CLASSIFICATION']);
  assert.deepEqual(Object.keys(pickAttributes(all, 'all')), ['_INTENSITY', '_CLASSIFICATION']);
  assert.deepEqual(Object.keys(pickAttributes({ _INTENSITY: all._INTENSITY }, 'all')), ['_INTENSITY']);
  assert.deepEqual(Object.keys(pickAttributes(null, 'all')), []);
});

