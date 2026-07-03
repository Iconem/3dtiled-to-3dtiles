import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, TransformControls, GizmoHelper, GizmoViewport } from '@react-three/drei';
import {
  TilesRenderer as TilesRendererR3F,
  TilesPlugin,
  GlobeControls,
  EnvironmentControls,
  CameraTransition,
} from '3d-tiles-renderer/r3f';
import { DebugTilesPlugin, XYZTilesOverlay } from '3d-tiles-renderer/plugins';
// GeneratedSurfacePlugin is exported at runtime (3d-tiles-renderer/src/three/plugins/index.js) but
// missing from this package's .d.ts — imported via the namespace + cast to dodge the stale types.
import * as ThreeTilesPlugins from '3d-tiles-renderer/plugins';
const GeneratedSurfacePlugin = (ThreeTilesPlugins as any).GeneratedSurfacePlugin;
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

const BASEMAP_URL: Record<'osm' | 'google', string> = {
  osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  google: 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
};

// Real slippy-map (XYZ) tile draping over a procedurally-generated WGS84 ellipsoid — no real terrain
// tileset needed. GeneratedSurfacePlugin (its own, SEPARATE TilesRenderer, independent of whatever
// content-tileset is loaded below) generates the ellipsoid mesh itself and textures it directly from
// the overlay (`applyOverlayTexture: true`); ImageOverlayPlugin, by contrast, only textures EXISTING
// tile geometry, so it can't be used here on its own for a basemap-with-no-real-terrain case.
function Globe({ basemap }: { basemap: 'google' | 'osm' | 'none' }) {
  const pluginArgs = useMemo(() => {
    if (basemap === 'none') return null;
    return { overlay: new XYZTilesOverlay({ url: BASEMAP_URL[basemap] }), shape: 'ellipsoid' as const, applyOverlayTexture: true };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemap]);
  if (!pluginArgs) return null;
  return (
    <TilesRendererR3F>
      <TilesPlugin plugin={GeneratedSurfacePlugin as any} args={pluginArgs as any} />
    </TilesRendererR3F>
  );
}

