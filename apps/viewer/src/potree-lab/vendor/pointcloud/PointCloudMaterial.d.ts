// Minimal types for the vendored, untyped PointCloudMaterial.js (used from TS by lib/addRefinePointSize.ts).
import { PointsMaterial } from 'three';
export const CHILD_BOXES: number;
export class PointCloudMaterial extends PointsMaterial {
  readonly isPointCloudMaterial: true;
  uniforms: Record<string, { value: any }>;
  pointShape: 'square' | 'round' | 'sphere';
  minPointSize: number;
  maxPointSize: number;
  edlStrength: number;
  edlRadius: number;
  [k: string]: any;
}
