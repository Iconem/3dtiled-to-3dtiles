import { useEffect, useRef } from 'react';
import { useUrlState } from '@/state/urlState';
import { useViewerStore } from '@/state/store';

type ViewerStore = ReturnType<typeof useViewerStore.getState>;

/**
 * The side panel's settings in the address bar (state/urlState.ts lists the keys): the camera scheme, imagery,
 * terrain, debug view, ground snap, and every other control a link should reopen with, so that a link opens on the
 * same view and a reload keeps what was set.
 *
 * On mount the URL wins over the store's defaults; afterwards every change in the store is written to the URL, and
 * a value equal to the store's default is left out, so a plain link stays plain. The URL is not watched after
 * mount: nuqs only changes it through setUrl here, and the browser's back/forward would otherwise fight the store.
 */
type Setting = {
  key: string;
  read: (s: ViewerStore) => string;
  write: (s: ViewerStore, v: string) => void;
};
const bool = (v: string) => (v === '1' || v === 'true' ? true : v === '0' || v === 'false' ? false : null);
const num = (v: string) => (v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const oneOf = <T extends string>(all: readonly T[], v: string): T | null => (all.includes(v as T) ? (v as T) : null);
const fmt = (n: number) => String(Number(n.toPrecision(6)));

const flag = (key: string, get: (s: ViewerStore) => boolean, set: (s: ViewerStore, v: boolean) => void): Setting =>
  ({ key, read: (s) => (get(s) ? '1' : '0'), write: (s, v) => { const b = bool(v); if (b !== null) set(s, b); } });
const number = (key: string, get: (s: ViewerStore) => number, set: (s: ViewerStore, v: number) => void): Setting =>
  ({ key, read: (s) => fmt(get(s)), write: (s, v) => { const n = num(v); if (n !== null) set(s, n); } });
const choice = <T extends string>(key: string, all: readonly T[], get: (s: ViewerStore) => T, set: (s: ViewerStore, v: T) => void): Setting =>
  ({ key, read: (s) => get(s), write: (s, v) => { const c = oneOf(all, v); if (c !== null) set(s, c); } });

const SETTINGS: Setting[] = [
  choice('controls', ['auto', 'globe', 'orbit', 'env', 'trackball', 'fly'] as const, (s) => s.controlMode, (s, v) => s.setControlMode(v)),
  { key: 'imagery', read: (s) => s.basemap, write: (s, v) => s.setBasemap(v as ViewerStore['basemap']) },
  { key: 'terrain', read: (s) => s.terrainMode, write: (s, v) => s.setTerrainMode(v as ViewerStore['terrainMode']) },
  choice('debug', ['off', 'cells', 'cells-only', 'tiles'] as const, (s) => s.debugMode, (s, v) => s.setDebugMode(v)),
  // 1 counts as the user's own choice, so a fresh load keeps it (store.zOffsetAutoByUser)
  { key: 'zauto', read: (s) => (s.zOffsetAuto ? '1' : '0'), write: (s, v) => { const b = bool(v); if (b !== null) s.setZOffsetAuto(b, true); } },
  number('clearance', (s) => s.zOffsetClearance, (s, v) => s.setZOffsetClearance(v)),
  flag('globe', (s) => s.globeVisible, (s, v) => s.setGlobeVisible(v)),
  flag('collision', (s) => s.collisionEnabled, (s, v) => s.setCollisionEnabled(v)),
  flag('tbehind', (s) => s.terrainBehind, (s, v) => s.setTerrainBehind(v)),
  number('fov', (s) => s.fov, (s, v) => s.setFov(v)),
  flag('ortho', (s) => s.ortho, (s, v) => s.setOrtho(v)),
  // null = the per-type default, written as '' (left out)
  { key: 'sse', read: (s) => (s.maxSSE === null ? '' : fmt(s.maxSSE)), write: (s, v) => { const n = num(v); if (n !== null) s.setMaxSSE(n); } },
  flag('asset', (s) => s.assetVisible, (s, v) => s.setAssetVisible(v)),
  choice('material', ['default', 'xray', 'wireframe', 'features'] as const, (s) => s.materialMode, (s, v) => s.setMaterialMode(v)),
  number('xray', (s) => s.xrayOpacity, (s, v) => s.setXrayOpacity(v)),
  choice('pcolor', ['rgb', 'color', 'height'] as const, (s) => s.pointColorMode, (s, v) => s.setPointColorMode(v)),
  { key: 'color', read: (s) => s.pointColor, write: (s, v) => { if (/^#[0-9a-f]{6}$/i.test(v)) s.setPointColor(v); } },
  number('psize', (s) => s.pointSize, (s, v) => s.setPointSize(v)),
  choice('pshape', ['square', 'round', 'sphere'] as const, (s) => s.pointShape, (s, v) => s.setPointShape(v)),
  flag('adaptive', (s) => s.pointAdaptive, (s, v) => s.setPointAdaptive(v)),
  flag('edl', (s) => s.edl, (s, v) => s.setEdl(v)),
  number('edls', (s) => s.edlStrength, (s, v) => s.setEdlStrength(v)),
  flag('shadeless', (s) => s.shadeless, (s, v) => s.setShadeless(v)),
  number('brightness', (s) => s.brightness, (s, v) => s.setBrightness(v)),
];
export const URL_SETTING_KEYS = SETTINGS.map((x) => x.key);

const read = (s: ViewerStore): Record<string, string> => Object.fromEntries(SETTINGS.map((x) => [x.key, x.read(s)]));

export function useUrlSettings() {
  const [url, setUrl] = useUrlState();
  const defaults = useRef<Record<string, string> | null>(null);
  useEffect(() => {
    const st = useViewerStore.getState();
    defaults.current = read(st);
    // 1. the URL into the store, once
    const u = url as unknown as Record<string, string>;
    for (const x of SETTINGS) if (u[x.key]) x.write(st, u[x.key]);
    // 2. the store into the URL, from then on
    let last = read(useViewerStore.getState());
    const unsub = useViewerStore.subscribe((s) => {
      const now = read(s);
      const patch: Record<string, string> = {};
      let changed = false;
      for (const x of SETTINGS) {
        if (now[x.key] === last[x.key]) continue;
        patch[x.key] = now[x.key] === defaults.current![x.key] ? '' : now[x.key];
        changed = true;
      }
      last = now;
      if (changed) setUrl(patch as any);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
