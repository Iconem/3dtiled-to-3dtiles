import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, TrackballControls, FlyControls, TransformControls, GizmoHelper, GizmoViewport } from '@react-three/drei';
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
import { PointCloudEffectsPlugin } from '3d-tiles-renderer/plugins';
const GeneratedSurfacePlugin = (ThreeTilesPlugins as any).GeneratedSurfacePlugin;
const TerrariumMeshPlugin = (ThreeTilesPlugins as any).TerrariumMeshPlugin;
import { WGS84_ELLIPSOID, type TilesRenderer as TilesRendererImpl } from '3d-tiles-renderer';
import { PivotPointMesh } from '3d-tiles-renderer/src/three/renderer/controls/PivotPointMesh.js';
import * as tilesCore from '3d-tiles-renderer/core';

// The imagery and Terrarium globes have no content to download: their `parseToMesh` is where the
// tile FETCHES its elevation grid and then its overlay image (TerrainRGBMeshPlugin awaits one, then
// the other), builds a 32×32 mesh and returns. 3DTRjs runs every parse through one shared queue of
// 5 jobs (DEFAULT_PARSE_QUEUE, sized for Draco / glTF decoding), so a close view that needs ~300
// terrain tiles (the leaves, their ancestors and siblings — `loadAncestors`) drains at five
// network round-trips at a time: measured headless, the fine imagery of a 400 m view finished 8-10 s
// after the camera got there while every single fetch took ~10 ms. These renderers get their own
// queue with 32 jobs; the data renderers keep the shared one (their parses are real CPU work).
const GLOBE_PARSE_QUEUE = new tilesCore.PriorityQueue();
GLOBE_PARSE_QUEUE.maxJobs = 32;
GLOBE_PARSE_QUEUE.priorityCallback = (tilesCore as any).unifiedPriorityCallback;   // exported, not typed
// The globes also get their own tile cache. 3DTRjs shares one LRU cache (DEFAULT_LRU_CACHE, 0.4 GiB)
// between every renderer, and a renderer whose cache is full requests nothing more. A terrain tile with
// its imagery texture weighs ~2.2 MB: measured headless at 150 m over Bastia, 161 globe tiles held
// 350 MB of the 429 and the 211 point tiles of the dataset 66 MB, so a pitched view or a long browse
// filled the cache with terrain and the data stopped refining (the "only the root loads" of Bastia).
// The data renderer and its native-leaf children keep the default cache to themselves.
const GLOBE_LRU_CACHE = new tilesCore.LRUCache();
GLOBE_LRU_CACHE.unloadPriorityCallback = (tilesCore as any).DEFAULT_LRU_CACHE.unloadPriorityCallback;
const useGlobeQueues = (t: any) => {
  if (!t) return;
  if (t.parseQueue !== GLOBE_PARSE_QUEUE) t.parseQueue = GLOBE_PARSE_QUEUE;
  if (t.lruCache !== GLOBE_LRU_CACHE) t.lruCache = GLOBE_LRU_CACHE;
};
const useGlobeCache = (t: any) => { if (t && t.lruCache !== GLOBE_LRU_CACHE) t.lruCache = GLOBE_LRU_CACHE; };
import { GaussianSplatPlugin } from '3d-tiles-rendererjs-3dgs-plugin';
import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import type { ViewerHandle } from '@/lib/viewer-handle';
import { MW, type AssetType } from '@/lib/formats';
import { CESIUM_ION_TOKEN } from '@/lib/ion';
import { GOOGLE_MAPS_API_KEY } from '@/lib/google';
import { ecefToPose, poseToEcef, type CameraPose } from '@/lib/cameraPose';
import { installB3dmClientFixes } from '@/lib/b3dmClientFix';
import { useViewerStore } from '@/state/store';
import { RASTER_TERRAINS, resolveTerrainMode, sampleRasterTerrain, snapRasterFor, terrariumFromAncestor, type RasterTerrainId } from '@/lib/terrarium';
import { basemapLayers, type BasemapId } from '@/lib/basemaps';
import { tileDatasetId, type DatasetStyle } from '@/lib/datasetStyle';
import { applyPointsPickTolerance, installFilteredRaycast, pickPoint, pointerNdc } from '@/lib/picking';
import { FootprintGatePlugin } from '@/lib/footprintGate';
import { StaleLoadAbortPlugin } from '@/lib/staleLoads';
import { MotionLodPlugin, flight, motionLodPlugins, setMotionLodInvalidate } from '@/lib/motionLod';
import { fetchOutlines, outlineColor, type TileOutline } from '@/lib/mosaicOutlines';
import { datasetGroundSamples, offsetFromSamples, type GroundSample } from '@/lib/datasetGround';
import { applyHeightColors, fitHeightRange, restoreHeightColors, type HeightRange } from '@/lib/pointColors';
import { NativeLeavesPlugin, withNativeLeaves } from '@/lib/nativeLeaves';
import { AddRefinePointSizePlugin } from '@/lib/addRefinePointSize';
// Vendored from 3DTilesRendererJS master (unreleased), with local patches (size cap, child boxes).
import { useUrlState } from '@/state/urlState';
import { SNAP_HALF, SNAP_SAMPLES, SNAP_MIN_HITS } from '@/lib/snapToGround';
import { isAggregateUrl, type DatasetMarker } from '@/lib/aggregate';
import DatasetTooltip, { type TooltipChannel } from './DatasetTooltip';
import ThreeDatasetMarkers, { datasetsInView3d, type LoadedDatasets } from './ThreeDatasetMarkers';

// GlobeControls takes its ellipsoid frame from the TilesRenderer it sits in, i.e. the DATA tileset's group. For a
// georeferenced tileset that group is the identity, but a local scene is anchored at the Local Frame (frameToTileset
// moves and rotates its group), and the controls then orbited an Earth centred at the anchor: a stale, wrong pivot and
// up after moving from one tileset to another ("globe controls stall on the previous camera up or pivot"). The frame
// is the world itself, always.
const WORLD_FRAME = new THREE.Group();
WORLD_FRAME.updateMatrixWorld(true);

// EnvironmentControls / GlobeControls `state` values (3d-tiles-renderer/src/three/renderer/controls/EnvironmentControls.js)

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
// Draco and KTX2 decode in workers, 4 each by default. A Bing 3D view is ~300 Draco + KTX2 tiles: measured on
// 2026-11-14, the downloads were done in 10 s and the decoding took 50 more, so use half the cores (4 to 8).
const DECODE_WORKERS = Math.max(4, Math.min(8, Math.floor((navigator.hardwareConcurrency || 8) / 2)));
dracoLoader.setWorkerLimit(DECODE_WORKERS);

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

// Controls "Auto": camera height above the ground (m) at which it changes scheme, and how long after
// the last wheel step.
const AUTO_ORBIT_BELOW = 3000;
const AUTO_GLOBE_ABOVE = 6000;
const AUTO_SETTLE_MS = 180;

// Where the globe is looked at when nothing says otherwise: most Iconem projects are in Europe and
// MENA. (The Canvas camera default sits on +Z, i.e. straight above the north pole; a world-sized
// mosaic root was framed from there: "globe controls start centred on the north pole".)
const ALULA = { lat: THREE.MathUtils.degToRad(26.6), lon: THREE.MathUtils.degToRad(37.9) };
const northAt = (lat: number, lon: number) => new THREE.Vector3(-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat));

function buildBoundsTrees(scene: THREE.Object3D) {
  scene.traverse((o: any) => {
    if (o.isMesh && o.geometry && !o.geometry.boundsTree) {
      try { o.geometry.computeBoundsTree(); } catch { /* leave unaccelerated for this one tile */ }
    }
  });
}

// Picking (double-click, middle-drag, the controls' own pivots, crop-to-view) goes through lib/picking:
// hidden objects, wireframes, transparent materials and back faces are never candidates, and the data
// wins over the terrain. `applyPointsPickTolerance` widens point hits to ~15 screen px, as points have
// no area; callers pass the last-framed tileset's bounding-sphere centre as the distance estimate.

/** Draws nothing; clears the depth buffer between the terrain (renderOrder 0) and the data (1). */
function makeClearDepthHook(): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setDrawRange(0, 0);
  const hook = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
  hook.frustumCulled = false;
  hook.renderOrder = 0.5;
  hook.raycast = () => {};
  hook.onBeforeRender = (renderer) => { renderer.clearDepth(); };
  return hook;
}

/** Data draws after the terrain (see makeClearDepthHook); the markers keep their own order. */
/**
 * Material modes (store.materialMode), applied per loaded model and re-applied on change:
 *   default    the content's own materials;
 *   xray       see-through: meshes as an additive, non-depth-writing tint (the structure reads through
 *              itself, a scan's interior shows through its walls), points additive at 35 %;
 *   wireframe  meshes as wireframe, points unchanged;
 *   features   one colour per feature: EXT_mesh_features ids (3d-tiles-renderer's GLTFMeshFeaturesExtension leaves a
 *              MeshFeatures on `userData.meshFeatures`), a `_feature_id_N` attribute as vertex colours (hashed hue
 *              per id), a feature-ID texture as the map (its channels are the ids), an implicit id per vertex; a
 *              3D Tiles 1.0 b3dm's `_BATCHID` (`_batchid` once loaded) the same way as a feature-ID attribute; a
 *              primitive with neither gets one colour per tile mesh, so tile boundaries show.
 * The original mesh material is kept on the object and restored by `default`. Points take their colour
 * independently, in every mode: their own (`rgb`), one colour, or by height (lib/pointColors.ts).
 */
