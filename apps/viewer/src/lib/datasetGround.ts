/**
 * Where is the ground of a dataset? — the viewer side of packages/core/dataset-ground.js, which the
 * tile-server's `/aggregate?…&snap=` runs too, so a single tileset snapped here and a dataset snapped
 * inside a mosaic get the same offset (8 × 8 bins of the dataset's own top geometry; see there).
 */
import {
  datasetGroundSamples as coreSamples, offsetFromSamples, GROUND_GRID, type GroundSample,
} from '../../../../packages/core/dataset-ground.js';

export { offsetFromSamples, GROUND_GRID, type GroundSample };

export function datasetGroundSamples(tilesetUrl: string, { signal, ...opts }: { grid?: number; budget?: number; signal?: AbortSignal; frame?: ArrayLike<number> | null } = {}) {
  return coreSamples(tilesetUrl, { ...opts, fetch: ((u: RequestInfo | URL, init?: RequestInit) => fetch(u, { ...init, signal })) as typeof fetch });
}
