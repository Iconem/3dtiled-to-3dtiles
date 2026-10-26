/**
 * "There is data here" markers for /aggregate mosaics in the 3DTRjs renderer — the counterpart of
 * CesiumViewer's PointPrimitiveCollection.
 *
 * One THREE.Points draw call: a fixed-pixel dot per dataset, a few metres above the WGS84 ellipsoid.
 * The "hide once the dataset spans more than 10% of the viewport" rule runs in the vertex shader
 * (radius / (distance·tan(fov/2)) — the same formula Cesium's DistanceDisplayCondition encodes), so
 * ~700 markers cost no per-frame JavaScript.
 *
 * Why not a 3DTRjs plugin: MVTAnnotationsPlugin / GeoJSONOverlay / ImageOverlayPlugin all drape
 * features onto tile SURFACES (so they need loaded geometry under them and scale with the ground),
 * and MVT would mean serving vector tiles for ~700 points. A marker must be visible exactly where
 * nothing has loaded yet, at a constant size, so a plain Points layer is the right tool.
 *
 * Positions are computed in the TILESET's frame and the layer follows `tiles.group.matrixWorld`, so
 * it stays glued to the globe whatever transform the viewer applies to the tileset group.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { WGS84_ELLIPSOID } from '3d-tiles-renderer';
import type { TilesRenderer as TilesRendererImpl } from '3d-tiles-renderer';
import type { DatasetMarker } from '@/lib/aggregate';
import { MARKER_COLORS, type TooltipChannel } from './DatasetTooltip';

export const MARKER_HIDE_FRACTION = 0.1;
const MARKER_LIFT_M = 30;
const PICK_RADIUS_PX = 8;

const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 aColor;
  attribute float aRadius;
  attribute float aSize;
  uniform float uTanHalf;
  uniform float uHideFraction;
  uniform float uPixelRatio;
  varying vec3 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // The dataset is big enough on screen to speak for itself: drop the marker (outside clip space).
    if (aRadius / (length(mv.xyz) * uTanHalf) > uHideFraction) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = aSize * uPixelRatio;
    vColor = aColor;
    #include <logdepthbuf_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying vec3 vColor;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    if (r > 0.5) discard;
    gl_FragColor = vec4(r > 0.34 ? vec3(0.043, 0.043, 0.059) : vColor, 1.0);   // dark outline ring
    #include <colorspace_fragment>
    #include <logdepthbuf_fragment>
  }
`;

/** Where a marker sits, in the tileset's frame. */
function localPosition(d: DatasetMarker, out: THREE.Vector3) {
  return WGS84_ELLIPSOID.getCartographicToPosition(
    THREE.MathUtils.degToRad(d.lat), THREE.MathUtils.degToRad(d.lon), MARKER_LIFT_M, out);
}

/** Fraction of the viewport height a sphere spans (Infinity when the camera is inside it). */
export function screenFraction(camera: THREE.Camera, center: THREE.Vector3, radius: number): number {
  if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
    const c = camera as THREE.OrthographicCamera;
    return radius / ((c.top - c.bottom) / (2 * c.zoom));
  }
  const dist = camera.position.distanceTo(center);
  if (dist <= radius) return Infinity;
  const fov = (camera as THREE.PerspectiveCamera).fov ?? 60;
  return radius / (dist * Math.tan(THREE.MathUtils.degToRad(fov) / 2));
}

