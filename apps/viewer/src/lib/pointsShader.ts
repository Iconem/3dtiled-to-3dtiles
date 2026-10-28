/**
 * Shader patch for three's PointsMaterial as used by the 3DTRjs viewer on 3D Tiles point clouds
 * (anything that is not a native Potree leaf, whose PointCloudMaterial already does all this).
 *
 *  - round sprites: the corners of the point quad are discarded, so overlapping points read as
 *    discs (what Potree and Cesium draw) instead of a lattice of squares;
 *  - a screen-size cap for attenuated points: three has no maximum, and a 20 cm "adaptive" point
 *    seen from 30 cm covers thousands of pixels — tens of thousands of those stall the GPU on fill
 *    rate (what zooming close into a dense cloud "freezing" looks like). Cesium's PointCloudShading
 *    has `maximumAttenuation` for the same reason. One shared uniform, set from the point-size
 *    slider; the floor keeps far tiles from vanishing into sub-pixel points;
 *  - ADD-refinement sizing: a Potree/COPC cloud streamed as 3D Tiles refines additively — a coarse
 *    tile keeps drawing under its finer children. Sized by its own spacing, its points are big blobs
 *    among the children's small ones. Each material carries the boxes of up to MAX_CHILD_BOXES
 *    visible direct children with the size to use inside each; a point inside a child's box takes
 *    the child's size (lib/addRefinePointSize.ts fills these every frame).
 */
import * as THREE from 'three';

export const MAX_POINT_PX = { value: 24 };
export const MAX_CHILD_BOXES = 8;

export interface ChildBoxUniforms {
  count: { value: number };
  inv: { value: THREE.Matrix4[] };
  min: { value: THREE.Vector3[] };
  max: { value: THREE.Vector3[] };
  size: { value: Float32Array };
}

export function patchPointsMaterial(material: any) {
  if (material.userData.__ptPatched) return;
  material.userData.__ptPatched = true;
  const u: ChildBoxUniforms = {
    count: { value: 0 },
    inv: { value: Array.from({ length: MAX_CHILD_BOXES }, () => new THREE.Matrix4()) },
    min: { value: Array.from({ length: MAX_CHILD_BOXES }, () => new THREE.Vector3()) },
    max: { value: Array.from({ length: MAX_CHILD_BOXES }, () => new THREE.Vector3()) },
    size: { value: new Float32Array(MAX_CHILD_BOXES) },
  };
  material.userData.childBoxes = u;
  material.onBeforeCompile = (shader: any) => {
    shader.uniforms.uMaxPointPx = MAX_POINT_PX;
    shader.uniforms.uChildCount = u.count;
    shader.uniforms.uChildInv = u.inv;
    shader.uniforms.uChildMin = u.min;
    shader.uniforms.uChildMax = u.max;
    shader.uniforms.uChildSize = u.size;
    shader.vertexShader = shader.vertexShader
      .replace('uniform float scale;', [
        'uniform float scale;',
        'uniform float uMaxPointPx;',
        'uniform int uChildCount;',
        `uniform mat4 uChildInv[${MAX_CHILD_BOXES}];`,
        `uniform vec3 uChildMin[${MAX_CHILD_BOXES}];`,
        `uniform vec3 uChildMax[${MAX_CHILD_BOXES}];`,
        `uniform float uChildSize[${MAX_CHILD_BOXES}];`,
      ].join('\n'))
      .replace('gl_PointSize = size;', [
        'gl_PointSize = size;',
        '#ifdef USE_SIZEATTENUATION',
        `for ( int i = 0; i < ${MAX_CHILD_BOXES}; i ++ ) {`,
        '  if ( i >= uChildCount ) break;',
        '  vec3 q = ( uChildInv[ i ] * vec4( position, 1.0 ) ).xyz;',
        '  if ( all( greaterThanEqual( q, uChildMin[ i ] ) ) && all( lessThanEqual( q, uChildMax[ i ] ) ) ) { gl_PointSize = uChildSize[ i ]; break; }',
        '}',
        '#endif',
      ].join('\n'))
      .replace('#include <logdepthbuf_vertex>', [
        '#ifdef USE_SIZEATTENUATION',
        'gl_PointSize = clamp( gl_PointSize, 1.0, uMaxPointPx );',
        '#endif',
        '#include <logdepthbuf_vertex>',
      ].join('\n'));
    shader.fragmentShader = shader.fragmentShader.replace('void main() {', [
      'void main() {',
      '  vec2 ptc = gl_PointCoord - 0.5;',
      '  if ( dot( ptc, ptc ) > 0.25 ) discard;',
    ].join('\n'));
  };
  material.customProgramCacheKey = () => 'iconem-points';
  material.needsUpdate = true;
}
