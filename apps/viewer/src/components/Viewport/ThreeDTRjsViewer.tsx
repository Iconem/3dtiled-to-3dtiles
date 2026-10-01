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
import { DebugTilesPlugin, XYZTilesOverlay, QuantizedMeshPlugin, CesiumIonAuthPlugin, ImageOverlayPlugin, GoogleCloudAuthPlugin, ImplicitTilingPlugin, GLTFExtensionsPlugin } from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
// GeneratedSurfacePlugin is exported at runtime (3d-tiles-renderer/src/three/plugins/index.js) but
// missing from this package's .d.ts — imported via the namespace + cast to dodge the stale types.
import * as ThreeTilesPlugins from '3d-tiles-renderer/plugins';
const GeneratedSurfacePlugin = (ThreeTilesPlugins as any).GeneratedSurfacePlugin;
const TerrariumMeshPlugin = (ThreeTilesPlugins as any).TerrariumMeshPlugin;
import { WGS84_ELLIPSOID, type TilesRenderer as TilesRendererImpl } from '3d-tiles-renderer';
import { PivotPointMesh } from '3d-tiles-renderer/src/three/renderer/controls/PivotPointMesh.js';
import { GaussianSplatPlugin } from '3d-tiles-rendererjs-3dgs-plugin';
import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import type { ViewerHandle } from '@/lib/viewer-handle';
import { MW, type AssetType } from '@/lib/formats';
import { CESIUM_ION_TOKEN } from '@/lib/ion';
import { GOOGLE_MAPS_API_KEY } from '@/lib/google';
import { installB3dmClientFixes } from '@/lib/b3dmClientFix';
import { useViewerStore } from '@/state/store';
import { RASTER_TERRAINS, REEARTH_QM_URL, resolveTerrainMode, sampleRasterTerrain, snapRasterFor, type RasterTerrainId } from '@/lib/terrarium';
import { BASEMAPS, type BasemapId } from '@/lib/basemaps';
import { tileDatasetId, type DatasetStyle } from '@/lib/datasetStyle';
import { fetchOutlines, outlineColor, type TileOutline } from '@/lib/mosaicOutlines';
import { datasetGroundSamples, offsetFromSamples } from '@/lib/datasetGround';
import { ImplicitAddRefineFixPlugin } from '@/lib/implicitAddFix';
import { SNAP_HALF, SNAP_SAMPLES, SNAP_MIN_HITS } from '@/lib/snapToGround';
import type { DatasetMarker } from '@/lib/aggregate';
import DatasetTooltip, { type TooltipChannel } from './DatasetTooltip';
import ThreeDatasetMarkers, { datasetsInView3d } from './ThreeDatasetMarkers';

// Fixes Clermont/Marseille-style crashes (see b3dmClientFix.ts) for tilesets loaded directly, with
// no ?tool=upgrade transform selected — those never touch packages/3dtiles-tools/upgrade.js's
// already-working server-side fixes for the exact same two real-world b3dm spec violations.
installB3dmClientFixes();

// GlobeControls/EnvironmentControls raycast the loaded scene on every drag/zoom interaction to find
// the point under the cursor to orbit/zoom around (so does our own double-click-to-pivot handler and
// "set crop box to view"), and three.js's DEFAULT Mesh.raycast checks every triangle brute-force —
// for a real-sized mesh/point-cloud tileset this is the actual per-frame cost behind "orbiting feels
// slow", not anything the frameloop="demand" switch above touches (that only helps the IDLE case).
// Patched once, globally: geometries opt in via `computeBoundsTree()` in onLoadModel below.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// Build a BVH for every mesh in a freshly-loaded tile so the raycasts above hit it instead of falling
// back to brute force. Points/Lines aren't meshes (no-op there — three-mesh-bvh is triangle-only).
// try/catch: a handful of malformed/degenerate tile geometries (zero triangles, no position attribute)
// throw inside computeBoundsTree rather than no-op — one bad tile shouldn't break the whole scene.
// Shared across every TilesRenderer instance (content + basemaps) — same pattern viewer.html used.
// Without this, any tileset whose glTF/GLB content is Draco-compressed (Bing 3D is the one that
// actually surfaced it: "THREE.GLTFLoader: No DRACOLoader instance provided") fails to decode geometry
// entirely, since 3d-tiles-renderer's GLTFExtensionsPlugin only wires Draco support when given a loader.
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');

// KTX2/BasisU-textured content (Bing 3D is the one that surfaced it: "THREE.GLTFLoader: setKTX2Loader
// must be called before loading KTX2 textures") needs a KTX2Loader too — unlike dracoLoader, it can't be
// a plain module-level singleton: `detectSupport(renderer)` needs the actual WebGLRenderer instance to
// pick GPU-native vs. software transcoding, which only exists once <Canvas> has mounted. Created inside
// Scene (below) via useMemo once `gl` is available instead. Pinned to this repo's exact `three` version
// (see root package.json) — the basis transcoder .wasm must match the loader JS that requests it.
const KTX2_TRANSCODER_PATH = 'https://unpkg.com/three@0.180.0/examples/jsm/libs/basis/';

// `TilesRendererBase.invokeOnePlugin('loadRootTileset')` runs the FIRST plugin (in registration-array
// order) that implements the hook — and `registerPlugin` inserts a LOWER-priority plugin EARLIER in
// that array (before any already-registered higher-priority one). QuantizedMeshPlugin sets
// `priority = -1000`; CesiumIonAuthPlugin defaults to 0 — so QuantizedMeshPlugin's OWN loadRootTileset
// ends up running FIRST regardless of JSX order, using `tiles.rootURL` still at CesiumIonAuthPlugin's
// un-resolved placeholder (`https://api.cesium.com/v1/assets/<id>/endpoint`) instead of the real,
// Ion-resolved terrain base URL. QuantizedMeshPlugin then builds `layer.json` against that placeholder,
// producing the malformed `.../assets/<id>/layer.json` request (real symptom: a 405 from Cesium Ion's
// API, which has no such route) — Ion's own endpoint-resolution never gets a chance to run first. Force
// a lower priority than QuantizedMeshPlugin's so CesiumIonAuthPlugin always wins that one hook.
class PrioritizedCesiumIonAuthPlugin extends CesiumIonAuthPlugin {
  constructor(...args: ConstructorParameters<typeof CesiumIonAuthPlugin>) {
    super(...args);
    (this as any).priority = -2000;
  }
}

function buildBoundsTrees(scene: THREE.Object3D) {
  scene.traverse((o: any) => {
    if (o.isMesh && o.geometry && !o.geometry.boundsTree) {
      try { o.geometry.computeBoundsTree(); } catch { /* leave unaccelerated for this one tile */ }
    }
  });
}

// Points have zero raycast area — a bare THREE.Raycaster needs a near-exact pixel hit to register
// anything at all, which is what made "double-click to zoom" often miss on point clouds. Widen the hit
// test to accept anything within ~15 screen pixels of the ray, converted to a world-space radius that
// scales with distance (so it feels like a constant 15px whether zoomed into a single sample or looking
// at a whole city, the same idea behind GlobeControls' own pixel-based tolerances) — harmless for
// mesh/triangle raycasts, `params.Points` is only ever consulted when testing THREE.Points objects.
// `refPoint` estimates how far into the scene the click will likely land — there's an inherent
// chicken-and-egg problem (the real distance isn't known until AFTER the raycast), so callers pass the
// last-framed tileset's own bounding-sphere center as a reasonable stand-in for "roughly how far away
// things are here".
function applyPointsPickTolerance(raycaster: THREE.Raycaster, camera: THREE.Camera, dom: HTMLElement, refPoint: THREE.Vector3, pixelRadius = 15) {
  const fovRad = THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov ?? 60);
  const distance = camera.position.distanceTo(refPoint) || 1;
  const worldPerPixel = (2 * distance * Math.tan(fovRad / 2)) / (dom.clientHeight || 1);
  raycaster.params.Points.threshold = worldPerPixel * pixelRadius;
}

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

type LoadArgs = { url: string; type: AssetType; sseOverride?: number | null; skipAutoFrame?: boolean } | null;

// Google's raw mt1.google.com tile hotlink sends no Access-Control-Allow-Origin header at all (unlike
// OSM's tile server, which does). That matters here because 3d-tiles-renderer's XYZTilesOverlay fetches
// tiles with plain `fetch()` (TiledImageSource.fetchItem, in 3d-tiles-renderer/src/three/plugins/images/
// sources/TiledImageSource.js) and feeds the bytes straight into `createImageBitmap` for a WebGL
// texture — NOT an <img> tag (which is how Cesium's own imagery pipeline gets away with hotlinking the
// same URL: a cross-origin <img> can be uploaded as a texture with no CORS headers at all, it just taints
// the canvas for pixel *readback*, which a basemap never needs). Under fetch()'s default `mode: 'cors'`,
// a response with no ACAO header makes the fetch() Promise reject outright, so the overlay never gets
// bytes and silently never textures anything.
//
// A first attempt forced `mode: 'no-cors'` for Google's fetches, reasoning that TiledImageSource never
// checks `res.ok` before `res.arrayBuffer()` so an opaque body should still decode — WRONG in practice:
// verified live that Chrome returns a genuinely EMPTY (0-byte) body for an opaque cross-origin response
// (a Spectre-era mitigation — opaque bodies aren't actually readable via fetch(), despite older docs/
// assumptions), so createImageBitmap always fails to decode.
//
// The actual fix: route Google's tile requests through this app's own tile-server, which already has a
// generic CORS-adding passthrough (`/proxy?url=<source>`, packages/tile-server/proxy-live.js) — verified
// live that fetching a tile THROUGH it returns a real, decodable 256×256 JPEG. Crucially, the proxy
// prefix must be applied via `preprocessURL` (an ImageOverlay constructor option, invoked in
// ImageOverlay.fetch() AFTER XYZImageSource.getUrl() has already substituted real x/y/z into the
// template) rather than baked into the raw URL template up front — `encodeURIComponent`-ing the whole
// `.../proxy?url=https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}` string turns the `{`/`}` into
// `%7B`/`%7D`, and XYZImageSource's placeholder-replace regex (which matches literal `{x}` etc.) then
// never matches — every tile silently requests the exact same broken literal-`{x}` URL forever. That's
// almost certainly what "a previous attempt through the proxy fired zero *varying* tile requests" was.
/** A basemap's layers as overlays, bottom first (lib/basemaps.ts) — Esri is imagery + a label layer. */
function makeBasemapOverlays(basemap: BasemapId): any[] {
  if (basemap === 'none') return [];
  return BASEMAPS[basemap].layers.map((l) => new XYZTilesOverlay({
    url: l.url,
    levels: l.maxZoom + 1,
    preprocessURL: l.proxy ? (url: string) => `${MW}/proxy?url=${encodeURIComponent(url)}` : undefined,
  } as any));
}

