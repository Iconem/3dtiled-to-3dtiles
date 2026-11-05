/**
 * A camera pose that means the same thing in both renderers and in a URL: where the camera is on the globe
 * (WGS84 degrees, metres above the ellipsoid) and how it looks from there (heading clockwise from north, pitch
 * above the horizon so looking down is negative, roll about the view axis; degrees).
 *
 * The renderers hold a camera as ECEF vectors (position, direction, up). The two functions here convert between
 * those and the pose with plain maths, so CesiumJS and 3DTilesRendererJS agree to the last digit: a pose read from
 * one globe (Bing 3D) and set on another (Google 3D) is the exact same view.
 */
export interface CameraPose { lon: number; lat: number; height: number; heading: number; pitch: number; roll: number }
export type Vec3 = [number, number, number];

const A = 6378137, F = 1 / 298.257223563, E2 = F * (2 - F);
const rad = (d: number) => (d * Math.PI) / 180, deg = (r: number) => (r * 180) / Math.PI;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** East, north and up unit vectors (ECEF) at a longitude and latitude in radians. */
function enu(lon: number, lat: number): { e: Vec3; n: Vec3; u: Vec3 } {
  const sl = Math.sin(lon), cl = Math.cos(lon), sp = Math.sin(lat), cp = Math.cos(lat);
  return { e: [-sl, cl, 0], n: [-sp * cl, -sp * sl, cp], u: [cp * cl, cp * sl, sp] };
}
const fromEnu = (b: { e: Vec3; n: Vec3; u: Vec3 }, v: Vec3): Vec3 =>
  [b.e[0] * v[0] + b.n[0] * v[1] + b.u[0] * v[2], b.e[1] * v[0] + b.n[1] * v[1] + b.u[1] * v[2], b.e[2] * v[0] + b.n[2] * v[1] + b.u[2] * v[2]];

/** Pose → ECEF position, view direction and up. */
export function poseToEcef(p: CameraPose): { position: Vec3; direction: Vec3; up: Vec3 } {
  const lon = rad(p.lon), lat = rad(p.lat), h = rad(p.heading), pt = rad(p.pitch), r = rad(p.roll);
  const N = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  const position: Vec3 = [(N + p.height) * Math.cos(lat) * Math.cos(lon), (N + p.height) * Math.cos(lat) * Math.sin(lon), (N * (1 - E2) + p.height) * Math.sin(lat)];
  const b = enu(lon, lat);
  const dir: Vec3 = [Math.sin(h) * Math.cos(pt), Math.cos(h) * Math.cos(pt), Math.sin(pt)];
  const right: Vec3 = [Math.cos(h), -Math.sin(h), 0];
  const up0: Vec3 = [-Math.sin(h) * Math.sin(pt), -Math.cos(h) * Math.sin(pt), Math.cos(pt)];
  const up: Vec3 = [up0[0] * Math.cos(r) + right[0] * Math.sin(r), up0[1] * Math.cos(r) + right[1] * Math.sin(r), up0[2] * Math.cos(r) + right[2] * Math.sin(r)];
  return { position, direction: fromEnu(b, dir), up: fromEnu(b, up) };
}

/** ECEF position, view direction and up → pose. */
export function ecefToPose(position: Vec3, direction: Vec3, up: Vec3): CameraPose {
  const [x, y, z] = position;
  const lon = Math.atan2(y, x), pxy = Math.hypot(x, y);
  let lat = Math.atan2(z, pxy * (1 - E2)), N = A;
  for (let i = 0; i < 6; i++) { N = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2); lat = Math.atan2(z + E2 * N * Math.sin(lat), pxy); }
  const height = pxy > 1 ? pxy / Math.cos(lat) - N : Math.abs(z) - A * (1 - F);
  const b = enu(lon, lat);
  const d = norm(direction), u = norm(up);
  const dl: Vec3 = [dot(d, b.e), dot(d, b.n), dot(d, b.u)], ul: Vec3 = [dot(u, b.e), dot(u, b.n), dot(u, b.u)];
  const pitch = Math.asin(Math.max(-1, Math.min(1, dl[2])));
  // straight up or down has no heading of its own: the up vector carries it
  const vertical = Math.hypot(dl[0], dl[1]) < 1e-6;
  const heading = vertical ? Math.atan2(-Math.sign(dl[2]) * ul[0], -Math.sign(dl[2]) * ul[1]) : Math.atan2(dl[0], dl[1]);
  const right: Vec3 = [Math.cos(heading), -Math.sin(heading), 0];
  const up0: Vec3 = [-Math.sin(heading) * Math.sin(pitch), -Math.cos(heading) * Math.sin(pitch), Math.cos(pitch)];
  const roll = Math.atan2(dot(ul, right), dot(ul, up0));
  return { lon: deg(lon), lat: deg(lat), height, heading: (deg(heading) + 360) % 360, pitch: deg(pitch), roll: deg(roll) };
}

/** `lon,lat,height,heading,pitch,roll` for a URL: about 10 cm and a hundredth of a degree of view. */
export function formatPose(p: CameraPose): string {
  const r = (v: number, d: number) => String(Number(v.toFixed(d)));
  return [r(p.lon, 6), r(p.lat, 6), r(p.height, 1), r(Number(p.heading.toFixed(2)) % 360, 2), r(p.pitch, 2), r(p.roll, 2)].join(',');
}

/** The reverse of formatPose; null when the text is not a pose. Heading, pitch and roll may be left out (north, straight down). */
export function parsePose(s: string | null | undefined): CameraPose | null {
  if (!s) return null;
  const v = s.split(',').map(Number);
  if (v.length < 3 || v.some((n) => !Number.isFinite(n))) return null;
  const [lon, lat, height, heading = 0, pitch = -90, roll = 0] = v as [number, number, number, number?, number?, number?];
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  return { lon, lat, height, heading, pitch: Math.max(-90, Math.min(90, pitch)), roll };
}
