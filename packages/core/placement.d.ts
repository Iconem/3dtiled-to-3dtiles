export interface Placement {
  lon: number; lat: number; alt: number;
  /** degrees clockwise from north */
  heading: number;
  scale: number;
}
export interface DecomposedPlacement extends Placement {
  /** degrees between the matrix's vertical and the ellipsoid's */
  tilt: number;
  /** largest axis scale over the smallest; 1 when uniform */
  stretch: number;
  /** do the five numbers reproduce the matrix */
  exact: boolean;
}
export function placementMatrix(lon: number, lat: number, alt?: number, heading?: number, scale?: number): number[];
export function decomposePlacement(m: ArrayLike<number>): DecomposedPlacement;
export function placedStreamUrl(url: string, p: Placement): string;
export function isStreamUrl(url: string | null | undefined): boolean;
export function streamUrlPlacement(url: string): number[] | null;
export function placedTileset(
  sourceUrl: string, matrix: ArrayLike<number>,
  o: { sphere: ArrayLike<number>; geometricError: number; placement?: Placement },
): Record<string, unknown>;
