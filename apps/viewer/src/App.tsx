import { useEffect, useMemo, useRef } from 'react';
import TopBar from '@/components/TopBar';
import Sidebar from '@/components/Sidebar';
import StatusPanel from '@/components/StatusPanel';
import ErrorModal from '@/components/ErrorModal';
import AggregateSearch from '@/components/AggregateSearch';
import CesiumViewer from '@/components/Viewport/CesiumViewer';
import ThreeDTRjsViewer from '@/components/Viewport/ThreeDTRjsViewer';
import { useUrlState } from '@/state/urlState';
import { useViewerStore } from '@/state/store';
import type { ViewerHandle } from '@/lib/viewer-handle';

export default function App() {
  const [url] = useUrlState();
  const cesiumRef = useRef<ViewerHandle>(null);
  const threeRef = useRef<ViewerHandle>(null);

  // Both renderers stay mounted (hidden via CSS) rather than unmount/remount on toggle — each keeps
  // its own last-loaded tileset, matching viewer.html's #cesium-container/#three-container behavior.
  // Memoized on url.renderer alone: App re-renders on every nuqs URL change (e.g. switching presets
  // sets `preset` in the URL), and a fresh object here on every render — even though `.current` always
  // reads the same underlying ref — gave BasemapSection's `[basemap, activeHandleRef]` effect a new
  // dependency identity on every tileset switch, re-applying (and visibly reloading) the basemap layer
  // even though the basemap itself never changed.
  const activeHandleRef: React.RefObject<ViewerHandle | null> = useMemo(() => ({
    get current() {
      return url.renderer === 'cesium' ? cesiumRef.current : threeRef.current;
    },
  } as React.RefObject<ViewerHandle | null>), [url.renderer]);

  // Switching the RENDERER pill doesn't automatically carry the currently-loaded tileset over — each
  // renderer only loads what it's explicitly told to. Mirror viewer.html's toggle3DT(), which re-issues
  // the last load() to whichever renderer just became active.
  useEffect(() => {
    const { lastLoadUrl, currentType } = useViewerStore.getState();
    if (!lastLoadUrl) return;
    activeHandleRef.current?.load(lastLoadUrl, currentType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url.renderer]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <TopBar activeHandleRef={activeHandleRef} />
      <div className="relative flex flex-1 overflow-hidden">
        <div className="relative flex-1 overflow-hidden">
          <CesiumViewer ref={cesiumRef} visible={url.renderer === 'cesium'} />
          <ThreeDTRjsViewer ref={threeRef} visible={url.renderer === '3dtrjs'} />
          <StatusPanel />
          <AggregateSearch activeHandleRef={activeHandleRef} renderer={url.renderer} />
        </div>
        <Sidebar activeHandleRef={activeHandleRef} />
      </div>
      <ErrorModal />
    </div>
  );
}
