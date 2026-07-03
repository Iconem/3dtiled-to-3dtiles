import { ScrollArea } from '@/components/ui/scroll-area';
import RendererSection from './RendererSection';
import BasemapSection from './BasemapSection';
import TilesetLodSection from './TilesetLodSection';
import CropExtractSection from './CropExtractSection';
import LocalFrameSection from './LocalFrameSection';
import IonAssetSection from './IonAssetSection';
import type { ViewerHandle } from '@/lib/viewer-handle';

export default function Sidebar({ activeHandleRef }: { activeHandleRef: React.RefObject<ViewerHandle | null> }) {
  return (
    <ScrollArea className="h-full w-64 shrink-0 border-l">
      <div className="flex flex-col divide-y divide-border">
        <RendererSection />
        <BasemapSection activeHandleRef={activeHandleRef} />
        <TilesetLodSection activeHandleRef={activeHandleRef} />
        <CropExtractSection activeHandleRef={activeHandleRef} />
        <LocalFrameSection activeHandleRef={activeHandleRef} />
        <IonAssetSection activeHandleRef={activeHandleRef} />
      </div>
    </ScrollArea>
  );
}
