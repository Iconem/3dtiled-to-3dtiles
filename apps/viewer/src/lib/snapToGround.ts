/**
 * "Snap to ground" — shared parameters of the two renderer implementations (CesiumViewer and
 * ThreeDTRjsViewer each sample with their own picking / terrain APIs, but the same way):
 *
 *  1. Lay a (2·HALF+1)² grid over the central half of the dataset's bounding sphere (≤ 5 km).
 *  2. At each node, pick the dataset's TOP surface with a narrow vertical ray (~1% of the sampled
 *     width; the globe is hidden while picking), and read the active terrain's height there.
 *  3. The Z offset moves by the 80th percentile of (terrain − dataset). Points on roofs, canopy or
 *     monuments sit above the ground and give the most negative differences; bare ground gives the
 *     largest, so a high percentile lands on the ground while tolerating some noise.
 *  4. Repeat once: moving the dataset changes which level of detail is on screen.
 *
 * Sparse point clouds miss most narrow picks, hence the dense grid; a result needs MIN_HITS samples.
 * The result is only as good as the terrain: Terrarium is ~30 m SRTM in most places and smooths
 * gorges and cliffs, and its heights are above mean sea level, not the ellipsoid.
 */
export const SNAP_HALF = 4;
export const SNAP_SAMPLES = (2 * SNAP_HALF + 1) ** 2;
export const SNAP_MIN_HITS = 5;
