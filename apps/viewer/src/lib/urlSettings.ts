import { useEffect, useRef } from 'react';
import { useUrlState } from '@/state/urlState';
import { useViewerStore } from '@/state/store';

type ViewerStore = ReturnType<typeof useViewerStore.getState>;

/**
 * The side panel's settings in the address bar: `controls=` (auto | globe | orbit | env | trackball | fly),
 * `imagery=` (a basemap id), `terrain=` (a terrain mode), `debug=` (off | cells | cells-only | tiles) and `zauto=`
 * (1 | 0, the ground snap; 1 counts as the user's own choice, so a fresh load keeps it).
 *
 * On mount the URL wins over the store's defaults; afterwards every change in the store is written to the URL, and
 * a value equal to the store's default is left out, so a plain link stays plain. The URL is not watched after
 * mount: nuqs only changes it through setUrl here, and the browser's back/forward would otherwise fight the store.
 */
const KEYS = ['controls', 'imagery', 'terrain', 'debug', 'zauto'] as const;
type Key = (typeof KEYS)[number];

const CONTROLS = new Set(['auto', 'globe', 'orbit', 'env', 'trackball', 'fly']);
const DEBUG = new Set(['off', 'cells', 'cells-only', 'tiles']);

const read = (s: ViewerStore): Record<Key, string> => ({
  controls: s.controlMode, imagery: s.basemap, terrain: s.terrainMode, debug: s.debugMode, zauto: s.zOffsetAuto ? '1' : '0',
});

export function useUrlSettings() {
  const [url, setUrl] = useUrlState();
  const defaults = useRef<Record<Key, string> | null>(null);
  useEffect(() => {
    const st = useViewerStore.getState();
    defaults.current = read(st);
    // 1. the URL into the store, once
    if (url.controls && CONTROLS.has(url.controls)) st.setControlMode(url.controls as ViewerStore['controlMode']);
    if (url.imagery) st.setBasemap(url.imagery as ViewerStore['basemap']);
    if (url.terrain) st.setTerrainMode(url.terrain as ViewerStore['terrainMode']);
    if (url.debug && DEBUG.has(url.debug)) st.setDebugMode(url.debug as ViewerStore['debugMode']);
    if (url.zauto === '1' || url.zauto === '0') st.setZOffsetAuto(url.zauto === '1', true);
    // 2. the store into the URL, from then on
    let last = read(useViewerStore.getState());
    const unsub = useViewerStore.subscribe((s) => {
      const now = read(s);
      const patch: Partial<Record<Key, string>> = {};
      let changed = false;
      for (const k of KEYS) {
        if (now[k] === last[k]) continue;
        patch[k] = now[k] === defaults.current![k] ? '' : now[k];
        changed = true;
      }
      last = now;
      if (changed) setUrl(patch);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