// Real slippy-map (XYZ) tile draping over a procedurally-generated WGS84 ellipsoid — no real terrain
// tileset needed. GeneratedSurfacePlugin (its own, SEPARATE TilesRenderer, independent of whatever
// content-tileset is loaded below) generates the ellipsoid mesh itself and textures it directly from
// the overlay (`applyOverlayTexture: true`); ImageOverlayPlugin, by contrast, only textures EXISTING
// tile geometry, so it can't be used here on its own for a basemap-with-no-real-terrain case.
function Globe({ basemap, gl }: { basemap: BasemapId; gl: THREE.WebGLRenderer }) {
  // The first layer textures the generated surface; any further ones (labels) are layered on top by
  // ImageOverlayPlugin.
  const [pluginArgs, extra] = useMemo(() => {
    const [base, ...rest] = makeBasemapOverlays(basemap);
    if (!base) return [null, null];
    return [{ overlay: base, shape: 'ellipsoid' as const, applyOverlayTexture: true }, rest.length ? { renderer: gl, overlays: rest } : null];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemap]);
  if (!pluginArgs) return null;
  // key={basemap}: GeneratedSurfacePlugin has no API to swap its `overlay` post-construction, so a
  // basemap change unregisters the old plugin instance and registers a fresh one (see makeBasemapOverlay
  // above) — but the plugin's own `dispose()` only releases overlay texture LOCKS for already-loaded
  // tiles, it never evicts their meshes. Those tiles keep the OLD overlay's texture baked into
  // `material.map` forever (until they happen to fall out of the LRU cache from panning/zooming), so
  // switching imagery left a patchwork of old-and-new tiles rather than a clean swap ("3DTRJS doing a
  // weird thing when switching xyz/tms tiles"). Forcing a full remount is the only reliable way to
  // guarantee every tile re-fetches against the new overlay.
  return (
    <TilesRendererR3F key={basemap} onLoadModel={(e: any) => buildBoundsTrees(e.scene)}>
      <TilesPlugin plugin={GeneratedSurfacePlugin as any} args={pluginArgs as any} />
      {extra && <TilesPlugin plugin={ImageOverlayPlugin as any} args={extra as any} />}
    </TilesRendererR3F>
  );
}

// Real Cesium World Terrain (Ion asset 1) via QuantizedMeshPlugin — actual elevation mesh, not the flat
// ellipsoid Globe above. CesiumIonAuthPlugin resolves the asset + attaches the token; QuantizedMeshPlugin
// fetches layer.json + per-tile quantized-mesh buffers and turns them into real geometry.
// ImageOverlayPlugin (NOT GeneratedSurfacePlugin — that one generates its own ellipsoid, which would
// fight with QuantizedMeshPlugin's real one) drapes the SAME basemap imagery on top of that real
// geometry when a basemap is selected; terrain itself still renders (bare, Cesium's own material) with
// basemap 'none'. This is the 3DTRJS equivalent of CesiumViewer's terrainMode==='cesium'.
function TerrainGlobe({ basemap, gl, url }: { basemap: BasemapId; gl: THREE.WebGLRenderer; url?: string }) {
  const overlays = useMemo(() => makeBasemapOverlays(basemap),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [basemap]);
  // `url` = an open quantized-mesh base (its layer.json is resolved against it); else Cesium ion asset 1.
  return (
    <TilesRendererR3F key={`${url ?? 'ion'}|${basemap}`} url={url} onLoadModel={(e: any) => buildBoundsTrees(e.scene)}>
      {!url && <TilesPlugin plugin={PrioritizedCesiumIonAuthPlugin as any} args={{ apiToken: CESIUM_ION_TOKEN, assetId: '1', autoRefreshToken: true } as any} />}
      <TilesPlugin plugin={QuantizedMeshPlugin as any} />
      {overlays.length > 0 && <TilesPlugin plugin={ImageOverlayPlugin as any} args={{ renderer: gl, overlays } as any} />}
    </TilesRendererR3F>
  );
}

// Open Terrarium elevation (AWS Terrain Tiles, no key) via 3DTRjs's own TerrariumMeshPlugin, which
// displaces a shared surface mesh on the GPU and drapes the basemap on it. The live renderer is kept in
// a module variable so "snap to ground" can ask the plugin for heights (sampleCartographicElevation) —
// GPU-displaced geometry is invisible to a plain raycast.
let terrariumTiles: TilesRendererImpl | null = null;

/**
 * Re:Earth's ellipsoidal Terrarium set answers its z0 tile with HTTP 500 ("Invalid typed array
 * length"; z1+ are fine), and TerrariumMeshPlugin cannot start without a root. The root is only ever
 * seen at planet scale, so it comes from the source's `rootUrl` instead (Mapterhorn's own sea-level
 * z0 — the ~±100 m geoid difference is invisible there, and every deeper level is the real thing).
 */
class TerrariumRootFallbackPlugin extends TerrariumMeshPlugin {
  constructor(opts: any) {
    super(opts);
    const rootUrl: string | undefined = opts.rootUrl;
    if (!rootUrl) return;
    // The plugin builds its XYZ image source in loadRootTileset and asks IT for every tile URL (for
    // tile content and for the texture fetch alike), so the substitution goes on the source.
    let source: any = (this as any)._source;
    Object.defineProperty(this, '_source', {
      configurable: true,
      get: () => source,
      set: (v: any) => {
        source = v;
        if (!v) return;
        const getUrl = v.getUrl.bind(v);
        v.getUrl = (x: number, y: number, level: number) => (level === 0 ? rootUrl : getUrl(x, y, level));
      },
    });
  }
}
function TerrariumGlobe({ basemap, source, gl }: { basemap: BasemapId; source: RasterTerrainId; gl: THREE.WebGLRenderer }) {
  const [args, extra] = useMemo(() => {
    const [overlay = null, ...rest] = makeBasemapOverlays(basemap);
    const src = RASTER_TERRAINS[source];
    // Mapterhorn is z12 everywhere and deeper only where regional DEMs exist; the plugin has no
    // per-tile fallback, so it stops at the globally complete level.
    const maxZoom = source === 'mapterhorn' ? 12 : src.maxZoom;
    return [
      { url: src.url, rootUrl: src.rootUrl, maxZoom, tileDimension: src.tileSize, overlay, applyOverlayTexture: !!overlay },
      rest.length ? { renderer: gl, overlays: rest } : null,
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemap, source]);
  return (
    <TilesRendererR3F key={`${basemap}|${source}`} ref={(t: any) => { terrariumTiles = t ?? null; }}>
      <TilesPlugin plugin={TerrariumRootFallbackPlugin as any} args={args as any} />
      {extra && <TilesPlugin plugin={ImageOverlayPlugin as any} args={extra as any} />}
    </TilesRendererR3F>
  );
}

// Google Photorealistic 3D Tiles — 3d-tiles-renderer's own first-party GoogleCloudAuthPlugin, using a
// real Google Maps Platform key (lib/google.ts) rather than brokering through Cesium ion. The plugin
// sets tiles.rootURL itself (https://tile.googleapis.com/v1/3dtiles/root.json) when unset, same
// self-resolving pattern as CesiumIonAuthPlugin above — no separate `url` prop needed. Already fully
// textured (real photos baked into the mesh) — no separate basemap imagery overlay needed or wanted
// here, unlike TerrainGlobe above.
function GoogleGlobe({ ktxLoader }: { ktxLoader: KTX2Loader }) {
  return (
    <TilesRendererR3F onLoadModel={(e: any) => buildBoundsTrees(e.scene)}>
      <TilesPlugin plugin={GoogleCloudAuthPlugin as any} args={{ apiToken: GOOGLE_MAPS_API_KEY, autoRefreshToken: true } as any} />
      {/* Google Photorealistic 3D Tiles ships Draco-compressed (and sometimes KTX2-textured) geometry —
          same decoders as content below. */}
      <TilesPlugin plugin={GLTFExtensionsPlugin as any} args={{ dracoLoader, ktxLoader } as any} />
    </TilesRendererR3F>
  );
}

// Drag directly on the loaded tileset's own root group — a manual alternative to typing lon/lat/alt
// for tilesets with no geographic locator. `pickScene` (set once `frameToTileset` confirms the
// tileset actually loaded — see the comment on its declaration) gates readiness instead of reading
// `tilesRef.current` directly in render: a plain ref mutation doesn't trigger a re-render, so toggling
// this gizmo on could easily land on a render where the ref was still null (tileset started loading
// but hadn't finished) and permanently return null for THIS render — nothing forced a follow-up
// render once the ref did populate. That's what "gizmo pill doesn't show it before I switch ortho/
// persp mode" actually was: switching modes just happened to trigger an UNRELATED re-render at a
// moment when the ref had since become valid.
function TilesetGizmo({ tilesRef, pickScene }: { tilesRef: React.MutableRefObject<TilesRendererImpl | null>; pickScene: THREE.Object3D | null }) {
  const on = useViewerStore((s) => s.tilesetGizmoOn);
  const mode = useViewerStore((s) => s.gizmoMode);
  const [proxy, setProxy] = useState<THREE.Object3D | null>(null);
  // Baseline transform captured whenever the gizmo (re)anchors. TransformControls attached directly to
  // `tilesRef.current.group` renders its handles at the GROUP's own local position — for georeferenced
  // content that's (0,0,0)-ish (the real ECEF placement is baked into the loaded tile hierarchy's OWN
  // transform, several levels below `group`), i.e. near Earth's center, nowhere close to what's actually
  // on screen ("gizmo doesn't work, only for local-origin tilesets" — those happen to have their content
  // sitting near (0,0,0) already, so group's own position coincides with the visible geometry). Drag a
  // proxy positioned at the tileset's actual bounding-sphere center instead, and re-apply the proxy's
  // motion — translated, and rotated/scaled AROUND that pivot rather than the group's own distant local
  // origin — onto the real group transform.
  const baseGroupPos = useRef(new THREE.Vector3());
  const baseGroupQuat = useRef(new THREE.Quaternion());
  const baseGroupScale = useRef(new THREE.Vector3(1, 1, 1));
  const basePivot = useRef(new THREE.Vector3());

  useEffect(() => {
    const tiles = tilesRef.current;
    if (!on || !proxy || !tiles) return;
    const sphere = new THREE.Sphere();
    tiles.group.updateWorldMatrix(true, false);
    const pivot = (tiles as any).getBoundingSphere(sphere)
      ? sphere.center.clone().applyMatrix4(tiles.group.matrixWorld)
      : tiles.group.getWorldPosition(new THREE.Vector3());
    basePivot.current.copy(pivot);
    baseGroupPos.current.copy(tiles.group.position);
    baseGroupQuat.current.copy(tiles.group.quaternion);
    baseGroupScale.current.copy(tiles.group.scale);
    proxy.position.copy(pivot);
    proxy.quaternion.identity();
    proxy.scale.set(1, 1, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, mode, proxy]);

  const handleChange = useCallback(() => {
    const tiles = tilesRef.current;
    if (!proxy || !tiles) return;
    const pivot = basePivot.current;
    const dPos = proxy.position.clone().sub(pivot);
    const dq = proxy.quaternion;
    const r = baseGroupPos.current.clone().sub(pivot).applyQuaternion(dq);
    tiles.group.position.copy(pivot).add(r).add(dPos);
    tiles.group.quaternion.copy(dq).multiply(baseGroupQuat.current);
    tiles.group.scale.set(
      baseGroupScale.current.x * proxy.scale.x,
      baseGroupScale.current.y * proxy.scale.y,
      baseGroupScale.current.z * proxy.scale.z,
    );
    tiles.group.updateMatrixWorld(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proxy]);

  if (!on || !pickScene || !tilesRef.current) return null;
  return (
    <>
      <object3D ref={setProxy} />
      {proxy && <TransformControls object={proxy} mode={mode} onChange={handleChange} />}
    </>
  );
}

function CropGizmo({ tilesRef, pickScene }: { tilesRef: React.MutableRefObject<TilesRendererImpl | null>; pickScene: THREE.Object3D | null }) {
  const boxRef = useRef<THREE.Mesh>(null);
  const store = useViewerStore;
  const on = useViewerStore((s) => s.cropGizmoOn);
  const mode = useViewerStore((s) => s.gizmoMode);

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
      // Orient the box to the LOCAL East/North/Up frame at its own position, not left at world/ECEF
      // identity — TransformControls' `space="local"` (below) then draws its arrows along this
      // rotation, so dragging actually moves the box east/north/up instead of along whatever direction
      // ECEF's global X/Y/Z axes happen to point at that spot on the globe ("only lets me translate
      // along weird axes"). A quick, correct-enough basis: ellipsoid "up" from the normal, then two
      // vectors perpendicular to it for east/north (exact heading doesn't matter for a crop box).
      const up = ellipsoid.getPositionToNormal(pos, new THREE.Vector3());
      const helper = Math.abs(up.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const east = new THREE.Vector3().crossVectors(helper, up).normalize();
      // (east, north, up) is the standard right-handed ENU triad (up = east × north), so (east, up,
      // north) — swapping the last two columns — is a LEFT-handed / mirrored basis: feeding that to
      // setFromRotationMatrix() below produced a reflection, not a rotation, which quaternions can't
      // represent correctly. The third column needs to be south (= east × up = -north) to keep the
      // basis proper — matching the "(E,U,-N)" convention this app's glTF content is already built in
      // (see potree-live.js's serveTileGlb comment).
      const south = new THREE.Vector3().crossVectors(east, up).normalize();
      box.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(east, up, south));
      const dLat = THREE.MathUtils.degToRad(n - s), dLon = THREE.MathUtils.degToRad(e - w);
      const R = 6378137;
      box.scale.set(Math.max(1, dLon * R * Math.cos(centerCarto.lat)), Math.max(1, maxH - minH), Math.max(1, dLat * R));
    }
  }, [on]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!on || !pickScene) return null;
  return (
    <>
      <mesh ref={boxRef}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="cyan" wireframe />
      </mesh>
      {boxRef.current && <TransformControls object={boxRef.current} mode={mode} space="local" />}
    </>
  );
}

