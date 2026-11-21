/**
 * geometric-error.js: the rules several readers share to derive a tile's `geometricError`.
 *
 * SCREEN SIZE. A source that says "replace this node once its bounding sphere is `px` pixels across" (OSGB's
 * PagedLOD range in pixel mode, 3MX's maxScreenDiameter, I3S's maxScreenThreshold) is reproduced by
 *     geometricError = 2 · radius · 16 / px
 * A 3D Tiles client refines when geometricError · K / distance exceeds its target (K = viewport height / 2·tan(fov/2)),
 * and the sphere is 2 · radius · K / distance pixels across: both switch at the same distance when the target is 16 px,
 * the default maximumScreenSpaceError.
 *
 * DENSITY (`&ge=density` on /stream, for the formats whose error comes from the size of the box alone). The error of a
 * tile is the spacing of what it draws, the box rule being kept as a ceiling:
 *     spacing = √(largest face of the node's own box / count)
 *     error   = min(k · spacing, the box rule, the parent's error)
 * The largest face and not the volume, because this data lies on surfaces. k is 8 for splats (the factor streamed SOG
 * uses, sog-to-3dtiles/src/lodMeta.js), 1.5 for points and 1 for mesh vertices.
 */

/** The screen-space error, in pixels, that the errors written here are meant for: the default maximumScreenSpaceError. */
export const SSE_TARGET = 16;

/** k of the density rule, by what the count counts. */
export const DENSITY_K = { splats: 8, points: 1.5, mesh: 1 };

/**
 * The error that makes a client with a 16 px target refine a node when its bounding sphere is `px` pixels across.
 * A `px` under 1 (0: always refine) counts as 1.
 */
export function screenDiameterError(radius, px) {
  return 2 * radius * SSE_TARGET / Math.max(Number.isFinite(px) ? px : 0, 1);
}

/** The full side lengths of a 3D Tiles `box` (12 numbers: centre, then three half axes). */
export function boxSides(box) {
  return [Math.hypot(box[3], box[4], box[5]), Math.hypot(box[6], box[7], box[8]), Math.hypot(box[9], box[10], box[11])].map((h) => 2 * h);
}

/** The area of the largest face of a box of these side lengths. */
export function largestFace(sides) {
  const [a, b, c] = [...sides].sort((p, q) => q - p);
  return a * b;
}

/** √(largest face / count): the spacing of `count` samples lying on a surface the size of the box. null without a usable count or box. */
export function densitySpacing(sides, count) {
  const area = largestFace(sides);
  return count > 0 && area > 0 && Number.isFinite(area) ? Math.sqrt(area / count) : null;
}

/**
 * The density rule: min(k · spacing, the box rule, the parent's error). Without a count, or without a box, what is
 * left of it: min(the box rule, the parent's error).
 * @param {{ sides?: number[], area?: number, count?: number, k: number, boxError: number, parentError?: number }} o
 *   `sides`: the full side lengths of the node's own box, or `area`: its largest face when that is all there is.
 */
export function densityError({ sides, area, count, k, boxError, parentError = Infinity }) {
  const spacing = sides ? densitySpacing(sides, count) : (count > 0 && area > 0 ? Math.sqrt(area / count) : null);
  return Math.min(spacing != null ? k * spacing : Infinity, boxError, parentError ?? Infinity);
}

/**
 * I3S's own answer: a node's `lodThreshold` read through the layer's `lodSelectionMetricType` (node pages), or one
 * entry of a legacy node's `lodSelection[]` (`metricType`, `maxError`).
 *   maxScreenThresholdSQ  the screen area (px²) of the node's bounding sphere above which it is refined: a disc of
 *                         that area is √(4 · value / π) px across
 *   maxScreenThreshold    that diameter, in px
 *   density-threshold     (point clouds) the node's effective area, so √(value / vertexCount) is the spacing of its
 *                         points; the error is DENSITY_K.points times that
 * @returns the error, or null when the metric is another one or the value is missing (the caller falls back).
 */
export function i3sLodError({ metricType, value, radius, vertexCount }) {
  if (!Number.isFinite(value) || value < 0) return null;
  const metric = String(metricType ?? '').toLowerCase();
  if (metric === 'maxscreenthresholdsq') return screenDiameterError(radius, Math.sqrt(4 * value / Math.PI));
  if (metric === 'maxscreenthreshold') return screenDiameterError(radius, value);
  if (metric === 'density-threshold') return value > 0 && vertexCount > 0 ? DENSITY_K.points * Math.sqrt(value / vertexCount) : null;
  return null;
}

/** `ge=` of a /stream request → 'density', or undefined for the rules as they are (a number is Nexus's own factor). */
export const geRuleParam = (v) => (String(v ?? '').toLowerCase() === 'density' ? 'density' : undefined);
