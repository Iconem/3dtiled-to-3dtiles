import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, TransformControls } from '@react-three/drei';
import {
  TilesRenderer as TilesRendererR3F,
  TilesPlugin,
  GlobeControls,
  EnvironmentControls,
  CameraTransition,
} from '3d-tiles-renderer/r3f';
import { DebugTilesPlugin } from '3d-tiles-renderer/plugins';
import type { TilesRenderer as TilesRendererImpl } from '3d-tiles-renderer';
import { GaussianSplatPlugin } from '3d-tiles-rendererjs-3dgs-plugin';
import * as THREE from 'three';
import type { ViewerHandle } from '@/lib/viewer-handle';
import type { AssetType } from '@/lib/formats';
import { useViewerStore } from '@/state/store';

// R3F port of viewer.html's 3DTilesRendererJS section (lines ~1838-2753). Uses 3d-tiles-renderer's
// OFFICIAL /r3f components (<TilesRenderer>, <TilesPlugin>, <GlobeControls>, <EnvironmentControls>,
// <CameraTransition>) instead of hand-rolled imperative three.js — see the plan file for why. The
// Gaussian-splat plugin (@sparkjsdev/spark-based) has no official R3F wrapper, so it's registered like
// any other TilesPlugin but its per-frame Spark update rides on the same useFrame TilesRenderer already
// drives (Spark's SplatMesh updates lazily via the scene graph, no extra tick needed for our purposes).
//
// The crop-box 3D gizmo is drei's <TransformControls> (translate + scale) on a plain box mesh — a
// first-pass replacement for viewer.html's hand-rolled PivotControls-style gizmo; it edits the SAME
// crop bbox store state, converting through the tileset's ellipsoid when the loaded asset is
// georeferenced (globe mode) and treating the box as local-metric otherwise.

interface Props { visible: boolean }

type LoadArgs = { url: string; type: AssetType; sseOverride?: number | null } | null;

function CropGizmo({ tilesRef }: { tilesRef: React.MutableRefObject<TilesRendererImpl | null> }) {
  const boxRef = useRef<THREE.Mesh>(null);
  const store = useViewerStore;
  const on = useViewerStore((s) => s.cropGizmoOn);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const { w, s, e, n, minH, maxH } = store.getState().crop;
    const tiles = tilesRef.current;
    const ellipsoid = (tiles as any)?.ellipsoid;
    if (ellipsoid && [w, s, e, n].every((v) => !Number.isNaN(v))) {
      const centerCarto = { lat: THREE.MathUtils.degToRad((s + n) / 2), lon: THREE.MathUtils.degToRad((w + e) / 2), height: (minH + maxH) / 2 };
      const pos = new THREE.Vector3();
      ellipsoid.getCartographicToPosition(centerCarto.lat, centerCarto.lon, centerCarto.height, pos);
      box.position.copy(pos);
      const dLat = THREE.MathUtils.degToRad(n - s), dLon = THREE.MathUtils.degToRad(e - w);
      const R = 6378137;
      box.scale.set(Math.max(1, dLon * R * Math.cos(centerCarto.lat)), Math.max(1, maxH - minH), Math.max(1, dLat * R));
    }
  }, [on]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!on) return null;
  return (
    <>
      <mesh ref={boxRef} visible={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="cyan" wireframe />
      </mesh>
      {boxRef.current && <TransformControls object={boxRef.current} mode="translate" />}
    </>
  );
}

