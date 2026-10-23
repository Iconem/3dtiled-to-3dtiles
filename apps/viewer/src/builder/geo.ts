/**
 * WGS84 and bounding-sphere maths for the Aggregate Builder's export. Same formulas as
 * packages/core/geo.js and aggregate-live.js's unionSphere, so a hand-built mosaic is bounded exactly
 * as a server-built one would be. No imports: selftest.ts runs this under plain Node.
 */
export type Sphere = [number, number, number, number];

const DEG = Math.PI / 180;
const A = 6378137.0;
const E2 = 0.00669437999014; // first eccentricity²

/** Geodetic (lon°, lat°, h m) → geocentric ECEF [x, y, z]. */
export function llhToEcef(lon: number, lat: number, h: number): [number, number, number] {
  const sLat = Math.sin(lat * DEG), cLat = Math.cos(lat * DEG);
  const N = A / Math.sqrt(1 - E2 * sLat * sLat);
  return [(N + h) * cLat * Math.cos(lon * DEG), (N + h) * cLat * Math.sin(lon * DEG), (N * (1 - E2) + h) * sLat];
}

/** ECEF → [lon°, lat°, h] (closed-form Bowring; sub-millimetre at Earth-surface heights). */
export function ecefToLlh(x: number, y: number, z: number): [number, number, number] {
  const b = A * Math.sqrt(1 - E2), ep2 = (A * A - b * b) / (b * b);
  const p = Math.hypot(x, y), th = Math.atan2(A * z, b * p);
  const lat = Math.atan2(z + ep2 * b * Math.sin(th) ** 3, p - E2 * A * Math.cos(th) ** 3);
  const N = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  return [Math.atan2(y, x) / DEG, lat / DEG, p / Math.cos(lat) - N];
}

/** Minimal sphere enclosing two spheres. */
export function unionSphere(a: Sphere | null, b: Sphere): Sphere {
  if (!a) return b;
  const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  if (d + b[3] <= a[3]) return a;
  if (d + a[3] <= b[3]) return b;
  const R = (d + a[3] + b[3]) / 2, k = (R - a[3]) / d;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, R];
}

/** Enclosing sphere of any 3D Tiles bounding volume (tile transform not applied, except for regions). */
export function sphereOfVolume(bv: { sphere?: number[]; box?: number[]; region?: number[] }): Sphere | null {
  if (bv.sphere) return bv.sphere.slice(0, 4) as Sphere;
  if (bv.box) {
    const b = bv.box;
    let r = 0;
    for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      r = Math.max(r, Math.hypot(sx * b[3] + sy * b[6] + b[9], sx * b[4] + sy * b[7] + b[10], sx * b[5] + sy * b[8] + b[11]));
    }
    return [b[0], b[1], b[2], r];
  }
  if (bv.region) {
    const [w, s, e, n, h0, h1] = bv.region;
    const pts: number[][] = [];
    for (let i = 0; i <= 2; i++) for (let j = 0; j <= 2; j++) for (const h of [h0, h1]) {
      pts.push(llhToEcef((w + ((e - w) * i) / 2) / DEG, (s + ((n - s) * j) / 2) / DEG, h));
    }
    const c = [0, 1, 2].map((k) => pts.reduce((acc, p) => acc + p[k], 0) / pts.length);
    const r = Math.max(...pts.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])));
    return [c[0], c[1], c[2], r * 1.05];
  }
  return null;
}

/** Transform a sphere by a column-major 4×4 (the largest axis scale scales the radius). */
export function transformSphere(s: Sphere, t?: number[]): Sphere {
  if (!t) return s;
  const [x, y, z, r] = s;
  const scale = Math.max(Math.hypot(t[0], t[1], t[2]), Math.hypot(t[4], t[5], t[6]), Math.hypot(t[8], t[9], t[10]));
  return [
    t[0] * x + t[4] * y + t[8] * z + t[12],
    t[1] * x + t[5] * y + t[9] * z + t[13],
    t[2] * x + t[6] * y + t[10] * z + t[14],
    r * scale,
  ];
}
