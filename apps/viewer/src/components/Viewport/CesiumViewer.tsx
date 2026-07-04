import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as Cesium from 'cesium';
import type { ViewerHandle } from '@/lib/viewer-handle';
import type { AssetType } from '@/lib/formats';
import { CESIUM_ION_TOKEN } from '@/lib/ion';
import { useViewerStore } from '@/state/store';

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
  const pendingLoadRef = useRef<{ url: string; type: AssetType; opts?: { sseOverride?: number | null } } | null>(null);

  const getViewer = () => viewerRef.current;

  function loadTilesetInternal(url: string, type: AssetType, opts?: { sseOverride?: number | null }) {
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
          const lf = store.getState().localFrame;
          applyLocalFrameInternal(lf.lon, lf.lat, lf.alt, lf.range);
          store.getState().setStatus(`${isSplat ? 'Splat' : 'Local tileset'} placed at local frame origin.\nAdjust ⊕ Local Frame if needed.`);
        } else {
          try {
            const range = Math.max(50, bs.radius * 2.5);
            v.camera.flyToBoundingSphere(bs, {
              offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(-30), Cesium.Math.toRadians(-25), range),
              duration: 1.5,
            });
          } catch {
            store.getState().setStatus('Tileset loaded but zoom failed.\nUse ⊕ Local Frame to place it.');
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
        store.getState().showError(`Failed to load tileset:\n${e.message}`);
        store.getState().setStatus('Load failed.');
        store.getState().tlog(`✗ load failed: ${(e.message || '').slice(0, 50)}`);
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
    store.getState().setStatus('Cesium ready. Select a preset or enter a tileset.json URL.');
    cleanupRef.current = () => { handler.destroy(); v.destroy(); viewerRef.current = null; };
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
    try {
      if (!shadeless && brightness === 1) { (tileset as any).customShader = undefined; return; }
      // Point clouds are frequently uncolored (LAS/COPC with no RGB channel stores black), so
      // multiplying a near-zero diffuse by brightness still renders black — shadeless on a point
      // cloud instead forces a flat white so the geometry actually becomes visible.
      const fragmentShaderText = currentTypeRef.current === 'pointcloud' && shadeless
        ? `void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material){ material.diffuse = vec3(${brightness.toFixed(2)}); }`
        : `void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material){ material.diffuse *= ${brightness.toFixed(2)}; }`;
      (tileset as any).customShader = new Cesium.CustomShader({
        lightingModel: shadeless ? Cesium.LightingModel.UNLIT : undefined,
        fragmentShaderText,
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
        store.getState().showError(`Ion endpoint/tileset load failed: ${(e as Error).message}`);
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
    </div>
  );
});

export default CesiumViewer;
