/**
 * Colour a point cloud tile by one of its attributes (the lab's "colour by"): elevation, intensity,
 * classification, return number, number of returns, point source, user data, GPS time.
 *
 * The colours are written on the CPU into the tile's `color` attribute, in place, and the file's own
 * colours are kept beside it (as lib/pointColors.ts does for the viewer's height mode): any point
 * material draws them, with no shader of its own, and going back to RGB copies them back.
 *
 * What a source offers depends on its loader: CopcLoader fills every attribute named here;
 * upstream's PotreeLoader (0.5.4) decodes position, colour and intensity only, so a Potree cloud can
 * be coloured by elevation and intensity and nothing else.
 */
import { BufferAttribute, Color } from 'three';

/** value → label, in the order of the menu. */
export const COLOR_MODES = {
  rgb: 'file colours',
  elevation: 'elevation',
  intensity: 'intensity',
  classification: 'classification',
  returnNumber: 'return number',
  numberOfReturns: 'number of returns',
  pointSourceId: 'point source',
  userData: 'user data',
  gpsTime: 'GPS time',
};

const lin16 = (hex) => { const c = new Color(hex); return [Math.round(c.r * 65535), Math.round(c.g * 65535), Math.round(c.b * 65535)]; };

// blue, cyan, green, yellow, red (the viewer's height ramp), as 256 linear colours
const RAMP = (() => {
  const stops = ['#2c3ec8', '#19b5d8', '#34c759', '#ffd60a', '#e5322d'].map((c) => new Color(c));
  const out = new Uint16Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255 * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(t)), f = t - k;
    const a = stops[k], b = stops[k + 1];
    out[i * 3] = Math.round((a.r + (b.r - a.r) * f) * 65535);
    out[i * 3 + 1] = Math.round((a.g + (b.g - a.g) * f) * 65535);
    out[i * 3 + 2] = Math.round((a.b + (b.b - a.b) * f) * 65535);
  }
  return out;
})();
const GREY = (() => { const out = new Uint16Array(256 * 3); for (let i = 0; i < 256; i++) { const v = Math.round((i / 255) ** 2.2 * 65535); out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = v; } return out; })();

// ASPRS LAS 1.4 standard classes; the others get a colour of their own from their number
const CLASS_HEX = {
  0: '#9a9a9a', 1: '#c8c8c8', 2: '#a8743c', 3: '#9bd27a', 4: '#4fb04a', 5: '#1f7a34', 6: '#e8502e', 7: '#ff00ff',
  8: '#ffe14d', 9: '#2f7fe0', 10: '#6b4a2b', 11: '#55585e', 12: '#b9a0d8', 13: '#f2c14e', 14: '#f29e4c', 15: '#d7263d',
  16: '#f46036', 17: '#8d99ae', 18: '#ff3df2',
};
const hashed = (id) => { const c = new Color().setHSL((id * 0.61803398875) % 1, 0.65, 0.55); return [Math.round(c.r * 65535), Math.round(c.g * 65535), Math.round(c.b * 65535)]; };
const CLASS_LUT = (() => { const out = new Uint16Array(256 * 3); for (let i = 0; i < 256; i++) out.set(CLASS_HEX[i] ? lin16(CLASS_HEX[i]) : hashed(i + 7), i * 3); return out; })();
// returns: 1 to 15, from the first (light) to the last
const RETURN_LUT = (() => { const out = new Uint16Array(16 * 3); const hex = ['#555555', '#ffe14d', '#f29e4c', '#e8502e', '#b5179e', '#7209b7', '#3a0ca3', '#4361ee']; for (let i = 0; i < 16; i++) out.set(lin16(hex[Math.min(i, hex.length - 1)]), i * 3); return out; })();

/** Continuous modes: coloured along a ramp between two values fitted to the data. */
const CONTINUOUS = { elevation: RAMP, intensity: GREY, userData: RAMP, gpsTime: RAMP };

/** The values a mode reads: `(i) => number`, or null when the tile does not have them. */
function reader(points, mode) {
  const a = points.geometry.attributes;
  if (mode === 'elevation') {
    // the file's own Z: the tile's points are relative to its centre, which is the object's position
    // (CopcPlugin notes it apart, a placed cloud's position being earth-centred)
    const pos = a.position?.array, z0 = points.userData.fileZ ?? points.position.z;
    return pos ? (i) => pos[i * 3 + 2] + z0 : null;
  }
  const arr = a[mode]?.array;
  return arr ? (i) => arr[i] : null;
}

/** Colour-by state of one tile set: the mode, and the range of each continuous mode once fitted. */
export function createColorState(mode = 'rgb') {
  return { mode, ranges: {}, missing: false };
}

