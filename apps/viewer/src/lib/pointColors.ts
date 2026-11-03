/**
 * Colour points by height (the Material section's "Height" mode). The colours are a replacement
 * `color` attribute, written on the CPU and kept beside the original: any point material draws it
 * (/stream tiles, native Potree leaves, the sprite shapes of PointCloudEffectsPlugin alike), and going
 * back to RGB only restores the attribute. Heights are the tileset's own, before the viewer's Z offset,
 * so a tile looks the same whether or not it has joined the scene yet.
 */
import * as THREE from 'three';
import { WGS84_ELLIPSOID } from '3d-tiles-renderer';

export type HeightRange = [number, number];

// blue, cyan, green, yellow, red, as linear RGB (glTF vertex colours are linear)
const RAMP = ['#2c3ec8', '#19b5d8', '#34c759', '#ffd60a', '#e5322d'].map((c) => new THREE.Color(c));

const tmpM = new THREE.Matrix4();
const tmpV = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const carto = { lat: 0, lon: 0, height: 0 };

/**
 * `o`'s matrix up to (not including) `stop`: the tileset's frame, whether attached yet or not. A native
 * Potree leaf's model holds source CRS coordinates and its tile may not be attached, so its top object
 * names where it goes (`userData.heightParent`, lib/nativeLeaves.ts): without the leaf's frame, a
 * projected Y of 6,500 km reads as ECEF, hundreds of km above the ellipsoid.
 */
function chainMatrix(o: THREE.Object3D, stop: THREE.Object3D | null, out: THREE.Matrix4) {
  if (o.matrixAutoUpdate) o.updateMatrix();
  out.copy(o.matrix);
  for (let c = o, p = o.parent ?? c.userData.heightParent; p && p !== stop && !(p as THREE.Scene).isScene; c = p, p = p.parent ?? c.userData.heightParent) {
    if (p.matrixAutoUpdate) p.updateMatrix();
    out.premultiply(p.matrix);
  }
  return out;
}

/** Calls `cb(height)` for every `step`-th point: a tile is small, so one normal and base height do. */
function forEachHeight(o: any, stop: THREE.Object3D | null, step: number, cb: (h: number, i: number) => void) {
  const pos = o.geometry?.attributes?.position;
  if (!pos?.count) return;
  chainMatrix(o, stop, tmpM);
  const g = o.geometry;
  if (!g.boundingSphere) g.computeBoundingSphere();
  tmpC.copy(g.boundingSphere.center).applyMatrix4(tmpM);
  let h0 = 0;
  if (tmpC.length() > 6378137 * 0.5) {
    WGS84_ELLIPSOID.getPositionToNormal(tmpC, tmpUp);
    h0 = WGS84_ELLIPSOID.getPositionToCartographic(tmpC, carto).height;
  } else tmpUp.set(0, 0, 1);                                    // local content: Z-up (3D Tiles)
  const e = tmpM.elements;
  const cx = tmpC.x, cy = tmpC.y, cz = tmpC.z, ux = tmpUp.x, uy = tmpUp.y, uz = tmpUp.z;
  for (let i = 0; i < pos.count; i += step) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const dx = e[0] * x + e[4] * y + e[8] * z + e[12] - cx;
    const dy = e[1] * x + e[5] * y + e[9] * z + e[13] - cy;
    const dz = e[2] * x + e[6] * y + e[10] * z + e[14] - cz;
    cb(h0 + dx * ux + dy * uy + dz * uz, i);
  }
}

/** The 2nd to 98th percentile of the heights of these Points objects (a few stray points don't count). */
export function fitHeightRange(objects: THREE.Object3D[], stop: THREE.Object3D | null): HeightRange | null {
  const hs: number[] = [];
  for (const o of objects) {
    const n = (o as any).geometry?.attributes?.position?.count ?? 0;
    forEachHeight(o, stop, Math.max(1, Math.ceil(n / 2000)), (h) => hs.push(h));
  }
  if (hs.length < 2) return null;
  hs.sort((a, b) => a - b);
  const lo = hs[Math.floor(hs.length * 0.02)], hi = hs[Math.floor(hs.length * 0.98)];
  return hi > lo ? [Math.floor(lo), Math.ceil(hi)] : [Math.floor(lo), Math.floor(lo) + 1];
}

/** Paint `o` by height over `range`, once per range. The original attribute is kept. */
export function applyHeightColors(o: any, range: HeightRange, stop: THREE.Object3D | null) {
  const g = o.geometry;
  const pos = g?.attributes?.position;
  if (!pos?.count) return;
  const key = range.join('|');
  if (o.userData.__heightKey === key) return;
  o.userData.__heightKey = key;
  if (!('__origColor' in o.userData)) o.userData.__origColor = g.attributes.color ?? null;
  const out = new Uint16Array(pos.count * 3);
  const span = range[1] - range[0] || 1, last = RAMP.length - 1;
  forEachHeight(o, stop, 1, (h, i) => {
    const t = THREE.MathUtils.clamp((h - range[0]) / span, 0, 1) * last;
    const k = Math.min(last - 1, Math.floor(t)), f = t - k;
    const a = RAMP[k], b = RAMP[k + 1];
    out[i * 3] = Math.round((a.r + (b.r - a.r) * f) * 65535);
    out[i * 3 + 1] = Math.round((a.g + (b.g - a.g) * f) * 65535);
    out[i * 3 + 2] = Math.round((a.b + (b.b - a.b) * f) * 65535);
  });
  g.setAttribute('color', new THREE.BufferAttribute(out, 3, true));
}

/** Back to the tile's own colours. */
export function restoreHeightColors(o: any) {
  if (!('__origColor' in o.userData)) return;
  const orig = o.userData.__origColor;
  if (orig) o.geometry.setAttribute('color', orig);
  else o.geometry.deleteAttribute('color');
  delete o.userData.__origColor;
  delete o.userData.__heightKey;
}
