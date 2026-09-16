import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as Cesium from 'cesium';
import type { ViewerHandle } from '@/lib/viewer-handle';
import type { DatasetMarker } from '@/lib/aggregate';
import type { AssetType } from '@/lib/formats';
import { CESIUM_ION_TOKEN } from '@/lib/ion';
import { useViewerStore } from '@/state/store';
import DatasetTooltip, { MARKER_COLORS, type TooltipChannel } from './DatasetTooltip';
import { createTerrariumTerrainProvider } from '@/lib/terrarium';
import { SNAP_HALF, SNAP_SAMPLES, SNAP_MIN_HITS } from '@/lib/snapToGround';

// Ported from viewer.html's Cesium section (lines ~855-1675), near-verbatim: a plain `Cesium.Viewer`
// constructed imperatively in a mount effect against a bare container div, exactly like viewer.html's
// initCesium() — the plan's documented fallback. Resium's <Viewer> was tried first per the plan; this
// vanilla construction is functionally identical to what Resium would produce, just without an extra
// abstraction layer to debug through, and matches every other renderer module in this repo.
//
// One real bug found along the way (see store.ts's `basemap` default comment): the raw
// mt1.google.com "Google Hybrid" tile hotlink occasionally answers a tile request with an HTML error
// page instead of image bytes, and Cesium's imagery pipeline doesn't gracefully skip that — it tries
// to decode the HTML as a texture and crashes the ENTIRE render loop ("InvalidStateError: the source
// image could not be decoded"), not just that one tile. Not a Resium/React-port issue at all.

interface Props {
  visible: boolean;
}

// Cesium's own request pipeline rejects with a `RequestErrorEvent` on a network-level failure
// (DNS failure, connection refused, CORS, or an untrusted/self-signed TLS certificate on the
// tile-server's own domain) — that object has NO `.message` property, unlike a standard Error, so
// `` `Failed to load tileset:\n${e.message}` `` rendered literally as "...\nundefined" with zero
// actionable information (the actual bug behind a mis-issued cert on a Traefik-routed subdomain).
// Extract whatever's actually there, falling back to an actionable hint instead of "undefined".
// Aggregate markers: hide once a dataset's bounds span more than this fraction of the viewport height.
const MARKER_HIDE_FRACTION = 0.1;

function describeLoadError(e: any): string {
  if (typeof e === 'string' && e) return e;
  if (e?.message) return String(e.message);
  if (e?.statusCode != null) return `HTTP ${e.statusCode}`;
  return 'Network error — the tile-server may be unreachable, blocked by CORS, or its TLS ' +
    'certificate may not be trusted by this browser. Try opening the tile-server URL directly in ' +
    'a new tab to see the underlying error.';
}