/** The 2nd to 98th percentile of a mode's values over these tiles (a few stray points do not count). */
function fitRange(objects, mode) {
  const vs = [];
  for (const o of objects) {
    const read = reader(o, mode), n = o.geometry.attributes.position?.count ?? 0;
    if (!read) continue;
    for (let i = 0, step = Math.max(1, Math.ceil(n / 4000)); i < n; i += step) vs.push(read(i));
  }
  if (vs.length < 2) return null;
  vs.sort((x, y) => x - y);
  const lo = vs[Math.floor(vs.length * 0.02)], hi = vs[Math.floor(vs.length * 0.98)];
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}

/** Back to the tile's own colours. */
function restore(points) {
  const u = points.userData;
  if (!u.__colorMode) return;
  const attr = points.geometry.attributes.color;
  if (u.__rgb) { attr.array.set(u.__rgb); attr.needsUpdate = true; }
  else if (u.__rgbAttr) points.geometry.setAttribute('color', u.__rgbAttr);
  else { points.geometry.deleteAttribute('color'); points.material.vertexColors = false; points.material.needsUpdate = true; }
  delete u.__rgb; delete u.__rgbAttr; delete u.__colorMode;
}

/**
 * Paint one tile (a Points object) for the state's mode. Returns false when the tile lacks the
 * attribute (it then keeps its own colours). The first tiles seen fix the range of a continuous
 * mode: the root of an octree is a sample of the whole cloud, which is what the range should fit.
 */
export function paint(points, state) {
  const { mode } = state;
  const g = points.geometry, n = g?.attributes?.position?.count ?? 0;
  if (!points.isPoints || !n) return true;
  if (mode === 'rgb') { restore(points); return true; }
  const read = reader(points, mode);
  if (!read) { restore(points); return false; }
  const ramp = CONTINUOUS[mode];
  if (ramp && !state.ranges[mode]) state.ranges[mode] = fitRange([points], mode) ?? undefined;
  if (ramp && !state.ranges[mode]) return true;            // one point: nothing to fit a range to yet
  const key = ramp ? `${mode}|${state.ranges[mode].join('|')}` : mode;
  const u = points.userData;
  if (u.__colorMode === key) return true;

  let attr = g.attributes.color;
  if (!u.__colorMode) {
    if (attr && attr.array instanceof Uint16Array && attr.normalized) u.__rgb = attr.array.slice();
    else {
      // no colour, or colours kept another way: a colour attribute of our own, the original put aside
      u.__rgbAttr = attr ?? null;
      attr = new BufferAttribute(new Uint16Array(n * 3), 3, true);
      g.setAttribute('color', attr);
      if (!points.material.vertexColors) { points.material.vertexColors = true; points.material.needsUpdate = true; }
    }
  }
  const out = attr.array;
  if (ramp) {
    const [lo, hi] = state.ranges[mode], k = 255 / (hi - lo);
    for (let i = 0; i < n; i++) {
      let t = (read(i) - lo) * k; t = t < 0 ? 0 : t > 255 ? 255 : t | 0;
      out[i * 3] = ramp[t * 3]; out[i * 3 + 1] = ramp[t * 3 + 1]; out[i * 3 + 2] = ramp[t * 3 + 2];
    }
  } else if (mode === 'pointSourceId') {
    const seen = (state.sources ??= new Map());
    for (let i = 0; i < n; i++) {
      const id = read(i);
      let c = seen.get(id); if (!c) { c = hashed(id); seen.set(id, c); }
      out[i * 3] = c[0]; out[i * 3 + 1] = c[1]; out[i * 3 + 2] = c[2];
    }
  } else {
    const lut = mode === 'classification' ? CLASS_LUT : RETURN_LUT, last = lut.length / 3 - 1;
    for (let i = 0; i < n; i++) {
      const v = Math.min(last, read(i)) * 3;
      out[i * 3] = lut[v]; out[i * 3 + 1] = lut[v + 1]; out[i * 3 + 2] = lut[v + 2];
    }
  }
  attr.needsUpdate = true;
  u.__colorMode = key;
  return true;
}

/**
 * Switch a whole tile set to `mode`: the range of a continuous mode is fitted again over what is
 * loaded, then every loaded tile is painted. `forEachPoints(cb)` calls `cb` for each Points object.
 * Sets `state.missing` when no loaded tile has the attribute.
 */
export function setColorMode(state, mode, forEachPoints) {
  state.mode = mode;
  const all = [];
  forEachPoints((p) => { if (p.isPoints && p.geometry?.attributes?.position?.count) all.push(p); });
  if (CONTINUOUS[mode]) state.ranges[mode] = fitRange(all, mode) ?? undefined;
  let painted = 0;
  for (const p of all) if (paint(p, state)) painted++;
  state.missing = mode !== 'rgb' && all.length > 0 && painted === 0;
}
