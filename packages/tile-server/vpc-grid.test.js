// The grid VPC (vpc-grid.js): a national grid said once. Cells → document → the entries a STAC VPC would give.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GRIDS, buildGridVpc, parseGridVpc, isGridVpc, templateRe, gridUrl, cellBox } from './vpc-grid.js';
import { boxBounds, parseVpcBytes, vpcToSet } from './vpc-live.js';
import { detectFormatByName } from '../core/detect.js';
import { ecefToLlh } from '../core/index.js';

const IGN = 'https://host/copc/LHD_FXX_{x}_{y}_PTS_{v}_LAMB93_IGN69.copc.laz';
const ign = { crs: 'EPSG:2154', unit: 1000, cell: 1000, anchor: 'nw', pad: 4, url: IGN };

test('a template captures what it leaves open, and writes it back', () => {
  const name = 'LHD_FXX_0600_6833_PTS_O_LAMB93_IGN69.copc.laz';
  const m = templateRe(IGN.split('/').pop()).exec(name);
  assert.deepEqual({ ...m.groups }, { x: '0600', y: '6833', v: 'O' });
  assert.equal(gridUrl(IGN, 600, 6833, 'O', 4), `https://host/copc/${name}`);
  assert.equal(templateRe('t_{x}-{y}.copc.laz').exec('t_2671-1221.copc.laz').groups.x, '2671');
  assert.equal(templateRe('t_{x}-{y}.copc.laz').exec('t_2671-1221Xcopc.laz'), null, 'the dot is a dot');
});

test('cells → document → entries: place, name, variant, heights and counts', () => {
  const cells = [
    { x: 600, y: 6833, v: 'C', z0: 31.4, z1: 120.2, count: 21_300_000 },
    { x: 601, y: 6833, v: 'O', z0: 30, z1: 99, count: 9_000_000 },
    { x: 603, y: 6835, v: 'C', z0: -2_000_000, z1: 1_074_000, count: 40_000 },   // a header's noise: clamped
    { x: 600, y: 6833, v: 'O', z0: 0, z1: 1, count: 1 },                          // the same square again: dropped
  ];
  const { doc, stats } = buildGridVpc(cells, { ...ign, title: 'test' });
  assert.ok(isGridVpc(doc));
  assert.deepEqual([doc.x0, doc.y0, doc.width, doc.height], [600, 6833, 4, 3]);
  assert.deepEqual(doc.rows, ['01..', '....', '...0']);
  assert.deepEqual(doc.variants, ['C', 'O']);
  assert.equal(stats.duplicates, 1);
  assert.deepEqual(doc.z, { min: [31, 30, -1000], max: [121, 99, 9000] });
  assert.deepEqual(doc.points, { unit: 100000, counts: [213, 90, 1] });

  const parsed = parseGridVpc(JSON.parse(JSON.stringify(doc)), 'https://x/y.gridvpc.json', { boxBounds });
  assert.equal(parsed.entries.length, 3);
  const [a, b] = parsed.entries;
  assert.equal(a.url, 'https://host/copc/LHD_FXX_0600_6833_PTS_C_LAMB93_IGN69.copc.laz');
  assert.equal(b.url, 'https://host/copc/LHD_FXX_0601_6833_PTS_O_LAMB93_IGN69.copc.laz');
  assert.deepEqual([a.format, a.crs, a.points, a.boundsFrom], ['copc', 'EPSG:2154', 21_300_000, 'grid']);
  // the name gives the NORTH-WEST corner: the square is south of Y 6 833 000 (Paris, 48.6° N, 1.6° E)
  assert.deepEqual(cellBox(doc, 600, 6833), [600000, 6832000, 601000, 6833000]);
  assert.deepEqual(GRIDS['ign-lidarhd'].box(600, 6833).map(Math.round), [600000, 6832000, 601000, 6833000]);
  const [lon, lat] = ecefToLlh(...a.bounds.sphere.slice(0, 3));
  assert.ok(Math.abs(lat - 48.59) < 0.02 && Math.abs(lon - 1.65) < 0.02, `${lon}, ${lat}`);
  assert.ok(a.bounds.sphere[3] > 700 && a.bounds.sphere[3] < 760, 'a square kilometre: a 707 m half-diagonal and its heights');
  assert.ok(Math.abs(a.bounds.geometricError - 1000 * Math.sqrt(3)) < 1);
  const { set, report } = vpcToSet(parsed, undefined, { url: 'https://x/y.gridvpc.json', label: parsed.label });
  assert.equal(set.label, 'test');
  assert.deepEqual(report.boundsFrom, { grid: 3 });
  assert.equal(report.points, 21_300_000 + 9_000_000 + 100_000);
});

test('availability alone, a south-west grid, extra files, a relative template', () => {
  const { doc } = buildGridVpc([{ x: 2671, y: 1221 }, { x: 2672, y: 1221 }], { crs: 'EPSG:2056', unit: 1000, cell: 1000, anchor: 'sw', url: './tiles/s_{x}-{y}.copc.laz', withStats: false,
    extra: [{ url: 'https://h/old.copc.laz', bbox: [2670000, 1220000, 400, 2671000, 1221000, 500], points: 5 }] });
  assert.equal(doc.z, undefined);
  assert.deepEqual(doc.variants, ['']);
  const parsed = parseGridVpc({ ...doc, zRange: [400, 900], pointsPerCell: 7 }, 'https://x/dir/ch.gridvpc.json.gz', { boxBounds });
  assert.deepEqual(parsed.entries.map((e) => e.url), ['https://x/dir/tiles/s_2671-1221.copc.laz', 'https://x/dir/tiles/s_2672-1221.copc.laz', 'https://h/old.copc.laz']);
  assert.deepEqual(parsed.entries.map((e) => e.points), [7, 7, 5]);
  assert.equal(parsed.entries[2].boundsFrom, 'grid:extra');
  assert.deepEqual(cellBox(doc, 2671, 1221), [2671000, 1221000, 2672000, 1222000]);
  assert.throws(() => parseGridVpc({ ...doc, version: 2 }, 'https://x/a', { boxBounds }), /version 2/);
  assert.throws(() => parseGridVpc({ ...doc, rows: ['5'] }, 'https://x/a', { boxBounds }), /variant/);
  assert.throws(() => parseGridVpc(doc, null, { boxBounds }), /relative/);
});

test('a .gridvpc.json[.gz] is served as a VPC', () => {
  for (const n of ['a.gridvpc.json.gz', 'https://h/a.gridvpc.json?x=1', 'a.gridvpc']) assert.equal(detectFormatByName(n), 'vpc');
});

test('all of France from the committed 9 KB: 337 190 squares and the 16 files named otherwise', async () => {
  const doc = parseVpcBytes(await readFile(new URL('./samples/france-lidarhd.gridvpc.json.gz', import.meta.url)), 'france');
  assert.ok(isGridVpc(doc));
  const t0 = performance.now();
  const parsed = parseGridVpc(doc, 'https://x/france.gridvpc.json.gz', { boxBounds });
  assert.equal(parsed.entries.length, 337_206);
  assert.equal(parsed.entries.filter((e) => /_PTS_O_/.test(e.url)).length, 78_716);
  assert.equal(parsed.entries.filter((e) => e.boundsFrom === 'grid:extra').length, 16);
  assert.ok(performance.now() - t0 < 30_000);
});
