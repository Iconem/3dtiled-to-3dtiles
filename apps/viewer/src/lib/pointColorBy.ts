/**
 * Colour streamed point tiles by a LAS attribute: intensity (a grey ramp) or classification (the ASPRS palette).
 *
 * The tile server writes the attributes into each point tile's glTF when its URL asks (`/stream?…&attributes=Intensity`,
 * packages/core/points-glb.js): `_INTENSITY` as the LAS uint16 and `_CLASSIFICATION` as the LAS uint8, raw scalars.
 * three's GLTFLoader lowercases a custom attribute's name, so a loaded Points geometry has `_intensity` /
 * `_classification`.
 *
 * Like the height mode (lib/pointColors.ts), the colours are written on the CPU into a replacement `color` attribute,
 * the tile's own kept on `userData.__origColor`: any point material draws them (plain PointsMaterial, the sprite shapes
 * of PointCloudEffectsPlugin, X-ray) with no shader of its own, and going back to RGB puts the original back. The two
 * modules share that convention, and each forgets the other's key when it paints, so switching between them repaints.
 *
 * Nothing here depends on the viewer: it takes a three.js Points object and a small state, so it can move into
 * 3DTilesRendererJS as a plugin (paint on `load-model`, repaint every loaded model on a mode change).
 */
import * as THREE from 'three';

export type ColorBy = 'intensity' | 'classification';
export const COLOR_BY_MODES: readonly ColorBy[] = ['intensity', 'classification'];
export const isColorBy = (v: string): v is ColorBy => (COLOR_BY_MODES as readonly string[]).includes(v);

/** The LAS dimension (PDAL name) a mode needs from the tile server: the value of `&attributes=`. */
export const COLOR_BY_DIMENSION: Record<ColorBy, string> = { intensity: 'Intensity', classification: 'Classification' };
/** The geometry attribute a mode reads (the glTF `_INTENSITY` / `_CLASSIFICATION`, as GLTFLoader names them). */
export const COLOR_BY_ATTRIBUTE: Record<ColorBy, string> = { intensity: '_intensity', classification: '_classification' };

/**
 * Per tileset: the intensity range the grey ramp spans, the 2nd to 98th percentile of the values loaded. LAS intensity
 * is 16-bit, but its range is the scanner's: many write 0–255 or 0–4095, which on a fixed 0–65535 ramp is near black.
 * The first tile painted (the root, a sample of the whole cloud) fixes it; `fitColorByRange` fits it again over every
 * loaded tile.
 */
export type ColorByState = { intensity: [number, number] | null };
export const createColorByState = (): ColorByState => ({ intensity: null });

// glTF vertex colours are linear: THREE.Color converts these sRGB hex values on the way in.
const lin16 = (c: THREE.Color): [number, number, number] => [Math.round(c.r * 65535), Math.round(c.g * 65535), Math.round(c.b * 65535)];

/** 256 greys, even in display brightness (sRGB), as linear 16-bit colours. */
const GREY = (() => {
  const out = new Uint16Array(256 * 3), c = new THREE.Color();
  for (let i = 0; i < 256; i++) out.set(lin16(c.setRGB(i / 255, i / 255, i / 255, THREE.SRGBColorSpace)), i * 3);
  return out;
})();

/**
 * ASPRS LAS 1.4 standard classes (the palette of the Potree lab, potree-lab/colorModes.js): never classified and
 * unassigned greys, ground brown, low / medium / high vegetation light to dark green, building orange-red, low point
 * (noise) magenta, water blue, rail, road surface dark grey, wire, tower, bridge deck, high noise. Any other class
 * gets a hue of its own from its number.
 */
export const CLASSIFICATION_COLORS: Record<number, string> = {
  0: '#9a9a9a', 1: '#c8c8c8', 2: '#a8743c', 3: '#9bd27a', 4: '#4fb04a', 5: '#1f7a34', 6: '#e8502e', 7: '#ff00ff',
  8: '#ffe14d', 9: '#2f7fe0', 10: '#6b4a2b', 11: '#55585e', 12: '#b9a0d8', 13: '#f2c14e', 14: '#f29e4c', 15: '#d7263d',
  16: '#f46036', 17: '#8d99ae', 18: '#ff3df2',
};
const CLASS_LUT = (() => {
  const out = new Uint16Array(256 * 3), c = new THREE.Color();
  for (let i = 0; i < 256; i++) {
    if (CLASSIFICATION_COLORS[i]) c.set(CLASSIFICATION_COLORS[i]);
    else c.setHSL(((i + 7) * 0.61803398875) % 1, 0.65, 0.55, THREE.SRGBColorSpace);
    out.set(lin16(c), i * 3);
  }
  return out;
})();

