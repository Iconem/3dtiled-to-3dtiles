import { Moon, Sun, PanelRightClose, PanelRightOpen, BookOpen, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useViewerStore } from '@/state/store';
import { useUrlState } from '@/state/urlState';
import BasemapSection from './BasemapSection';
import CameraSection from './CameraSection';
import TilesetLodSection from './TilesetLodSection';
import MaterialSection from './MaterialSection';
import CropExtractSection from './CropExtractSection';
import LocalFrameSection from './LocalFrameSection';
import type { ViewerHandle } from '@/lib/viewer-handle';
import { DOCS_URL, MW } from '@/lib/formats';

export default function Sidebar({ activeHandleRef }: { activeHandleRef: React.RefObject<ViewerHandle | null> }) {
  const theme = useViewerStore((s) => s.theme);
  const setTheme = useViewerStore((s) => s.setTheme);
  const collapsed = useViewerStore((s) => s.sidebarCollapsed);
  const setCollapsed = useViewerStore((s) => s.setSidebarCollapsed);
  const [url, setUrl] = useUrlState();

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
    <div className="flex h-full w-72 shrink-0 flex-col border-l">
      <div className="flex items-center justify-between border-b px-2 py-1.5">
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" className="size-7" title="Docs" asChild>
            <a href={DOCS_URL} target="_blank" rel="noopener noreferrer"><BookOpen className="size-4" /></a>
          </Button>
          <Button size="icon" variant="ghost" className="size-7" title="API playground (middleware server)" asChild>
            <a href={`${MW}/playground`} target="_blank" rel="noopener noreferrer"><Terminal className="size-4" /></a>
          </Button>
        </div>
        <ToggleGroup type="single" variant="outline" size="sm" value={url.renderer} onValueChange={(v) => v && setUrl({ renderer: v as any })}>
          <ToggleGroupItem value="cesium" className="h-7 px-2 text-xs">Cesium</ToggleGroupItem>
          <ToggleGroupItem value="3dtrjs" className="h-7 px-2 text-xs">3DTRJS</ToggleGroupItem>
        </ToggleGroup>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" className="size-7" title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
          <Button size="icon" variant="ghost" className="size-7" title="Collapse sidebar" onClick={() => setCollapsed(true)}>
            <PanelRightClose className="size-4" />
          </Button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col divide-y divide-border">
          {/* every section folds and remembers its state (SidebarSection.tsx); the two occasional
              ones, Crop & Extract and Local Frame, start folded */}
          <BasemapSection activeHandleRef={activeHandleRef} />
          <CameraSection activeHandleRef={activeHandleRef} />
          <TilesetLodSection activeHandleRef={activeHandleRef} />
          <MaterialSection activeHandleRef={activeHandleRef} />
          <CropExtractSection activeHandleRef={activeHandleRef} />
          <LocalFrameSection activeHandleRef={activeHandleRef} />
        </div>
      </ScrollArea>
    </div>
  );
}