const Scene = forwardRef<ViewerHandle, { loadArgs: LoadArgs }>(function Scene({ loadArgs }, ref) {
  const tilesRef = useRef<TilesRendererImpl | null>(null);
  const { camera, gl, scene, invalidate } = useThree();
  const store = useViewerStore;
  const [pendingFlyTo, setPendingFlyTo] = useState<{ lon: number; lat: number; height: number } | null>(null);
  const controlsRef = useRef<any>(null);

  const controlMode = useViewerStore((s) => s.controlMode);
  const ortho = useViewerStore((s) => s.ortho);
  const debugTiles = useViewerStore((s) => s.debugTiles);
  const fov = useViewerStore((s) => s.fov);
  const maxSSE = useViewerStore((s) => s.maxSSE);
  const assetVisible = useViewerStore((s) => s.assetVisible);
  const pointSize = useViewerStore((s) => s.pointSize);

  useEffect(() => {
    if ('fov' in camera) (camera as THREE.PerspectiveCamera).fov = fov;
    (camera as THREE.PerspectiveCamera).updateProjectionMatrix?.();
    invalidate();
  }, [fov, camera, invalidate]);

  useEffect(() => {
    if (tilesRef.current) tilesRef.current.group.visible = assetVisible;
  }, [assetVisible]);

  const isSplat = loadArgs?.type === 'splat';
  const isPoints = loadArgs?.type === 'pointcloud';
  const defaultSSE = isSplat ? 0.5 : loadArgs?.type === 'mesh' ? 16 : 4;
  const errorTarget = loadArgs?.sseOverride ?? maxSSE ?? defaultSSE;

  const applyPointSize = () => {
    const tiles = tilesRef.current;
    if (!tiles || !isPoints) return;
    tiles.group.traverse((o: any) => {
      if (o.isPoints && o.material) o.material.size = pointSize;
    });
  };
  useEffect(applyPointSize, [pointSize, loadArgs]);

  useImperativeHandle(ref, (): ViewerHandle => ({
    load() { /* handled via loadArgs prop from the outer component (URL change remounts TilesRenderer) */ },
    setBasemap() { /* the globe surface TilesRenderer below is always mounted; no per-provider imagery yet (first pass) */ },
    toggleTerrain() {},
    setMaxSSE(v) { store.getState().setMaxSSE(v); },
    toggleAssetVisible(show) { store.getState().setAssetVisible(show); },
    setOrtho(on) { store.getState().setOrtho(on); },
    toggleDebug(on) { store.getState().setDebugTiles(on); },
    applyShading() { /* shadeless/brightness is a Cesium-only CustomShader path; splats+meshes here use plain materials */ },
    setFov(deg) { store.getState().setFov(deg); },
    flyToLocalFrame(lon, lat, alt) {
      const tiles = tilesRef.current;
      const ellipsoid = (tiles as any)?.ellipsoid;
      if (!ellipsoid) return;
      const pos = new THREE.Vector3();
      ellipsoid.getCartographicToPosition(THREE.MathUtils.degToRad(lat), THREE.MathUtils.degToRad(lon), alt, pos);
      camera.position.copy(pos).add(new THREE.Vector3(0, 0, 200));
      camera.lookAt(pos);
      invalidate();
    },
    applyLocalFrame(lon, lat, alt, range) {
      flyToLocalFrameInternal(lon, lat, alt, range);
    },
    applyZOffset(v) {
      const tiles = tilesRef.current;
      if (!tiles) return;
      tiles.group.position.y = v;
      invalidate();
    },
    loadIonAsset() { store.getState().setStatus('Ion loading via 3DTRJS: not yet wired in this first pass.'); },
    toggleCollision() {},
    useCurrentView() {
      const p = camera.position;
      const tiles = tilesRef.current;
      const ellipsoid = (tiles as any)?.ellipsoid;
      if (ellipsoid) {
        const carto: any = {};
        ellipsoid.getPositionToCartographic(p, carto);
        return { lon: THREE.MathUtils.radToDeg(carto.lon), lat: THREE.MathUtils.radToDeg(carto.lat), alt: carto.height, range: 200 };
      }
      return { lon: 0, lat: 0, alt: p.length(), range: 200 };
    },
    setCropToView() {
      const tiles = tilesRef.current;
      const ellipsoid = (tiles as any)?.ellipsoid;
      if (!tiles || !ellipsoid) { store.getState().setStatus('Load a georeferenced tileset in 3DTRJS to set the crop box from view.'); return null; }
      const raycaster = new THREE.Raycaster();
      const corners: THREE.Vector3[] = [];
      for (const [nx, ny] of [[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]]) {
        raycaster.setFromCamera(new THREE.Vector2(nx, ny), camera);
        const hit = raycaster.intersectObject(tiles.group, true)[0];
        if (hit) corners.push(hit.point);
      }
      if (!corners.length) { store.getState().setStatus('Point the 3DTRJS camera at the tileset, then retry.'); return null; }
      const lons: number[] = [], lats: number[] = [];
      for (const c of corners) {
        const carto: any = {};
        ellipsoid.getPositionToCartographic(c, carto);
        lons.push(THREE.MathUtils.radToDeg(carto.lon));
        lats.push(THREE.MathUtils.radToDeg(carto.lat));
      }
      const w = Math.min(...lons), e = Math.max(...lons), s = Math.min(...lats), n = Math.max(...lats);
      store.getState().setCrop({ w, s, e, n });
      return [w, s, store.getState().crop.minH, e, n, store.getState().crop.maxH];
    },
    getExtractMatrix() {
      const tiles = tilesRef.current;
      if (!tiles || tiles.group.position.lengthSq() === 0) return null;
      const m = new THREE.Matrix4().makeTranslation(tiles.group.position.x, tiles.group.position.y, tiles.group.position.z);
      return Array.from(m.elements);
    },
    flyToCity(lon, lat, height) { setPendingFlyTo({ lon, lat, height }); },
    flyToOrigin() {
      camera.position.set(0, Math.max(camera.position.length(), 100), 0);
      camera.lookAt(0, 0, 0);
      invalidate();
    },
    setControlMode(mode) { store.getState().setControlMode(mode); },
    setPointSize(px) { store.getState().setPointSize(px); },
    showCropGizmo() { store.getState().setCropGizmoOn(true); return true; },
    hideCropGizmo() { store.getState().setCropGizmoOn(false); },
  }), [camera, invalidate]);

  function flyToLocalFrameInternal(lon: number, lat: number, alt: number, range: number) {
    const tiles = tilesRef.current;
    const ellipsoid = (tiles as any)?.ellipsoid;
    if (!ellipsoid) return;
    const pos = new THREE.Vector3();
    ellipsoid.getCartographicToPosition(THREE.MathUtils.degToRad(lat), THREE.MathUtils.degToRad(lon), alt, pos);
    const dir = pos.clone().normalize();
    camera.position.copy(pos.clone().add(dir.multiplyScalar(range)));
    camera.lookAt(pos);
    invalidate();
  }

  useEffect(() => {
    if (!pendingFlyTo || !tilesRef.current) return;
    flyToLocalFrameInternal(pendingFlyTo.lon, pendingFlyTo.lat, pendingFlyTo.height, 800);
    setPendingFlyTo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFlyTo, loadArgs]);

  return (
    <>
      <ambientLight intensity={1.2} />
      <directionalLight position={[1, 1, 1]} intensity={0.6} />
      {/* Base globe surface — a plain WGS84-radius sphere for visual ground reference (first pass: no
          imagery overlay; 3d-tiles-renderer's GeneratedSurfacePlugin, which viewer.html's buildGlobe()
          used for this, isn't part of the package's public/typed export surface). */}
      <mesh>
        <sphereGeometry args={[6378137, 64, 64]} />
        <meshBasicMaterial color="#1a2a3a" wireframe />
      </mesh>
      {loadArgs && (
        <TilesRendererR3F ref={tilesRef as any} url={loadArgs.url} errorTarget={errorTarget}>
          {isSplat && <TilesPlugin plugin={GaussianSplatPlugin as any} args={{ renderer: gl, scene } as any} />}
          {debugTiles && <TilesPlugin plugin={DebugTilesPlugin as any} displayBoxBounds colorMode={7} />}
          {controlMode === 'globe' && <GlobeControls enableDamping />}
          {controlMode === 'env' && <EnvironmentControls enableDamping />}
        </TilesRendererR3F>
      )}
      {controlMode === 'orbit' && <OrbitControls ref={controlsRef} enableDamping />}
      <CameraTransition mode={ortho ? 'orthographic' : 'perspective'} />
      <CropGizmo tilesRef={tilesRef} />
    </>
  );
});

