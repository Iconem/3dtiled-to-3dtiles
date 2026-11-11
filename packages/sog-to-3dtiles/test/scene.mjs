/**
 * scene.mjs — the synthetic scene behind test/fixtures: a seeded cluster of 3 000 splats with random rotations, scales
 * and colours and one band of spherical harmonics, the same on every run. scripts/make-fixtures.mjs writes it through
 * splat-transform's CLI; the tests read it back as the ground truth of the fixtures' positions and colours.
 */
import { DataTable, Column, Transform } from '@playcanvas/splat-transform';

export const SCENE_COUNT = 3000;

/**
 * The scene as a splat-transform DataTable in PLY conventions (logit opacity, log scales, rot_0 = w) and in the PLY frame
 * (`Transform.PLY`: a table in the default frame is turned by 180° about z on its way into a PLY or a SOG, and what
 * readSog gives back is the file's frame, so the fixtures match this table row for row only in that frame).
 */
export function sceneTable() {
  let seed = 0x9e3779b9;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const N = SCENE_COUNT;
  const f = (fn) => Float32Array.from({ length: N }, (_, i) => fn(i));
  const q = Array.from({ length: N }, () => { const v = [gauss(), gauss(), gauss(), gauss()]; const l = Math.hypot(...v); return v.map((c) => c / l); });
  return new DataTable([
    new Column('x', f(() => gauss() * 2)), new Column('y', f(() => gauss())), new Column('z', f(() => gauss() * 3 + 1)),
    new Column('rot_0', f((i) => q[i][0])), new Column('rot_1', f((i) => q[i][1])), new Column('rot_2', f((i) => q[i][2])), new Column('rot_3', f((i) => q[i][3])),
    new Column('scale_0', f(() => -4 + rand() * 2)), new Column('scale_1', f(() => -4 + rand() * 2)), new Column('scale_2', f(() => -4 + rand() * 2)),
    new Column('opacity', f(() => Math.log(1 / (0.02 + rand() * 0.98) - 1) * -1)),   // logit of an opacity in [0.02, 1)
    new Column('f_dc_0', f(() => (rand() - 0.5) * 3)), new Column('f_dc_1', f(() => (rand() - 0.5) * 3)), new Column('f_dc_2', f(() => (rand() - 0.5) * 3)),
    ...Array.from({ length: 9 }, (_, k) => new Column(`f_rest_${k}`, f(() => (rand() - 0.5) * 0.4))),
  ], Transform.PLY.clone());
}
