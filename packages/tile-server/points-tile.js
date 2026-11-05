/**
 * points-tile.js — the CPU half of a live point tile: decoded points → POINTS GLB, with no network and no cached
 * context, so that it runs the same on the server's thread (copc-live.js, potree-live.js) and on a tile worker
 * (tile-tasks.js, behind TILED_WORKERS).
 */
import { buildPointsGlb, wantedAttributes, pickAttributes, POINT_ATTRIBUTES, curvedTileLocalizer } from '../core/index.js';

/**
 * The LAS dimensions `keys` (PDAL names, core's POINT_ATTRIBUTES) of a point view as glTF custom attributes, for
 * buildPointsGlb: a map by glTF name, plus `extras` for a dimension stored relative to the tile (GpsTime).
 */
export function lasScalarAttributes(view, keys = Object.keys(POINT_ATTRIBUTES)) {
  const n = view.pointCount, d = view.dimensions, out = {}, extras = {};
  for (const key of keys) {
    const spec = POINT_ATTRIBUTES[key];
    if (!spec || !d[key]) continue;
    const g = view.getter(key), a = new spec.array(n);
    if (spec.relative) {
      let min = Infinity; for (let i = 0; i < n; i++) { const v = g(i); if (v < min) min = v; }
      if (!Number.isFinite(min)) min = 0;
      for (let i = 0; i < n; i++) a[i] = g(i) - min;
      extras[spec.relative] = min;
    } else for (let i = 0; i < n; i++) a[i] = +g(i);
    out[spec.name] = a;
  }
  if (Object.keys(extras).length) out.extras = extras;
  return out;
}

/**
 * A COPC node's point view → GLB bytes.
 * @param view Las.View of the node
 * @param {{origin:number[], colors?:string, attributes?:string|null, toLocal?:Function|null, subCube?:number[]}} o
 *   `toLocal` + `subCube` (the node's cube) for a curved placement; otherwise points are relative to `origin`.
 */
export async function copcViewGlb(view, { origin, colors: colorsEnc, attributes = null, toLocal = null, subCube = null }) {
  const n = view.pointCount, [ox, oy, oz] = origin;
  const gx = view.getter('X'), gy = view.getter('Y'), gz = view.getter('Z');
  const pos = new Float32Array(n * 3);
  if (toLocal) {
    const place = curvedTileLocalizer(toLocal, subCube);
    for (let i = 0; i < n; i++) place(gx(i), gy(i), gz(i), pos, i*3);
  }
  else for (let i = 0; i < n; i++) { pos[i*3] = gx(i)-ox; pos[i*3+1] = gy(i)-oy; pos[i*3+2] = gz(i)-oz; }
  const d = view.dimensions; let colors = null;
  if (d.Red && d.Green && d.Blue) {
    const gr = view.getter('Red'), gg = view.getter('Green'), gb = view.getter('Blue'), s = d.Red.size === 2 ? 1/65535 : 1/255;
    colors = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { colors[i*4]=gr(i)*s; colors[i*4+1]=gg(i)*s; colors[i*4+2]=gb(i)*s; colors[i*4+3]=1; }
  }
  // No RGB: white (colors = null), which reads well under eye-dome lighting. Intensity as grey used to
  // stand in, but intensity is stored in 16 bits with small values (0–255 or 0–4095 for most
  // scanners), so divided by 65535 it rendered near-black. It travels as `_INTENSITY` instead, with `_CLASSIFICATION`,
  // when the tile URL asks (`&attributes=`), so a tile is no heavier than its points and colours otherwise.
  const attrs = attributes ? lasScalarAttributes(view, wantedAttributes(attributes)) : undefined;
  return buildPointsGlb(pos, colors, n, { colors: colorsEnc, attributes: attrs });   // core applies the (E,U,−N) Y-up swizzle
}

/** A decoded Potree node ({ positions: world coords, colors, count, attributes }) → GLB bytes, or null when empty. */
export async function potreeDataGlb(data, { origin, colors: colorsEnc, attributes: attrSpec = null }) {
  if (!data || !data.count) return null;
  const { positions, colors, count, attributes } = data;
  const [ox, oy, oz] = origin;                              // world → tile-local (float32-safe)
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) { pos[i*3]=positions[i*3]-ox; pos[i*3+1]=positions[i*3+1]-oy; pos[i*3+2]=positions[i*3+2]-oz; }
  return buildPointsGlb(pos, colors, count, { colors: colorsEnc, attributes: pickAttributes(attributes, attrSpec) });   // core applies the (E,U,−N) Y-up swizzle
}
