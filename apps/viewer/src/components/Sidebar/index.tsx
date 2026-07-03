import { Moon, Sun, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useViewerStore } from '@/state/store';
import RendererSection from './RendererSection';
import BasemapSection from './BasemapSection';
import TilesetLodSection from './TilesetLodSection';
import CropExtractSection from './CropExtractSection';
import LocalFrameSection from './LocalFrameSection';
import IonAssetSection from './IonAssetSection';
import type { ViewerHandle } from '@/lib/viewer-handle';

export default function Sidebar({ activeHandleRef }: { activeHandleRef: React.RefObject<ViewerHandle | null> }) {
  const theme = useViewerStore((s) => s.theme);
  const setTheme = useViewerStore((s) => s.setTheme);
  const collapsed = useViewerStore((s) => s.sidebarCollapsed);
  const setCollapsed = useViewerStore((s) => s.setSidebarCollapsed);

  if (collapsed) {
    return (
      <div className="flex h-full w-9 shrink-0 flex-col items-center gap-1 border-l pt-1.5">
        <Button size="icon" variant="ghost" className="size-7" title="Expand sidebar" onClick={() => setCollapsed(false)}>
          <PanelRightOpen className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full w-64 shrink-0 flex-col border-l">
      <div className="flex items-center justify-between border-b px-2 py-1.5">
        <Button size="icon" variant="ghost" className="size-7" title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
        <Button size="icon" variant="ghost" className="size-7" title="Collapse sidebar" onClick={() => setCollapsed(true)}>
          <PanelRightClose className="size-4" />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col divide-y divide-border">
          <RendererSection />
          <BasemapSection activeHandleRef={activeHandleRef} />
          <TilesetLodSection activeHandleRef={activeHandleRef} />
          <CropExtractSection activeHandleRef={activeHandleRef} />
          <LocalFrameSection activeHandleRef={activeHandleRef} />
          <IonAssetSection activeHandleRef={activeHandleRef} />
        </div>
      </ScrollArea>
    </div>
  );
}