const ThreeDTRjsViewer = forwardRef<ViewerHandle, Props>(function ThreeDTRjsViewer({ visible }, ref) {
  const [loadArgs, setLoadArgs] = useState<LoadArgs>(null);
  const sceneRef = useRef<ViewerHandle>(null);

  useImperativeHandle(ref, (): ViewerHandle => ({
    load(url, type, opts) { setLoadArgs({ url, type, sseOverride: opts?.sseOverride }); },
    setBasemap: (...a) => sceneRef.current?.setBasemap(...a),
    toggleTerrain: (...a) => sceneRef.current?.toggleTerrain(...a),
    setMaxSSE: (...a) => sceneRef.current?.setMaxSSE(...a),
    toggleAssetVisible: (...a) => sceneRef.current?.toggleAssetVisible(...a),
    setOrtho: (...a) => sceneRef.current?.setOrtho(...a),
    toggleDebug: (...a) => sceneRef.current?.toggleDebug(...a),
    applyShading: (...a) => sceneRef.current?.applyShading(...a),
    setFov: (...a) => sceneRef.current?.setFov(...a),
    flyToLocalFrame: (...a) => sceneRef.current?.flyToLocalFrame(...a),
    applyLocalFrame: (...a) => sceneRef.current?.applyLocalFrame(...a),
    applyZOffset: (...a) => sceneRef.current?.applyZOffset(...a),
    loadIonAsset: (...a) => sceneRef.current?.loadIonAsset(...a),
    toggleCollision: (...a) => sceneRef.current?.toggleCollision(...a),
    useCurrentView: () => sceneRef.current?.useCurrentView() ?? null,
    setCropToView: () => sceneRef.current?.setCropToView() ?? null,
    getExtractMatrix: () => sceneRef.current?.getExtractMatrix() ?? null,
    flyToCity: (...a) => sceneRef.current?.flyToCity(...a),
    flyToOrigin: () => sceneRef.current?.flyToOrigin(),
    setControlMode: (...a) => sceneRef.current?.setControlMode?.(...a),
    setPointSize: (...a) => sceneRef.current?.setPointSize?.(...a),
    showCropGizmo: () => sceneRef.current?.showCropGizmo?.() ?? false,
    hideCropGizmo: () => sceneRef.current?.hideCropGizmo?.(),
  }), []);

  return (
    <div style={{ position: 'absolute', inset: 0, visibility: visible ? 'visible' : 'hidden' }}>
      <Canvas camera={{ fov: 60, near: 0.1, far: 1e8, position: [0, 0, 1e7] }} gl={{ logarithmicDepthBuffer: true }}>
        <Scene ref={sceneRef} loadArgs={loadArgs} />
      </Canvas>
    </div>
  );
});

export default ThreeDTRjsViewer;
