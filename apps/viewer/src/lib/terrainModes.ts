/** Terrain choices, without pulling Cesium in (lib/terrarium.ts has the renderers' side). */
export type RasterTerrainId = 'terrarium' | 'mapterhorn' | 'mapterhorn-ellipsoid';

/**
 * Every terrain choice. `auto` is the default: Mapterhorn on the ellipsoid in whichever form the
 * renderer draws best — Re:Earth's quantized mesh in Cesium (its native format), the Terrarium tiles
 * of the same DEM in 3DTRjs (GPU-displaced, TerrariumMeshPlugin).
 */
export type TerrainMode = 'auto' | 'none' | 'wgs84' | 'cesium' | 'reearth-qm' | RasterTerrainId | 'google';

export function resolveTerrainMode(mode: TerrainMode, renderer: 'cesium' | '3dtrjs'): Exclude<TerrainMode, 'auto'> {
  if (mode !== 'auto') return mode;
  return renderer === 'cesium' ? 'reearth-qm' : 'mapterhorn-ellipsoid';
}

/** The raster to sample for "snap to ground" under a mode — the quantized mesh is the same DEM. */
export function snapRasterFor(mode: TerrainMode): RasterTerrainId | null {
  if (mode === 'auto' || mode === 'reearth-qm' || mode === 'mapterhorn-ellipsoid' || mode === 'none') return 'mapterhorn-ellipsoid';
  if (mode === 'mapterhorn' || mode === 'terrarium') return mode;
  return null;
}

