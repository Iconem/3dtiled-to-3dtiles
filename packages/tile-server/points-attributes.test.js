// Point tiles carry the source's scalar attributes as glTF custom attributes, raw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeIO } from '@gltf-transform/core';
import { buildPointsGlb, pickAttributes, wantedAttributes, attributesSpec } from '../core/index.js';
import { lasScalarAttributes } from './copc-live.js';

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

test('attributes are asked for by PDAL dimension name, in any case', () => {
  assert.deepEqual(wantedAttributes('intensity, Classification,GPSTIME,nope'), ['Intensity', 'Classification', 'GpsTime']);
  assert.deepEqual(wantedAttributes('ALL').length, 16);
  assert.deepEqual(wantedAttributes(''), []);
  assert.equal(attributesSpec('classification,intensity'), 'Classification,Intensity');
  assert.equal(attributesSpec('Intensity,all'), 'all');
  assert.equal(attributesSpec('nope'), '');
});

test('a LAS view gives the dimensions asked for; GpsTime is float32 relative to the tile, with the offset in extras', async () => {
  const dims = { Intensity: 1, GpsTime: 1, ReturnNumber: 1, EdgeOfFlightLine: 1 };
  const view = { pointCount: 3, dimensions: dims, getter: (k) => (i) => ({ Intensity: [5, 70000 & 0xffff, 9], GpsTime: [1.5e9 + 0.25, 1.5e9 + 1.75, 1.5e9 + 0.5], ReturnNumber: [1, 2, 1], EdgeOfFlightLine: [false, true, false] })[k][i] };
  const a = lasScalarAttributes(view, wantedAttributes('gpstime,intensity,edgeofflightline,classification'));
  assert.deepEqual(Object.keys(a).sort(), ['_EDGE_OF_FLIGHT_LINE', '_GPS_TIME', '_INTENSITY', 'extras']);
  assert.deepEqual([...a._GPS_TIME], [0, 1.5, 0.25]);
  assert.equal(a.extras.gpsTimeOffset, 1.5e9 + 0.25);
  assert.deepEqual([...a._EDGE_OF_FLIGHT_LINE], [0, 1, 0]);
  const glb = await buildPointsGlb(new Float32Array(9), null, 3, { attributes: a });
  const prim = (await new NodeIO().readBinary(glb)).getRoot().listMeshes()[0].listPrimitives()[0];
  assert.equal(prim.getExtras().gpsTimeOffset, 1.5e9 + 0.25);
  assert.equal(prim.getAttribute('_GPS_TIME').getArray().constructor, Float32Array);
  assert.equal(prim.getAttribute('extras'), null);
});