/** A mosaic leaf's own dataset id (tile metadata, raw from the tileset JSON). */
const threeTileId = (t: any): string | undefined => t.metadata?.properties?.id;

/**
 * Hide / tint one loaded content model by its dataset (the aggregate picker). Visibility is the
 * scene's own flag, which TilesRenderer leaves alone (it adds/removes the scene from its group).
 * Points get a flat colour; meshes keep their texture, multiplied by the tint.
 */
function styleDatasetModel(scene: THREE.Object3D, tile: any, st: DatasetStyle | null) {
  const id = st ? tileDatasetId(tile, threeTileId) : null;
  scene.visible = !(id && st!.hidden.has(id));
  const c = id ? st!.colors?.get(id) : undefined;
  scene.traverse((o: any) => {
    for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
      if (!m.color) continue;
      const u = m.userData;
      if (c) {
        if (!u.dsOrig) u.dsOrig = { color: m.color.clone(), vertexColors: m.vertexColors };
        m.color.set(c);
        if (o.isPoints && m.vertexColors) { m.vertexColors = false; m.needsUpdate = true; }
      } else if (u.dsOrig) {
        m.color.copy(u.dsOrig.color);
        if (m.vertexColors !== u.dsOrig.vertexColors) { m.vertexColors = u.dsOrig.vertexColors; m.needsUpdate = true; }
        delete u.dsOrig;
      }
    }
  });
}

/**
 * Debug 'cells': the loaded tileset's own declared tiles (lib/mosaicOutlines.ts) as line segments,
 * parented to the TilesRenderer group so they follow its placement. Never raycast (double-click and
 * the controls' pivot pick must not land on a debug line).
 */
function MosaicOutlines({ url, tilesRef }: { url: string; tilesRef: React.MutableRefObject<TilesRendererImpl | null> }) {
  const invalidate = useThree((s) => s.invalidate);
  const [outlines, setOutlines] = useState<TileOutline[] | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    setOutlines(null);
    fetchOutlines(url, ac.signal).then((o) => { if (!ac.signal.aborted) setOutlines(o); }).catch(() => {});
    return () => ac.abort();
  }, [url]);
  useEffect(() => {
    const group = tilesRef.current?.group;
    if (!outlines || !group) return;
    const objs: THREE.LineSegments[] = [];
    for (const o of outlines) {
      const pos: number[] = [];
      for (const line of o.lines) for (let i = 0; i + 5 < line.length; i += 3) pos.push(line[i], line[i + 1], line[i + 2], line[i + 3], line[i + 4], line[i + 5]);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: outlineColor(o), depthTest: false, transparent: true, opacity: o.leaf ? 0.9 : 0.7 }));
      l.raycast = () => {};
      l.renderOrder = 10;
      group.add(l);
      objs.push(l);
    }
    invalidate();
    return () => { for (const l of objs) { group.remove(l); l.geometry.dispose(); (l.material as THREE.Material).dispose(); } invalidate(); };
  }, [outlines, tilesRef, invalidate]);
  return null;
}