/** `(i) => value` over a tile's attribute, or null when the tile does not carry it. */
function reader(o: any, by: ColorBy): ((i: number) => number) | null {
  const a = o.geometry?.attributes?.[COLOR_BY_ATTRIBUTE[by]];
  if (!a?.count) return null;
  const arr = !a.isInterleavedBufferAttribute && a.itemSize === 1 ? a.array : null;
  return arr ? (i) => arr[i] : (i) => a.getX(i);
}

/** Whether a Points object carries what `by` needs. */
export const hasColorBy = (o: any, by: ColorBy) => reader(o, by) != null;

/** The 2nd to 98th percentile of the intensities of these objects, or null when none carries it. */
export function fitIntensityRange(objects: any[]): [number, number] | null {
  const vs: number[] = [];
  for (const o of objects) {
    const read = reader(o, 'intensity'), n = o.geometry?.attributes?.position?.count ?? 0;
    if (!read) continue;
    for (let i = 0, step = Math.max(1, Math.ceil(n / 4000)); i < n; i += step) vs.push(read(i));
  }
  if (vs.length < 2) return null;
  vs.sort((x, y) => x - y);
  const lo = vs[Math.floor(vs.length * 0.02)], hi = vs[Math.floor(vs.length * 0.98)];
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}

/** Fit the state's range of `by` again over these objects (a no-op for classification, which has a fixed palette). */
export function fitColorByRange(state: ColorByState, by: ColorBy, objects: any[]) {
  if (by === 'intensity') state.intensity = fitIntensityRange(objects) ?? state.intensity;
}

/**
 * Paint a Points object by `by`. Returns false when it lacks the attribute: it then keeps (gets back) its own colours.
 * Painted once per mode and range; the tile's own colour attribute is kept and `restoreColorBy` puts it back.
 */
export function applyColorBy(o: any, by: ColorBy, state: ColorByState): boolean {
  const g = o.geometry, n = g?.attributes?.position?.count ?? 0;
  if (!o.isPoints || !n) return false;
  const read = reader(o, by);
  if (!read) { restoreColorBy(o); return false; }
  if (by === 'intensity' && !state.intensity) state.intensity = fitIntensityRange([o]);
  const range = by === 'intensity' ? state.intensity ?? [0, 65535] : null;
  const key = range ? `${by}|${range.join('|')}` : by;
  const u = o.userData;
  if (u.__colorByKey === key) return true;
  if (!('__origColor' in u)) u.__origColor = g.attributes.color ?? null;
  const out = new Uint16Array(n * 3);
  if (range) {
    const lo = range[0], k = 255 / (range[1] - range[0] || 1);
    for (let i = 0; i < n; i++) {
      let t = (read(i) - lo) * k; t = t < 0 ? 0 : t > 255 ? 255 : t | 0;
      out[i * 3] = GREY[t * 3]; out[i * 3 + 1] = GREY[t * 3 + 1]; out[i * 3 + 2] = GREY[t * 3 + 2];
    }
  } else {
    for (let i = 0; i < n; i++) {
      const v = (read(i) & 255) * 3;
      out[i * 3] = CLASS_LUT[v]; out[i * 3 + 1] = CLASS_LUT[v + 1]; out[i * 3 + 2] = CLASS_LUT[v + 2];
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(out, 3, true));
  u.__colorByKey = key;
  delete u.__heightKey;                                         // lib/pointColors.ts repaints when height comes back
  return true;
}

/** Back to the tile's own colours (whichever of this module and the height mode painted it). */
export function restoreColorBy(o: any) {
  const u = o.userData;
  if (!('__origColor' in u)) return;
  if (u.__origColor) o.geometry.setAttribute('color', u.__origColor);
  else o.geometry.deleteAttribute('color');
  delete u.__origColor; delete u.__colorByKey; delete u.__heightKey;
}
