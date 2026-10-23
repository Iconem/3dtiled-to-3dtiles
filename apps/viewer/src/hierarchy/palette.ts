/**
 * Colour system for the hierarchy explorer.
 *
 * Two independent axes have to stay readable at once, so each gets its own channel:
 *   - WHICH TILESET  → hue. Held constant across every chart, so a series is identifiable by colour
 *                      alone in the tree, the breadth chart and the GE chart simultaneously.
 *   - HOW DEEP       → lightness, within that hue. Depth is ordinal, so an ordinal lightness ramp is
 *                      the honest encoding (a rainbow would imply categories that aren't there).
 *
 * Written in oklch to match the app's own theme tokens: perceptual lightness means the ramp steps
 * look evenly spaced rather than bunching in the middle the way an HSL ramp does.
 */

/** Series hues, ordered for maximum separation between the first few (most mosaics load 2–4). */
const SERIES = [
  { h: 250, c: 0.17, name: 'blue' },
  { h: 70, c: 0.15, name: 'amber' },
  { h: 160, c: 0.14, name: 'emerald' },
  { h: 15, c: 0.18, name: 'rose' },
  { h: 300, c: 0.17, name: 'violet' },
  { h: 200, c: 0.12, name: 'cyan' },
];

/** The flat identity colour for a series — legend chips, chart lines, badges. */
export function seriesColor(i: number, dark = true): string {
  const s = SERIES[i % SERIES.length];
  return `oklch(${dark ? 0.72 : 0.55} ${s.c} ${s.h})`;
}

/**
 * Depth-shaded variant of a series colour.
 *
 * The ramp runs toward the background in each theme (dark→light on dark, light→dark on light) so the
 * root end stays the most prominent, and the far end is clamped to keep ≥3:1 contrast against the
 * card surface — a tree whose deepest ring fades into the background hides exactly the truncation
 * these graphs exist to reveal.
 */
export function depthColor(i: number, level: number, maxLevel: number, dark = true): string {
  const s = SERIES[i % SERIES.length];
  const t = maxLevel > 0 ? Math.min(1, Math.max(0, level / maxLevel)) : 0;
  const l = dark ? 0.85 - t * 0.33 : 0.45 + t * 0.3;
  return `oklch(${l.toFixed(3)} ${(s.c * (dark ? 1 : 0.95)).toFixed(3)} ${s.h})`;
}