// Drag (or press W/E/R to switch translate/rotate/scale, drei/three.js's standard TransformControls
// shortcuts) directly on the loaded tileset's own root group — a manual alternative to typing lon/lat/
// alt for tilesets with no geographic locator.
function TilesetGizmo({ tilesRef }: { tilesRef: React.MutableRefObject<TilesRendererImpl | null> }) {
  const on = useViewerStore((s) => s.tilesetGizmoOn);
  if (!on || !tilesRef.current) return null;
  return <TransformControls object={tilesRef.current.group} mode="translate" />;
}

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
  // Individually-selected (not `const {...} = useThree()`, which subscribes to the ENTIRE R3F root
  // state — including `pointer`/`viewport`, which update on every mouse move) — that pattern was
  // re-rendering this whole component, and everything it computes, dozens of times a second while
  // dragging to orbit, which is very likely most of what read as "3DTRJS is slow".
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
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
  const basemap = useViewerStore((s) => s.basemap);
  // Whether the WGS84-radius wireframe globe is meaningful to show at all — see frameToTileset below.
  const [showGlobe, setShowGlobe] = useState(true);
  useEffect(() => { if (!loadArgs) setShowGlobe(true); }, [loadArgs]);

  useEffect(() => {
    if ('fov' in camera) (camera as THREE.PerspectiveCamera).fov = fov;
    (camera as THREE.PerspectiveCamera).updateProjectionMatrix?.();
    invalidate();
  }, [fov, camera, invalidate]);

  useEffect(() => {
    if (tilesRef.current) tilesRef.current.group.visible = assetVisible;
  }, [assetVisible]);

  // OrbitControls (drei) orbits around `.target`; GlobeControls/EnvironmentControls (3d-tiles-renderer)
  // orbit around `.pivotPoint`/`.zoomPoint` instead — neither has a dblclick-to-pivot built in, and
  // <CameraTransition>'s ortho↔perspective swap also reads whichever of these is set to decide what
  // point in space should stay visually fixed during the transition (see onBeforeToggle below), so
  // keeping this in sync is what fixes BOTH "double-click doesn't re-pivot" and the ortho zoom jump.
  const setControlsPivot = useCallback((point: THREE.Vector3) => {
    const controls = controlsRef.current;
    if (!controls) return;
    if (controls.target) controls.target.copy(point);
    if (controls.pivotPoint) controls.pivotPoint.copy(point);
    if ('zoomPoint' in controls) { controls.zoomPoint.copy(point); controls.zoomPointSet = true; }
    controls.update?.();
  }, []);

  // Nothing flies the camera to the loaded content otherwise — the Canvas camera starts at a fixed
  // deep-space default (see the `camera` prop below) and stays there, so any tileset not centered
  // exactly under that default view direction never appears (reported as "3DTRJS shows nothing").
  // Frame the camera on the root tile's bounding sphere as soon as it's known, and sync whichever
  // controls are active (orbit target, or globe/environment controls' internal state) to match.
  const frameToTileset = useCallback((tiles: TilesRendererImpl | null) => {
    if (!tiles) return;
    // Z offset composes onto the tileset's own transform, so a freshly-loaded tileset needs it applied
    // before we frame the camera on it — previously it only took effect the next time the user actually
    // edited the Z-offset field on an already-loaded tileset.
    const zOffset = store.getState().localFrame.zOffset;
    if (zOffset) tiles.group.position.y = zOffset;
    const sphere = new THREE.Sphere();
    if (!(tiles as any).getBoundingSphere(sphere)) return;
    tiles.group.updateWorldMatrix(true, false);
    sphere.applyMatrix4(tiles.group.matrixWorld);
    // A tileset with no real geographic placement loads with its own local origin near (0,0,0) — its
    // group transform is never moved onto the WGS84 ellipsoid (that's what 3d-tiles-renderer's
    // ReorientationPlugin is for, and we intentionally don't register it: it would also recenter — and
    // thus visually relocate — the many already-correctly-georeferenced presets this app tests against).
    // Showing the real-scale Earth sphere next to such local-only content is what read as "the globe
    // misplaced vs. the tileset": the tiny content sits deep inside a 6,378 km sphere it has no real
    // relationship to, invisible once the camera below auto-frames tightly on the small local content.
    // Only draw the globe when the bounding sphere is actually far enough from the origin to plausibly
    // BE a point on Earth's surface — the same heuristic ReorientationPlugin itself uses internally.
    const geoReferenced = sphere.center.length() > 6378137 * 0.5;
    setShowGlobe(geoReferenced);
    const fovRad = THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov ?? fov);
    const dist = (sphere.radius / Math.sin(fovRad / 2)) * 1.5;
    const dir = camera.position.clone().sub(sphere.center);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    camera.position.copy(sphere.center).addScaledVector(dir, dist);
    camera.near = Math.max(dist * 0.01, 0.1);
    // The far plane must also reach back to the globe sphere (always centered at world origin) when
    // it's shown — basing it purely on the local content's own size (as below) clipped the globe out
    // of view entirely for real georeferenced content sitting millions of meters from world origin.
    camera.far = geoReferenced
      ? Math.max(dist + sphere.radius * 4, camera.position.length() + 6378137 * 1.5)
      : dist + sphere.radius * 4;
    // EnvironmentControls assumes world +Y is "up", which is only true for local/non-georeferenced
    // content — real Earth-surface content needs the actual ellipsoid normal at that point instead, or
    // orbiting tilts the camera against the true horizon ("env mode has the wrong up" without this).
    // GlobeControls already derives this itself; setting it here too is harmless (same value either way).
    if (geoReferenced) {
      const ellipsoid = (tiles as any).ellipsoid;
      if (ellipsoid) camera.up.copy(ellipsoid.getPositionToNormal(sphere.center, new THREE.Vector3()));
    }
    camera.lookAt(sphere.center);
    (camera as THREE.PerspectiveCamera).updateProjectionMatrix?.();
    setControlsPivot(sphere.center);
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, invalidate, setControlsPivot]);

  // Double-click to re-pivot + zoom halfway toward the clicked point — mirrors CesiumViewer's own
  // LEFT_DOUBLE_CLICK handler (same 50%-lerp-toward-the-pick behavior) for consistency between renderers.
  useEffect(() => {
    const dom = gl.domElement;
    function onDblClick(e: MouseEvent) {
      const tiles = tilesRef.current;
      if (!tiles) return;
      const rect = dom.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObject(tiles.group, true)[0];
      if (!hit) return;
      camera.position.lerp(hit.point, 0.5);
      camera.lookAt(hit.point);
      setControlsPivot(hit.point);
      invalidate();
    }
    dom.addEventListener('dblclick', onDblClick);
    return () => dom.removeEventListener('dblclick', onDblClick);
  }, [gl, camera, invalidate, setControlsPivot]);

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
    setTerrainMode() { /* Cesium-only (Ion World Terrain / Google Photorealistic 3D Tiles) — no-op here */ },
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
      if (!tiles || !ellipsoid) { store.getState().setStatus('Load a tileset in 3DTRJS to set the crop box from view.'); return null; }
      // Raycast a handful of NDC points against the loaded content — tighter margins (±0.5, plus dead
      // center) than before (±0.8) since the auto-frame-on-load fit doesn't always leave content
      // reaching all the way to the far viewport corners, which made every ray miss and this silently
      // no-op ("not working").
      const raycaster = new THREE.Raycaster();
      const corners: THREE.Vector3[] = [];
      for (const [nx, ny] of [[0, 0], [-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
        raycaster.setFromCamera(new THREE.Vector2(nx, ny), camera);
        const hit = raycaster.intersectObject(tiles.group, true)[0];
        if (hit) corners.push(hit.point);
      }
      let w: number, e: number, s: number, n: number, minH: number, maxH: number;
      if (corners.length) {
        const lons: number[] = [], lats: number[] = [], heights: number[] = [];
        for (const c of corners) {
          const carto: any = {};
          ellipsoid.getPositionToCartographic(c, carto);
          lons.push(THREE.MathUtils.radToDeg(carto.lon));
          lats.push(THREE.MathUtils.radToDeg(carto.lat));
          heights.push(carto.height);
        }
        w = Math.min(...lons); e = Math.max(...lons); s = Math.min(...lats); n = Math.max(...lats);
        minH = Math.min(...heights); maxH = Math.max(...heights);
      } else {
        // No ray hit anything visible (e.g. camera framing content too loosely) — fall back to the
        // tileset's own bounding sphere so this always produces a usable box instead of no-oping.
        const sphere = new THREE.Sphere();
        if (!(tiles as any).getBoundingSphere(sphere)) { store.getState().setStatus('Point the 3DTRJS camera at the tileset, then retry.'); return null; }
        tiles.group.updateWorldMatrix(true, false);
        sphere.applyMatrix4(tiles.group.matrixWorld);
        const centerCarto: any = {};
        ellipsoid.getPositionToCartographic(sphere.center, centerCarto);
        const dLat = THREE.MathUtils.radToDeg(sphere.radius / 6378137);
        const dLon = dLat / Math.max(0.1, Math.cos(centerCarto.lat));
        const centerLat = THREE.MathUtils.radToDeg(centerCarto.lat);
        const centerLon = THREE.MathUtils.radToDeg(centerCarto.lon);
        w = centerLon - dLon; e = centerLon + dLon; s = centerLat - dLat; n = centerLat + dLat;
        minH = centerCarto.height - sphere.radius; maxH = centerCarto.height + sphere.radius;
      }
      store.getState().setCrop({ w, s, e, n, minH: Math.round(minH), maxH: Math.round(maxH) });
      return [w, s, store.getState().crop.minH, e, n, store.getState().crop.maxH];
    },
    getExtractMatrix() {
      const tiles = tilesRef.current;
      if (!tiles || tiles.group.position.lengthSq() === 0) return null;
      const m = new THREE.Matrix4().makeTranslation(tiles.group.position.x, tiles.group.position.y, tiles.group.position.z);
      return Array.from(m.elements);
    },
    flyToCity(lon, lat, height) { setPendingFlyTo({ lon, lat, height }); },
    autoZoomToTileset() { frameToTileset(tilesRef.current); },
    setControlMode(mode) { store.getState().setControlMode(mode); },
    setPointSize(px) { store.getState().setPointSize(px); },
    showCropGizmo() { store.getState().setCropGizmoOn(true); return true; },
    hideCropGizmo() { store.getState().setCropGizmoOn(false); },
    showTilesetGizmo() { store.getState().setTilesetGizmoOn(true); },
    hideTilesetGizmo() { store.getState().setTilesetGizmoOn(false); },
  }), [camera, invalidate, frameToTileset]);

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
      {/* Base globe surface. Hidden entirely for tilesets with no real geographic placement (see the
          comment in frameToTileset above). Otherwise a real OSM/Google-tile-draped WGS84 ellipsoid
          (see Globe above) when imagery is on, or a plain wireframe sphere as a ground reference when
          imagery is explicitly off. */}
      {showGlobe && (basemap === 'none' ? (
        <mesh>
          <sphereGeometry args={[6378137, 64, 64]} />
          <meshBasicMaterial color="#1a2a3a" wireframe />
        </mesh>
      ) : (
        <Globe basemap={basemap} />
      ))}
      {loadArgs && (
        <TilesRendererR3F
          ref={tilesRef as any}
          url={loadArgs.url}
          errorTarget={errorTarget}
          onLoadRootTileset={() => frameToTileset(tilesRef.current)}
        >
          {isSplat && <TilesPlugin plugin={GaussianSplatPlugin as any} args={{ renderer: gl, scene } as any} />}
          {debugTiles && <TilesPlugin plugin={DebugTilesPlugin as any} displayBoxBounds colorMode={7} />}
          {controlMode === 'globe' && <GlobeControls ref={controlsRef} enableDamping dampingFactor={0.05} minDistance={1} />}
          {controlMode === 'env' && <EnvironmentControls ref={controlsRef} enableDamping dampingFactor={0.05} minDistance={1} />}
        </TilesRendererR3F>
      )}
      {controlMode === 'orbit' && <OrbitControls ref={controlsRef} enableDamping dampingFactor={0.05} />}
      <CameraTransition
        mode={ortho ? 'orthographic' : 'perspective'}
        onBeforeToggle={(manager: any) => {
          const controls = controlsRef.current;
          if (controls?.isEnvironmentControls) {
            // GlobeControls/EnvironmentControls already do the right thing by default (this mirrors
            // CameraTransition's own built-in EnvironmentControls-aware branch) — getPivotPoint() reads
            // their real navigation focus, and adjustCamera() is what actually keeps the transition from
            // clipping/jumping. Our EARLIER attempt at this only set fixedPoint and skipped adjustCamera
            // entirely, which is very likely why the transition still looked wrong even with a pivot set.
            controls.getPivotPoint(manager.fixedPoint);
            manager.syncCameras();
            controls.adjustCamera(manager.perspectiveCamera);
            controls.adjustCamera(manager.orthographicCamera);
            return;
          }
          // OrbitControls has no such awareness, and the library's OWN fallback for this branch assumes
          // whatever the camera is looking at sits a fixed 50 units in front of it — wildly wrong for
          // content auto-framed at real-world (often kilometers-to-millions-of-meters) scale, which
          // produced the dramatic zoom jump switching in/out of orthographic. Use its tracked `.target`
          // (kept in sync by frameToTileset and double-click) instead.
          if (controls?.target) manager.fixedPoint.copy(controls.target);
          else manager.fixedPoint.set(0, 0, -1).transformDirection(camera.matrixWorld).multiplyScalar(50).add(camera.position);
          manager.syncCameras();
        }}
      />
      <CropGizmo tilesRef={tilesRef} />
      <TilesetGizmo tilesRef={tilesRef} />
      <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
        <GizmoViewport />
      </GizmoHelper>
    </>
  );
});

const ThreeDTRjsViewer = forwardRef<ViewerHandle, Props>(function ThreeDTRjsViewer({ visible }, ref) {
  const [loadArgs, setLoadArgs] = useState<LoadArgs>(null);
  const sceneRef = useRef<ViewerHandle>(null);

  useImperativeHandle(ref, (): ViewerHandle => ({
    load(url, type, opts) { setLoadArgs({ url, type, sseOverride: opts?.sseOverride }); },
    setBasemap: (...a) => sceneRef.current?.setBasemap(...a),
    setTerrainMode: (...a) => sceneRef.current?.setTerrainMode(...a),
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
    autoZoomToTileset: () => sceneRef.current?.autoZoomToTileset(),
    setControlMode: (...a) => sceneRef.current?.setControlMode?.(...a),
    setPointSize: (...a) => sceneRef.current?.setPointSize?.(...a),
    showCropGizmo: () => sceneRef.current?.showCropGizmo?.() ?? false,
    hideCropGizmo: () => sceneRef.current?.hideCropGizmo?.(),
    showTilesetGizmo: () => sceneRef.current?.showTilesetGizmo?.(),
    hideTilesetGizmo: () => sceneRef.current?.hideTilesetGizmo?.(),
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
