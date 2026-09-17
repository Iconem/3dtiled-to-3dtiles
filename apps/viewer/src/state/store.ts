// Ephemeral / high-frequency state — everything that would be noisy or pointless to sync to the URL
// (crop drag positions, live camera readouts, status/timing-log lines, error text). See urlState.ts
// for the shareable slice. Mirrors viewer.html's remaining module-level `let`s.
import { create } from 'zustand';
import type { AssetType } from '@/lib/formats';
import type { BasemapId } from '@/lib/basemaps';
import type { TerrainMode } from '@/lib/terrainModes';

export interface CropBbox {
  w: number; s: number; minH: number; e: number; n: number; maxH: number;
}

interface ViewerStore {
  // Light/dark — persisted to localStorage under the same key index.html's inline script reads
  // synchronously before first paint (see index.html), so toggling here and reloading never flashes
  // the other theme.
  theme: 'light' | 'dark';
  setTheme: (v: 'light' | 'dark') => void;

  // Sidebar fold — UI-only, not persisted; resets open each session.
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;

  // The type of the currently-loaded asset (mesh/pointcloud/splat) — drives per-type SSE defaults and
  // renderer behavior (e.g. Cesium's splat vs. point-cloud shading paths). Set on preset selection.
  currentType: AssetType;
  setCurrentType: (v: AssetType) => void;

  // The URL bar field + raw-url-mode toggle — kept HERE, not in urlState.ts's nuqs slice: a resolved
  // /stream URL nests its own query string as a value, and round-tripping that through ANOTHER
  // query-string layer (nuqs) corrupted it in testing. See urlState.ts's comment for the full story.
  urlField: string;
  rawUrlMode: boolean;
  setUrlField: (v: string) => void;
  setRawUrlMode: (v: boolean) => void;

  // The last fully-resolved (never raw) URL actually handed to a renderer's load() — distinct from
  // urlField, which in raw-url mode displays the unwrapped source instead. Used to replay the same
  // load into whichever renderer becomes newly active when the RENDERER pill is switched.
  lastLoadUrl: string;
  setLastLoadUrl: (v: string) => void;

  // Basemap / terrain
  basemap: BasemapId;
  // 'auto' = Mapterhorn (ellipsoid) in each renderer's native form (lib/terrarium.ts), 'wgs84' = flat
  // ellipsoid, 'cesium' = Cesium World Terrain (Ion), 'google' = Google Photorealistic 3D Tiles.
  terrainMode: TerrainMode;
  setBasemap: (v: ViewerStore['basemap']) => void;
  setTerrainMode: (v: ViewerStore['terrainMode']) => void;

  // Tileset & LOD
  maxSSE: number | null; // null = per-type default
  assetVisible: boolean;
  ortho: boolean;
  debugTiles: boolean;
  shadeless: boolean;
  brightness: number;
  fov: number;
  controlMode: 'globe' | 'orbit' | 'env'; // 3DTRJS only
  pointSize: number; // 3DTRJS only
  setMaxSSE: (v: number | null) => void;
  setAssetVisible: (v: boolean) => void;
  setOrtho: (v: boolean) => void;
  setDebugTiles: (v: boolean) => void;
  setShadeless: (v: boolean) => void;
  setBrightness: (v: number) => void;
  setFov: (v: number) => void;
  setControlMode: (v: ViewerStore['controlMode']) => void;
  setPointSize: (v: number) => void;

  // Crop & extract
  crop: CropBbox;
  maxGE: number;
  lasStream: boolean;
  enuFrame: boolean;
  splatFormat: string;
  splatClip: boolean;
  cropGizmoOn: boolean;
  setCrop: (v: Partial<CropBbox>) => void;
  setMaxGE: (v: number) => void;
  setLasStream: (v: boolean) => void;
  setEnuFrame: (v: boolean) => void;
  setSplatFormat: (v: string) => void;
  setSplatClip: (v: boolean) => void;
  setCropGizmoOn: (v: boolean) => void;
  // Shared between the crop-box gizmo and the tileset-placement gizmo (3DTRJS only) — drei's
  // TransformControls only ever does ONE of translate/rotate/scale at a time (W/E/R keys cycle it in
  // plain three.js apps, but this app has no keyboard focus story for the canvas), so it needs an
  // explicit UI control instead of only being reachable via keyboard shortcuts a user wouldn't know about.
  gizmoMode: 'translate' | 'rotate' | 'scale';
  setGizmoMode: (v: ViewerStore['gizmoMode']) => void;

  // Navigation
  collisionEnabled: boolean;
  setCollisionEnabled: (v: boolean) => void;