type MaterialMode = 'default' | 'xray' | 'wireframe' | 'features';
type MaterialOpts = { mode: MaterialMode; opacity: number; points: 'rgb' | 'color' | 'height'; color: string; range: HeightRange | null; stop: THREE.Object3D | null };
const XRAY_MESH = new THREE.MeshBasicMaterial({ color: 0x9ad8ff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
const WIRE_MESH = new THREE.MeshBasicMaterial({ color: 0xdddddd, wireframe: true, transparent: true, opacity: 0.6, depthWrite: false });
const featureColor = (id: number, out: THREE.Color) => out.setHSL((((id + 1) * 2654435761) >>> 0) / 4294967296, 0.7, 0.55);
function featureMaterial(o: any): THREE.Material {
  if (o.userData.__featureMaterial) return o.userData.__featureMaterial;
  const g: THREE.BufferGeometry = o.geometry, mf = o.userData.meshFeatures;
  const info: any[] = mf?.getFeatureInfo?.() ?? [];
  const byTexture = info.find((f) => f.texture), byAttribute = info.find((f) => 'attribute' in f && f.attribute !== undefined);
  let mat: THREE.Material;
  if (byTexture && !byAttribute) {
    mat = new THREE.MeshBasicMaterial({ map: mf.getTextures()[byTexture.texture.index], side: THREE.DoubleSide });
  } else {
    const ids = byAttribute ? g.getAttribute(`_feature_id_${byAttribute.attribute}`) : (g.getAttribute('_batchid') ?? null);
    const idOf = ids ? (i: number) => ids.getX(i) : info.length ? (i: number) => i : () => o.id;
    const n = g.getAttribute('position').count, c = new Float32Array(n * 3), col = new THREE.Color();
    for (let i = 0; i < n; i++) { featureColor(idOf(i), col); c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b; }
    if (o.userData.__origColor === undefined) o.userData.__origColor = g.getAttribute('color') ?? null;
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  }
  o.userData.__featureMaterial = mat;
  return mat;
}
function applyMaterialMode(o: any, { mode, opacity, points, color, range, stop }: MaterialOpts) {
  if (o.isMesh && !o.isPoints) {
    if (mode !== 'features' && o.userData.__origColor !== undefined) {
      if (o.userData.__origColor) o.geometry.setAttribute('color', o.userData.__origColor); else o.geometry.deleteAttribute('color');
      delete o.userData.__origColor;
      o.userData.__featureMaterial?.dispose(); delete o.userData.__featureMaterial;
    }
    if (mode === 'default') {
      if (o.userData.__origMaterial) { o.material = o.userData.__origMaterial; delete o.userData.__origMaterial; }
      return;
    }
    if (!o.userData.__origMaterial) o.userData.__origMaterial = o.material;
    if (mode === 'features') { o.material = featureMaterial(o); return; }
    XRAY_MESH.opacity = opacity * 0.6;                          // shared: set on every apply, cheap
    o.material = mode === 'xray' ? XRAY_MESH : WIRE_MESH;
  } else if (o.isPoints && o.material) {
    // PointCloudMaterial extends PointsMaterial: three's own opacity / blending / vertexColors apply
    const m = o.material;
    const xray = mode === 'xray';
    // per object, unlike the rest: the colours live on the geometry, and a material can be shared
    const byHeight = points === 'height' && !!range;
    if (byHeight) applyHeightColors(o, range!, stop);
    else restoreHeightColors(o);
    const key = `${xray ? opacity : ''}|${byHeight ? 'height+' : points}|${points === 'color' ? color : ''}`;
    if ((m.userData.__xray ?? '|rgb|') === key) return;
    m.userData.__xray = key;
    if (m.userData.__vertexColors === undefined) { m.userData.__vertexColors = m.vertexColors; m.userData.__color = m.color.getHex(); }
    m.transparent = xray; m.opacity = xray ? opacity : 1; m.depthWrite = !xray;
    m.blending = xray ? THREE.AdditiveBlending : THREE.NormalBlending;
    const flat = points === 'color';                           // one colour for every point (picker)
    m.vertexColors = flat ? false : byHeight ? true : (m.userData.__vertexColors ?? m.vertexColors);
    if (flat) m.color.set(color);
    else if (byHeight) m.color.setHex(0xffffff);
    else if (m.userData.__color !== undefined) m.color.setHex(m.userData.__color);
    m.needsUpdate = true;                                       // vertexColors toggles the program
  }
}

function setContentRenderOrder(scene: THREE.Object3D) {
  scene.traverse((o) => { o.renderOrder = 1; });
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
  return basemapLayers(basemap).map((l) => new XYZTilesOverlay({
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
    // useRecommendedSettings would pin errorTarget at 1 px: every imagery tile refined until one texel
    // is one pixel, four times the tiles of a 2 px target for no visible gain while flying.
    return [{ overlay: base, shape: 'ellipsoid' as const, applyOverlayTexture: true, useRecommendedSettings: false }, rest.length ? { renderer: gl, overlays: rest } : null];
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
    <TilesRendererR3F key={basemap} errorTarget={2} ref={useGlobeQueues} onLoadModel={(e: any) => buildBoundsTrees(e.scene)}>
      <TilesPlugin plugin={GeneratedSurfacePlugin as any} args={pluginArgs as any} />
      {extra && <TilesPlugin plugin={ImageOverlayPlugin as any} args={extra as any} />}
      <TilesPlugin plugin={StaleLoadAbortPlugin as any} />
      <TilesPlugin plugin={MotionLodPlugin as any} />
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
function TerrainGlobe({ basemap, gl }: { basemap: BasemapId; gl: THREE.WebGLRenderer }) {
  const overlays = useMemo(() => makeBasemapOverlays(basemap),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [basemap]);
  return (
    <TilesRendererR3F key={basemap} ref={(t: any) => { terrainTiles = t ?? null; useGlobeCache(t); }} onLoadModel={(e: any) => buildBoundsTrees(e.scene)}>
      <TilesPlugin plugin={PrioritizedCesiumIonAuthPlugin as any} args={{ apiToken: CESIUM_ION_TOKEN, assetId: '1', autoRefreshToken: true } as any} />
      <TilesPlugin plugin={QuantizedMeshPlugin as any} />
      {overlays.length > 0 && <TilesPlugin plugin={ImageOverlayPlugin as any} args={{ renderer: gl, overlays } as any} />}
      <TilesPlugin plugin={StaleLoadAbortPlugin as any} />
      <TilesPlugin plugin={MotionLodPlugin as any} />
    </TilesRendererR3F>
  );
}

// Open Terrarium elevation (AWS Terrain Tiles, no key) via 3DTRjs's own TerrariumMeshPlugin, which
// displaces a shared surface mesh on the GPU and drapes the basemap on it. The live renderer is kept in
// a module variable so "snap to ground" can ask the plugin for heights (sampleCartographicElevation) —
// GPU-displaced geometry is invisible to a plain raycast.
let terrariumTiles: TilesRendererImpl | null = null;
/** The real-geometry terrain renderer on screen (World Terrain, Google 3D), if any. */
let terrainTiles: TilesRendererImpl | null = null;

/** One tile of Terrarium at 0 m (R 128, G 0, B 0), as PNG bytes. */
const flatTerrarium = new Map<number, Promise<ArrayBuffer>>();
function flatTerrariumTile(size: number) {
  let p = flatTerrarium.get(size);
  if (!p) {
    const c = new OffscreenCanvas(size, size), ctx = c.getContext('2d')!;
    ctx.fillStyle = 'rgb(128,0,0)';
    ctx.fillRect(0, 0, size, size);
    p = c.convertToBlob({ type: 'image/png' }).then((b) => b.arrayBuffer());
    flatTerrarium.set(size, p);
  }
  return p;
}
/**
 * The plugin decodes whatever comes back and has no per-tile fallback, so a missing tile failed and left
 * a hole. mapterhorn.com answers 404 in two cases, told apart by its complete level (z12): above it,
 * open ocean, which reads as sea level; below it, no regional DEM here (Geghard stops at z12, Rome at
 * z13, Tokyo at z16, Chamonix at z17), so the tile is cut out of the nearest ancestor that exists.
 */
class TerrariumFallbackPlugin extends TerrariumMeshPlugin {
  terrainId: RasterTerrainId;
  constructor(options: any) { super(options); this.terrainId = options.terrainId; }
  async loadRootTileset() {
    const tileset = await super.loadRootTileset();
    const source = this._source, fetchData = source.fetchData;
    source.fetchData = async (url: string, options: RequestInit) => {
      // Re:Earth answers 500 for its z0 tile (RasterTerrain.rootUrl)
      const root = RASTER_TERRAINS[this.terrainId].rootUrl;
      const res = await fetchData(root && /\/0\/0\/0\.\w+$/.test(url) ? root : url, options);
      if (res.status !== 404) return res;
      const m = /(\d+)\/(\d+)\/(\d+)\.\w+$/.exec(url);
      const cut = m && await terrariumFromAncestor(this.terrainId, +m[1], +m[2], +m[3]);
      return new Response(cut ?? await flatTerrariumTile(this.tileDimension));
    };
    return tileset;
  }
}
function TerrariumGlobe({ basemap, source, gl }: { basemap: BasemapId; source: RasterTerrainId; gl: THREE.WebGLRenderer }) {
  const [args, extra] = useMemo(() => {
    const [overlay = null, ...rest] = makeBasemapOverlays(basemap);
    const src = RASTER_TERRAINS[source];
    return [
      // Imagery "None": unlit (no lighting, no bump-map normals) and painted black below, so the
      // ground is a plain black silhouette rather than a white hillshade competing with the data.
      { url: src.url, maxZoom: src.maxZoom, terrainId: source, tileDimension: src.tileSize, overlay, applyOverlayTexture: !!overlay, unlit: !overlay },
      rest.length ? { renderer: gl, overlays: rest } : null,
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemap, source]);
  return (
    // onLoadModel is always a function: the component registers whatever it is given as a listener, and
    // an undefined one throws at every dispatch, which failed each terrain tile as it loaded.
    <TilesRendererR3F key={`${basemap}|${source}`} ref={(t: any) => { terrariumTiles = t ?? null; useGlobeQueues(t); }}
      onLoadModel={(e: any) => { if (!args.overlay) e.scene.traverse((o: any) => { if (o.isMesh && o.material?.color) o.material.color.setRGB(0, 0, 0); }); }}>
      <TilesPlugin plugin={TerrariumFallbackPlugin as any} args={args as any} />
      {extra && <TilesPlugin plugin={ImageOverlayPlugin as any} args={extra as any} />}
      <TilesPlugin plugin={StaleLoadAbortPlugin as any} />
      <TilesPlugin plugin={MotionLodPlugin as any} />
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
    <TilesRendererR3F ref={(t: any) => { terrainTiles = t ?? null; useGlobeCache(t); }} onLoadModel={(e: any) => buildBoundsTrees(e.scene)}>
      <TilesPlugin plugin={GoogleCloudAuthPlugin as any} args={{ apiToken: GOOGLE_MAPS_API_KEY, autoRefreshToken: true } as any} />
      {/* Google Photorealistic 3D Tiles ships Draco-compressed (and sometimes KTX2-textured) geometry —
          same decoders as content below. */}
      <TilesPlugin plugin={GLTFExtensionsPlugin as any} args={{ dracoLoader, ktxLoader } as any} />
      <TilesPlugin plugin={StaleLoadAbortPlugin as any} />
      <TilesPlugin plugin={MotionLodPlugin as any} />
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

// East and north at a lat/lon, true geographic axes (radians).
function enuAxes(lat: number, lon: number) {
  return {
    east: new THREE.Vector3(-Math.sin(lon), Math.cos(lon), 0),
    north: new THREE.Vector3(-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)),
  };
}

/**
 * The crop box in 3D, two-way with the sidebar's numbers (store.crop): it follows them, and a drag
 * writes back on release, so what is extracted is what is drawn. The box is a lon/lat box, so a
 * rotation has no meaning for it and snaps back on release.
 */
function CropGizmo({ tilesRef, pickScene }: { tilesRef: React.MutableRefObject<TilesRendererImpl | null>; pickScene: THREE.Object3D | null }) {
  // state, not a ref: TransformControls needs the mesh on the render it mounts, and the placement
  // below must re-run once the mesh exists
  const [box, setBox] = useState<THREE.Mesh | null>(null);
  const invalidate = useThree((s) => s.invalidate);
  const on = useViewerStore((s) => s.cropGizmoOn);
  const mode = useViewerStore((s) => s.gizmoMode);
  const crop = useViewerStore((s) => s.crop);

  const place = useCallback(() => {
    if (!box) return;
    const { w, s, e, n, minH, maxH } = useViewerStore.getState().crop;
    if ([w, s, e, n, minH, maxH].some((v) => Number.isNaN(v))) return;
    const lat = THREE.MathUtils.degToRad((s + n) / 2), lon = THREE.MathUtils.degToRad((w + e) / 2);
    WGS84_ELLIPSOID.getCartographicToPosition(lat, lon, (minH + maxH) / 2, box.position);
    // Oriented to East/North/Up at its own position: TransformControls' `space="local"` then draws its
    // arrows along those axes. (east, up, south) is the proper rotation: (east, up, north) would mirror.
    const up = WGS84_ELLIPSOID.getPositionToNormal(box.position, new THREE.Vector3());
    const { east, north } = enuAxes(lat, lon);
    box.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(east, up, north.clone().negate()));
    const R = 6378137;
    box.scale.set(
      Math.max(1, THREE.MathUtils.degToRad(e - w) * R * Math.cos(lat)),
      Math.max(1, maxH - minH),
      Math.max(1, THREE.MathUtils.degToRad(n - s) * R),
    );
    invalidate();
  }, [box, invalidate]);
  useEffect(place, [place, crop, on]);

  /** The dragged box back to lon/lat/heights. */
  const commit = useCallback(() => {
    if (!box) return;
    const c = WGS84_ELLIPSOID.getPositionToCartographic(box.position, { lat: 0, lon: 0, height: 0 } as any);
    const R = 6378137;
    const lat = THREE.MathUtils.radToDeg(c.lat), lon = THREE.MathUtils.radToDeg(c.lon);
    const halfLat = THREE.MathUtils.radToDeg(Math.abs(box.scale.z) / 2 / R);
    const halfLon = THREE.MathUtils.radToDeg(Math.abs(box.scale.x) / 2 / (R * Math.max(0.01, Math.cos(c.lat))));
    const halfH = Math.abs(box.scale.y) / 2;
    useViewerStore.getState().setCrop({ w: lon - halfLon, e: lon + halfLon, s: lat - halfLat, n: lat + halfLat, minH: Math.round(c.height - halfH), maxH: Math.round(c.height + halfH) });
    place();                                                    // a rotation snaps back; crop may be unchanged
  }, [box, place]);

  if (!on || !pickScene || !tilesRef.current) return null;
  return (
    <>
      <mesh ref={setBox} raycast={() => {}} renderOrder={10}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="cyan" wireframe depthTest={false} transparent />
      </mesh>
      {box && <TransformControls object={box} mode={mode} space="local" onMouseUp={commit} />}
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
function MosaicOutlines({ url, tilesRef, cellsOnly }: { url: string; tilesRef: React.MutableRefObject<TilesRendererImpl | null>; cellsOnly: boolean }) {
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
      if (cellsOnly && o.leaf) continue;
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
  }, [outlines, cellsOnly, tilesRef, invalidate]);
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
    loader.setWorkerLimit(DECODE_WORKERS);
    loader.detectSupport(gl);
    return loader;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl]);
  const invalidate = useThree((s) => s.invalidate);
  const store = useViewerStore;
  const sceneHandleRef = useRef<ViewerHandle | null>(null);       // the devtools hook's way to the handle
  const [pendingFlyTo, setPendingFlyTo] = useState<{ lon: number; lat: number; height: number } | null>(null);
  const [pendingPose, setPendingPose] = useState<CameraPose | null>(null);
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
  const lastSphereRadiusRef = useRef(0);
  const framedAtRef = useRef(0);                              // performance.now() of the last frameToTileset
  // Where the user is looking now: the orbit target, or globe/env's last zoom/drag pivot, sampled
  // every frame. A control scheme mounting mid-session starts from HERE, not from the tileset's
  // centre (which, after navigating away, could be a continent off: the "huge jump" on switching).
  const lastPivotRef = useRef<THREE.Vector3 | null>(null);
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

  // 'auto' resolves to a real scheme by height (autoScheme, useFrame below): everything else keys off
  // the scheme actually mounted, so a switch behaves like the user picking it in the sidebar.
  const controlSetting = useViewerStore((s) => s.controlMode);
  const [autoScheme, setAutoScheme] = useState<'globe' | 'orbit'>('globe');
  const controlMode = controlSetting === 'auto' ? autoScheme : controlSetting;
  const terrainBehind = useViewerStore((s) => s.terrainBehind);
  const gizmoOn = useViewerStore((s) => s.cropGizmoOn || s.tilesetGizmoOn);
  const ortho = useViewerStore((s) => s.ortho);
  const debugMode = useViewerStore((s) => s.debugMode);
  const pointAdaptive = useViewerStore((s) => s.pointAdaptive);
  const fov = useViewerStore((s) => s.fov);
  const maxSSE = useViewerStore((s) => s.maxSSE);
  const assetVisible = useViewerStore((s) => s.assetVisible);
  const pointSize = useViewerStore((s) => s.pointSize);
  // Native mosaic leaves (3DTRjs only): an /aggregate URL is ALWAYS requested with &native=1 (the
  // mosaic is the same either way: the extension sits beside each leaf's /stream link), and the
  // NativeLeavesPlugin switches each Potree leaf between its PotreePlugin child and its /stream child
  // in place — so the checkbox never remounts the renderer. See lib/nativeLeaves.ts.
  const [{ native }] = useUrlState();
  const tilesUrl = loadArgs ? withNativeLeaves(loadArgs.url) : undefined;
  // Google Photorealistic 3D Tiles loaded as the DATA (the "Google 3D" pill): its root.json names its children by
  // root-relative paths with a session, and every one of them must also carry the key, which only
  // GoogleCloudAuthPlugin appends (seen 2026-11-13: the root loaded, all 37 first tiles failed, a blank globe).
  const isGoogleData = /tile\.googleapis\.com/.test(tilesUrl ?? '');
  const basemap = useViewerStore((s) => s.basemap);
  const terrainMode = useViewerStore((s) => s.terrainMode);
  const terrain = resolveTerrainMode(terrainMode, '3dtrjs');
  const globeVisible = useViewerStore((s) => s.globeVisible);
  const datasetStyleRef = useRef<DatasetStyle | null>(null);
  // Whether the WGS84-radius wireframe globe is meaningful to show at all — see frameToTileset below.
  const [showGlobe, setShowGlobe] = useState(true);
  useEffect(() => { if (!loadArgs) setShowGlobe(true); }, [loadArgs]);
  // The controls' closest approach to the pivot, from the framed content's size: 1 m on a globe or a building, a
  // few mm on a scan smaller than a metre (the Stanford dragon, 0.12 m, framed 0.37 m away, was pushed to 1 m).
  const [minDist, setMinDist] = useState(1);
  // EnvironmentControls keeps a sphere of `cameraRadius` (5 m by default) around the camera clear of the scene,
  // terrain included: framed 0.37 m from the dragon, the camera was pushed 7.9 m away once the terrain under it had
  // loaded, and the dragon left the view. A quarter of the framed radius, 5 m at most.
  const [camRadius, setCamRadius] = useState(5);
  // The controls also lift the camera above whatever is under it (`adjustHeight`), terrain included, by raycasting
  // down from above: a coarse terrain tile that for a moment stands 2.6 m above the camera framed on the dragon
  // pushed it off the scene for good. Off for a scene under 20 m across, where a terrain tile's error is of the
  // scene's own size; on for everything else, where it keeps the camera out of the ground.
  const [adjustHeight, setAdjustHeight] = useState(true);
  useEffect(() => { setPickScene(null); store.getState().setPointHeightRange(null); }, [tilesUrl]);

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
  // What the globe/env controls raycast to find the point under the cursor: the content AND the
  // globe/terrain renderers (one group around both, below). With the content group alone, a drag
  // that started on the terrain found nothing: EnvironmentControls then fell back to its default
  // plane (world Y = 0, through the Earth's centre) and did nothing useful ("only middle-drag works").
  const [navScene, setNavScene] = useState<THREE.Object3D | null>(null);
  const navSceneRef = useRef<THREE.Object3D | null>(null);
  navSceneRef.current = navScene;

  // The controls pick with the viewer's rule (lib/picking): no hidden objects, wireframes, transparent
  // materials or back faces, and the data before the terrain. Re-run whenever a control scheme
  // (re)mounts; the install is idempotent per instance.
  useEffect(() => {
    installFilteredRaycast(controlsRef.current, () => tilesRef.current?.group ?? null, () => navSceneRef.current);
  }, [controlMode, navScene, pickScene]);

  // Terrain first, then the data on a cleared depth buffer (store.terrainBehind).
  const clearDepthHook = useMemo(makeClearDepthHook, []);
  useEffect(() => () => { clearDepthHook.geometry.dispose(); (clearDepthHook.material as THREE.Material).dispose(); }, [clearDepthHook]);
  useEffect(() => { invalidate(); }, [terrainBehind, invalidate]);

  // Which datasets of a mosaic have tiles on screen right now — the markers hand off to the data only
  // for these (ThreeDatasetMarkers). Sampled every few frames from the renderer's visible set.
  const loadedRef = useRef<LoadedDatasets>({ ids: new Set(), version: 0 });
  const frameCounter = useRef(0);

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
    (lastPivotRef.current ??= new THREE.Vector3()).copy(point);
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
    // FlyControls.update(delta) needs the frame's delta (undefined → NaN camera): drei's own frame
    // loop drives it; everything else can be nudged here
    if (!('movementSpeed' in controls)) controls.update?.();
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
    // A local scene lands at the frame's altitude whatever the terrain there is, inside or under it as often as
    // not (an LCC2 showroom, a Nexus statue): a fresh load of one turns the ground snap on, which measures the
    // scene's own ground against the terrain and keeps it there as the terrain refines; a georeferenced load
    // turns it back off, since its heights are its own. Only while the user has not touched the toggle: once
    // they have, their choice holds across loads ("auto Z reactivates by itself even when I disabled it").
    if (isFreshLoad && store.getState().zOffsetAutoByUser == null && store.getState().zOffsetAuto !== !!needsEnuAnchorRef.current) store.getState().setZOffsetAuto(!!needsEnuAnchorRef.current);
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
    // a whole-planet root's sphere is bigger than the Earth (every dataset around the globe): frame
    // the Earth itself, not that sphere, or the globe is a marble
    const dist = global ? 2.6 * 6378137 : (sphere.radius / Math.sin(fovRad / 2)) * 1.5;
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
      // camera SOUTH of the target, so the view faces north and, with camera.up = surface normal,
      // north is up on screen (it used to sit north of it, looking south: "globe is not north up")
      dir = surfaceUp.clone().multiplyScalar(Math.sin(pitch)).addScaledVector(north, -Math.cos(pitch)).normalize();
    } else if (global) {
      // a whole-planet root (an aggregate mosaic): from above AlUla, north up
      dir = WGS84_ELLIPSOID.getPositionToNormal(WGS84_ELLIPSOID.getCartographicToPosition(ALULA.lat, ALULA.lon, 0, new THREE.Vector3()), new THREE.Vector3());
      camera.up.copy(northAt(ALULA.lat, ALULA.lon));
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
    lastSphereRadiusRef.current = sphere.radius;
    framedAtRef.current = performance.now();
    setMinDist(global ? 1 : THREE.MathUtils.clamp(sphere.radius / 20, 0.005, 1));
    setCamRadius(global ? 5 : THREE.MathUtils.clamp(sphere.radius / 4, 0.01, 5));
    setAdjustHeight(global || sphere.radius > 20);
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
  // The pivot is the point last looked at (lastPivotRef), and "up" is the ellipsoid normal THERE: the
  // normal at the tileset's centre is degrees off once the camera has moved a few hundred km, which
  // read as "orbit/env up is not north-aligned when far away".
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const pivot = lastPivotRef.current ?? lastSphereCenterRef.current;
    if (!pivot) return;
    const up = pivot.length() > 6378137 * 0.5 ? WGS84_ELLIPSOID.getPositionToNormal(pivot, new THREE.Vector3()) : new THREE.Vector3(0, 1, 0);
    camera.up.copy(up);
    if (controls.up) controls.up.copy(up);
    // OrbitControls turned camera.up into a quaternion once, at construction: refresh it
    if (controls._quat && controls._quatInverse) {
      controls._quat.setFromUnitVectors(up, new THREE.Vector3(0, 1, 0));
      controls._quatInverse.copy(controls._quat).invert();
    }
    setControlsPivot(pivot, true);
    invalidate();
  }, [controlMode, setControlsPivot, invalidate, camera]);

  // Nothing loaded yet: the Earth seen from above AlUla, north up (see ALULA).
  useEffect(() => {
    if (loadArgs) return;
    const E = WGS84_ELLIPSOID;
    camera.position.copy(E.getCartographicToPosition(ALULA.lat, ALULA.lon, 1.4e7, new THREE.Vector3()));
    camera.up.copy(northAt(ALULA.lat, ALULA.lon));
    camera.lookAt(0, 0, 0);
    (camera as THREE.PerspectiveCamera).updateProjectionMatrix?.();
    setControlsPivot(E.getCartographicToPosition(ALULA.lat, ALULA.lon, 0, new THREE.Vector3()), true);
    invalidate();
  }, [loadArgs, camera, setControlsPivot, invalidate]);

  // Kill whatever motion the controls still carry (a drag's damping, a wheel zoom in flight) before
  // a scripted camera move; otherwise both drive the camera for the first frames ("the camera jumps
  // at the start of the animation").
  const stopControlsMotion = useCallback(() => {
    const c = controlsRef.current;
    if (!c) return;
    if (c.isEnvironmentControls) {
      c.resetState?.();
      c.zoomDelta = 0; c.zoomDirectionSet = false; c.zoomPointSet = false;
      c.dragInertia?.set(0, 0, 0); c.rotationInertia?.set(0, 0);
    } else {
      c._sphericalDelta?.set(0, 0, 0); c._panOffset?.set(0, 0, 0);
      if ('_scale' in c) c._scale = 1;
    }
  }, []);

  // Controls "Auto": Globe from far away (drag the planet), Orbit near the ground (turn around what is
  // on screen). Two thresholds so a zoom hovering around one doesn't flip back and forth, measured from
  // the ground where the terrain is known. Never mid-gesture or mid-flight: the switch waits for the
  // pointer to be released and the wheel to settle, then happens on a frame queued for it.
  const autoInput = useRef({ pressed: false, lastWheel: 0 });
  useEffect(() => {
    if (controlSetting !== 'auto') return;
    const dom = gl.domElement, input = autoInput.current;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const later = () => { if (timer) clearTimeout(timer); timer = setTimeout(invalidate, AUTO_SETTLE_MS + 20); };
    const down = () => { input.pressed = true; };
    const up = () => { input.pressed = false; later(); };
    const wheel = () => { input.lastWheel = performance.now(); later(); };
    dom.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    dom.addEventListener('wheel', wheel, { passive: true });
    return () => { if (timer) clearTimeout(timer); dom.removeEventListener('pointerdown', down); window.removeEventListener('pointerup', up); dom.removeEventListener('wheel', wheel); };
  }, [controlSetting, gl, invalidate]);
  const autoSwitch = (geoCam: boolean) => {
    const input = autoInput.current;
    if (input.pressed || flight.active || performance.now() - input.lastWheel < AUTO_SETTLE_MS) return;
    let height = 0;
    if (geoCam) {
      WGS84_ELLIPSOID.getPositionToCartographic(camera.position, cartoProbe);
      const ground = terrain === 'wgs84' ? 0 : (terrariumTiles as any)?.getPluginByName?.('TERRARIUM_MESH_PLUGIN')?.sampleCartographicElevation(cartoProbe.lat, cartoProbe.lon);
      height = cartoProbe.height - (ground ?? 0);
    }
    const next = !geoCam ? 'orbit' : height < AUTO_ORBIT_BELOW ? 'orbit' : height > AUTO_GLOBE_ABOVE ? 'globe' : autoScheme;
    if (next === autoScheme) return;
    if (next === 'orbit' && geoCam) {
      // Orbit turns around its target and re-aims the camera at it, so the target goes under the
      // centre of the screen. Near-nadir (how one arrives from space) its up vector is parallel to the
      // view and the heading would be arbitrary: a tilt of 2° keeps the one on screen.
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
      const hit = pickPoint(raycaster, tilesRef.current?.group ?? null, navSceneRef.current);
      const view = camera.getWorldDirection(new THREE.Vector3());
      const fallback = camera.position.clone().addScaledVector(view, Math.max(height, 10) * 2);
      const target = hit && hit.point.distanceTo(camera.position) < Math.max(height, 10) * 20 ? hit.point.clone() : fallback;
      const up = WGS84_ELLIPSOID.getPositionToNormal(target, new THREE.Vector3());
      if (Math.abs(view.dot(up)) > Math.cos(THREE.MathUtils.degToRad(2))) {
        const screenUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
        camera.position.addScaledVector(screenUp, -0.035 * camera.position.distanceTo(target));
      }
      (lastPivotRef.current ??= new THREE.Vector3()).copy(target);
    }
    setAutoScheme(next);
  };

  // Per frame: remember the current pivot, and keep the clip planes sane for orbit/env. GlobeControls
  // sets near/far itself (adjustCamera, from the horizon); OrbitControls and EnvironmentControls never
  // touch them, so they stayed at whatever frameToTileset chose for the first framing distance: zoom
  // from a city overview to a facade and the near plane (1 % of that first distance) eats the facade.
  const pivotProbe = useMemo(() => new THREE.Vector3(), []);
  const cartoProbe = useMemo(() => ({ lat: 0, lon: 0, height: 0 }), []);
  useFrame(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    // GlobeControls.adjustCamera() floors the near plane at 1 m (lerp(1, 1000) by altitude, for the globe), which
    // clips away a scene smaller than a metre: the Stanford dragon (0.12 m), framed 0.37 m from the camera, was
    // entirely inside the near plane and "nxs showed nothing". Wrapped once per controls: close to the content
    // the near plane follows the distance (the depth buffer is logarithmic, so a near:far of 1e9 costs nothing).
    if (controls.isGlobeControls && !controls.__nearWrapped) {
      controls.__nearWrapped = true;
      const orig = controls.adjustCamera.bind(controls);
      controls.adjustCamera = (cam: any) => {
        orig(cam);
        const c = lastSphereCenterRef.current;
        if (!cam.isPerspectiveCamera || !c) return;
        const d = Math.min(cam.position.distanceTo(c), controls.pivotPoint ? cam.position.distanceTo(controls.pivotPoint) : Infinity);
        if (d < 100 && cam.near > d * 0.01) { cam.near = Math.max(d * 0.01, 0.002); cam.updateProjectionMatrix(); }
      };
    }
    // Safety net for "the controls froze until I switched them": drei's TransformControls disables
    // the default controls for the length of a gizmo drag and re-enables them on release; a gizmo
    // unmounted (or remounted) mid-drag never re-enables them. No gizmo shown = controls enabled.
    if (!gizmoOn && controls.enabled === false) { controls.enabled = true; invalidate(); }
    // (a just-mounted OrbitControls still has its default target at the origin, until the effect above
    // gives it the pivot: a frame in between must not overwrite that pivot with the Earth's centre)
    if (controls.target) { if (controls.target.lengthSq() > 0) (lastPivotRef.current ??= new THREE.Vector3()).copy(controls.target); }
    else if (controls.getPivotPoint && controls.getPivotPoint(pivotProbe)) (lastPivotRef.current ??= new THREE.Vector3()).copy(pivotProbe);

    // Mosaic markers: which datasets are drawing (every 10th frame; cheap, visibleTiles is small)
    if (markers && ++frameCounter.current % 10 === 0) {
      const ids = new Set<string>();
      tilesRef.current?.visibleTiles.forEach((t: any) => { const id = tileDatasetId(t, threeTileId); if (id) ids.add(id); });
      const cur = loadedRef.current;
      if (ids.size !== cur.ids.size || [...ids].some((i) => !cur.ids.has(i))) { cur.ids = ids; cur.version++; }
    }

    // The camera's roll is the controls' own business: GlobeControls keeps the camera up on the local
    // vertical when near the surface and nudges it toward north only from far away (its
    // _alignCameraUp / _alignCameraUpToNorth); nothing here fights that.
    const geoCam = camera.position.length() > 6378137 * 0.5;
    if (controlSetting === 'auto') autoSwitch(geoCam);
    if (!(camera as THREE.PerspectiveCamera).isPerspectiveCamera) return;
    const pivot = lastPivotRef.current ?? lastSphereCenterRef.current;
    // EnvironmentControls takes its "up" from `this.up`, set once; a camera that travelled far from
    // where it was set has a stale up, and a drag whose ray is near-parallel to that up is refused
    // (DRAG_PLANE_THRESHOLD): the "controls froze" of env mode. Keep it the ellipsoid normal here.
    if (controls.isEnvironmentControls && !controls.isGlobeControls && controls.up && geoCam) {
      WGS84_ELLIPSOID.getPositionToNormal(camera.position, pivotProbe);
      if (controls.up.dot(pivotProbe) < 0.99999) { controls.up.copy(pivotProbe); camera.up.copy(pivotProbe); }
    }
    if (controlMode === 'globe') return;
    // Fly: metres per second scaled to the height above the ground (a city in a few seconds from
    // 2 km up, a facade at walking pace); roll stays slow.
    if (controlMode === 'fly' && 'movementSpeed' in controls) {
      let alt = 100;
      if (geoCam) { WGS84_ELLIPSOID.getPositionToCartographic(camera.position, cartoProbe); alt = Math.max(cartoProbe.height, 2); }
      else if (lastSphereCenterRef.current) alt = Math.max(camera.position.distanceTo(lastSphereCenterRef.current), 2);
      controls.movementSpeed = alt * 0.5;
    }
    if (!pivot) return;
    const d = camera.position.distanceTo(pivot);
    const geo = pivot.length() > 6378137 * 0.5;
    // EnvironmentControls' fallback plane (a drag or zoom that hits no geometry) is world Y = 0 by
    // default, i.e. through the Earth's centre: make it the local horizontal plane at the pivot.
    if (controls.fallbackPlane && controls.isEnvironmentControls && !controls.isGlobeControls) {
      const up = geo ? WGS84_ELLIPSOID.getPositionToNormal(pivot, pivotProbe) : pivotProbe.set(0, 1, 0);
      controls.fallbackPlane.setFromNormalAndCoplanarPoint(up, pivot);
    }
    // The pivot can sit kilometres away (an orbit target left behind, the horizon under a globe
    // drag) while the camera is a few metres above a facade: the near plane also follows the
    // camera's own height above the ellipsoid, or the content beneath it is clipped away
    // ("the tileset disappears in orbit", "terrain disappears").
    let base = d;
    if (geo) { WGS84_ELLIPSOID.getPositionToCartographic(camera.position, cartoProbe); base = Math.min(d, Math.max(cartoProbe.height, 1)); }
    // logarithmicDepthBuffer is on (see <Canvas>), so a near:far ratio of 1e9 costs no precision
    const near = THREE.MathUtils.clamp(base * 2e-4, 0.02, 1000);
    const far = geo ? camera.position.length() + 6378137 * 2.5 : Math.max(d * 200, 1e4);
    if (Math.abs(camera.near - near) > near * 0.05 || Math.abs(camera.far - far) > far * 0.05) {
      camera.near = near;
      camera.far = far;
      (camera as THREE.PerspectiveCamera).updateProjectionMatrix();
    }
  });

  // rAF-driven eased camera tween — Canvas runs frameloop="demand", so each step must invalidate() to
  // actually get drawn. Used by double-click-to-zoom below (previously an instant one-frame jump).
  const cameraTweenRef = useRef<number | null>(null);
  const animateCameraTo = useCallback((toPos: THREE.Vector3, toLookAt: THREE.Vector3, durationMs = 450) => {
    if (cameraTweenRef.current != null) cancelAnimationFrame(cameraTweenRef.current);
    const fromPos = camera.position.clone();
    const controls = controlsRef.current;
    // Where the camera looks NOW: a point ON the view axis (not the pivot itself, which sits off-axis
    // after a pan or a globe drag), at the pivot's distance. Frame 0 of the tween then reproduces the
    // current view exactly. (It used to be the pivot, or 1 m ahead of the camera: the first frames
    // swung the view direction, "the camera jumps at the start of the animation".)
    const pivot = new THREE.Vector3();
    const hasPivot = controls?.target ? !!pivot.copy(controls.target) : !!controls?.getPivotPoint?.(pivot);
    const fromLookAt = camera.position.clone().addScaledVector(camera.getWorldDirection(new THREE.Vector3()),
      hasPivot ? camera.position.distanceTo(pivot) : camera.position.distanceTo(toLookAt));
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
    const toUp = toLookAt.length() > 1e6 ? up : new THREE.Vector3(0, 1, 0);   // local scenes keep +Y
    // the camera's REAL up right now, from its orientation: camera.up is only the hint lookAt() last
    // used, and is stale after a controls switch (the roll snapped on frame 0: "wrong camera up before
    // the transition")
    const fromUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    flight.active = true;                                    // coarse tiles while flying (lib/motionLod.ts)
    const t0 = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / durationMs);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease-in-out-quad
      camera.up.copy(fromUp).lerp(toUp, eased).normalize();   // the roll eases too, no snap
      camera.position.lerpVectors(fromPos, toPos, eased);
      const lookAt = new THREE.Vector3().lerpVectors(fromLookAt, toLookAt, eased);
      camera.lookAt(lookAt);
      setControlsPivot(lookAt);
      if (t >= 1) {
        flight.active = false;
        // OrbitControls cached camera.up as a quaternion at construction; EnvironmentControls keeps
        // its own `up`. Both must follow, or the next drag snaps the roll back.
        if (controls?._quat && controls._quatInverse) { controls._quat.setFromUnitVectors(camera.up, new THREE.Vector3(0, 1, 0)); controls._quatInverse.copy(controls._quat).invert(); }
        if (controls?.up && controls.isEnvironmentControls && !controls.isGlobeControls) controls.up.copy(camera.up);
      }
      invalidate();
      cameraTweenRef.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    cameraTweenRef.current = requestAnimationFrame(step);
  }, [camera, invalidate, setControlsPivot]);
  useEffect(() => () => { if (cameraTweenRef.current != null) cancelAnimationFrame(cameraTweenRef.current); flight.active = false; }, []);
  useEffect(() => { setMotionLodInvalidate(invalidate); return () => setMotionLodInvalidate(null); }, [invalidate]);

  // Double-click to re-pivot + zoom halfway toward the clicked point — mirrors CesiumViewer's own
  // LEFT_DOUBLE_CLICK handler (same 50%-lerp-toward-the-pick behavior) for consistency between
  // renderers, animated with an ease-in/ease-out tween instead of an instant one-frame jump. The
  // pick follows lib/picking: the data before the ground, never a hidden or back-facing surface.
  useEffect(() => {
    const dom = gl.domElement;
    function onDblClick(e: MouseEvent) {
      const tiles = tilesRef.current;
      if (!tiles) return;
      const raycaster = new THREE.Raycaster();
      applyPointsPickTolerance(raycaster, camera, dom, lastSphereCenterRef.current ?? camera.position);
      raycaster.setFromCamera(pointerNdc(e, dom), camera);
      const hit = pickPoint(raycaster, tiles.group, navSceneRef.current);
      if (!hit) return;
      stopControlsMotion();
      const targetPos = camera.position.clone().lerp(hit.point, 0.5);
      animateCameraTo(targetPos, hit.point);
    }
    dom.addEventListener('dblclick', onDblClick);
    return () => dom.removeEventListener('dblclick', onDblClick);
  }, [gl, camera, animateCameraTo, stopControlsMotion]);

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
      const raycaster = new THREE.Raycaster();
      applyPointsPickTolerance(raycaster, camera, dom, lastSphereCenterRef.current ?? camera.position);
      raycaster.setFromCamera(pointerNdc(e, dom), camera);
      const hit = pickPoint(raycaster, tilesRef.current?.group ?? null, navSceneRef.current);
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
      // globe/env: the clicked point also becomes the rotate/zoom pivot. (Not for OrbitControls,
      // which re-aims the camera at .target: the view would jump to centre the point.)
      if (!controlsRef.current?.target) setControlsPivot(pivot);
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
      // Drag DOWN (+dy) dollies in, drag up dollies out ("dragging down should always zoom in").
      const scale = Math.exp(-dy * 0.005);
      if (scale < 1 && toCam.length() * scale < 0.1) return;             // never through the point
      const delta = toCam.multiplyScalar(scale - 1);                     // camera displacement
      camera.position.add(delta);
      // OrbitControls: slide the target by the same amount, so the view direction holds and the zoom
      // converges on the CLICKED point rather than the screen centre (its own middle-drag is off, below)
      const controls = controlsRef.current;
      if (controls?.target) controls.target.add(delta);
      if (controls && !('movementSpeed' in controls)) controls.update?.();   // not FlyControls (needs a delta)
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
  }, [gl, camera, invalidate, scene, setControlsPivot]);

  const isSplat = loadArgs?.type === 'splat';
  const isPoints = loadArgs?.type === 'pointcloud';
  const defaultSSE = isSplat ? 0.5 : loadArgs?.type === 'mesh' ? 16 : 2;   // see CesiumViewer: 2 px for points
  const errorTarget = loadArgs?.sseOverride ?? maxSSE ?? defaultSSE;
  const autoSSE = loadArgs ? loadArgs.sseOverride ?? defaultSSE : null;
  useEffect(() => { store.getState().setAutoSSE(autoSSE); }, [autoSSE]);

  // Read fresh in onLoadContentModel below (called from 3d-tiles-renderer's own event, not a React
  // effect) — a plain closure over `pointSize` would capture whatever value was current when
  // TilesRendererR3F itself last remounted, not the slider's current value.
  const pointSizeRef = useRef(pointSize);
  pointSizeRef.current = pointSize;
  const pointAdaptiveRef = useRef(pointAdaptive);
  pointAdaptiveRef.current = pointAdaptive;
  const materialMode = useViewerStore((s) => s.materialMode);
  const xrayOpacity = useViewerStore((s) => s.xrayOpacity);
  const pointColorMode = useViewerStore((s) => s.pointColorMode);
  const pointColor = useViewerStore((s) => s.pointColor);
  const pointHeightRange = useViewerStore((s) => s.pointHeightRange);
  const materialOpts = useMemo((): MaterialOpts => ({ mode: materialMode, opacity: xrayOpacity, points: pointColorMode, color: pointColor, range: pointHeightRange, stop: tilesRef.current?.group ?? null }), [materialMode, xrayOpacity, pointColorMode, pointColor, pointHeightRange, pickScene]);
  const materialModeRef = useRef(materialOpts);
  materialModeRef.current = materialOpts;
  /**
   * Point size for one tile. Fixed: `pointSize` px. Adaptive: a world-space size from the tile's
   * geometric error — for a Potree/COPC-derived tile that is its point spacing — so coarse tiles
   * close their gaps and fine tiles stay sharp (what the potree lab's "size from tile GE" does, and
   * Cesium's attenuation approximates). Half the px size acts as the multiplier.
   */
  /**
   * A tile's point spacing. /stream's Potree/COPC tiles say it (geometricError = spacing); a 3D Tiles
   * point cloud's geometric error is whatever its author chose (Iconem's Angkor: many times the
   * spacing, so every point drew as a blob). Estimate it from the tile itself (points over a disc of
   * the geometry's bounding radius) and trust the geometric error only when it agrees.
   */
  const pointSpacing = (o: any, tile: any): number => {
    const g = o.geometry;
    const n = g?.attributes?.position?.count ?? 0;
    if (!n) return tile.geometricError;
    if (!g.boundingSphere) g.computeBoundingSphere();
    const est = g.boundingSphere.radius * Math.sqrt(Math.PI / n);
    const ge = tile.geometricError;
    return est > 0 && ge > 4 * est ? est : ge;
  };
  const applyPointSize = (o: any, tile: any) => {
    if (!o.isPoints || !o.material) return;
    // PotreePlugin sizes its own points, per point, from its active-nodes texture
    if (tile?.internal?.nativeLeaf || o.material.uniforms?.uActiveNodes?.value) return;
    // The material is PointCloudEffectsPlugin's PointCloudMaterial (swapped in by processTileModel
    // before this runs): shape, min/max size, EDL and the ADD child boxes live there.
    const adaptive = pointAdaptiveRef.current && Number.isFinite(tile?.geometricError) && tile.geometricError > 0;
    o.material.sizeAttenuation = adaptive;
    o.material.size = adaptive ? pointSpacing(o, tile) * pointSizeRef.current * 0.5 : pointSizeRef.current;
    o.material.needsUpdate = true;
  };

  // PointCloudEffectsPlugin options, read from the store at construction (getters), for the parent
  // renderer, every /stream child and every native Potree leaf (PotreePlugin extends the same class).
  const effectsArgs = useMemo(() => ({
    get pointShape() { return store.getState().pointShape; },
    get edlStrength() { const s = store.getState(); return s.edl ? s.edlStrength : 0; },
    get minPointSize() { return Math.min(2, store.getState().pointSize); },
    get maxPointSize() { return THREE.MathUtils.clamp(store.getState().pointSize * 8, 12, 48); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);
  const applyEffects = useCallback(() => {
    const tiles = tilesRef.current as any;
    if (!tiles) return;
    const s = store.getState();
    const apply = (p: any) => {
      if (!p) return;
      p.pointShape = s.pointShape;
      p.edlStrength = s.edl ? s.edlStrength : 0;
      p.minPointSize = Math.min(2, s.pointSize);
      p.maxPointSize = THREE.MathUtils.clamp(s.pointSize * 8, 12, 48);
    };
    apply(tiles.getPluginByName?.('POINT_CLOUD_EFFECTS_PLUGIN'));
    tiles.getPluginByName?.('NATIVE_LEAVES_PLUGIN')?.forEachEffects(apply);
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invalidate]);
  const pointShape = useViewerStore((s) => s.pointShape);
  const edl = useViewerStore((s) => s.edl);
  const edlStrength = useViewerStore((s) => s.edlStrength);
  useEffect(() => { applyEffects(); }, [pointShape, edl, edlStrength, pointSize, loadArgs, applyEffects]);

  // ONE args object for the plugin's lifetime. <TilesPlugin> re-instantiates its plugin whenever
  // `args` changes (a shallow compare), and an inline literal with a fresh arrow function did that on
  // EVERY Scene render: a terrain, point-size or controls change disposed the Potree child renderers,
  // and the new plugin never re-claims already-parsed leaves ("switching terrain / changing point
  // size / switching controls disables the Potree tileset" with native leaves on).
  const gltfArgs = useMemo(() => ({ dracoLoader, ktxLoader }), [ktxLoader]);
  const gltfArgsRef = useRef(gltfArgs);
  gltfArgsRef.current = gltfArgs;
  const nativeRef = useRef(native);
  nativeRef.current = native;
  const nativeArgs = useMemo(() => ({
    // read at construction: a renderer remount (new URL) picks up the checkbox's current state
    get mode() { return nativeRef.current ? 'native' : 'stream'; },
    pointScale: pointSizeRef.current / 2,
    // a /stream child renderer gets the same plugin set as the parent's own /stream leaves
    createStreamPlugins: () => [
      new ImplicitTilingPlugin(),
      new (GLTFExtensionsPlugin as any)(gltfArgsRef.current),
      new (PointCloudEffectsPlugin as any)({ ...effectsArgs }),
      new AddRefinePointSizePlugin(),
    ],
    effectOptions: () => ({ ...effectsArgs }),
    // every child renderer (native and /stream) drops the downloads the camera left behind
    extraPlugins: () => [new StaleLoadAbortPlugin()],
    // a child's model is treated like one of the parent's own: pickable, styled, sized
    onChildModel: (sc: THREE.Object3D, leaf: any, childTile: any) => {
      buildBoundsTrees(sc);
      setContentRenderOrder(sc);
      styleDatasetModel(sc, leaf, datasetStyleRef.current);
      sc.traverse((o: any) => { applyPointSize(o, childTile); applyMaterialMode(o, materialModeRef.current); });
      if (store.getState().pointColorMode === 'height' && !store.getState().pointHeightRange) fitPointHeightsRef.current();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);
  // Mosaic dataset roots load only once they span this many pixels (lib/footprintGate.ts)
  // (a picker-hidden dataset is masked too: no loading, its tiles leave the cache)
  const gateArgs = useMemo(() => ({ minPixels: 24, idOf: threeTileId, isHidden: (id: string) => !!datasetStyleRef.current?.hidden.has(id) }), []);
  // the checkbox flips the variant in place (both stay mounted; see lib/nativeLeaves.ts)
  useEffect(() => {
    const plugin = (tilesRef.current as any)?.getPluginByName?.('NATIVE_LEAVES_PLUGIN');
    if (plugin) plugin.mode = native ? 'native' : 'stream';
    invalidate();
  }, [native, invalidate]);
  const splatArgs = useMemo(() => ({ renderer: gl, scene }), [gl, scene]);

  // Point size was only ever (re)applied by the rAF-throttled effect below, which fires on slider drag
  // or on the INITIAL loadArgs change — but tiles for a large point cloud keep streaming in well after
  // that first effect run finds nothing yet to restyle (`tiles.group` is still empty at that instant).
  // Every subsequently-loaded tile then rendered at three.js's PointsMaterial default size until the
  // user nudged the slider by hand. Apply it per newly-loaded tile too, not just on slider changes.
  const onLoadContentModel = useCallback((e: any) => {
    buildBoundsTrees(e.scene);
    setContentRenderOrder(e.scene);
    styleDatasetModel(e.scene, e.tile, datasetStyleRef.current);
    e.scene.traverse((o: any) => { applyPointSize(o, e.tile); applyMaterialMode(o, materialModeRef.current); });   // any points, whatever the preset's type
    if (store.getState().pointColorMode === 'height' && !store.getState().pointHeightRange) fitPointHeightsRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Canvas runs frameloop="demand" (see below) — controls/TilesRenderer/CameraTransition all invalidate()
  // themselves on their own 'change'/'needs-update' events, but a bare controls/plugin remount (switching
  // globe/orbit/env, toggling debug tiles, changing basemap or LOD target) has nothing queued yet, so it'd
  // otherwise sit frozen until the next interaction.
  useEffect(() => { invalidate(); }, [controlMode, debugMode, basemap, terrainMode, errorTarget, invalidate]);
  // Trackball and Fly keep the camera level, like Orbit: neither has an up vector of its own
  // (Trackball rotates camera.up with every drag, Fly composes pitch and yaw in the camera's own frame),
  // so the roll they accumulate is removed after each of their updates. The vertical is the ellipsoid
  // normal (at the trackball target, at the fly camera) on the globe, world +Y otherwise. Trackball
  // also stops 2° short of the zenith and nadir instead of rolling over the pole.
  const levelTmp = useMemo(() => ({ up: new THREE.Vector3(), v: new THREE.Vector3(), h: new THREE.Vector3(), prevH: new THREE.Vector3(), hasPrev: false }), []);
  const verticalAt = useCallback((p: THREE.Vector3, out: THREE.Vector3) =>
    p.length() > 6378137 * 0.5 ? WGS84_ELLIPSOID.getPositionToNormal(p, out) : out.set(0, 1, 0), []);
  const POLE_COS = Math.cos(THREE.MathUtils.degToRad(2));
  const levelTrackball = useCallback(() => {
    const c = controlsRef.current;
    if (!c?.target) return;
    const { up, v, h, prevH } = levelTmp;
    verticalAt(c.target, up);
    v.subVectors(camera.position, c.target);                     // eye, target → camera
    const r = v.length();
    if (r === 0) return;
    const cos = v.dot(up) / r;
    h.copy(v).addScaledVector(up, -v.dot(up));                  // horizontal part of the eye
    const crossed = levelTmp.hasPrev && h.dot(prevH) < 0 && Math.abs(cos) > 0.5;   // went over a pole
    if (Math.abs(cos) > POLE_COS || crossed || h.lengthSq() < 1e-12) {
      if (!levelTmp.hasPrev) return;
      const sgn = Math.sign(cos) || 1;
      v.copy(up).multiplyScalar(sgn * POLE_COS).addScaledVector(prevH, Math.sqrt(1 - POLE_COS * POLE_COS)).multiplyScalar(r);
      camera.position.copy(c.target).add(v);
    } else { prevH.copy(h).normalize(); levelTmp.hasPrev = true; }
    camera.up.copy(up);
    camera.lookAt(c.target);
  }, [camera, levelTmp, verticalAt, POLE_COS]);
  const levelFly = useCallback(() => {
    const { up, v, h } = levelTmp;
    verticalAt(camera.position, up);
    v.set(0, 0, -1).applyQuaternion(camera.quaternion);          // forward
    const cos = v.dot(up);
    if (Math.abs(cos) > 0.999) {                                 // straight up or down: heading from the camera's own up
      h.set(0, 1, 0).applyQuaternion(camera.quaternion).multiplyScalar(-Math.sign(cos));
      h.addScaledVector(up, -h.dot(up)).normalize();
      v.copy(up).multiplyScalar(Math.sign(cos) * 0.999).addScaledVector(h, Math.sqrt(1 - 0.999 * 0.999));
    }
    camera.up.copy(up);
    camera.lookAt(h.copy(camera.position).add(v));
  }, [camera, levelTmp, verticalAt]);
  useEffect(() => { levelTmp.hasPrev = false; }, [controlMode, levelTmp]);

  // Fly controls move the camera while a key is held, from their own per-frame update: with the
  // demand frameloop no frame would come, so the loop runs continuously in fly mode only.
  const setFrameloop = useThree((s) => s.setFrameloop);
  useEffect(() => { setFrameloop(controlMode === 'fly' ? 'always' : 'demand'); return () => setFrameloop('demand'); }, [controlMode, setFrameloop]);

  // Fly look. three's FlyControls maps the cursor's ABSOLUTE offset from the viewport centre to a rotation
  // RATE: the view keeps turning as long as the cursor is off centre, and where a drag ends sets the heading
  // ("the camera is attached to the mouse"). Mouse-look instead: its pointer handlers are swapped for ones that
  // turn the camera by the cursor's movement since the last event, one pixel of drag for one pixel of view
  // (yaw about the local vertical, pitch about the camera's right axis, short of the poles). The keyboard
  // (W A S D, R F, arrows) still goes through FlyControls.update().
  useEffect(() => {
    const c = controlsRef.current;
    if (controlMode !== 'fly' || !c || !('movementSpeed' in c) || !c.domElement) return;
    const el: HTMLElement = c.domElement;
    for (const [ev, h] of [['pointermove', c._onPointerMove], ['pointerdown', c._onPointerDown], ['pointerup', c._onPointerUp], ['pointercancel', c._onPointerCancel]] as const) if (h) el.removeEventListener(ev, h);
    let dragging = false, lx = 0, ly = 0;
    const up = new THREE.Vector3(), right = new THREE.Vector3(), fwd = new THREE.Vector3(), q = new THREE.Quaternion();
    const down = (e: PointerEvent) => { if (e.button !== 0) return; dragging = true; lx = e.clientX; ly = e.clientY; el.setPointerCapture?.(e.pointerId); };
    const stop = (e: PointerEvent) => { if (!dragging) return; dragging = false; if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId); };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      if (!dx && !dy) return;
      const perPx = THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov ?? fov) / Math.max(1, el.clientHeight);
      verticalAt(camera.position, up);
      camera.quaternion.premultiply(q.setFromAxisAngle(up, -dx * perPx));                 // drag right: look right
      fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
      right.crossVectors(fwd, up).normalize();
      const cur = Math.asin(THREE.MathUtils.clamp(fwd.dot(up), -1, 1));
      const lim = THREE.MathUtils.degToRad(89);
      const want = THREE.MathUtils.clamp(cur - dy * perPx, -lim, lim);                     // drag up: look up
      camera.quaternion.premultiply(q.setFromAxisAngle(right, want - cur));
      levelFly();
      invalidate();
    };
    el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', stop); el.addEventListener('pointercancel', stop);
    // Keys by physical position (event.code), so W A S D is Z Q S D on an AZERTY keyboard; Q and E (A and E there)
    // fly down and up like R and F, instead of FlyControls' roll, which levelFly undoes anyway. Registered after
    // FlyControls' own window listeners, so this runs last and overrides its roll.
    const vertical = (e: KeyboardEvent, on: number) => {
      if (e.code !== 'KeyQ' && e.code !== 'KeyE') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const ms = c._moveState;
      if (!ms) return;
      if (e.code === 'KeyQ') ms.down = on; else ms.up = on;
      ms.rollLeft = 0; ms.rollRight = 0;
      c._updateMovementVector?.(); c._updateRotationVector?.();
    };
    const keyDown = (e: KeyboardEvent) => vertical(e, 1), keyUp = (e: KeyboardEvent) => vertical(e, 0);
    window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp);
    return () => {
      el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', stop); el.removeEventListener('pointercancel', stop);
      window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp);
    };
  }, [controlMode, camera, fov, invalidate, levelFly, verticalAt]);
  useEffect(() => { if (controlSetting === 'auto') invalidate(); }, [controlSetting, invalidate]);

  // rAF-throttled: the point-size slider's onValueChange fires on every drag tick (dozens of times a
  // second), and traversing the WHOLE tiles group to restyle every Points mesh is not free for a large
  // cloud with many loaded tiles — doing that traversal synchronously on every single tick is exactly
  // why dragging this slider specifically felt slow with 3DTRJS open (Cesium's point-size path is a
  // single shared style set, not a per-mesh JS traversal, so it doesn't have this cost). Collapse any
  // number of rapid pointSize changes into at most one traversal per animation frame.
  // Material mode: every loaded model, the native children included, then redraw.
  useEffect(() => {
    const tiles = tilesRef.current;
    if (!tiles) return;
    tiles.forEachLoadedModel((sc: THREE.Object3D) => sc.traverse((o: any) => applyMaterialMode(o, materialOpts)));
    (tiles as any).getPluginByName?.('NATIVE_LEAVES_PLUGIN')?.forEachChildModel((sc: THREE.Object3D) => sc.traverse((o: any) => applyMaterialMode(o, materialOpts)));
    invalidate();
  }, [materialOpts, loadArgs, invalidate]);
  // Colour by height: the range comes from what is loaded, when asked (the sidebar's Fit), when the mode
  // is picked with no range yet, and from the first tiles that arrive if nothing was loaded by then.
  const fitPointHeights = useCallback(() => {
    const tiles = tilesRef.current as any;
    if (!tiles) return false;
    const pts: THREE.Object3D[] = [];
    const add = (sc: THREE.Object3D) => sc.traverse((o: any) => { if (o.isPoints) pts.push(o); });
    tiles.forEachLoadedModel(add);
    tiles.getPluginByName?.('NATIVE_LEAVES_PLUGIN')?.forEachChildModel(add);
    const range = fitHeightRange(pts, tiles.group);
    if (range) store.getState().setPointHeightRange(range);
    return !!range;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const fitPointHeightsRef = useRef(fitPointHeights);
  fitPointHeightsRef.current = fitPointHeights;
  useEffect(() => { if (pointColorMode === 'height' && !pointHeightRange) fitPointHeights(); }, [pointColorMode, pointHeightRange, loadArgs, fitPointHeights]);

  const pointSizeRaf = useRef<number | null>(null);
  useEffect(() => {
    if (isSplat) return;
    if (pointSizeRaf.current != null) cancelAnimationFrame(pointSizeRaf.current);
    pointSizeRaf.current = requestAnimationFrame(() => {
      pointSizeRaf.current = null;
      const tiles = tilesRef.current;
      if (!tiles) return;
      tiles.forEachLoadedModel((sc: THREE.Object3D, tile: any) => sc.traverse((o: any) => applyPointSize(o, tile)));
      const nativePlugin = (tiles as any).getPluginByName?.('NATIVE_LEAVES_PLUGIN');
      if (nativePlugin) {
        nativePlugin.pointScale = pointSize / 2;
        nativePlugin.forEachChildModel((sc: THREE.Object3D, _leaf: any, ct: any) => sc.traverse((o: any) => applyPointSize(o, ct)));
      }
      invalidate();
    });
    return () => { if (pointSizeRaf.current != null) cancelAnimationFrame(pointSizeRaf.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointSize, pointAdaptive, loadArgs, isSplat, invalidate]);

  /**
   * Snap the loaded tileset to the ground (the "Snap to ground" button, and the auto mode's re-snaps).
   * 1. Preferred: the dataset's own top geometry binned on an 8 × 8 grid, its low bins compared with the
   *    terrain under them — the ground of the scan, not its roofs (lib/datasetGround.ts, shared with the
   *    server's &snap=). The samples are read once per tileset URL; a re-snap only re-reads the terrain.
   * 2. Fallback: the rendered surface picked on a grid against the rendered terrain.
   */
  const groundSamplesCache = useRef(new Map<string, Promise<GroundSample[] | null>>());
  // A local tileset is measured where it is anchored (frameToTileset's ENU basis at the Local Frame, without
  // the Z offset): the samples are then absolute like a georeferenced tileset's, and the cache is per anchor.
  const groundSamplesFor = useCallback((url: string, frame: number[] | null) => {
    const key = frame ? `${url}|${frame.map((v) => v.toFixed(2)).join(',')}` : url;
    let p = groundSamplesCache.current.get(key);
    if (!p) { p = datasetGroundSamples(url, { frame }).catch(() => null); groundSamplesCache.current.set(key, p); }
    return p;
  }, []);
  const snapToGroundInternal = useCallback(async (): Promise<string> => {
    const tiles = tilesRef.current;
    if (!tiles) return 'Load a tileset first.';
    const E = WGS84_ELLIPSOID;
    const mode = resolveTerrainMode(store.getState().terrainMode, '3dtrjs');
    const rasterId = snapRasterFor(mode);
    const raster = rasterId != null;
    // the dataset's ground bins land this far above the terrain (store.zOffsetClearance)
    const clearance = store.getState().zOffsetClearance || 0;
    const clearanceNote = clearance ? `, +${clearance} m clearance` : '';
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
      // the terrain renderer itself: the rest of the scene holds markers, gizmos and debug lines
      const hit = terrainTiles ? raycaster.intersectObject(terrainTiles.group, true)[0] : undefined;
      if (!hit) return null;
      const c: any = {};
      E.getPositionToCartographic(hit.point, c);
      return c.height;
    };

    // 1. Preferred: the dataset's own top geometry, binned (lib/datasetGround.ts). Renderer-independent.
    const frame = needsEnuAnchorRef.current ? new THREE.Matrix4().compose(localAnchorRef.current, tiles.group.quaternion, new THREE.Vector3(1, 1, 1)).elements.slice() : null;
    const samples = await groundSamplesFor(store.getState().lastLoadUrl, frame);
    if (samples) {
      const terrain = await Promise.all(samples.map((s) => groundAt(s.lon, s.lat)));
      const r = offsetFromSamples(samples, terrain);
      if (r) {
        const next = +(r.dz + clearance).toFixed(2);            // absolute: the samples come from the file
        store.getState().setLocalFrame({ zOffset: next });
        applyZOffsetInternal(tiles, next);
        invalidate();
        return `Snapped to ground: Z offset ${next} m — from the dataset's own top geometry (${r.used}/${samples.length} ground bins, spread ${r.spread.toFixed(1)} m${clearanceNote}).`;
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
            const ground = terrainTiles ? raycaster.intersectObject(terrainTiles.group, true)[0] : undefined;
            if (ground) { E.getPositionToCartographic(ground.point, carto); groundH = carto.height; }
          }
          if (groundH != null && Number.isFinite(groundH)) diffs.push(groundH - dataH);
        }
      }
      diffs.sort((a, b) => a - b);
      if (diffs.length < SNAP_MIN_HITS) {
        // 3. Nothing of the content is drawn yet, and it is a local scene anchored at height 0: a scene smaller than
        // the terrain's height above the ellipsoid (the metre-wide CesiumGS samples, under 16 m of San Francisco)
        // sits buried, the camera is pushed up by the terrain and never sees it, so it never loads and nothing
        // can be measured. Put the anchor on the terrain for now (the content's own ground is near z = 0 in such a
        // scene); the retry on the next loaded model measures for real.
        if (needsEnuAnchorRef.current && pass === 0 && store.getState().localFrame.zOffset === 0) {
          const lf = store.getState().localFrame;
          const h = await groundAt(lf.lon, lf.lat);
          if (h != null && Number.isFinite(h) && Math.abs(h) > 0.5) {
            const next = +(h + clearance).toFixed(2);
            store.getState().setLocalFrame({ zOffset: next });
            applyZOffsetInternal(tiles, next);
            invalidate();
            return `Z offset ${next} m from the terrain at the anchor, until the content is drawn and can be measured (${diffs.length} of ${SNAP_SAMPLES} samples hit it).`;
          }
        }
        return `Snap to ground: only ${diffs.length} of ${SNAP_SAMPLES} samples hit both the dataset and the terrain — zoom in so more of both is loaded, then retry.`;
      }
      const dz = diffs[Math.floor(0.8 * (diffs.length - 1))] + clearance;   // converges: the next pass measures -clearance
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
  }, [invalidate, applyZOffsetInternal, groundSamplesFor]);

  // Auto snap: re-measure whenever the terrain under the tileset refines (a terrain tile arrives), the
  // terrain mode changes, or a new tileset loads — debounced, one run at a time, quiet unless the offset
  // moved. Mosaics snap server-side (&snap=, per dataset; the sidebar toggles it), not here.
  const zOffsetAuto = useViewerStore((s) => s.zOffsetAuto);
  const zOffsetClearance = useViewerStore((s) => s.zOffsetClearance);
  useEffect(() => {
    if (!zOffsetAuto || !pickScene || isAggregateUrl(store.getState().lastLoadUrl)) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false, again = false, cancelled = false, measured = false;
    const run = async () => {
      if (cancelled) return;
      if (running) { again = true; return; }
      running = true;
      const before = store.getState().localFrame.zOffset;
      const msg = await snapToGroundInternal().catch((e) => `Auto snap failed: ${e?.message ?? e}`);
      running = false;
      if (cancelled) return;
      const after = store.getState().localFrame.zOffset;
      measured = /^Snapped/.test(msg);
      if (Math.abs(after - before) > 0.05 || !measured) store.getState().setStatus(`Auto Z offset: ${msg}`);
      // The snap moved the content by more than its own size right after it was framed (the 0.12 m dragon, lifted
      // 26 m onto the terrain): the camera, still where the framing left it, looked at the ground. Frame it again;
      // a later or a smaller snap leaves the camera where the user has it.
      if (Math.abs(after - before) > lastSphereRadiusRef.current && performance.now() - framedAtRef.current < 20000 && tilesRef.current) frameToTileset(tilesRef.current);   // not a fresh load: the anchor stays
      if (again) { again = false; schedule(); }
    };
    const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(run, 1000); };
    schedule();
    // Raster terrains are sampled from their tiles at a fixed zoom, independently of what is drawn, so
    // one measurement per terrain mode is final; only real-geometry terrain (World Terrain, Google 3D)
    // refines under the tileset as the camera gets closer.
    // The renderer itself mounts a moment after this effect runs, hence the watch for it.
    const realGeometry = snapRasterFor(terrain) == null && terrain !== 'wgs84';
    let t: TilesRendererImpl | null = null;
    const watchTerrain = setInterval(() => {
      if (!realGeometry || t === terrainTiles) return;
      t?.removeEventListener('load-model', schedule);
      t = terrainTiles;
      t?.addEventListener('load-model', schedule);
    }, 500);
    // On any terrain, a first try can find nothing to measure (content the bins cannot read, whose
    // fallback picks the rendered data): new data retries until a measurement lands.
    const data = tilesRef.current;
    const retry = () => { if (!measured) schedule(); };
    data?.addEventListener('load-model', retry);
    return () => { cancelled = true; if (timer) clearTimeout(timer); clearInterval(watchTerrain); t?.removeEventListener('load-model', schedule); data?.removeEventListener('load-model', retry); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zOffsetAuto, zOffsetClearance, pickScene, terrainMode, loadArgs, snapToGroundInternal]);

  useImperativeHandle(ref, (): ViewerHandle => (sceneHandleRef.current = {
    load() { /* handled via loadArgs prop from the outer component (URL change remounts TilesRenderer) */ },
    setBasemap() { /* the globe surface TilesRenderer below is always mounted; no per-provider imagery yet (first pass) */ },
    setTerrainMode() { /* Cesium-only (Ion World Terrain / Google Photorealistic 3D Tiles) — no-op here */ },
    setMaxSSE(v) { store.getState().setMaxSSE(v); },
    toggleAssetVisible(show) { store.getState().setAssetVisible(show); },
    setOrtho(on) { store.getState().setOrtho(on); },
    setDebugMode(mode) { store.getState().setDebugMode(mode); },
    applyPointShading() { store.getState().setPointAdaptive(store.getState().pointAdaptive); /* the effect above re-applies */ applyEffects(); },
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
      for (const [nx, ny] of [[0, 0], [-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]]) {
        raycaster.setFromCamera(new THREE.Vector2(nx, ny), camera);
        const hit = pickPoint(raycaster, tiles.group, navSceneRef.current);
        if (hit) { corners.push(hit.point.clone()); continue; }
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
        const { east, north } = enuAxes(centerCarto.lat, centerCarto.lon);
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
        // Five points of a surface say little about the height of what stands on it: a flat view would
        // give a box with no height, and an extract of nothing. A quarter of its width above and below, up to 1 km.
        const pad = THREE.MathUtils.clamp(0.25 * Math.max(maxE - minE, maxN - minN), 10, 1000);
        minH = Math.min(...heights) - pad; maxH = Math.max(...heights) + pad;
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
    getCameraPose() {
      // the scene's frame is ECEF on a globe; a camera nowhere near the ellipsoid is in a local scene, which has no pose
      const p = camera.position, r = p.length();
      if (r < 6.2e6 || r > 1e8) return null;
      const d = camera.getWorldDirection(new THREE.Vector3()), u = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
      return ecefToPose([p.x, p.y, p.z], [d.x, d.y, d.z], [u.x, u.y, u.z]);
    },
    setCameraPose(pose) { setPendingPose(pose); },
    setDatasetMarkers(list) { setMarkers(list); },
    setDatasetStyle(style) {
      datasetStyleRef.current = style;
      tilesRef.current?.forEachLoadedModel((sc: THREE.Object3D, tile: any) => styleDatasetModel(sc, tile, style));
      // native Potree leaves: their points live in child renderers, styled per model as they load —
      // a model that arrived while its dataset was hidden must be re-shown too
      const nativePlugin = (tilesRef.current as any)?.getPluginByName?.('NATIVE_LEAVES_PLUGIN');
      nativePlugin?.forEachChildModel((sc: THREE.Object3D, leaf: any) => styleDatasetModel(sc, leaf, style));
      invalidate();
    },
    snapToGround() { return snapToGroundInternal(); },
    flyToSphere(lon, lat, height, radius) { flyToSphereInternal(lon, lat, height, radius); },
    datasetsInView(list, minFraction) {
      const g = tilesRef.current?.group;
      g?.updateMatrixWorld(true);
      return datasetsInView3d(list, camera, g ? g.matrixWorld : null, minFraction);
    },
    autoZoomToTileset() { frameToTileset(tilesRef.current); },
    setControlMode(mode) { store.getState().setControlMode(mode); },
    fitPointHeights() { return fitPointHeights(); },
    setPointSize(px) { store.getState().setPointSize(px); },
    showCropGizmo() { store.getState().setCropGizmoOn(true); return true; },
    hideCropGizmo() { store.getState().setCropGizmoOn(false); },
    showTilesetGizmo() { store.getState().setTilesetGizmoOn(true); },
    hideTilesetGizmo() { store.getState().setTilesetGizmoOn(false); },
  }), [camera, invalidate, frameToTileset, applyZOffsetInternal, animateCameraTo, snapToGroundInternal, fitPointHeights]);

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

  // An exact camera pose (viewer-handle's setCameraPose): position, direction and up, as given.
  function applyCameraPose(pose: CameraPose) {
    const { position, direction, up } = poseToEcef(pose);
    camera.position.set(position[0], position[1], position[2]);
    camera.up.set(up[0], up[1], up[2]);
    camera.lookAt(position[0] + direction[0], position[1] + direction[1], position[2] + direction[2]);
    camera.updateMatrixWorld();
    invalidate();
  }
  const pendingPoseRef = useRef<CameraPose | null>(null);
  useEffect(() => {
    if (!pendingPose) return;
    pendingPoseRef.current = pendingPose;
    applyCameraPose(pendingPose);
    setPendingPose(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPose, loadArgs]);

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
      <group ref={setNavScene}>
      {showGlobe && globeVisible && (terrain === 'cesium' ? (
        <TerrainGlobe basemap={basemap} gl={gl} />
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
          // 3d-tiles-renderer's cache refuses a tile past 0.4 GB of decoded content (textures at their GPU size):
          // the textured Unio shell's Nexus nodes decode to about 30 MB each (every node carries the JPEGs its
          // patches name), so its 14th node was refused and the level never completed: nothing drawn. 1 GB, which
          // a 2026 laptop GPU has, with the trim starting at 0.6 GB.
          // The parse queue is 3d-tiles-renderer's shared one, 5 jobs. A mesh tile's parse mostly waits on the Draco
          // and KTX2 workers, so 5 at a time left them idle: Bing 3D drew its view in 60 s, 50 of them a backlog of
          // ~110 decoded tiles draining at 3 a second. 16 for meshes; points and splats parse on the main thread
          // and keep 5.
          ref={(t: any) => {
            (tilesRef as React.MutableRefObject<any>).current = t;
            if (t?.lruCache && t.lruCache.maxBytesSize < 1e9) { t.lruCache.minBytesSize = 0.6e9; t.lruCache.maxBytesSize = 1e9; }
            if (t?.parseQueue) t.parseQueue.maxJobs = loadArgs?.type === 'mesh' ? 16 : 5;
          }}
          url={tilesUrl}
          errorTarget={errorTarget}
          // 3d-tiles-renderer's default also loads every sibling of a used tile, in or out of view: a tree whose
          // levels are a tile's children (a Nexus mesh: 187 nodes in 9 levels for the gargoyle) then loads ALL its
          // levels before the first view (51 s on production), a city loads what is behind the camera. CesiumJS
          // loads what the view needs: so does this. The ancestors still load, to stand in while the children do.
          loadSiblings={false}
          // Skipped when the caller (a flyTo-tagged preset — e.g. Bing's per-city pills, which all
          // load the SAME global tileset URL) is about to issue its OWN flyToCity right after load()
          // — this async auto-frame (fires once the tileset.json fetch resolves) would otherwise land
          // AFTER and override that flyTo with the tileset's own (possibly world-sized) bounding sphere.
          onLoadRootTileset={() => {
            // devtools / headless inspection — the counterpart of CesiumViewer's window.viewer
            (window as any).tiles3dtr = { tiles: tilesRef.current, globeLru: GLOBE_LRU_CACHE, scene, camera, invalidate, store, terrarium: () => terrariumTiles, terrain: () => terrainTiles, handle: () => sceneHandleRef.current, controls: () => controlsRef.current, motionLod: () => [...motionLodPlugins], flight };
            if (!loadArgs?.skipAutoFrame) frameToTileset(tilesRef.current, true);
            const fly = pendingFlyToRef.current;
            pendingFlyToRef.current = null;
            if (fly && loadArgs?.skipAutoFrame) {
              flyToLocalFrameInternal(fly.lon, fly.lat, fly.height, 800);
              setControlsPivot(camera.position.clone().setLength(6378137), true);
            }
            const pose = pendingPoseRef.current;
            pendingPoseRef.current = null;
            if (pose && loadArgs?.skipAutoFrame) {
              applyCameraPose(pose);
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
          {isGoogleData && <TilesPlugin plugin={GoogleCloudAuthPlugin as any} args={{ apiToken: GOOGLE_MAPS_API_KEY, autoRefreshToken: true } as any} />}
          <TilesPlugin plugin={GLTFExtensionsPlugin as any} args={gltfArgs as any} />
          {/* point sprites: shape, min/max size, EDL — the same plugin the potree lab and the native
              Potree leaves use, so one sidebar block drives all of them */}
          {!isSplat && <TilesPlugin plugin={PointCloudEffectsPlugin as any} args={effectsArgs as any} />}
          <TilesPlugin plugin={AddRefinePointSizePlugin as any} />
          {/* mosaics: a dataset root loads once it is big enough on screen; downloads the camera left
              behind are dropped (lib/footprintGate.ts, lib/staleLoads.ts). No motion LOD here: the
              data keeps its own level of detail while the camera moves (lib/motionLod.ts is for the
              globe renderers) */}
          <TilesPlugin plugin={FootprintGatePlugin as any} args={gateArgs as any} />
          <TilesPlugin plugin={StaleLoadAbortPlugin as any} />
          <TilesPlugin plugin={NativeLeavesPlugin as any} args={nativeArgs as any} />
          {isSplat && <TilesPlugin plugin={GaussianSplatPlugin as any} args={splatArgs as any} />}
          {debugMode === 'tiles' && <TilesPlugin plugin={DebugTilesPlugin as any} displayBoxBounds colorMode={7} />}
          {(debugMode === 'cells' || debugMode === 'cells-only') && <MosaicOutlines url={loadArgs.url} tilesRef={tilesRef} cellsOnly={debugMode === 'cells-only'} />}
          {/* enableDoubleTapZoom off: the controls' own double-click zoom raced our animated one
              (it starts on pointerup, ours on dblclick: a jump, then the tween) */}
          {controlMode === 'globe' && <GlobeControls ref={controlsRef} scene={navScene ?? undefined} ellipsoid={WGS84_ELLIPSOID} ellipsoidFrame={WORLD_FRAME as any} enableDamping dampingFactor={0.05} minDistance={minDist} cameraRadius={camRadius} adjustHeight={adjustHeight} enableDoubleTapZoom={false} />}
          {controlMode === 'env' && <EnvironmentControls ref={controlsRef} scene={navScene ?? undefined} enableDamping dampingFactor={0.05} minDistance={minDist} cameraRadius={camRadius} adjustHeight={adjustHeight} enableDoubleTapZoom={false} />}
        </TilesRendererR3F>
      )}
      {/* makeDefault registers this as R3F's `state.controls` — same thing GlobeControls/EnvironmentControls
          already do unconditionally (see 3d-tiles-renderer's ControlsBaseComponent). drei's own
          <TransformControls> (the crop/tileset gizmos below) listens for exactly that and auto-pauses
          `state.controls.enabled` while a gizmo handle is being dragged, so they stop fighting over the
          same pointer drag ("clicking the gizmo should pause the control") — no extra wiring needed once
          every control scheme is registered the same way. */}
      {/* MIDDLE off: the middle-drag zoom is ours (toward the clicked point, drag down = in); OrbitControls'
          own dolly on the same button went the other way at the same time */}
      {controlMode === 'orbit' && <OrbitControls ref={controlsRef} makeDefault enableDamping dampingFactor={0.3} mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: undefined, RIGHT: THREE.MOUSE.PAN }} />}
      {/* Trackball: rotation about the target at trackball speed, kept level (levelTrackball); MIDDLE
          off for the same reason as OrbitControls. Fly: WASD / R F and drag to look, kept level
          (levelFly, so Q E roll does nothing), speed from the height above ground (useFrame above);
          needs the frameloop running (effect above). */}
      {controlMode === 'trackball' && <TrackballControls ref={controlsRef} makeDefault rotateSpeed={2.5} zoomSpeed={1.2} panSpeed={0.8} dynamicDampingFactor={0.15} onChange={levelTrackball} mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: undefined as any, RIGHT: THREE.MOUSE.PAN }} />}
      {controlMode === 'fly' && <FlyControls ref={controlsRef} makeDefault dragToLook movementSpeed={100} rollSpeed={0.25} onChange={levelFly} />}
      </group>
      {terrainBehind && <primitive object={clearDepthHook} />}
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
        <ThreeDatasetMarkers list={markers} tilesRef={tilesRef} tooltip={tooltip} loadedRef={loadedRef} onPick={(d) => {
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
    getCameraPose: () => sceneRef.current?.getCameraPose?.() ?? null,
    setCameraPose: (...a) => whenScene((h) => h.setCameraPose?.(...a)),
    autoZoomToTileset: () => sceneRef.current?.autoZoomToTileset(),
    setDatasetMarkers: (list) => whenScene((h) => h.setDatasetMarkers?.(list)),
    setDatasetStyle: (style) => whenScene((h) => h.setDatasetStyle?.(style)),
    snapToGround: () => sceneRef.current?.snapToGround?.() ?? Promise.resolve('3DTRjs scene not ready.'),
    flyToSphere: (...a) => whenScene((h) => h.flyToSphere?.(...a)),
    datasetsInView: (list, f) => sceneRef.current?.datasetsInView?.(list, f) ?? [],
    setControlMode: (...a) => sceneRef.current?.setControlMode?.(...a),
    fitPointHeights: () => sceneRef.current?.fitPointHeights?.() ?? false,
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
