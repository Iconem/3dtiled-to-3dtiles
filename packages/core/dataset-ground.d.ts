export interface GroundSample { lon: number; lat: number; h: number; n: number }
export const GROUND_GRID: number;
export function datasetGroundSamples(
  tilesetUrl: string,
  opts?: { grid?: number; budget?: number; fetch?: typeof fetch; frame?: ArrayLike<number> | null },
): Promise<GroundSample[] | null>;
export function offsetFromSamples(
  samples: GroundSample[],
  terrain: (number | null)[],
): { dz: number; used: number; spread: number } | null;