  // Local frame
  localFrame: { lon: number; lat: number; alt: number; range: number; zOffset: number };
  setLocalFrame: (v: Partial<ViewerStore['localFrame']>) => void;
  // 3DTRJS only — shows a translate/rotate/scale gizmo (drag, or W/E/R keys) on the loaded tileset's
  // own transform, for manually positioning non-georeferenced content instead of typing lon/lat/alt.
  tilesetGizmoOn: boolean;
  setTilesetGizmoOn: (v: boolean) => void;

  // Status / timing log / error
  statusLine: string;
  timingLog: string[];
  error: string | null;
  setStatus: (msg: string) => void;
  tlogReset: (label?: string) => void;
  tlog: (msg: string) => void;
  showError: (msg: string) => void;
  hideError: () => void;
}

let tlogT0 = 0;

const THEME_KEY = '3d-tiled-theme';

function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  localStorage.setItem(THEME_KEY, theme);
}

export const useViewerStore = create<ViewerStore>((set, get) => ({
  theme: (localStorage.getItem(THEME_KEY) as 'light' | 'dark' | null) ?? 'dark',
  setTheme: (v) => { applyTheme(v); set({ theme: v }); },

  sidebarCollapsed: false,
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),

  currentType: 'pointcloud',
  setCurrentType: (v) => set({ currentType: v }),

  urlField: '',
  rawUrlMode: false,
  setUrlField: (v) => set({ urlField: v }),
  setRawUrlMode: (v) => set({ rawUrlMode: v }),

  lastLoadUrl: '',
  setLastLoadUrl: (v) => set({ lastLoadUrl: v }),

  // Esri imagery + labels (not 'google'): mt1.google.com's raw tile endpoint is an unofficial hotlink
  // that sometimes answers with an HTML error page instead of image bytes — Cesium's imagery pipeline
  // doesn't gracefully skip that ("InvalidStateError: the source image could not be decoded"). Esri's
  // tile service is public, keyless and sends CORS headers (lib/basemaps.ts).
  basemap: 'esri',
  terrainMode: 'auto',
  setBasemap: (v) => set({ basemap: v }),
  setTerrainMode: (v) => set({ terrainMode: v }),

  maxSSE: null,
  assetVisible: true,
  ortho: false,
  debugTiles: false,
  shadeless: false,
  brightness: 1.6,
  fov: 60,
  controlMode: 'globe',
  pointSize: 2,
  setMaxSSE: (v) => set({ maxSSE: v }),
  setAssetVisible: (v) => set({ assetVisible: v }),
  setOrtho: (v) => set({ ortho: v }),
  setDebugTiles: (v) => set({ debugTiles: v }),
  setShadeless: (v) => set({ shadeless: v }),
  setBrightness: (v) => set({ brightness: v }),
  setFov: (v) => set({ fov: v }),
  setControlMode: (v) => set({ controlMode: v }),
  setPointSize: (v) => set({ pointSize: v }),

  crop: { w: NaN, s: NaN, minH: -50, e: NaN, n: NaN, maxH: 800 },
  maxGE: 0,
  lasStream: true,
  enuFrame: true,
  splatFormat: 'spz',
  splatClip: true,
  cropGizmoOn: false,
  setCrop: (v) => set((s) => ({ crop: { ...s.crop, ...v } })),
  setMaxGE: (v) => set({ maxGE: v }),
  setLasStream: (v) => set({ lasStream: v }),
  setEnuFrame: (v) => set({ enuFrame: v }),
  setSplatFormat: (v) => set({ splatFormat: v }),
  setSplatClip: (v) => set({ splatClip: v }),
  setCropGizmoOn: (v) => set({ cropGizmoOn: v }),
  gizmoMode: 'translate',
  setGizmoMode: (v) => set({ gizmoMode: v }),

  collisionEnabled: true,
  setCollisionEnabled: (v) => set({ collisionEnabled: v }),

  localFrame: { lon: -122.4194, lat: 37.7749, alt: 0, range: 200, zOffset: 0 },
  setLocalFrame: (v) => set((s) => ({ localFrame: { ...s.localFrame, ...v } })),
  tilesetGizmoOn: false,
  setTilesetGizmoOn: (v) => set({ tilesetGizmoOn: v }),

  statusLine: 'Ready. Select a preset or enter a tileset.json URL.',
  timingLog: [],
  error: null,
  setStatus: (msg) => set({ statusLine: msg }),
  tlogReset: (label) => {
    tlogT0 = performance.now();
    set({ timingLog: label ? [`▶ ${label}`] : [] });
  },
  tlog: (msg) => {
    const dt = tlogT0 ? `+${((performance.now() - tlogT0) / 1000).toFixed(2)}s ` : '';
    const line = dt + msg;
    set((s) => ({ timingLog: [...s.timingLog, line].slice(-14) }));
    console.log('[timing]', line);
  },
  showError: (msg) => set({ error: msg }),
  hideError: () => set({ error: null }),
}));