const Scene = forwardRef<ViewerHandle, { loadArgs: LoadArgs; tooltip: TooltipChannel }>(function Scene({ loadArgs, tooltip }, ref) {
  const tilesRef = useRef<TilesRendererImpl | null>(null);
  // Individually-selected (not `const {...} = useThree()`, which subscribes to the ENTIRE R3F root
  // state — including `pointer`/`viewport`, which update on every mouse move) — that pattern was
  // re-rendering this whole component, and everything it computes, dozens of times a second while
  // dragging to orbit, which is very likely most of what read as "3DTRJS is slow".
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const ktxLoader = useMemo(() => {
    const loader = new KTX2Loader();
    loader.setTranscoderPath(KTX2_TRANSCODER_PATH);
    loader.detectSupport(gl);
    return loader;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl]);
  const invalidate = useThree((s) => s.invalidate);
  const store = useViewerStore;
  const [pendingFlyTo, setPendingFlyTo] = useState<{ lon: number; lat: number; height: number } | null>(null);
  const [markers, setMarkers] = useState<DatasetMarker[] | null>(null);
  const controlsRef = useRef<any>(null);
  // Cached local "up" (ellipsoid surface normal) at the loaded tileset's own location — set once in
  // frameToTileset, read by applyZOffsetInternal. null for non-georeferenced content (flat world-Y is
  // already correct "up" there — it's only wrong for content sitting elsewhere on the globe's surface).
  const upDirRef = useRef<THREE.Vector3 | null>(null);
  // Base position `applyZOffsetInternal` nudges away from — (0,0,0) normally, or the ENU anchor
  // `frameToTileset` places a non-georeferenced tileset at (see below) when one has been applied.
  const localAnchorRef = useRef<THREE.Vector3>(new THREE.Vector3());
  // Last-framed tileset bounding-sphere center — re-applied as the pivot/target whenever `controlMode`
  // switches to a control scheme that wasn't mounted at load time (e.g. loading in 'globe' mode, then
  // switching to 'orbit' afterward). Without this, a freshly-mounted OrbitControls initializes its own
  // `.target` at the default (0,0,0) — for georeferenced (ECEF-scale) content that's ~Earth's center,
  // not the tileset ("orbit pivot/target should be the tileset origin, not earth center").
  const lastSphereCenterRef = useRef<THREE.Vector3 | null>(null);
  // Whether THIS load needed the synthetic ENU anchor below (null = not yet determined). Decided ONCE,
  // on the fresh-load call, from the tileset's true native bounding sphere (still near local origin at
  // that point) — and then REUSED as-is on every later re-frame (e.g. "Auto-zoom to tileset"). Re-testing
  // `sphere.center.length()` on a later call is unsound: by then `tiles.group`'s transform already IS the
  // anchor we applied, so the (now world-space) sphere sits near the real ellipsoid surface regardless of
  // whether this content is genuinely georeferenced or was only synthetically anchored here — indistinguishable
  // from the "real georeferenced" case, so a later call would wrongly take the `else` branch below and
  // reset `tiles.group.quaternion` to identity, wiping the east/north/up basis while leaving position at
  // the anchor point. That is the exact mechanism behind "up is wrong after clicking Auto-zoom" even with
  // zero free navigation in between — reproduces in every controls mode because it happens before any
  // controls code ever runs.
  const needsEnuAnchorRef = useRef<boolean | null>(null);

  // Z-offset used to be a flat `group.position.y = v` — correct only for local/non-georeferenced
  // content near the world origin. For real georeferenced content sitting somewhere else on the
  // ellipsoid, world +Y isn't "up" at that point (it's only ever "up" relative to Earth's own center),
  // so a flat Y-set nudged the content sideways/diagonally instead of vertically — reported as "Z
  // offset applied in the same weird CRS rather than ENU". Move along the cached local-up direction
  // instead when one is available.
  const applyZOffsetInternal = useCallback((tiles: TilesRendererImpl, v: number) => {
    const anchor = localAnchorRef.current;
    if (upDirRef.current) tiles.group.position.copy(anchor).addScaledVector(upDirRef.current, v);
    else tiles.group.position.set(anchor.x, anchor.y + v, anchor.z);
  }, []);

  const controlMode = useViewerStore((s) => s.controlMode);
  const ortho = useViewerStore((s) => s.ortho);
  const debugMode = useViewerStore((s) => s.debugMode);
  const pointAdaptive = useViewerStore((s) => s.pointAdaptive);
  const fov = useViewerStore((s) => s.fov);
  const maxSSE = useViewerStore((s) => s.maxSSE);
  const assetVisible = useViewerStore((s) => s.assetVisible);
  const pointSize = useViewerStore((s) => s.pointSize);
  const basemap = useViewerStore((s) => s.basemap);
  const terrainMode = useViewerStore((s) => s.terrainMode);
  const terrain = resolveTerrainMode(terrainMode, '3dtrjs');
  const datasetStyleRef = useRef<DatasetStyle | null>(null);
  // Whether the WGS84-radius wireframe globe is meaningful to show at all — see frameToTileset below.
  const [showGlobe, setShowGlobe] = useState(true);
  useEffect(() => { if (!loadArgs) setShowGlobe(true); }, [loadArgs]);
  useEffect(() => { setPickScene(null); }, [loadArgs]);

  // GlobeControls/EnvironmentControls default to raycasting the WHOLE R3F scene (3d-tiles-renderer's
  // own ControlsBaseComponent falls back to useThree's default scene when no `scene` prop is given) to
  // find the point under the cursor to orbit/pivot around — which sweeps up our OWN UI furniture too:
  // the crop/tileset TransformControls gizmo handles, the bottom-right GizmoHelper compass, lights.
  // That's very likely the "Cannot read properties of null (reading 'layers')" crash reported with
  // these controls — none of that furniture is meant to be pickable, and TransformControls in
  // particular churns internal helper objects during a drag. Scope the raycast to just the loaded
  // content group once it's actually mounted (set from onLoadRootTileset below, so it's never a stale
  // ref read at render time) instead of the whole scene.
  const [pickScene, setPickScene] = useState<THREE.Object3D | null>(null);

  useEffect(() => {
    if ('fov' in camera) (camera as THREE.PerspectiveCamera).fov = fov;
    (camera as THREE.PerspectiveCamera).updateProjectionMatrix?.();
    invalidate();
  }, [fov, camera, invalidate]);

  useEffect(() => {
    if (tilesRef.current) tilesRef.current.group.visible = assetVisible;
    invalidate();
  }, [assetVisible, invalidate]);

  // OrbitControls (drei) orbits around `.target`; GlobeControls/EnvironmentControls (3d-tiles-renderer)
  // orbit around `.pivotPoint`/`.zoomPoint` instead — neither has a dblclick-to-pivot built in, and
  // <CameraTransition>'s ortho↔perspective swap also reads whichever of these is set to decide what
  // point in space should stay visually fixed during the transition (see onBeforeToggle below), so
  // keeping this in sync is what fixes BOTH "double-click doesn't re-pivot" and the ortho zoom jump.
  const setControlsPivot = useCallback((point: THREE.Vector3, resetZoomState = false) => {
    const controls = controlsRef.current;
    if (!controls) return;
    if (controls.target) controls.target.copy(point);
    if (controls.pivotPoint) controls.pivotPoint.copy(point);
    if ('zoomPoint' in controls) { controls.zoomPoint.copy(point); controls.zoomPointSet = true; }
    // Only used after a hard camera teleport (frameToTileset) — see call site for why this is NOT the
    // default for every setControlsPivot caller (double-click-to-pivot, camera tween, etc. all want the
    // controls' live interactive zoom/drag state left alone).
    if (resetZoomState) {
      // GlobeControls/EnvironmentControls.update() unconditionally clears `zoomPointSet` back to false
      // BEFORE checking `zoomDirectionSet` inside `_setFrame()` (see EnvironmentControls.js's `update()`
      // then `_setFrame()`) — `zoomDirectionSet` is only ever cleared by real pointer input, never by us
      // repositioning the camera programmatically. Left stale from free navigation (e.g. the user
      // scroll-zoomed way out to a whole-Earth view before hitting "Auto-zoom to tileset"), the very next
      // controls tick after we jump the camera back near the tileset re-raycasts along that STALE
      // direction from the camera's BRAND NEW position, produces a garbage `zoomPoint` on the opposite
      // side of the globe, and then rotates/shifts the camera to keep THAT point fixed on screen while
      // reconciling old-up vs. new-up — this is the actual mechanism behind "up is wrong after
      // free-navigate then auto-zoom-to-tileset" (verified live: without this reset, `zoomDirectionSet`/
      // `zoomPointSet` remained `true` with a stale `zoomPoint` millions of meters from the tileset after
      // calling frameToTileset, and the camera visibly teleported to the wrong side of the Earth on the
      // controls' next tick). Also drop any leftover drag/rotate/zoom state and cached zoom delta for the
      // same reason — none of it describes anything meaningful about the camera's brand new position.
      controls.zoomDirectionSet = false;
      controls.zoomDelta = 0;
      controls.resetState?.();
    }
    controls.update?.();
  }, []);

  // Nothing flies the camera to the loaded content otherwise — the Canvas camera starts at a fixed
  // deep-space default (see the `camera` prop below) and stays there, so any tileset not centered
  // exactly under that default view direction never appears (reported as "3DTRJS shows nothing").
  // Frame the camera on the root tile's bounding sphere as soon as it's known, and sync whichever
  // controls are active (orbit target, or globe/environment controls' internal state) to match.
  const frameToTileset = useCallback((tiles: TilesRendererImpl | null, isFreshLoad = false) => {
    if (!tiles) return;
    const sphere = new THREE.Sphere();
    if (!(tiles as any).getBoundingSphere(sphere)) return;
    tiles.group.updateWorldMatrix(true, false);
    sphere.applyMatrix4(tiles.group.matrixWorld);

    // A tileset with no real geographic placement loads with its own local origin near (0,0,0) — bake
    // the user's Local Frame lon/lat/alt in as an ENU anchor so the globe/basemap machinery below (which
    // all key off "is the bounding sphere far from world origin") treats it the same as real
    // georeferenced content instead of hiding the globe for it entirely ("3DTRJS should also display the
    // globe for local tilesets, at the user-defined lon/lat/alt"). Skip this for content that's ALREADY
    // georeferenced (its own tileset.json root transform already placed it on the real ellipsoid) —
    // re-anchoring that would visibly relocate already-correct content.
    const ellipsoidForAnchor = (tiles as any).ellipsoid;
    // "Centre near the origin" alone does not mean local content: a worldwide /aggregate mosaic is
    // bounded by an Earth-centred sphere (centre 0,0,0, radius ~6 400 km). A planet-sized sphere is
    // global data, and anchoring it to the local frame would fling every dataset off the globe.
    const planetScale = (sp: THREE.Sphere) => sp.center.length() <= 6378137 * 0.5 && sp.radius > 6378137 * 0.5;
    // Decide (and cache) this ONLY on the fresh-load call — see needsEnuAnchorRef's own comment for why
    // re-deriving it from `sphere.center.length()` on a later re-frame call is unsound.
    if (isFreshLoad) needsEnuAnchorRef.current = sphere.center.length() <= 6378137 * 0.5 && !planetScale(sphere) && !!ellipsoidForAnchor;
    if (needsEnuAnchorRef.current && ellipsoidForAnchor) {
      const { lon, lat, alt } = store.getState().localFrame;
      const anchor = new THREE.Vector3();
      ellipsoidForAnchor.getCartographicToPosition(THREE.MathUtils.degToRad(lat), THREE.MathUtils.degToRad(lon), alt, anchor);
      const up = ellipsoidForAnchor.getPositionToNormal(anchor, new THREE.Vector3());
      const helper = Math.abs(up.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const east = new THREE.Vector3().crossVectors(helper, up).normalize();
      const north = new THREE.Vector3().crossVectors(up, east).normalize();
      // A tileset's OWN local frame is Z-up, not Y-up — glTF content (Y-up per spec) already went
      // through the standard Y-up→Z-up conversion one level below `tiles.group` when it was loaded as
      // a tile, and every already-working root `transform` in this codebase confirms it: geo.js's
      // enuMatrix (used for every real COPC/Potree georef) is column-major [East, North, Up, origin] —
      // local X→east, Y→north, Z→UP. The previous version of this fix put `up` in the Y column, which
      // is off by a 90° tip (verified live: the Potree "Lion 2.0" preset landed with its head on the
      // ground instead of pointing up) — `up` belongs in the THIRD column, matching enuMatrix exactly.
      localAnchorRef.current.copy(anchor);
      tiles.group.position.copy(anchor);
      tiles.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(east, north, up));
      tiles.group.updateWorldMatrix(true, false);
      (tiles as any).getBoundingSphere(sphere);
      sphere.applyMatrix4(tiles.group.matrixWorld);
    } else {
      localAnchorRef.current.set(0, 0, 0);
      tiles.group.quaternion.identity();
    }

    // Cache the local "up" direction (the ellipsoid surface normal at the tileset's OWN, pre-offset
    // location) for applyZOffsetInternal below — must come from THIS bounding sphere, before the group
    // moves; a flat world-Y offset (the previous behavior) only means "up" for content sitting near the
    // world origin — for real georeferenced content sitting somewhere else on the globe's surface, "up"
    // there is the ellipsoid's surface normal at that point, not the world +Y axis.
    upDirRef.current = sphere.center.length() > 6378137 * 0.5 && (tiles as any).ellipsoid
      ? (tiles as any).ellipsoid.getPositionToNormal(sphere.center, new THREE.Vector3())
      : null;
    // Z offset composes onto the tileset's own transform, so a freshly-loaded tileset needs it applied
    // before we frame the camera on it — previously it only took effect the next time the user actually
    // edited the Z-offset field on an already-loaded tileset. Re-derive the sphere afterward so framing
    // below reflects the actual (offset-applied) final position, not the pre-offset one.
    const zOffset = store.getState().localFrame.zOffset;
    if (zOffset) {
      applyZOffsetInternal(tiles, zOffset);
      tiles.group.updateWorldMatrix(true, false);
      (tiles as any).getBoundingSphere(sphere);
      sphere.applyMatrix4(tiles.group.matrixWorld);
    }
    // A tileset with no real geographic placement loads with its own local origin near (0,0,0) — its
    // group transform is never moved onto the WGS84 ellipsoid (that's what 3d-tiles-renderer's
    // ReorientationPlugin is for, and we intentionally don't register it: it would also recenter — and
    // thus visually relocate — the many already-correctly-georeferenced presets this app tests against).
    // Showing the real-scale Earth sphere next to such local-only content is what read as "the globe
    // misplaced vs. the tileset": the tiny content sits deep inside a 6,378 km sphere it has no real
    // relationship to, invisible once the camera below auto-frames tightly on the small local content.
    // Only draw the globe when the bounding sphere is actually far enough from the origin to plausibly
    // BE a point on Earth's surface — the same heuristic ReorientationPlugin itself uses internally.
    const global = planetScale(sphere);
    const geoReferenced = sphere.center.length() > 6378137 * 0.5 || global;
    setShowGlobe(geoReferenced);
    const fovRad = THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov ?? fov);
    const dist = (sphere.radius / Math.sin(fovRad / 2)) * 1.5;
    // EnvironmentControls assumes world +Y is "up", which is only true for local/non-georeferenced
    // content — real Earth-surface content needs the actual ellipsoid normal at that point instead, or
    // orbiting tilts the camera against the true horizon ("env mode has the wrong up" without this).
    // GlobeControls already derives this itself; setting it here too is harmless (same value either way).
    // (no single surface normal for a whole-planet sphere — it is framed from wherever the camera is)
    const ellipsoid = geoReferenced && !global ? (tiles as any).ellipsoid : null;
    const surfaceUp = ellipsoid ? ellipsoid.getPositionToNormal(sphere.center, new THREE.Vector3()) : null;
    let dir: THREE.Vector3;
    if (surfaceUp) {
      // For georeferenced content, `camera.position - sphere.center` trends toward the SAME direction
      // as the surface normal itself for any far-off camera default (the world-origin term dominates) —
      // i.e. the naive approach direction is nearly always straight down from directly overhead. That's
      // fine for the DISTANCE, but camera.up gets set to that same surface normal a few lines down, and
      // lookAt() degenerates (cross(up, forward) ≈ 0) when the approach direction is parallel to up —
      // producing a garbage view matrix, which is exactly "auto-zoom often can't see the tileset" from a
      // top-down start. Approach from a fixed 35° pitch above the local horizon instead — a normal
      // "3/4 aerial" angle that's never parallel to up, so lookAt() always has a well-defined orientation.
      const helper = Math.abs(surfaceUp.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const east = new THREE.Vector3().crossVectors(helper, surfaceUp).normalize();
      const north = new THREE.Vector3().crossVectors(surfaceUp, east).normalize();
      const pitch = THREE.MathUtils.degToRad(35);
      dir = surfaceUp.clone().multiplyScalar(Math.sin(pitch)).addScaledVector(north, Math.cos(pitch)).normalize();
    } else {
      dir = camera.position.clone().sub(sphere.center);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
      dir.normalize();
    }
    camera.position.copy(sphere.center).addScaledVector(dir, dist);
    camera.near = Math.max(dist * 0.01, 0.1);
    // The far plane must also reach back to the globe sphere (always centered at world origin) when
    // it's shown — basing it purely on the local content's own size (as below) clipped the globe out
    // of view entirely for real georeferenced content sitting millions of meters from world origin.
    camera.far = geoReferenced
      ? Math.max(dist + sphere.radius * 4, camera.position.length() + 6378137 * 1.5)
      : dist + sphere.radius * 4;
    if (surfaceUp) camera.up.copy(surfaceUp);
    camera.lookAt(sphere.center);
    (camera as THREE.PerspectiveCamera).updateProjectionMatrix?.();
    // EnvironmentControls.getUpDirection() (unlike GlobeControls, which overrides it with real
    // per-point ellipsoid math) just returns `this.up`, which defaults to world +Y — wrong for
    // georeferenced content sitting elsewhere on the globe's surface ("env controls should have ENU as
    // up vector"). GlobeControls ignores this.up entirely (its own override takes over), so setting it
    // unconditionally here is harmless for that mode.
    if (surfaceUp && controlsRef.current?.up) controlsRef.current.up.copy(surfaceUp);
    lastSphereCenterRef.current = sphere.center.clone();
    // resetZoomState=true: this just hard-teleported the camera (a fresh load, or "Auto-zoom to
    // tileset" after the user free-navigated far away) — see setControlsPivot's comment for why any
    // stale zoom/drag state from before the jump must not survive into the controls' next tick.
    setControlsPivot(sphere.center, true);
    setPickScene(tiles.group);
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, invalidate, setControlsPivot]);

  // Re-sync the pivot/target and up-vector whenever a DIFFERENT control scheme mounts (e.g. loading a
  // tileset in the default 'globe' mode, then switching to 'orbit' afterward) — a freshly-mounted
  // OrbitControls/EnvironmentControls otherwise starts at its own default (0,0,0 target, world +Y up),
  // which frameToTileset above never gets a chance to correct since it only runs once at load time.
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    if (lastSphereCenterRef.current) setControlsPivot(lastSphereCenterRef.current);
    if (upDirRef.current && controls.up) controls.up.copy(upDirRef.current);
    controls.update?.();
    invalidate();
  }, [controlMode, setControlsPivot, invalidate]);

  // rAF-driven eased camera tween — Canvas runs frameloop="demand", so each step must invalidate() to
  // actually get drawn. Used by double-click-to-zoom below (previously an instant one-frame jump).
  const cameraTweenRef = useRef<number | null>(null);
  const animateCameraTo = useCallback((toPos: THREE.Vector3, toLookAt: THREE.Vector3, durationMs = 450) => {
    if (cameraTweenRef.current != null) cancelAnimationFrame(cameraTweenRef.current);
    const fromPos = camera.position.clone();
    const fromLookAt = controlsRef.current?.target?.clone() ?? camera.position.clone().add(camera.getWorldDirection(new THREE.Vector3()));
    // lookAt() orients the roll from camera.up, which three defaults to ECEF +Y — an arbitrary
    // heading on the ground (it read as "facing west"). Use the local up at the target; when the view
    // is nearly vertical (up ∥ view direction, where lookAt degenerates), north instead.
    const E = WGS84_ELLIPSOID;
    const up = E.getPositionToNormal(toLookAt, new THREE.Vector3());
    const view = toLookAt.clone().sub(toPos).normalize();
    if (Math.abs(view.dot(up)) > 0.95) {
      const c: any = {};
      E.getPositionToCartographic(toLookAt, c);
      up.set(-Math.sin(c.lat) * Math.cos(c.lon), -Math.sin(c.lat) * Math.sin(c.lon), Math.cos(c.lat));
    }
    if (toLookAt.length() > 1e6) camera.up.copy(up);   // georeferenced content only; local scenes keep +Y
    const t0 = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / durationMs);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease-in-out-quad
      camera.position.lerpVectors(fromPos, toPos, eased);
      const lookAt = new THREE.Vector3().lerpVectors(fromLookAt, toLookAt, eased);
      camera.lookAt(lookAt);
      setControlsPivot(lookAt);
      invalidate();
      cameraTweenRef.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    cameraTweenRef.current = requestAnimationFrame(step);
  }, [camera, invalidate, setControlsPivot]);
  useEffect(() => () => { if (cameraTweenRef.current != null) cancelAnimationFrame(cameraTweenRef.current); }, []);

  // Double-click to re-pivot + zoom halfway toward the clicked point — mirrors CesiumViewer's own
  // LEFT_DOUBLE_CLICK handler (same 50%-lerp-toward-the-pick behavior) for consistency between
  // renderers, animated with an ease-in/ease-out tween instead of an instant one-frame jump.
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
      applyPointsPickTolerance(raycaster, camera, dom, lastSphereCenterRef.current ?? camera.position);
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObject(tiles.group, true)[0];
      if (!hit) return;
      const targetPos = camera.position.clone().lerp(hit.point, 0.5);
      animateCameraTo(targetPos, hit.point);
    }
    dom.addEventListener('dblclick', onDblClick);
    return () => dom.removeEventListener('dblclick', onDblClick);
  }, [gl, camera, animateCameraTo]);

  // Middle-mouse-drag to smoothly dolly in/out — a continuous alternative to the mousewheel's
  // discrete zoom steps. Vertical drag distance maps to a fraction of the current camera-to-pivot
  // distance moved per frame (not a fixed world-space speed), so it feels consistent whether you're
  // orbiting a whole city or a single point-cloud sample — exactly how the wheel-zoom step already
  // scales in these controls. The pivot is resolved ONCE, at drag-start, from the actual clicked
  // point on the loaded tileset (raycast, like double-click-to-zoom above) rather than re-derived
  // from controls.target every move — that's what makes it "zoom to that clicked point" instead of
  // always the screen/orbit center. A PivotPointMesh (the exact same white-ring marker class
  // GlobeControls/EnvironmentControls use for their own click-to-pivot indicator, deep-imported for
  // visual consistency — see the ambient .d.ts in src/types) is shown at that point for the duration
  // of the drag.
  //
  // MUST be Pointer Events, not Mouse Events: GlobeControls/EnvironmentControls install their own
  // `pointerdown` listener on this same element and call `preventDefault()` on it unconditionally (see
  // EnvironmentControls.js) — per the Pointer Events spec, that suppresses the browser's compatibility
  // `mousedown`/`mousemove`/`mouseup` events entirely for that interaction, so a mousedown-based handler
  // here would silently never fire (this was the actual "middle-click drag not working" bug — several
  // *other* listeners on the same element don't block each other, only the mouse-event fallback does).
  useEffect(() => {
    const dom = gl.domElement;
    let dragging = false;
    let lastY = 0;
    const pivot = new THREE.Vector3();
    const pivotMesh = new PivotPointMesh();
    pivotMesh.scale.setScalar(0.25); // same scale EnvironmentControls uses for its own indicator
    pivotMesh.raycast = () => {}; // never itself pickable
    pivotMesh.visible = false;
    function resolvePivot(e: PointerEvent): THREE.Vector3 {
      const rect = dom.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const raycaster = new THREE.Raycaster();
      applyPointsPickTolerance(raycaster, camera, dom, lastSphereCenterRef.current ?? camera.position);
      raycaster.setFromCamera(ndc, camera);
      const hit = tilesRef.current ? raycaster.intersectObject(tilesRef.current.group, true)[0] : undefined;
      if (hit) return hit.point;
      const controls = controlsRef.current;
      if (controls?.target) return controls.target.clone();
      if (controls?.getPivotPoint) { const p = new THREE.Vector3(); controls.getPivotPoint(p); return p; }
      return camera.position.clone().add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(100));
    }
    function onPointerDown(e: PointerEvent) {
      if (e.button !== 1) return;
      dragging = true; lastY = e.clientY;
      pivot.copy(resolvePivot(e));
      pivotMesh.position.copy(pivot);
      pivotMesh.updateMatrixWorld();
      scene.add(pivotMesh);
      pivotMesh.visible = true;
      invalidate();
      e.preventDefault();
    }
    function onPointerMove(e: PointerEvent) {
      if (!dragging) return;
      const dy = e.clientY - lastY;
      lastY = e.clientY;
      const toCam = camera.position.clone().sub(pivot);
      // Drag down (+dy) dollies out, drag up dollies in — matches the mousewheel's own convention.
      const scale = Math.exp(dy * 0.005);
      toCam.multiplyScalar(scale);
      camera.position.copy(pivot).add(toCam);
      invalidate();
    }
    function onPointerUp(e: PointerEvent) {
      if (e.button !== 1) return;
      dragging = false;
      pivotMesh.visible = false;
      pivotMesh.removeFromParent();
      invalidate();
    }
    dom.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      dom.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      pivotMesh.removeFromParent();
      pivotMesh.dispose();
    };
  }, [gl, camera, invalidate, scene]);

  const isSplat = loadArgs?.type === 'splat';
  const isPoints = loadArgs?.type === 'pointcloud';
  const defaultSSE = isSplat ? 0.5 : loadArgs?.type === 'mesh' ? 16 : 2;   // see CesiumViewer: 2 px for points
  const errorTarget = loadArgs?.sseOverride ?? maxSSE ?? defaultSSE;

  // Read fresh in onLoadContentModel below (called from 3d-tiles-renderer's own event, not a React
  // effect) — a plain closure over `pointSize` would capture whatever value was current when
  // TilesRendererR3F itself last remounted, not the slider's current value.
  const pointSizeRef = useRef(pointSize);
  pointSizeRef.current = pointSize;
  const pointAdaptiveRef = useRef(pointAdaptive);
  pointAdaptiveRef.current = pointAdaptive;
  /**
   * Point size for one tile. Fixed: `pointSize` px. Adaptive: a world-space size from the tile's
   * geometric error — for a Potree/COPC-derived tile that is its point spacing — so coarse tiles
   * close their gaps and fine tiles stay sharp (what the potree lab's "size from tile GE" does, and
   * Cesium's attenuation approximates). Half the px size acts as the multiplier.
   */
  const applyPointSize = (o: any, tile: any) => {
    if (!o.isPoints || !o.material) return;
    const adaptive = pointAdaptiveRef.current && Number.isFinite(tile?.geometricError) && tile.geometricError > 0;
    o.material.sizeAttenuation = adaptive;
    o.material.size = adaptive ? tile.geometricError * pointSizeRef.current * 0.5 : pointSizeRef.current;
    o.material.needsUpdate = true;
  };

  // Point size was only ever (re)applied by the rAF-throttled effect below, which fires on slider drag
  // or on the INITIAL loadArgs change — but tiles for a large point cloud keep streaming in well after
  // that first effect run finds nothing yet to restyle (`tiles.group` is still empty at that instant).
  // Every subsequently-loaded tile then rendered at three.js's PointsMaterial default size until the
  // user nudged the slider by hand. Apply it per newly-loaded tile too, not just on slider changes.
  const onLoadContentModel = useCallback((e: any) => {
    buildBoundsTrees(e.scene);
    styleDatasetModel(e.scene, e.tile, datasetStyleRef.current);
    e.scene.traverse((o: any) => applyPointSize(o, e.tile));       // any points, whatever the preset's type
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Canvas runs frameloop="demand" (see below) — controls/TilesRenderer/CameraTransition all invalidate()
  // themselves on their own 'change'/'needs-update' events, but a bare controls/plugin remount (switching
  // globe/orbit/env, toggling debug tiles, changing basemap or LOD target) has nothing queued yet, so it'd
  // otherwise sit frozen until the next interaction.
  useEffect(() => { invalidate(); }, [controlMode, debugMode, basemap, terrainMode, errorTarget, invalidate]);

  // rAF-throttled: the point-size slider's onValueChange fires on every drag tick (dozens of times a
  // second), and traversing the WHOLE tiles group to restyle every Points mesh is not free for a large
  // cloud with many loaded tiles — doing that traversal synchronously on every single tick is exactly
  // why dragging this slider specifically felt slow with 3DTRJS open (Cesium's point-size path is a
  // single shared style set, not a per-mesh JS traversal, so it doesn't have this cost). Collapse any
  // number of rapid pointSize changes into at most one traversal per animation frame.
  const pointSizeRaf = useRef<number | null>(null);
  useEffect(() => {
    if (isSplat) return;
    if (pointSizeRaf.current != null) cancelAnimationFrame(pointSizeRaf.current);
    pointSizeRaf.current = requestAnimationFrame(() => {
      pointSizeRaf.current = null;
      const tiles = tilesRef.current;
      if (!tiles) return;
      tiles.forEachLoadedModel((sc: THREE.Object3D, tile: any) => sc.traverse((o: any) => applyPointSize(o, tile)));
      invalidate();
    });
    return () => { if (pointSizeRaf.current != null) cancelAnimationFrame(pointSizeRaf.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointSize, pointAdaptive, loadArgs, isSplat, invalidate]);

  useImperativeHandle(ref, (): ViewerHandle => ({
    load() { /* handled via loadArgs prop from the outer component (URL change remounts TilesRenderer) */ },
    setBasemap() { /* the globe surface TilesRenderer below is always mounted; no per-provider imagery yet (first pass) */ },
    setTerrainMode() { /* Cesium-only (Ion World Terrain / Google Photorealistic 3D Tiles) — no-op here */ },
    setMaxSSE(v) { store.getState().setMaxSSE(v); },
    toggleAssetVisible(show) { store.getState().setAssetVisible(show); },
    setOrtho(on) { store.getState().setOrtho(on); },
    setDebugMode(mode) { store.getState().setDebugMode(mode); },
    applyPointShading() { store.getState().setPointAdaptive(store.getState().pointAdaptive); /* the effect above re-applies */ },
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
      applyZOffsetInternal(tiles, v);
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
      // Raycast the viewport's actual corners against the loaded content FIRST, but fall back to the
      // bare ellipsoid surface per-corner when a ray misses the tileset geometry — e.g. zoomed out on
      // a georeferenced dataset (Strasbourg) so the visible ground extends past the tileset's own
      // extent. Without this fallback, corners that miss the tileset were just dropped, so the box
      // silently shrank to "wherever the tileset happens to be" instead of the true viewport ground
      // footprint ("set box to view uses the tileset rather than the viewport footprint on ellipsoid/
      // terrain"). A per-corner ellipsoid intersection is a flat-ground approximation (no real terrain
      // elevation), which is fine for a rough crop-box starting point.
      const raycaster = new THREE.Raycaster();
      applyPointsPickTolerance(raycaster, camera, gl.domElement, lastSphereCenterRef.current ?? camera.position);
      const corners: THREE.Vector3[] = [];
      for (const [nx, ny] of [[0, 0], [-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]]) {
        raycaster.setFromCamera(new THREE.Vector2(nx, ny), camera);
        const hit = raycaster.intersectObject(tiles.group, true)[0];
        if (hit) { corners.push(hit.point); continue; }
        const ground = ellipsoid.intersectRay(raycaster.ray, new THREE.Vector3());
        if (ground) corners.push(ground);
      }
      let w: number, e: number, s: number, n: number, minH: number, maxH: number;
      if (corners.length) {
        // Project each corner into a local East-North-Up tangent frame at their centroid and take
        // min/max in TRUE east/north METERS there, rather than raw lon/lat min/max — plain degree
        // min/max is skewed by cos(latitude) (a degree of longitude is NOT the same ground distance as
        // a degree of latitude except at the equator) and doesn't correspond to any consistent
        // screen-aligned rectangle for an off-axis camera either way (reported as "doesn't use ENU" +
        // "weird ratio vs screen"). Converting the resulting east/north half-extents back to degrees
        // with the correct per-axis scale keeps the box the crop store expects (a plain geographic
        // bbox, no rotation field) while making its SIZE track true ground distance at the view center.
        // This still won't exactly match the screen's aspect ratio for a camera not looking straight
        // down or due north — that would need a rotated box, which the crop data model doesn't support.
        const center = new THREE.Vector3();
        corners.forEach((c) => center.add(c));
        center.divideScalar(corners.length);
        const centerCarto: any = {};
        ellipsoid.getPositionToCartographic(center, centerCarto);
        const up = ellipsoid.getPositionToNormal(center, new THREE.Vector3());
        const helper = Math.abs(up.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        const east = new THREE.Vector3().crossVectors(helper, up).normalize();
        const north = new THREE.Vector3().crossVectors(up, east).normalize();
        let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
        const heights: number[] = [];
        const rel = new THREE.Vector3();
        for (const c of corners) {
          rel.subVectors(c, center);
          const de = rel.dot(east), dn = rel.dot(north);
          minE = Math.min(minE, de); maxE = Math.max(maxE, de);
          minN = Math.min(minN, dn); maxN = Math.max(maxN, dn);
          const carto: any = {};
          ellipsoid.getPositionToCartographic(c, carto);
          heights.push(carto.height);
        }
        const R = 6378137;
        const cosLat = Math.max(0.1, Math.cos(centerCarto.lat));
        w = THREE.MathUtils.radToDeg(centerCarto.lon + minE / (R * cosLat));
        e = THREE.MathUtils.radToDeg(centerCarto.lon + maxE / (R * cosLat));
        s = THREE.MathUtils.radToDeg(centerCarto.lat + minN / R);
        n = THREE.MathUtils.radToDeg(centerCarto.lat + maxN / R);
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
      if (!tiles) return null;
      const g = tiles.group;
      // Full TRS, not just translation — matches CesiumViewer's getExtractMatrix (which returns the
      // whole modelMatrix). Position-only missed the local-frame ENU anchor's rotation (see
      // frameToTileset) and any TilesetGizmo rotate/scale edit.
      if (g.position.lengthSq() === 0 && g.quaternion.w === 1 && g.scale.x === 1 && g.scale.y === 1 && g.scale.z === 1) return null;
      g.updateMatrix();
      return Array.from(g.matrix.elements);
    },
    flyToCity(lon, lat, height) { setPendingFlyTo({ lon, lat, height }); },
    setDatasetMarkers(list) { setMarkers(list); },
    setDatasetStyle(style) {
      datasetStyleRef.current = style;
      tilesRef.current?.forEachLoadedModel((sc: THREE.Object3D, tile: any) => styleDatasetModel(sc, tile, style));
      invalidate();
    },
    async snapToGround() {
      const tiles = tilesRef.current;
      if (!tiles) return 'Load a tileset first.';
      const E = WGS84_ELLIPSOID;
      const mode = resolveTerrainMode(store.getState().terrainMode, '3dtrjs');
      const rasterId = snapRasterFor(mode);
      const raster = rasterId != null;
      const terrarium = raster ? (terrariumTiles as any)?.getPluginByName?.('TERRARIUM_MESH_PLUGIN') : null;
      const raycaster = new THREE.Raycaster();
      /** Terrain under a lon/lat: the raster tiles directly, or a ray against whatever real ground is shown. */
      const groundAt = async (lonDeg: number, latDeg: number): Promise<number | null> => {
        if (mode === 'wgs84') return 0;
        if (rasterId) return sampleRasterTerrain(rasterId, lonDeg, latDeg);
        const lat = THREE.MathUtils.degToRad(latDeg), lon = THREE.MathUtils.degToRad(lonDeg);
        const pt = E.getCartographicToPosition(lat, lon, 20000, new THREE.Vector3());
        const nrm = E.getCartographicToNormal(lat, lon, new THREE.Vector3());
        raycaster.set(pt, nrm.negate());
        const hit = raycaster.intersectObjects(scene.children, true)
          .find((h) => { let o: THREE.Object3D | null = h.object; while (o) { if (o === tiles.group) return false; o = o.parent; } return true; });
        if (!hit) return null;
        const c: any = {};
        E.getPositionToCartographic(hit.point, c);
        return c.height;
      };

      // 1. Preferred: the dataset's own top geometry, binned (lib/datasetGround.ts). Renderer-independent.
      const samples = await datasetGroundSamples(store.getState().lastLoadUrl).catch(() => null);
      if (samples) {
        const terrain = await Promise.all(samples.map((s) => groundAt(s.lon, s.lat)));
        const r = offsetFromSamples(samples, terrain);
        if (r) {
          const next = +r.dz.toFixed(2);                          // absolute: the samples come from the file
          store.getState().setLocalFrame({ zOffset: next });
          applyZOffsetInternal(tiles, next);
          invalidate();
          return `Snapped to ground: Z offset ${next} m — from the dataset's own top geometry (${r.used}/${samples.length} ground bins, spread ${r.spread.toFixed(1)} m).`;
        }
      }
      // 2. Fallback (compressed or unreadable content): pick the rendered surface on a grid.
      let total = 0, last = '';
      for (let pass = 0; pass < 2; pass++) {
        const sphere = new THREE.Sphere();
        if (!(tiles as any).getBoundingSphere(sphere)) return 'The tileset has no bounds yet.';
        tiles.group.updateMatrixWorld(true);
        sphere.applyMatrix4(tiles.group.matrixWorld);
        const up = E.getPositionToNormal(sphere.center, new THREE.Vector3());
        const east = new THREE.Vector3().crossVectors(Math.abs(up.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0), up).normalize();
        const north = up.clone().cross(east).normalize();
        const reach = Math.min(sphere.radius * 0.5, 5000);
        const above = sphere.radius * 2 + 1000;
        const diffs: number[] = [];
        const carto: any = {};
        for (let i = -SNAP_HALF; i <= SNAP_HALF; i++) {
          for (let j = -SNAP_HALF; j <= SNAP_HALF; j++) {
            const p = sphere.center.clone().addScaledVector(east, (i / SNAP_HALF) * reach).addScaledVector(north, (j / SNAP_HALF) * reach);
            const n = E.getPositionToNormal(p, new THREE.Vector3());
            raycaster.set(p.clone().addScaledVector(n, above), n.clone().negate());
            // a NARROW column, like Cesium's pick volume: a wide one returns the highest point around
            raycaster.params.Points.threshold = Math.max(0.5, reach / 100);
            const hits = raycaster.intersectObject(tiles.group, true);
            if (!hits.length) continue;
            const dataH = E.getPositionToCartographic(hits[0].point, carto).height;
            let groundH: number | null = null;
            if (mode === 'wgs84') groundH = 0;
            else if (terrarium) groundH = terrarium.sampleCartographicElevation(carto.lat, carto.lon);
            else {
              // World Terrain / Google 3D: real geometry, so raycast everything that is NOT the dataset
              const ground = raycaster.intersectObjects(scene.children, true)
                .find((h) => { let o: THREE.Object3D | null = h.object; while (o) { if (o === tiles.group) return false; o = o.parent; } return true; });
              if (ground) { E.getPositionToCartographic(ground.point, carto); groundH = carto.height; }
            }
            if (groundH != null && Number.isFinite(groundH)) diffs.push(groundH - dataH);
          }
        }
        diffs.sort((a, b) => a - b);
        if (diffs.length < SNAP_MIN_HITS) return `Snap to ground: only ${diffs.length} of ${SNAP_SAMPLES} samples hit both the dataset and the terrain — zoom in so more of both is loaded, then retry.`;
        const dz = diffs[Math.floor(0.8 * (diffs.length - 1))];
        total += dz;
        const next = +(store.getState().localFrame.zOffset + dz).toFixed(2);
        store.getState().setLocalFrame({ zOffset: next });
        applyZOffsetInternal(tiles, next);
        invalidate();
        last = `${diffs.length}/${SNAP_SAMPLES} samples, spread ${(diffs[diffs.length - 1] - diffs[0]).toFixed(1)} m`;
        if (Math.abs(dz) < 0.25) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      return `Snapped to ground: moved ${total.toFixed(2)} m (Z offset now ${store.getState().localFrame.zOffset} m; ${last}).`;
    },
    flyToSphere(lon, lat, height, radius) { flyToSphereInternal(lon, lat, height, radius); },
    datasetsInView(list, minFraction) {
      const g = tilesRef.current?.group;
      g?.updateMatrixWorld(true);
      return datasetsInView3d(list, camera, g ? g.matrixWorld : null, minFraction);
    },
    autoZoomToTileset() { frameToTileset(tilesRef.current); },
    setControlMode(mode) { store.getState().setControlMode(mode); },
    setPointSize(px) { store.getState().setPointSize(px); },
    showCropGizmo() { store.getState().setCropGizmoOn(true); return true; },
    hideCropGizmo() { store.getState().setCropGizmoOn(false); },
    showTilesetGizmo() { store.getState().setTilesetGizmoOn(true); },
    hideTilesetGizmo() { store.getState().setTilesetGizmoOn(false); },
  }), [camera, invalidate, frameToTileset, applyZOffsetInternal, animateCameraTo]);

  /**
   * Frame a dataset from its bounding sphere: 3 radii out, pitched ~35° down, approaching from the
   * side the camera is already on (so a click never swings the view around the globe).
   */
  function flyToSphereInternal(lon: number, lat: number, height: number, radius: number) {
    const g = tilesRef.current?.group;
    g?.updateMatrixWorld(true);
    const lat_ = THREE.MathUtils.degToRad(lat), lon_ = THREE.MathUtils.degToRad(lon);
    const E = WGS84_ELLIPSOID;
    const center = E.getCartographicToPosition(lat_, lon_, height, new THREE.Vector3());
    const up = E.getCartographicToNormal(lat_, lon_, new THREE.Vector3());
    if (g) { center.applyMatrix4(g.matrixWorld); up.transformDirection(g.matrixWorld); }
    const side = camera.position.clone().sub(center);
    side.addScaledVector(up, -side.dot(up));
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0).addScaledVector(up, -up.x);
    side.normalize();
    const range = Math.max(150, radius * 3);
    const pos = center.clone()
      .addScaledVector(up, range * Math.sin(THREE.MathUtils.degToRad(35)))
      .addScaledVector(side, range * Math.cos(THREE.MathUtils.degToRad(35)));
    animateCameraTo(pos, center, 1200);
  }

  function flyToLocalFrameInternal(lon: number, lat: number, alt: number, range: number) {
    // WGS84 when no tileset has loaded yet: a preset's fly-to is issued right after load() and must
    // not depend on the tileset having arrived.
    const ellipsoid = (tilesRef.current as any)?.ellipsoid ?? WGS84_ELLIPSOID;
    const pos = new THREE.Vector3();
    ellipsoid.getCartographicToPosition(THREE.MathUtils.degToRad(lat), THREE.MathUtils.degToRad(lon), alt, pos);
    const dir = pos.clone().normalize();
    camera.position.copy(pos.clone().add(dir.multiplyScalar(range)));
    // north up, like Cesium's fly-to (three's default up is ECEF +Y, an arbitrary heading on the ground)
    const la = THREE.MathUtils.degToRad(lat), lo = THREE.MathUtils.degToRad(lon);
    camera.up.set(-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la));
    camera.lookAt(pos);
    invalidate();
  }

  // Fly at once, and again when the root tileset arrives (onLoadRootTileset below), so the controls
  // pick up the new pivot rather than the one from before the tileset existed.
  const pendingFlyToRef = useRef<typeof pendingFlyTo>(null);
  useEffect(() => {
    if (!pendingFlyTo) return;
    pendingFlyToRef.current = pendingFlyTo;
    flyToLocalFrameInternal(pendingFlyTo.lon, pendingFlyTo.lat, pendingFlyTo.height, 800);
    setPendingFlyTo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFlyTo, loadArgs]);

  return (
    <>
      <ambientLight intensity={1.2} />
      <directionalLight position={[1, 1, 1]} intensity={0.6} />
      {/* Base globe surface. Hidden entirely for tilesets with no real geographic placement (see the
          comment in frameToTileset above). terrainMode 'cesium' gets REAL elevation (Cesium World
          Terrain via QuantizedMeshPlugin, TerrainGlobe above) with imagery draped on top as an optional
          overlay layer; 'google' gets Google's own already-textured Photorealistic 3D Tiles (GoogleGlobe
          above, same Ion token, no basemap overlay needed); otherwise a real OSM/Google-tile-draped
          WGS84 ellipsoid (Globe above) when imagery is on, or a plain wireframe sphere as a ground
          reference when imagery is off. */}
      {showGlobe && (terrain === 'cesium' ? (
        <TerrainGlobe basemap={basemap} gl={gl} />
      ) : terrain === 'reearth-qm' ? (
        <TerrainGlobe basemap={basemap} gl={gl} url={`${REEARTH_QM_URL}/`} />
      ) : terrain === 'terrarium' || terrain === 'mapterhorn' || terrain === 'mapterhorn-ellipsoid' ? (
        <TerrariumGlobe basemap={basemap} source={terrain} gl={gl} />
      ) : terrain === 'google' ? (
        <GoogleGlobe ktxLoader={ktxLoader} />
      ) : basemap === 'none' ? (
        <mesh>
          <sphereGeometry args={[6378137, 64, 64]} />
          <meshBasicMaterial color="#1a2a3a" wireframe />
        </mesh>
      ) : (
        <Globe basemap={basemap} gl={gl} />
      ))}
      {loadArgs && (
        <TilesRendererR3F
          ref={tilesRef as any}
          url={loadArgs.url}
          errorTarget={errorTarget}
          // Skipped when the caller (a flyTo-tagged preset — e.g. Bing's per-city pills, which all
          // load the SAME global tileset URL) is about to issue its OWN flyToCity right after load()
          // — this async auto-frame (fires once the tileset.json fetch resolves) would otherwise land
          // AFTER and override that flyTo with the tileset's own (possibly world-sized) bounding sphere.
          onLoadRootTileset={() => {
            // devtools / headless inspection — the counterpart of CesiumViewer's window.viewer
            (window as any).tiles3dtr = { tiles: tilesRef.current, scene, camera };
            if (!loadArgs?.skipAutoFrame) frameToTileset(tilesRef.current, true);
            const fly = pendingFlyToRef.current;
            pendingFlyToRef.current = null;
            if (fly && loadArgs?.skipAutoFrame) {
              flyToLocalFrameInternal(fly.lon, fly.lat, fly.height, 800);
              setControlsPivot(camera.position.clone().setLength(6378137), true);
            }
          }}
          onLoadModel={onLoadContentModel}
          onLoadError={(e: any) => {
            // `tile === null` means the ROOT tileset.json itself failed (nothing will ever show) —
            // worth a user-visible error. A per-TILE failure (tile is a real tile) just means one
            // piece is missing out of a potentially huge tree; that's already visible via 3d-tiles-
            // renderer's own console.error per tile, and popping a modal for every one would be
            // very noisy on a large tileset with sporadic failures. Previously 3DTRJS had NO
            // user-visible error surfacing at all for a totally-failed load (silent blank viewport).
            if (e.tile) return;
            store.getState().showError(`Failed to load tileset:\n${e.error?.message || String(e.error) || 'unknown error'}`);
            store.getState().setStatus('Load failed.');
          }}
        >
          {/* 3D Tiles 1.1 implicit tiling (OCTREE/QUADTREE `.subtree` expansion) — unlike Cesium, 3DTRJS
              has no built-in support for `implicitTiling` root nodes; without this plugin a tileset that
              streams with tiling=implicit (COPC/Potree's default, and any 3D Tiles 1.1 source that ships
              implicit roots) never expands past the root tile. Plug-and-play, no options, and a no-op on
              explicit tilesets (only triggers on nodes that actually carry `implicitTiling`). */}
          <TilesPlugin plugin={ImplicitTilingPlugin as any} />
          <TilesPlugin plugin={ImplicitAddRefineFixPlugin as any} />
          <TilesPlugin plugin={GLTFExtensionsPlugin as any} args={{ dracoLoader, ktxLoader } as any} />
          {isSplat && <TilesPlugin plugin={GaussianSplatPlugin as any} args={{ renderer: gl, scene } as any} />}
          {debugMode === 'tiles' && <TilesPlugin plugin={DebugTilesPlugin as any} displayBoxBounds colorMode={7} />}
          {debugMode === 'cells' && <MosaicOutlines url={loadArgs.url} tilesRef={tilesRef} />}
          {controlMode === 'globe' && <GlobeControls ref={controlsRef} scene={pickScene ?? undefined} enableDamping dampingFactor={0.05} minDistance={1} />}
          {controlMode === 'env' && <EnvironmentControls ref={controlsRef} scene={pickScene ?? undefined} enableDamping dampingFactor={0.05} minDistance={1} />}
        </TilesRendererR3F>
      )}
      {/* makeDefault registers this as R3F's `state.controls` — same thing GlobeControls/EnvironmentControls
          already do unconditionally (see 3d-tiles-renderer's ControlsBaseComponent). drei's own
          <TransformControls> (the crop/tileset gizmos below) listens for exactly that and auto-pauses
          `state.controls.enabled` while a gizmo handle is being dragged, so they stop fighting over the
          same pointer drag ("clicking the gizmo should pause the control") — no extra wiring needed once
          every control scheme is registered the same way. */}
      {controlMode === 'orbit' && <OrbitControls ref={controlsRef} makeDefault enableDamping dampingFactor={0.05} />}
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
      {markers && markers.length > 0 && (
        <ThreeDatasetMarkers list={markers} tilesRef={tilesRef} tooltip={tooltip} onPick={(d) => {
          flyToSphereInternal(d.lon, d.lat, d.height, d.radius);
          store.getState().setStatus(`${d.name}${d.project ? ` — ${d.project}` : ''} [${d.format}]`);
        }} />
      )}
      <CropGizmo tilesRef={tilesRef} pickScene={pickScene} />
      <TilesetGizmo tilesRef={tilesRef} pickScene={pickScene} />
      <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
        <GizmoViewport />
      </GizmoHelper>
    </>
  );
});

const ThreeDTRjsViewer = forwardRef<ViewerHandle, Props>(function ThreeDTRjsViewer({ visible }, ref) {
  const [loadArgs, setLoadArgs] = useState<LoadArgs>(null);
  const sceneRef = useRef<ViewerHandle | null>(null);
  // The Scene lives inside <Canvas>, which mounts its children a few frames AFTER this component.
  // A call made in between — a preset pill's flyToCity right after load(), markers pushed on the first
  // render — used to hit a null ref and vanish (the Angkor pills then stayed on the whole globe). Calls
  // that must not be lost wait here until the Scene's handle arrives.
  const sceneQueue = useRef<((h: ViewerHandle) => void)[]>([]);
  const whenScene = useCallback((f: (h: ViewerHandle) => void) => {
    if (sceneRef.current) f(sceneRef.current);
    else sceneQueue.current.push(f);
  }, []);
  const setSceneRef = useCallback((h: ViewerHandle | null) => {
    sceneRef.current = h;
    if (!h) return;
    const q = sceneQueue.current;
    sceneQueue.current = [];
    for (const f of q) f(h);
  }, []);
  const tooltipRef: TooltipChannel = useRef(null);

  useImperativeHandle(ref, (): ViewerHandle => ({
    load(url, type, opts) { setLoadArgs({ url, type, sseOverride: opts?.sseOverride, skipAutoFrame: opts?.skipAutoFrame }); },
    setBasemap: (...a) => sceneRef.current?.setBasemap(...a),
    setTerrainMode: (...a) => sceneRef.current?.setTerrainMode(...a),
    setMaxSSE: (...a) => sceneRef.current?.setMaxSSE(...a),
    toggleAssetVisible: (...a) => sceneRef.current?.toggleAssetVisible(...a),
    setOrtho: (...a) => sceneRef.current?.setOrtho(...a),
    setDebugMode: (...a) => sceneRef.current?.setDebugMode(...a),
    applyPointShading: () => sceneRef.current?.applyPointShading(),
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
    flyToCity: (...a) => whenScene((h) => h.flyToCity(...a)),
    autoZoomToTileset: () => sceneRef.current?.autoZoomToTileset(),
    setDatasetMarkers: (list) => whenScene((h) => h.setDatasetMarkers?.(list)),
    setDatasetStyle: (style) => whenScene((h) => h.setDatasetStyle?.(style)),
    snapToGround: () => sceneRef.current?.snapToGround?.() ?? Promise.resolve('3DTRjs scene not ready.'),
    flyToSphere: (...a) => whenScene((h) => h.flyToSphere?.(...a)),
    datasetsInView: (list, f) => sceneRef.current?.datasetsInView?.(list, f) ?? [],
    setControlMode: (...a) => sceneRef.current?.setControlMode?.(...a),
    setPointSize: (...a) => sceneRef.current?.setPointSize?.(...a),
    showCropGizmo: () => sceneRef.current?.showCropGizmo?.() ?? false,
    hideCropGizmo: () => sceneRef.current?.hideCropGizmo?.(),
    showTilesetGizmo: () => sceneRef.current?.showTilesetGizmo?.(),
    hideTilesetGizmo: () => sceneRef.current?.hideTilesetGizmo?.(),
  }), [whenScene]);

  return (
    <div style={{ position: 'absolute', inset: 0, visibility: visible ? 'visible' : 'hidden' }}>
      {/* frameloop="demand": R3F's default ('always') redraws every single display refresh forever,
          whether or not anything changed — the actual source of the "constantly slow" feeling, not
          React re-renders (already fixed via useThree selectors above). Every piece in this scene
          (TilesRenderer's 'needs-render'/'needs-update' events, GlobeControls/EnvironmentControls/
          OrbitControls' 'change'/'start'/'end' events, CameraTransition's own animation loop) already
          calls invalidate() itself when it has something new to draw — that's what makes demand mode
          safe here instead of freezing mid-load or mid-orbit. */}
      {/* `flat`: R3F's Canvas defaults to ACESFilmicToneMapping (its own opinionated default, not a
          three.js default) — a nonlinear rolloff that visibly darkens/desaturates vertex colors and
          textures with no on-screen control for it. Point clouds/splats especially carry final,
          already-correct sRGB color data (not HDR meant for filmic tone mapping) and just looked dim
          compared to the identical data in Cesium (which does no such tone mapping) — this is the
          "hidden brightness multiplier" affecting potree/COPC/mesh content alike. */}
      <Canvas frameloop="demand" flat camera={{ fov: 60, near: 0.1, far: 1e8, position: [0, 0, 1e7] }} gl={{ logarithmicDepthBuffer: true }}>
        <Scene ref={setSceneRef} loadArgs={loadArgs} tooltip={tooltipRef} />
      </Canvas>
      <DatasetTooltip channel={tooltipRef} visible={visible} />
    </div>
  );
});

export default ThreeDTRjsViewer;
