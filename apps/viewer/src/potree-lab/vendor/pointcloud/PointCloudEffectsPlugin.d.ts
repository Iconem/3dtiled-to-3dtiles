// Minimal types for the vendored, untyped PointCloudEffectsPlugin.js (used from TS by the viewer).
export interface PointCloudEffectsOptions {
  pointShape?: 'square' | 'round' | 'sphere';
  minPointSize?: number;
  /** PATCH (PR #1780, ed4bcbb3): largest projected size in pixels of an attenuated point; 0 for no cap. */
  maxPointSize?: number;
  edlStrength?: number;
  edlRadius?: number;
  debugColorMode?: 'none' | 'node' | 'depth' | 'tile';
}
export class PointCloudEffectsPlugin {
  constructor(options?: PointCloudEffectsOptions);
  name: string;
  pointShape: 'square' | 'round' | 'sphere';
  minPointSize: number;
  maxPointSize: number;
  edlStrength: number;
  edlRadius: number;
  debugColorMode: 'none' | 'node' | 'depth' | 'tile';
  [k: string]: any;
}