const CesiumViewer = forwardRef<ViewerHandle, Props>(function CesiumViewer({ visible }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const currentTilesetRef = useRef<Cesium.Cesium3DTileset | null>(null);
  const currentTypeRef = useRef<AssetType>('pointcloud');
  const placementBaseRef = useRef<Cesium.Matrix4 | null>(null);
  const loadGenRef = useRef(0);
  const cropEntityRef = useRef<Cesium.Entity | null>(null);
  const cropHandlesRef = useRef<Cesium.Entity[]>([]);
  const cropDragRef = useRef<{ axis: 'lon' | 'lat' | 'height'; set: (v: number) => void } | null>(null);
  const cropDragHandlerRef = useRef<Cesium.ScreenSpaceEventHandler | null>(null);
  const googleTilesetRef = useRef<Cesium.Cesium3DTileset | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const store = useViewerStore;
  const cleanupRef = useRef<(() => void) | null>(null);
  // Aggregate dataset markers: one PointPrimitive per placed dataset (see setDatasetMarkers below).
  const markersRef = useRef<Cesium.PointPrimitiveCollection | null>(null);
  const markerDataRef = useRef<DatasetMarker[] | null>(null);
  const tooltipRef: TooltipChannel = useRef(null);
  const pendingLoadRef = useRef<{ url: string; type: AssetType; opts?: { sseOverride?: number | null; skipAutoFrame?: boolean } } | null>(null);

  const getViewer = () => viewerRef.current;

  function loadTilesetInternal(url: string, type: AssetType, opts?: { sseOverride?: number | null; skipAutoFrame?: boolean }) {
    const v = getViewer();
    if (!v) return;
    const gen = ++loadGenRef.current;
    if (currentTilesetRef.current) {
      v.scene.primitives.remove(currentTilesetRef.current);
      currentTilesetRef.current = null;
    }
    currentTypeRef.current = type;
    placementBaseRef.current = null;
    store.getState().hideError();
    store.getState().setStatus(`Loading…\n${url}`);
    const isSplat = type === 'splat';
    const isMesh = type === 'mesh';
    const defaultSSE = isSplat ? 0.5 : isMesh ? 16 : 4;
    const sse = opts?.sseOverride ?? store.getState().maxSSE ?? defaultSSE;
    const loadOpts: any = isSplat
      ? { maximumScreenSpaceError: sse, skipLevelOfDetail: false, cacheBytes: 512 * 1024 * 1024 }
      : { maximumScreenSpaceError: sse };

    Cesium.Cesium3DTileset.fromUrl(url, loadOpts)
      .then((tileset) => {
        store.getState().tlog('tileset.json resolved');
        if (gen !== loadGenRef.current) { v.scene.primitives.remove(tileset); return; }
        v.scene.primitives.add(tileset);
        currentTilesetRef.current = tileset;
        tileset.show = store.getState().assetVisible;
        if (store.getState().debugTiles) {
          (tileset as any).debugShowBoundingVolume = true;
          (tileset as any).debugColorizeTiles = true;
        }
        applyShadingInternal();
        if (!isSplat && (tileset as any).pointCloudShading) {
          const pcs = (tileset as any).pointCloudShading;
          pcs.attenuation = true;
          pcs.maximumAttenuation = 4;
          pcs.eyeDomeLighting = true;
          pcs.eyeDomeLightingStrength = 1.0;
          pcs.eyeDomeLightingRadius = 1.0;
        }
        const bs = tileset.boundingSphere;
        const distFromEcefOrigin = Cesium.Cartesian3.magnitude(bs.center);
        const isLocalCoords = distFromEcefOrigin < 1e6 && bs.radius < 1e6;
        if (isLocalCoords) {
          store.getState().setLocalFrame({ range: Math.max(5, Math.round(bs.radius * 3)) });
          if (!opts?.skipAutoFrame) {
            const lf = store.getState().localFrame;
            applyLocalFrameInternal(lf.lon, lf.lat, lf.alt, lf.range);
          }
          store.getState().setStatus(`${isSplat ? 'Splat' : 'Local tileset'} placed at local frame origin.\nAdjust ⊕ Local Frame if needed.`);
        } else {
          // Skipped when the caller is about to fly to its OWN city/point instead (see viewer-handle.ts) —
          // this async auto-frame (fires once the tileset.json fetch resolves) would otherwise land AFTER
          // and override that flyTo with the tileset's own (possibly much larger, e.g. Bing's whole-world)
          // bounding sphere.
          if (!opts?.skipAutoFrame) {
            try {
              const range = Math.max(50, bs.radius * 2.5);
              v.camera.flyToBoundingSphere(bs, {
                offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(-30), Cesium.Math.toRadians(-25), range),
                duration: 1.5,
              });
            } catch {
              store.getState().setStatus('Tileset loaded but zoom failed.\nUse ⊕ Local Frame to place it.');
            }
          }
          store.getState().setStatus(`Loaded: ${url}`);
        }
        // Z offset is per-tileset (it composes onto whatever placement transform is now current), so a
        // freshly-loaded tileset needs it (re-)applied immediately — previously it only took effect the
        // next time the user actually edited the Z-offset field on an already-loaded tileset.
        const zOffset = store.getState().localFrame.zOffset;
        if (zOffset) applyZOffsetInternal(zOffset);
        let firstTile = false;
        tileset.allTilesLoaded.addEventListener(() => {
          const n = (tileset as any).statistics.numberOfTilesWithContentReady;
          store.getState().setStatus(`Tiles ready: ${n}  —  ${url}`);
          store.getState().tlog(`✓ tiles ready: ${n}`);
        });
        tileset.tileFailed.addEventListener((e: any) => {
          console.error('[3DTiles] Tile failed:', e.url, e.message);
          store.getState().setStatus(`⚠ Tile failed: ${e.message || e.url}`);
          store.getState().tlog(`⚠ tile failed: ${(e.message || e.url || '').toString().slice(0, 40)}`);
        });
        tileset.tileLoad.addEventListener(() => {
          const ready = (tileset as any).statistics?.numberOfTilesWithContentReady;
          if (!firstTile) { firstTile = true; store.getState().tlog('first tile loaded'); }
          store.getState().tlog(`streaming… ${ready} tiles ready`);
        });
      })
      .catch((e) => {
        const msg = describeLoadError(e);
        store.getState().showError(`Failed to load tileset:\n${msg}`);
        store.getState().setStatus('Load failed.');
        store.getState().tlog(`✗ load failed: ${msg.slice(0, 50)}`);
      });
  }

  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return;
    // Defer construction one frame so the flex-layout container has a real size before Cesium reads
    // canvas dimensions (constructing against a still-0×0 container is a known source of WebGL sizing
    // glitches in flex/grid layouts).
    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      if (cancelled || !containerRef.current || viewerRef.current) return;
      initViewer(containerRef.current);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pause/resume Cesium's own render loop on every renderer-pill switch (see the comment on
  // `useDefaultRenderLoop` in initViewer above for why this exists at all).
  useEffect(() => {
    const v = viewerRef.current;
    if (v && !v.isDestroyed()) v.useDefaultRenderLoop = visible;
  }, [visible]);

  /**
   * "There is data here" markers for an /aggregate mosaic: a fixed-pixel point on the ellipsoid per
   * dataset, which disappears once the dataset itself is big enough on screen to speak for itself.
   *
   * That hand-off is a per-point DistanceDisplayCondition rather than per-frame JS: a sphere of radius
   * r seen from distance d spans r / (d·tan(fovy/2)) of the viewport height, so it exceeds
   * MARKER_HIDE_FRACTION once d < r / (MARKER_HIDE_FRACTION·tan(fovy/2)). Cesium then evaluates the
   * cut-off on the GPU side for all ~700 points at once. The distance is measured to the marker on the
   * ellipsoid rather than to the sphere centre — close enough for a visibility hint.
   */
  function applyDatasetMarkers() {
    const v = getViewer();
    if (!v) return;
    if (markersRef.current) { v.scene.primitives.remove(markersRef.current); markersRef.current = null; }
    tooltipRef.current?.(null);
    const list = markerDataRef.current;
    if (!list?.length) return;
    const fr: any = v.camera.frustum;
    const fovy: number = fr?.fovy ?? 1.047;
    const hideBelow = 1 / (MARKER_HIDE_FRACTION * Math.tan(fovy / 2));
    const pts = new Cesium.PointPrimitiveCollection();
    const outline = Cesium.Color.fromCssColorString('#0b0b0f');
    for (const d of list) {
      pts.add({
        // A few metres above the ellipsoid so the sprite doesn't z-fight with the globe surface.
        position: Cesium.Cartesian3.fromDegrees(d.lon, d.lat, 30),
        // Hidden-by-the-picker datasets stay as small grey dots, so they can still be found and re-shown.
        pixelSize: d.inactive ? 6 : 9,
        color: d.inactive
          ? Cesium.Color.fromCssColorString('#9ca3af').withAlpha(0.55)
          : Cesium.Color.fromCssColorString(MARKER_COLORS[d.format] ?? '#94a3b8'),
        outlineColor: outline,
        outlineWidth: 1.5,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(d.radius * hideBelow, Number.MAX_VALUE),
        // Depth-tested from far away (so the far side of the globe hides its markers), but never hidden
        // by terrain once the camera is within 50 km.
        disableDepthTestDistance: 50_000,
        id: { dataset: d },
      });
    }
    v.scene.primitives.add(pts);
    markersRef.current = pts;
  }

  function flyToSphereInternal(lon: number, lat: number, height: number, radius: number) {
    const v = getViewer();
    if (!v) return;
    const center = Cesium.Cartesian3.fromDegrees(lon, lat, height);
    v.camera.flyToBoundingSphere(new Cesium.BoundingSphere(center, Math.max(radius, 20)), {
      offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-35), Math.max(150, radius * 3)),
      duration: 1.5,
    });
  }

  function initViewer(container: HTMLDivElement) {
    // A personal Cesium Ion token — required for Cesium World Terrain and Google Photorealistic 3D
    // Tiles (see setTerrainMode below). Ships client-side like any Ion demo token; rotate it in the
    // Cesium ion console if this repo's exposure of it in a public history becomes a concern.
    Cesium.Ion.defaultAccessToken = CESIUM_ION_TOKEN;
    const v = new Cesium.Viewer(container, {
      animation: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      navigationHelpButton: false,
      creditContainer: document.createElement('div'),
      baseLayer: new Cesium.ImageryLayer(new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' })),
    });
    viewerRef.current = v;
    // Both renderers stay mounted (CSS `visibility` toggle, not unmount) when switching the RENDERER
    // pill — but that only hides Cesium visually. Cesium's own render loop is a SEPARATE, independent
    // requestAnimationFrame driven by `v.useDefaultRenderLoop` (nothing to do with 3DTRJS's R3F
    // Canvas/frameloop) and defaults to running forever regardless of visibility. A real-size Cesium
    // scene rendering fully every frame while hidden showed up in a trace as ~850ms/frame FireAnimationFrame
    // calls into Cesium's render2 — starving the main thread of everything else, including 3DTRJS's own
    // frames and ALL UI event handling (this is what actually explains "even opening a dropdown is slow
    // with 3DTRJS active" — Cesium was still fully rendering in the background the whole time). Stop its
    // loop outright while hidden; the `visible`-keyed effect below resumes it when switched back.
    v.useDefaultRenderLoop = visibleRef.current;
    // Cesium's default is to render EVERY frame unconditionally, even with a static camera and no
    // scene changes — this (not any stray rAF loop) is the actual gap vs. 3DTRJS's R3F Canvas, which
    // already runs `frameloop="demand"` and only re-renders on an explicit `invalidate()`. Cesium's own
    // built-in triggers (camera movement/flights, tile-load progress, imagery/terrain updates, entity
    // property changes) already call `scene.requestRender()` internally when this is on — camera drags,
    // flyTo animations, and streaming tile loads keep working exactly as before. The one thing that does
    // NOT auto-trigger a render is one of OUR OWN direct mutations made outside those built-in paths
    // (toggling shading/debug/visibility, changing basemap, moving the crop box, etc.) — every one of
    // those goes through the `ViewerHandle` returned below, which is wrapped to call requestRender()
    // after every call (sync or async) specifically to cover this.
    v.scene.requestRenderMode = true;
    v.scene.backgroundColor = Cesium.Color.fromCssColorString('#0a0a0f');
    (window as any).viewer = v;
    const initialBasemap = store.getState().basemap;
    if (initialBasemap !== 'osm') {
      v.imageryLayers.removeAll();
      if (initialBasemap === 'google') {
        v.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({ url: 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', credit: 'Google Hybrid' }));
      }
    }
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas);
    handler.setInputAction((movement: any) => {
      const picked = v.scene.pickPosition(movement.position);
      if (!Cesium.defined(picked)) return;
      const cam = v.camera;
      const newPos = Cesium.Cartesian3.lerp(cam.positionWC, picked, 0.5, new Cesium.Cartesian3());
      cam.flyTo({
        destination: newPos,
        orientation: { heading: cam.heading, pitch: cam.pitch, roll: cam.roll },
        duration: 0.35,
        easingFunction: Cesium.EasingFunction.QUADRATIC_OUT,
      });
    }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    // Dataset markers: click flies to the dataset, hover shows its card (DatasetTooltip).
    const markerOf = (pos: Cesium.Cartesian2): DatasetMarker | null => {
      if (!markersRef.current) return null;
      // drillPick, not pick: the marker of a small dataset often sits under a larger one that has
      // already loaded (Canal Grande under the Venice airborne cloud) and must still answer.
      const hit: any = v.scene.drillPick(pos, 6).find((p: any) => p?.collection === markersRef.current);
      return hit?.id?.dataset ?? null;
    };
    handler.setInputAction((e: any) => {
      const d = markerOf(e.position);
      if (!d) return;
      flyToSphereInternal(d.lon, d.lat, d.height, d.radius);
      store.getState().setStatus(`${d.name}${d.project ? ` — ${d.project}` : ''} [${d.format}]`);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    // scene.pick renders a pick pass, so skip it entirely while no markers are shown.
    // At most one pick per frame, however fast the mouse moves.
    let hoverRaf = 0;
    handler.setInputAction((e: any) => {
      const at = Cesium.Cartesian2.clone(e.endPosition);
      cancelAnimationFrame(hoverRaf);
      hoverRaf = requestAnimationFrame(() => {
        if (v.isDestroyed()) return;
        const d = markersRef.current ? markerOf(at) : null;
        const canvas = v.scene.canvas;
        canvas.style.cursor = d ? 'pointer' : '';
        tooltipRef.current?.(d ? { d, x: at.x, y: at.y, w: canvas.clientWidth, h: canvas.clientHeight } : null);
      });
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    store.getState().setStatus('Cesium ready. Select a preset or enter a tileset.json URL.');
    cleanupRef.current = () => { cancelAnimationFrame(hoverRaf); handler.destroy(); v.destroy(); viewerRef.current = null; };
    if (pendingLoadRef.current) {
      const { url, type, opts } = pendingLoadRef.current;
      pendingLoadRef.current = null;
      loadTilesetInternal(url, type, opts);
    }
  }

  function applyZOffsetInternal(dz: number) {
    const tileset = currentTilesetRef.current;
    if (!tileset) { store.getState().setStatus('Load a georeferenced tileset first, then set a Z offset.'); return; }
    const c = tileset.boundingSphere.center;
    const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(c, new Cesium.Cartesian3()) || Cesium.Cartesian3.normalize(c, new Cesium.Cartesian3());
    const t = Cesium.Cartesian3.multiplyByScalar(up, dz, new Cesium.Cartesian3());
    const base = placementBaseRef.current || Cesium.Matrix4.IDENTITY;
    tileset.modelMatrix = Cesium.Matrix4.multiply(Cesium.Matrix4.fromTranslation(t), base, new Cesium.Matrix4());
    const gsp = (tileset as any).gaussianSplatPrimitive;
    if (gsp) { gsp._rootTransform = undefined; gsp._dirty = true; }
    store.getState().setStatus(`Vertical Z offset: ${dz} m along local up (georef preserved).`);
  }

  function applyShadingInternal() {
    const v = getViewer();
    const tileset = currentTilesetRef.current;
    if (!v || !tileset) return;
    if (currentTypeRef.current === 'splat') {
      try { (tileset as any).customShader = undefined; } catch {}
      return;
    }
    const { shadeless, brightness } = store.getState();
    const isPointCloud = currentTypeRef.current === 'pointcloud';
    try {
      // Point clouds never carry a NORMAL attribute (glTF POINTS mode has none), so Cesium's default
      // LIT shading always zeroes their diffuse to black regardless of the shadeless toggle or
      // brightness value — always render them UNLIT, independent of the toggle. A genuinely uncolored
      // point cloud (no COLOR_0 at all, e.g. plain LAS/COPC) already defaults to white per the glTF
      // spec's own material fallback, so `material.diffuse *= brightness` alone reproduces the old
      // "shadeless forces flat white" look for that case too — but WITHOUT discarding real per-vertex
      // color (e.g. LEPCC-decoded RGB on I3S PointCloud layers) the way `diffuse = vec3(brightness)`
      // used to. That flat override was the actual cause of "real RGB renders as plain grey."
      if (!shadeless && !isPointCloud && brightness === 1) { (tileset as any).customShader = undefined; return; }
      (tileset as any).customShader = new Cesium.CustomShader({
        lightingModel: (shadeless || isPointCloud) ? Cesium.LightingModel.UNLIT : undefined,
        fragmentShaderText: `void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material){ material.diffuse *= ${brightness.toFixed(2)}; }`,
      });
    } catch (e) {
      console.warn('[shading]', (e as Error).message);
    }
  }

  function cropBboxNorm(): [number, number, number, number, number, number] {
    const { w, s, minH, e, n, maxH } = store.getState().crop;
    return [Math.min(w, e), Math.min(s, n), Math.min(minH, maxH), Math.max(w, e), Math.max(s, n), Math.max(minH, maxH)];
  }

  function updateCropBoxInternal() {
    const v = getViewer();
    if (!v) return;
    const [w, s, minh, e, n, maxh] = cropBboxNorm();
    if ([w, s, minh, e, n, maxh].some(Number.isNaN) || e - w < 1e-9 || n - s < 1e-9) return;
    if (cropEntityRef.current) v.entities.remove(cropEntityRef.current);
    cropEntityRef.current = v.entities.add({
      rectangle: {
        coordinates: Cesium.Rectangle.fromDegrees(w, s, e, n),
        material: Cesium.Color.CYAN.withAlpha(0.12),
        height: minh,
        extrudedHeight: maxh,
        outline: true,
        outlineColor: Cesium.Color.CYAN,
      } as any,
    });
    cropHandlesRef.current.forEach((h) => v.entities.remove(h));
    cropHandlesRef.current = [];
    const midLon = (w + e) / 2, midLat = (s + n) / 2, midH = (minh + maxh) / 2;
    const defs: Array<[string, 'lon' | 'lat' | 'height', number, number, number, (val: number) => void]> = [
      ['w', 'lon', w, midLat, midH, (val) => store.getState().setCrop({ w: val })],
      ['e', 'lon', e, midLat, midH, (val) => store.getState().setCrop({ e: val })],
      ['s', 'lat', midLon, s, midH, (val) => store.getState().setCrop({ s: val })],
      ['n', 'lat', midLon, n, midH, (val) => store.getState().setCrop({ n: val })],
      ['maxH', 'height', midLon, midLat, maxh, (val) => store.getState().setCrop({ maxH: val })],
      ['minH', 'height', midLon, midLat, minh, (val) => store.getState().setCrop({ minH: val })],
    ];
    for (const [, axis, lon, lat, h, setter] of defs) {
      const ent = v.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat, h),
        point: {
          pixelSize: 13,
          color: axis === 'height' ? Cesium.Color.ORANGE : Cesium.Color.YELLOW,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        } as any,
      });
      (ent as any)._cropBound = { axis, setter };
      cropHandlesRef.current.push(ent);
    }
    setupCropDrag();
  }

  function setupCropDrag() {
    const v = getViewer();
    if (cropDragHandlerRef.current || !v) return;
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas);
    cropDragHandlerRef.current = handler;
    handler.setInputAction((m: any) => {
      const picked = v.scene.pick(m.position);
      if (picked && picked.id && (picked.id as any)._cropBound) {
        const b = (picked.id as any)._cropBound;
        cropDragRef.current = { axis: b.axis, set: b.setter };
        v.scene.screenSpaceCameraController.enableInputs = false;
      }
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);
    handler.setInputAction((m: any) => {
      const drag = cropDragRef.current;
      if (!drag) return;
      if (drag.axis === 'height') {
        const [w, s, , e, n] = cropBboxNorm();
        const center = Cesium.Cartesian3.fromDegrees((w + e) / 2, (s + n) / 2, 0);
        const ray = v.camera.getPickRay(m.endPosition);
        if (!ray) return;
        const up = Cesium.Cartesian3.normalize(center, new Cesium.Cartesian3());
        const toCam = Cesium.Cartesian3.subtract(v.camera.positionWC, center, new Cesium.Cartesian3());
        Cesium.Cartesian3.subtract(toCam, Cesium.Cartesian3.multiplyByScalar(up, Cesium.Cartesian3.dot(toCam, up), new Cesium.Cartesian3()), toCam);
        const hit = Cesium.IntersectionTests.rayPlane(ray, Cesium.Plane.fromPointNormal(center, Cesium.Cartesian3.normalize(toCam, new Cesium.Cartesian3())));
        if (hit) drag.set(Cesium.Cartographic.fromCartesian(hit).height);
      } else {
        const c = v.camera.pickEllipsoid(m.endPosition, v.scene.globe.ellipsoid);
        if (!c) return;
        const g = Cesium.Cartographic.fromCartesian(c);
        drag.set(drag.axis === 'lon' ? Cesium.Math.toDegrees(g.longitude) : Cesium.Math.toDegrees(g.latitude));
      }
      updateCropBoxInternal();
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction(() => {
      cropDragRef.current = null;
      v.scene.screenSpaceCameraController.enableInputs = true;
    }, Cesium.ScreenSpaceEventType.LEFT_UP);
  }

  // Re-draw crop box whenever the store's crop bbox changes externally (e.g. numeric inputs).
  useEffect(() => {
    const unsub = store.subscribe((s, prev) => {
      if (s.crop !== prev.crop) updateCropBoxInternal();
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, (): ViewerHandle => {
    const raw: ViewerHandle = {
    load(url, type, opts) {
      // The viewer is constructed one rAF after mount (see the mount effect) — a caller (TopBar's
      // auto-load-on-mount effect) can easily race ahead of that and call load() before getViewer()
      // is non-null. Queue it; initViewer() replays the latest queued call once construction finishes.
      if (!getViewer()) { pendingLoadRef.current = { url, type, opts }; return; }
      loadTilesetInternal(url, type, opts);
    },
    setBasemap(id) {
      const v = getViewer();
      if (!v) return;
      const layers = v.imageryLayers;
      layers.removeAll();
      if (id === 'google') {
        layers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({ url: 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', credit: 'Google Hybrid' }));
      } else if (id === 'osm') {
        layers.addImageryProvider(new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }));
      }
    },
    async setTerrainMode(mode) {
      const v = getViewer();
      if (!v) return;
      if (googleTilesetRef.current) {
        v.scene.primitives.remove(googleTilesetRef.current);
        googleTilesetRef.current = null;
      }
      if (mode === 'wgs84') {
        v.terrainProvider = new Cesium.EllipsoidTerrainProvider();
        return;
      }
      if (mode === 'terrarium') {
        v.terrainProvider = createTerrariumTerrainProvider();
        store.getState().setStatus('Terrarium terrain (AWS open elevation tiles, heights above mean sea level).');
        return;
      }
      if (mode === 'cesium') {
        try {
          v.terrainProvider = await Cesium.createWorldTerrainAsync();
        } catch (e) {
          v.terrainProvider = new Cesium.EllipsoidTerrainProvider();
          store.getState().setTerrainMode('wgs84');
          store.getState().setStatus(`Cesium World Terrain failed to load:\n${(e as Error).message}`);
        }
        return;
      }
      // 'google': a photorealistic textured mesh that embeds its own ground — no separate terrain
      // provider needed (leave whatever elevation provider was active; the tileset sits on top of it).
      try {
        store.getState().setStatus('Loading Google Photorealistic 3D Tiles…');
        const tileset = await Cesium.createGooglePhotorealistic3DTileset();
        googleTilesetRef.current = tileset;
        v.scene.primitives.add(tileset);
        store.getState().setStatus('Google Photorealistic 3D Tiles loaded.');
      } catch (e) {
        store.getState().setTerrainMode('wgs84');
        store.getState().setStatus(`Google Photorealistic 3D Tiles failed to load:\n${(e as Error).message}`);
      }
    },
    setMaxSSE(v) {
      if (currentTilesetRef.current) (currentTilesetRef.current as any).maximumScreenSpaceError = v ?? (currentTilesetRef.current as any).maximumScreenSpaceError;
    },
    toggleAssetVisible(show) {
      if (currentTilesetRef.current) currentTilesetRef.current.show = show;
    },
    setOrtho(on) {
      const v = getViewer();
      if (!v) return;
      if (on) v.camera.switchToOrthographicFrustum();
      else v.camera.switchToPerspectiveFrustum();
    },
    toggleDebug(on) {
      if (currentTilesetRef.current) {
        (currentTilesetRef.current as any).debugShowBoundingVolume = on;
        (currentTilesetRef.current as any).debugColorizeTiles = on;
      }
    },
    applyShading() { applyShadingInternal(); },
    setFov(deg) {
      const v = getViewer();
      if (!v || !(deg > 0) || deg >= 120) return;
      const cam = v.camera, fr: any = cam.frustum;
      if (fr && 'fov' in fr) {
        const vrad = Cesium.Math.toRadians(deg);
        const aspect = v.scene.canvas.clientWidth / v.scene.canvas.clientHeight;
        fr.fov = aspect > 1 ? 2 * Math.atan(Math.tan(vrad / 2) * aspect) : vrad;
      }
      // Marker hide distances are derived from the vertical field of view.
      if (markerDataRef.current) applyDatasetMarkers();
    },
    setDatasetMarkers(list) {
      markerDataRef.current = list;
      applyDatasetMarkers();
    },
    flyToSphere(lon, lat, height, radius) { flyToSphereInternal(lon, lat, height, radius); },
    async snapToGround() {
      const v = getViewer();
      const ts = currentTilesetRef.current;
      if (!v || !ts) return 'Load a tileset first.';
      const exclude = [googleTilesetRef.current, markersRef.current].filter(Boolean) as object[];
      let total = 0, last = '';
      // Two passes: the first move changes what LOD is on screen, the second settles on it.
      for (let pass = 0; pass < 2; pass++) {
        const bs = ts.boundingSphere;
        const enu = Cesium.Transforms.eastNorthUpToFixedFrame(bs.center);
        const reach = Math.min(bs.radius * 0.5, 5000);
        const grid: Cesium.Cartographic[] = [];
        for (let i = -SNAP_HALF; i <= SNAP_HALF; i++) {
          for (let j = -SNAP_HALF; j <= SNAP_HALF; j++) {
            const p = Cesium.Matrix4.multiplyByPoint(enu, new Cesium.Cartesian3((i / SNAP_HALF) * reach, (j / SNAP_HALF) * reach, 0), new Cesium.Cartesian3());
            const c = Cesium.Cartographic.fromCartesian(p);
            c.height = 0;
            grid.push(c);
          }
        }
        const clone = () => grid.map((c) => Cesium.Cartographic.clone(c));
        // The dataset's own surface. sampleHeight ALSO hits the globe, and a sparse point cloud leaves
        // gaps where the ray reaches it — which silently returned terrain heights ("already on the
        // ground"). Hide the globe while sampling; a pick volume ~1% of the sampled area catches points.
        const globeShown = v.scene.globe.show;
        v.scene.globe.show = false;
        let data: (Cesium.Cartographic | undefined)[];
        try { data = await v.scene.sampleHeightMostDetailed(clone(), exclude, Math.max(0.5, reach / 100)); }
        finally { v.scene.globe.show = globeShown; }
        let ground: (Cesium.Cartographic | undefined)[];
        if (googleTilesetRef.current) ground = await v.scene.sampleHeightMostDetailed(clone(), [ts, markersRef.current].filter(Boolean) as object[]);
        else if (v.terrainProvider instanceof Cesium.EllipsoidTerrainProvider) ground = clone();
        else if ((v.terrainProvider as any).availability) ground = await Cesium.sampleTerrainMostDetailed(v.terrainProvider, clone());
        else ground = await Cesium.sampleTerrain(v.terrainProvider, 14, clone());   // custom providers publish no availability
        const diffs = data
          .map((d, i) => (d && ground[i] && Number.isFinite(d.height) && Number.isFinite(ground[i]!.height) ? ground[i]!.height - d.height : NaN))
          .filter(Number.isFinite)
          .sort((a, b) => a - b);
        if (diffs.length < SNAP_MIN_HITS) return `Snap to ground: only ${diffs.length} of ${SNAP_SAMPLES} samples hit the dataset — zoom in so more of it is loaded, then retry.`;
        // 80th percentile: points on roofs / canopy sit ABOVE the ground and give smaller differences;
        // the ground-level ones are the largest, minus a margin for noise.
        const dz = diffs[Math.floor(0.8 * (diffs.length - 1))];
        total += dz;
        const next = +(store.getState().localFrame.zOffset + dz).toFixed(2);
        store.getState().setLocalFrame({ zOffset: next });
        applyZOffsetInternal(next);
        last = `${diffs.length}/${SNAP_SAMPLES} samples, spread ${(diffs[diffs.length - 1] - diffs[0]).toFixed(1)} m`;
        if (Math.abs(dz) < 0.25) break;
        await new Promise((r) => setTimeout(r, 1500));      // let the moved tileset refine before re-sampling
      }
      return `Snapped to ground: moved ${total.toFixed(2)} m (Z offset now ${store.getState().localFrame.zOffset} m; ${last}).`;
    },
    datasetsInView(list, minFraction) {
      const v = getViewer();
      if (!v) return [];
      const cam = v.camera, fr: any = cam.frustum;
      const culling = fr.computeCullingVolume(cam.positionWC, cam.directionWC, cam.upWC);
      const tanHalf = Math.tan((fr.fovy ?? 1.047) / 2);
      const bs = new Cesium.BoundingSphere();
      const ids: string[] = [];
      for (const d of list) {
        Cesium.Cartesian3.fromDegrees(d.lon, d.lat, d.height, undefined, bs.center);
        bs.radius = d.radius;
        if (culling.computeVisibility(bs) === Cesium.Intersect.OUTSIDE) continue;
        const dist = Cesium.Cartesian3.distance(bs.center, cam.positionWC);
        if (dist <= d.radius || d.radius / (dist * tanHalf) >= minFraction) ids.push(d.id);
      }
      return ids;
    },
    flyToLocalFrame(lon, lat, alt, range) {
      const v = getViewer();
      if (!v) return;
      const origin = Cesium.Cartesian3.fromDegrees(lon, lat, alt);
      v.camera.flyToBoundingSphere(new Cesium.BoundingSphere(origin, range * 0.5), {
        offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-25), range),
        duration: 1.2,
      });
    },
    applyLocalFrame(lon, lat, alt, range) { applyLocalFrameInternal(lon, lat, alt, range); },
    applyZOffset(dz) { applyZOffsetInternal(dz); },
    async loadIonAsset(assetId, token, _isSplat) {
      const v = getViewer();
      if (!v) { store.getState().setStatus('Cesium not ready.'); return; }
      store.getState().setStatus(`Loading Ion asset ${assetId}…`);
      try {
        const resp = await fetch(`https://api.cesium.com/v1/assets/${assetId}/endpoint`, { headers: { Authorization: `Bearer ${token}` } });
        if (!resp.ok) throw new Error(`Ion API ${resp.status}: ${await resp.text()}`);
        const ep = await resp.json();
        if (currentTilesetRef.current) { v.scene.primitives.remove(currentTilesetRef.current); currentTilesetRef.current = null; }
        const tileset = await Cesium.Cesium3DTileset.fromUrl(ep.url, { maximumScreenSpaceError: 0.5, skipLevelOfDetail: false, cacheBytes: 512 * 1024 * 1024 } as any);
        v.scene.primitives.add(tileset);
        currentTilesetRef.current = tileset;
        currentTypeRef.current = 'splat';
        v.zoomTo(tileset);
        store.getState().setStatus(`Ion asset ${assetId} loaded (CesiumJS).`);
        tileset.tileFailed.addEventListener((e: any) => console.error('[Ion] tile failed:', e.url, e.message));
      } catch (e) {
        store.getState().showError(`Ion endpoint/tileset load failed: ${describeLoadError(e)}`);
      }
    },
    toggleCollision(enabled) {
      const v = getViewer();
      if (v) v.scene.screenSpaceCameraController.enableCollisionDetection = enabled;
    },
    useCurrentView() {
      const v = getViewer();
      if (!v) return null;
      const cart = v.camera.positionCartographic;
      return {
        lon: Number(Cesium.Math.toDegrees(cart.longitude).toFixed(6)),
        lat: Number(Cesium.Math.toDegrees(cart.latitude).toFixed(6)),
        alt: Math.round(cart.height),
        range: Math.max(20, Math.round(cart.height * 0.8)),
      };
    },
    setCropToView() {
      const v = getViewer();
      if (!v) { store.getState().setStatus('Cesium not ready.'); return null; }
      const cv = v.scene.canvas;
      const W = cv.clientWidth || cv.width, H = cv.clientHeight || cv.height;
      const ell = v.scene.globe.ellipsoid;
      const D = Cesium.Math.toDegrees;
      const lons: number[] = [], lats: number[] = [];
      if (W && H) {
        for (const [fx, fy] of [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9], [0.5, 0.5]]) {
          const c = v.camera.pickEllipsoid(new Cesium.Cartesian2(fx * W, fy * H), ell);
          if (c) { const g = Cesium.Cartographic.fromCartesian(c); lons.push(D(g.longitude)); lats.push(D(g.latitude)); }
        }
      }
      let w: number, s: number, e: number, n: number;
      if (lons.length >= 2) {
        w = Math.min(...lons); e = Math.max(...lons); s = Math.min(...lats); n = Math.max(...lats);
      } else {
        const carto = v.camera.positionCartographic;
        if (!carto) { store.getState().setStatus('Point the camera at the ground.'); return null; }
        const lat = D(carto.latitude), lon = D(carto.longitude);
        const fr: any = v.camera.frustum;
        const half = 0.8 * carto.height * Math.tan((fr.fovy || fr.fov || 1.047) / 2);
        const dLat = half / 111320, dLon = half / (111320 * Math.cos(carto.latitude));
        w = lon - dLon; e = lon + dLon; s = lat - dLat; n = lat + dLat;
      }
      const cLat = ((s + n) / 2) * Math.PI / 180;
      const spanM = Math.max((e - w) * 111320 * Math.cos(cLat), (n - s) * 111320);
      const ge = spanM > 0 ? Math.pow(10, Math.round(Math.log10(spanM / 100))) : store.getState().maxGE;
      // Default the height range to the loaded tileset's own extent (its bounding sphere already
      // reflects any root transform + local-frame placement) instead of leaving whatever minH/maxH
      // happened to be in the fields — those defaults (-50/800) rarely match the actual asset.
      const tileset = currentTilesetRef.current;
      let { minH, maxH } = store.getState().crop;
      if (tileset) {
        const bs = tileset.boundingSphere;
        const centerCarto = Cesium.Cartographic.fromCartesian(bs.center);
        if (centerCarto) {
          minH = Math.round(centerCarto.height - bs.radius);
          maxH = Math.round(centerCarto.height + bs.radius);
        }
      }
      store.getState().setCrop({ w, s, e, n, minH, maxH });
      store.getState().setMaxGE(ge);
      updateCropBoxInternal();
      return [w, s, store.getState().crop.minH, e, n, store.getState().crop.maxH];
    },
    getExtractMatrix() {
      const tileset = currentTilesetRef.current;
      if (!tileset) return null;
      const mm = tileset.modelMatrix;
      if (!mm || Cesium.Matrix4.equalsEpsilon(mm, Cesium.Matrix4.IDENTITY, 1e-9)) return null;
      return Cesium.Matrix4.toArray(mm) as unknown as number[];
    },
    flyToCity(lon, lat, height) {
      const v = getViewer();
      if (!v) return;
      v.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(lon, lat, height), orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 }, duration: 2 });
    },
    autoZoomToTileset() {
      const v = getViewer();
      if (!v) return;
      const tileset = currentTilesetRef.current;
      if (tileset) {
        const bs = tileset.boundingSphere;
        v.camera.flyToBoundingSphere(bs, {
          offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(-30), Cesium.Math.toRadians(-25), Math.max(50, bs.radius * 2.5)),
          duration: 1.5,
        });
        return;
      }
      v.scene.screenSpaceCameraController.enableCollisionDetection = false;
      store.getState().setCollisionEnabled(true);
      v.camera.flyTo({ destination: Cesium.Cartesian3.ZERO, orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 }, duration: 2 });
      },
    };

    // scene.requestRenderMode (set in initViewer) means a render only happens on Cesium's own built-in
    // triggers (camera movement, tile loads, …) or an explicit requestRender() call — every method above
    // mutates scene state OUTSIDE those triggers (visibility/shading/debug toggles, basemap swaps, crop
    // box moves, etc.), so without this wrapper those changes would sit invisible until the next camera
    // drag. Wrapping once here covers every handle method (sync or async) instead of hand-adding a
    // requestRender() call at the end of each one individually.
    const rr = () => { const v = getViewer(); if (v && !v.isDestroyed()) v.scene.requestRender(); };
    const wrapped: any = {};
    for (const key of Object.keys(raw) as (keyof ViewerHandle)[]) {
      const fn = (raw as any)[key];
      wrapped[key] = (...args: any[]) => {
        const result = fn(...args);
        rr();
        if (result && typeof result.then === 'function') result.then(rr, rr);
        return result;
      };
    }
    return wrapped as ViewerHandle;
  }, []);

  function applyLocalFrameInternal(lon: number, lat: number, alt: number, range: number) {
    const v = getViewer();
    const tileset = currentTilesetRef.current;
    if (!v || !tileset) { store.getState().setStatus('Load a tileset first, then apply a local frame.'); return; }
    const origin = Cesium.Cartesian3.fromDegrees(lon, lat, alt);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
    tileset.modelMatrix = enu;
    placementBaseRef.current = Cesium.Matrix4.clone(enu);
    v.camera.flyToBoundingSphere(new Cesium.BoundingSphere(origin, range * 0.5), {
      offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-25), range),
      duration: 1.2,
    });
    store.getState().setStatus(`Local frame applied.\nOrigin: ${lon.toFixed(5)}, ${lat.toFixed(5)}, ${alt}m`);
  }

  return (
    <div style={{ position: 'absolute', inset: 0, visibility: visible ? 'visible' : 'hidden' }}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      <DatasetTooltip channel={tooltipRef} visible={visible} />
    </div>
  );
});

export default CesiumViewer;