export default function ThreeDatasetMarkers({ list, tilesRef, tooltip, onPick }: {
  list: DatasetMarker[];
  tilesRef: React.MutableRefObject<TilesRendererImpl | null>;
  tooltip: TooltipChannel;
  onPick: (d: DatasetMarker) => void;
}) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  const points = useMemo(() => {
    const n = list.length;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), rad = new Float32Array(n), size = new Float32Array(n);
    const v = new THREE.Vector3(), c = new THREE.Color();
    list.forEach((d, i) => {
      localPosition(d, v).toArray(pos, i * 3);
      // Picker-hidden datasets stay as small grey dots so they can be found and re-shown.
      c.set(d.inactive ? '#6b7280' : d.color ?? MARKER_COLORS[d.format] ?? '#94a3b8').toArray(col, i * 3);
      rad[i] = d.radius;
      size[i] = d.inactive ? 6 : 9;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aRadius', new THREE.BufferAttribute(rad, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    const m = new THREE.ShaderMaterial({
      vertexShader, fragmentShader,
      uniforms: { uTanHalf: { value: 0.577 }, uHideFraction: { value: MARKER_HIDE_FRACTION }, uPixelRatio: { value: 1 } },
    });
    const p = new THREE.Points(g, m);
    p.frustumCulled = false;          // positions span the globe; the shader does the culling
    p.matrixAutoUpdate = false;
    p.renderOrder = 10;
    p.raycast = () => {};             // never a pivot target for the globe controls
    return p;
  }, [list]);

  useEffect(() => () => { points.geometry.dispose(); (points.material as THREE.Material).dispose(); }, [points]);
  useEffect(() => { invalidate(); }, [points, invalidate]);

  // Follow the tileset group's transform and the camera's FOV. useFrame only runs when something
  // is being drawn anyway (frameloop="demand").
  useFrame(() => {
    const g = tilesRef.current?.group;
    if (g) points.matrix.copy(g.matrixWorld);
    else points.matrix.identity();
    points.matrixWorld.copy(points.matrix);
    const u = (points.material as THREE.ShaderMaterial).uniforms;
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 60;
    u.uTanHalf.value = Math.tan(THREE.MathUtils.degToRad(fov) / 2);
    u.uPixelRatio.value = gl.getPixelRatio();
  });

  // Hover + click by projecting the markers to screen space: cheaper and more forgiving than raycasting
  // points, and it applies exactly the visibility rules the shader does.
  useEffect(() => {
    const dom = gl.domElement;
    const world = list.map((d) => localPosition(d, new THREE.Vector3()));
    const tmp = new THREE.Vector3(), ndc = new THREE.Vector3(), toCam = new THREE.Vector3(), centre = new THREE.Vector3();
    let raf = 0, down: { x: number; y: number } | null = null, current: DatasetMarker | null = null;

    function markerAt(x: number, y: number, w: number, h: number): DatasetMarker | null {
      const m = points.matrix;
      centre.setFromMatrixPosition(m);                    // the Earth's centre in world space
      let best: DatasetMarker | null = null, bestD = PICK_RADIUS_PX;
      for (let i = 0; i < list.length; i++) {
        tmp.copy(world[i]).applyMatrix4(m);
        if (screenFraction(camera, tmp, list[i].radius) > MARKER_HIDE_FRACTION) continue;
        // behind the horizon: the camera is on the far side of the marker's tangent plane
        toCam.subVectors(camera.position, tmp);
        if (toCam.dot(tmp.clone().sub(centre)) < 0) continue;
        ndc.copy(tmp).project(camera);
        if (ndc.z > 1 || ndc.z < -1) continue;
        const d = Math.hypot((ndc.x + 1) / 2 * w - x, (1 - ndc.y) / 2 * h - y);
        if (d < bestD) { bestD = d; best = list[i]; }
      }
      return best;
    }
    function onMove(e: PointerEvent) {
      if (e.buttons) return;                              // dragging the globe — not hovering
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = dom.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        current = markerAt(x, y, r.width, r.height);
        dom.style.cursor = current ? 'pointer' : '';
        tooltip.current?.(current ? { d: current, x, y, w: r.width, h: r.height } : null);
      });
    }
    function onDown(e: PointerEvent) { down = { x: e.clientX, y: e.clientY }; }
    function onUp(e: PointerEvent) {
      if (down && current && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) onPickRef.current(current);
      down = null;
    }
    function onLeave() { current = null; dom.style.cursor = ''; tooltip.current?.(null); }
    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(raf);
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('pointerleave', onLeave);
      onLeave();
    };
  }, [list, points, camera, gl, tooltip]);

  return <primitive object={points} />;
}

/** Datasets inside the frustum and at least `minFraction` of the viewport tall. */
export function datasetsInView3d(list: DatasetMarker[], camera: THREE.Camera, groupMatrix: THREE.Matrix4 | null, minFraction: number): string[] {
  camera.updateMatrixWorld();
  // The live clip planes are not the question (after framing a world mosaic, near sits at 200 km until
  // the controls' next tick): test against the view pyramid alone.
  const wide = camera.clone() as THREE.PerspectiveCamera;
  if (wide.isPerspectiveCamera) { wide.near = 1; wide.far = 1e9; wide.updateProjectionMatrix(); }
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(wide.projectionMatrix, camera.matrixWorldInverse));
  const sphere = new THREE.Sphere();
  const ids: string[] = [];
  for (const d of list) {
    WGS84_ELLIPSOID.getCartographicToPosition(THREE.MathUtils.degToRad(d.lat), THREE.MathUtils.degToRad(d.lon), d.height, sphere.center);
    if (groupMatrix) sphere.center.applyMatrix4(groupMatrix);
    sphere.radius = d.radius;
    if (!frustum.intersectsSphere(sphere)) continue;
    if (screenFraction(camera, sphere.center, d.radius) >= minFraction) ids.push(d.id);
  }
  return ids;
}
