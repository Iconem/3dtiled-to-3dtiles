// core/placement.js: the five numbers of a /stream placement ↔ the matrix a gizmo yields.
import assert from 'node:assert/strict';
import test from 'node:test';
import { placementMatrix, decomposePlacement, placedStreamUrl, streamUrlPlacement, placedTileset, isStreamUrl } from '../core/placement.js';
import { placementMatrix as geoPlacementMatrix, mat4Multiply, applyPlacement } from '../core/geo.js';

const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);

test('geo.js still hands out the same placement matrix', () => {
  assert.deepEqual(geoPlacementMatrix(14.4887, 40.7514, 35, 30, 2), placementMatrix(14.4887, 40.7514, 35, 30, 2));
});

test('a placement decomposes to the numbers it was made of', () => {
  for (const [lon, lat, alt, heading, scale] of [[14.4887, 40.7514, 35, 0, 1], [110.926, 36.7019, 1022, 137.5, 0.25], [-123.07, 44.05, -3, -90, 3], [0, -89.5, 10, 179, 1], [179.99, 0, 0, 12, 1]]) {
    const d = decomposePlacement(placementMatrix(lon, lat, alt, heading, scale));
    near(d.lon, lon, 1e-9, 'lon'); near(d.lat, lat, 1e-9, 'lat'); near(d.alt, alt, 1e-6, 'alt');
    near(d.heading, heading, 1e-7, 'heading'); near(d.scale, scale, 1e-9, 'scale');
    assert.equal(d.exact, true);
    near(d.tilt, 0, 1e-5, 'tilt'); near(d.stretch, 1, 1e-9, 'stretch');
  }
});

test('a tilt or a scale by axis is reported, and the numbers are the nearest upright placement', () => {
  const base = placementMatrix(2, 48, 100, 20, 1);
  const a = 5 * Math.PI / 180;
  const tilted = mat4Multiply(base, [1, 0, 0, 0, 0, Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1]);   // 5° about local X
  const d = decomposePlacement(tilted);
  assert.equal(d.exact, false);
  near(d.tilt, 5, 1e-6, 'tilt'); near(d.heading, 20, 0.2, 'heading');
  const squashed = decomposePlacement(mat4Multiply(base, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1]));
  assert.equal(squashed.exact, false);
  near(squashed.stretch, 2, 1e-9, 'stretch');
  const mirrored = decomposePlacement(mat4Multiply(base, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
  assert.equal(mirrored.exact, false);
});

test('a moved placement goes back into the stream URL, and the server then applies that very matrix', () => {
  const url = 'http://localhost:3001/stream/tileset.json?format=sog&url=https%3A%2F%2Fexample.org%2Flod-meta.json&up=y&lon=1&lat=2&alt=3';
  assert.equal(isStreamUrl(url), true);
  assert.equal(isStreamUrl('https://example.org/tileset.json'), false);
  assert.deepEqual(streamUrlPlacement(url), placementMatrix(1, 2, 3));
  assert.equal(streamUrlPlacement('http://localhost:3001/stream/tileset.json?format=sog&url=x'), null);
  // the gizmo moved the group by G on top of the URL's placement: the new placement is G · P0
  const P0 = streamUrlPlacement(url);
  const target = placementMatrix(14.4887761, 40.75135707, 35.25, 30.5, 1.5);
  const d = decomposePlacement(target);
  const out = placedStreamUrl(url, d);
  const sp = new URL(out).searchParams;
  assert.equal(sp.get('format'), 'sog'); assert.equal(sp.get('up'), 'y');
  assert.equal(sp.get('lon'), '14.4887761'); assert.equal(sp.get('lat'), '40.75135707'); assert.equal(sp.get('alt'), '35.25');
  assert.equal(sp.get('heading'), '30.5'); assert.equal(sp.get('scale'), '1.5');
  const root = { transform: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1] };
  assert.equal(applyPlacement(root, sp), true);
  const want = mat4Multiply(target, [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
  root.transform.forEach((v, i) => near(v, want[i], 2e-3, `matrix[${i}]`));
  assert.ok(P0);
  // nothing to say: a heading of 0 and a scale of 1 stay out of the URL
  const plain = new URL(placedStreamUrl(url, { lon: 5, lat: 6, alt: 0, heading: 0, scale: 1 })).searchParams;
  assert.equal(plain.has('alt'), false); assert.equal(plain.has('heading'), false); assert.equal(plain.has('scale'), false);
});

test('a placed tileset holds the source under the matrix', () => {
  const m = placementMatrix(2, 48, 0, 10, 1);
  const ts = placedTileset('https://example.org/tileset.json', m, { sphere: [0, 0, 5, 40], geometricError: 12, placement: { lon: 2, lat: 48, alt: 0, heading: 10, scale: 1 } });
  assert.deepEqual(ts.root.transform, m);
  assert.deepEqual(ts.root.boundingVolume.sphere, [0, 0, 5, 40]);
  assert.equal(ts.root.content.uri, 'https://example.org/tileset.json');
  assert.equal(ts.asset.extras.placement.heading, 10);
});
