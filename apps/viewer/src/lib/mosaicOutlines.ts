/**
 * Debug outlines of a tileset's OWN tiles — the ones declared in its tileset.json, without following
 * external references. On an /aggregate mosaic that is exactly its quadtree cells and the roots of
 * the datasets it references; on any other tileset, its declared tree. Each renderer's own debug mode
 * ("tiles") draws every tile it has loaded, externals included, which on a mosaic is thousands of
 * volumes; this one is the skeleton that the mosaic is.
 *
 * Output is renderer-neutral: ECEF polylines in the tileset's frame (apply the renderer's model matrix
 * on top), one entry per tile, with its depth and whether it is a group or a dataset root.
 */
import { llhToEcef } from '@/builder/geo';

export interface TileOutline {
  depth: number;
  /** A tile with content (a dataset root) rather than a grouping tile. */
  leaf: boolean;
  name?: string;
  /** Polylines, each a flat [x, y, z, x, y, z, …] in ECEF metres. */
  lines: number[][];
}

type M4 = number[];
const I4: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mul = (a: M4, b: M4): M4 => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const xf = (m: M4, p: number[]) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
const D = 180 / Math.PI;

/** The 12 edges of a region as arcs sampled along lon/lat, at both heights. Regions ignore transforms. */
function regionLines([w, s, e, n, h0, h1]: number[]): number[][] {
  const N = 12;
  const ring = (h: number) => {
    const out: number[] = [];
    const push = (lon: number, lat: number) => out.push(...llhToEcef(lon * D, lat * D, h));
    for (let i = 0; i <= N; i++) push(w + ((e - w) * i) / N, s);
    for (let i = 1; i <= N; i++) push(e, s + ((n - s) * i) / N);
    for (let i = 1; i <= N; i++) push(e - ((e - w) * i) / N, n);
    for (let i = 1; i <= N; i++) push(w, n - ((n - s) * i) / N);
    return out;
  };
  const vertical = [[w, s], [e, s], [e, n], [w, n]].map(([lo, la]) => [...llhToEcef(lo * D, la * D, h0), ...llhToEcef(lo * D, la * D, h1)]);
  return [ring(h0), ring(h1), ...vertical];
}

/** A box's 12 edges: centre + half axes (column-major 3×3), in the tile's frame. */
function boxLines(b: number[], m: M4): number[][] {
  const c = b.slice(0, 3), ax = b.slice(3, 6), ay = b.slice(6, 9), az = b.slice(9, 12);
  const corner = (sx: number, sy: number, sz: number) => xf(m, [0, 1, 2].map((i) => c[i] + sx * ax[i] + sy * ay[i] + sz * az[i]));
  const P = [corner(-1, -1, -1), corner(1, -1, -1), corner(1, 1, -1), corner(-1, 1, -1), corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1)];
  const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  return E.map(([a, b2]) => [...P[a], ...P[b2]]);
}

/** Three great circles of a sphere (world-aligned; a sphere has no orientation). */
function sphereLines([x, y, z, r]: number[], m: M4): number[][] {
  const c = xf(m, [x, y, z]);
  const N = 48;
  const circle = (u: number[], v: number[]) => {
    const out: number[] = [];
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * 2 * Math.PI;
      out.push(c[0] + r * (u[0] * Math.cos(t) + v[0] * Math.sin(t)), c[1] + r * (u[1] * Math.cos(t) + v[1] * Math.sin(t)), c[2] + r * (u[2] * Math.cos(t) + v[2] * Math.sin(t)));
    }
    return out;
  };
  return [circle([1, 0, 0], [0, 1, 0]), circle([0, 1, 0], [0, 0, 1]), circle([0, 0, 1], [1, 0, 0])];
}

/** Outlines of every tile declared in a tileset JSON (external references are not followed). */
export function tilesetOutlines(tileset: any): TileOutline[] {
  const out: TileOutline[] = [];
  (function walk(t: any, depth: number, parent: M4) {
    const m = t.transform ? mul(parent, t.transform) : parent;
    const bv = t.boundingVolume || {};
    const lines = bv.region ? regionLines(bv.region) : bv.box ? boxLines(bv.box, m) : bv.sphere ? sphereLines(bv.sphere, m) : [];
    if (lines.length) out.push({ depth, leaf: !!t.content?.uri, name: t.metadata?.properties?.name, lines });
    for (const c of t.children || []) walk(c, depth + 1, m);
  })(tileset.root, 0, I4);
  return out;
}

export async function fetchOutlines(tilesetUrl: string, signal?: AbortSignal): Promise<TileOutline[]> {
  const r = await fetch(tilesetUrl, { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return tilesetOutlines(await r.json());
}

/** Depth palette (groups) — leaves are drawn white. */
export const outlineColor = (o: TileOutline) => (o.leaf ? '#ffffff' : ['#f43f5e', '#f59e0b', '#84cc16', '#06b6d4', '#8b5cf6', '#ec4899', '#14b8a6', '#eab308'][o.depth % 8]);
