import { ScrollArea } from '@/components/ui/scroll-area';
import RendererSection from './RendererSection';
import BasemapSection from './BasemapSection';
import TilesetLodSection from './TilesetLodSection';
import CropExtractSection from './CropExtractSection';
import NavigationSection from './NavigationSection';
import LocalFrameSection from './LocalFrameSection';
import IonAssetSection from './IonAssetSection';
import SnippetSection from './SnippetSection';
import type { ViewerHandle } from '@/lib/viewer-handle';

export default function Sidebar({ activeHandleRef }: { activeHandleRef: React.RefObject<ViewerHandle | null> }) {
  return (
    <ScrollArea className="h-full w-72 shrink-0 border-l">
      <div className="flex flex-col gap-3 p-2">
        <RendererSection />
        <BasemapSection activeHandleRef={activeHandleRef} />
        <TilesetLodSection activeHandleRef={activeHandleRef} />
        <CropExtractSection activeHandleRef={activeHandleRef} />
        <NavigationSection activeHandleRef={activeHandleRef} />
        <LocalFrameSection activeHandleRef={activeHandleRef} />
        <IonAssetSection activeHandleRef={activeHandleRef} />
        <SnippetSection />
      </div>
    </ScrollArea>
  );
}
