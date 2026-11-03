/**
 * ADD-refinement point sizing for 3D Tiles point clouds drawn with 3d-tiles-renderer's
 * PointCloudMaterial, whose shader this extends (see withChildBoxes).
 *
 * A /stream Potree or COPC cloud refines additively: a tile keeps drawing under its children, and
 * every tile is sized by its own spacing (geometricError). Where fine children are visible, the
 * coarse tile's points are blobs several times the size of the points around them. Potree sizes
 * each point by the deepest active node containing it (PointCloudMaterial's active-nodes texture,
 * which only PotreePlugin's own octree fills); this does the same at tile granularity for any
 * ADD tileset:
 *
 *   after every update, each visible points tile whose refine is ADD gets the boxes of its visible
 *   direct children (up to CHILD_BOXES, the finest first, looking through implicit subtree roots)
 *   and, for each, the size its points should take inside that box — the child's own base size
 *   scaled by the finest visible spacing anywhere in the child's subtree, so a deep zoom pulls the
 *   sizes down through every level.
 *
 * The boxes are expressed in each Points object's own vertex space via a matrix per child, so the
 * test in the vertex shader is a plain min/max compare. Registers on the parent renderer and on
 * every /stream child renderer the native-leaves plugin mounts.
 */
import * as THREE from 'three';

// Visible child-tile boxes a material can size by.
const CHILD_BOXES = 8;
const _inv = new THREE.Matrix4();
const _groupInv = new THREE.Matrix4();

/** Adds the child boxes to a PointCloudMaterial: a point inside one takes that child's world size. */
function withChildBoxes(material: any) {
  const u = material.uniforms;
  if (u.uChildCount) return u;
  u.uChildCount = { value: 0 };
  u.uChildInv = { value: Array.from({ length: CHILD_BOXES }, () => new THREE.Matrix4()) };
  u.uChildMin = { value: Array.from({ length: CHILD_BOXES }, () => new THREE.Vector3()) };
  u.uChildMax = { value: Array.from({ length: CHILD_BOXES }, () => new THREE.Vector3()) };
  u.uChildSize = { value: new Float32Array(CHILD_BOXES) };
  const base = material.onBeforeCompile;
  material.onBeforeCompile = (shader: any, renderer: any) => {
    base(shader, renderer);
    const size = 'float worldSize = size / pow( 2.0, activeResult.x + activeResult.z );';
    if (!shader.vertexShader.includes(size)) throw new Error('PointCloudMaterial: worldSize line not found');
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `
        uniform int uChildCount;
        uniform mat4 uChildInv[ ${CHILD_BOXES} ];
        uniform vec3 uChildMin[ ${CHILD_BOXES} ];
        uniform vec3 uChildMax[ ${CHILD_BOXES} ];
        uniform float uChildSize[ ${CHILD_BOXES} ];
        void main() {`)
      .replace(size, `${size}
        for ( int i = 0; i < ${CHILD_BOXES}; i ++ ) {
          if ( i >= uChildCount ) break;
          vec3 q = ( uChildInv[ i ] * vec4( position, 1.0 ) ).xyz;
          if ( all( greaterThanEqual( q, uChildMin[ i ] ) ) && all( lessThanEqual( q, uChildMax[ i ] ) ) ) {
            worldSize = uChildSize[ i ];
            break;
          }
        }`);
  };
  material.needsUpdate = true;
  return u;
}

function firstPoints(tile: any): any | null {
  const scene = tile.engineData?.scene;
  if (!scene) return null;
  let found: any = null;
  scene.traverse((o: any) => { if (!found && o.isPoints && o.material?.isPointCloudMaterial) found = o; });
  return found;
}

export class AddRefinePointSizePlugin {
  name = 'ADD_REFINE_POINT_SIZE_PLUGIN';
  tiles: any = null;
  private _minGE = new Map<any, number>();
  private _onUpdateAfter = () => this._apply();

  init(tiles: any) {
    this.tiles = tiles;
    tiles.addEventListener('update-after', this._onUpdateAfter);
  }

  dispose() {
    this.tiles?.removeEventListener('update-after', this._onUpdateAfter);
  }

  private _apply() {
    const tiles = this.tiles;
    const visible: Set<any> = tiles?.visibleTiles;
    if (!visible || visible.size === 0) return;
    const minGE = this._minGE;
    minGE.clear();
    // finest visible spacing within every visible tile's ADD subtree
    visible.forEach((t) => {
      const ge = t.geometricError;
      if (!Number.isFinite(ge)) return;
      for (let a = t; a; a = a.parent) {
        const cur = minGE.get(a);
        if (cur === undefined || ge < cur) minGE.set(a, ge);
        if (!a.parent || a.parent.refine !== 'ADD') break;
      }
    });
    tiles.group.updateWorldMatrix(true, false);
    _groupInv.copy(tiles.group.matrixWorld).invert();
    const groupInv = _groupInv;
    visible.forEach((t) => {
      const pts = firstPoints(t);
      if (!pts) return;
      const unsized = pts.material.uniforms;
      // PotreePlugin tiles size per point from the active-nodes texture already
      if (unsized.uActiveNodes.value || !pts.material.sizeAttenuation || t.refine !== 'ADD' || !t.children?.length) {
        if (unsized.uChildCount) unsized.uChildCount.value = 0;
        return;
      }
      const u = withChildBoxes(pts.material);
      // visible children with points, finest-spacing first. An implicit subtree root has no
      // content of its own (its model sits in a content child one level down), so a child without
      // points is looked through, a couple of levels deep.
      const kids: any[] = [];
      const collect = (tile: any, depth: number) => {
        for (const c of tile.children) {
          if (visible.has(c) && c.engineData?.scene) kids.push(c);
          else if (!c.engineData?.scene && depth < 3 && c.children?.length) collect(c, depth + 1);
        }
      };
      collect(t, 0);
      if (!kids.length) { u.uChildCount.value = 0; return; }
      kids.sort((a, b) => (minGE.get(a) ?? Infinity) - (minGE.get(b) ?? Infinity));
      pts.updateWorldMatrix(true, false);
      // points-local → tiles-group frame (the frame tile OBBs live in)
      _inv.copy(groupInv).multiply(pts.matrixWorld);
      let n = 0;
      for (const c of kids) {
        if (n >= CHILD_BOXES) break;
        const obb = c.engineData.boundingVolume?.obb;
        const cpts = firstPoints(c);
        if (!obb || !cpts) continue;
        const ratio = Math.min(1, (minGE.get(c) ?? c.geometricError) / c.geometricError || 1);
        u.uChildInv.value[n].copy(obb.inverseTransform).multiply(_inv);
        u.uChildMin.value[n].copy(obb.box.min);
        u.uChildMax.value[n].copy(obb.box.max);
        u.uChildSize.value[n] = cpts.material.size * ratio;
        n++;
      }
      u.uChildCount.value = n;
    });
  }
}
