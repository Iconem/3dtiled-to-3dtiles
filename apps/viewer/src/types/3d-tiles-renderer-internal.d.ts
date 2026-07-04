// 3d-tiles-renderer exposes its whole `src/` tree via package.json's "./src/*" export map entry, but
// only some files carry an adjacent .d.ts — PivotPointMesh.js (the small white-ring marker mesh
// GlobeControls/EnvironmentControls use for their own click-to-pivot indicator, reused as-is in
// ThreeDTRjsViewer's middle-click dolly for visual consistency) doesn't. Ambient-declare it here so
// deep-importing it type-checks.
declare module '3d-tiles-renderer/src/three/renderer/controls/PivotPointMesh.js' {
  import { Mesh } from 'three';

  export class PivotPointMesh extends Mesh {
    dispose(): void;
  }
}
