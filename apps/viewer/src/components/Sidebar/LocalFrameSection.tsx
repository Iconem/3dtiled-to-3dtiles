import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useViewerStore } from '@/state/store';
import type { ViewerHandle } from '@/lib/viewer-handle';
import { SidebarCollapsibleSection } from './SidebarSection';

export default function LocalFrameSection({ activeHandleRef }: { activeHandleRef: React.RefObject<ViewerHandle | null> }) {
  const lf = useViewerStore((s) => s.localFrame);
  const setLocalFrame = useViewerStore((s) => s.setLocalFrame);
  const h = () => activeHandleRef.current;

  function useCurrentView() {
    const v = h()?.useCurrentView();
    if (v) setLocalFrame(v);
  }

  return (
    <SidebarCollapsibleSection title="Local Frame" defaultOpen>
      <div className="flex items-center justify-between"><Label className="text-xs">Lon</Label><Input type="number" className="h-7 w-28" value={lf.lon} onChange={(e) => setLocalFrame({ lon: Number(e.target.value) })} /></div>
      <div className="flex items-center justify-between"><Label className="text-xs">Lat</Label><Input type="number" className="h-7 w-28" value={lf.lat} onChange={(e) => setLocalFrame({ lat: Number(e.target.value) })} /></div>
      <div className="flex items-center justify-between"><Label className="text-xs">Alt (m)</Label><Input type="number" className="h-7 w-28" value={lf.alt} onChange={(e) => setLocalFrame({ alt: Number(e.target.value) })} /></div>
      <div className="flex items-center justify-between"><Label className="text-xs">Range (m)</Label><Input type="number" className="h-7 w-28" value={lf.range} onChange={(e) => setLocalFrame({ range: Number(e.target.value) })} /></div>
      <div className="flex items-center justify-between">
        <Label className="text-xs">Z offset (m)</Label>
        <Input type="number" className="h-7 w-28" value={lf.zOffset} onChange={(e) => { const v = Number(e.target.value); setLocalFrame({ zOffset: v }); h()?.applyZOffset(v); }} />
      </div>
      <Button size="sm" variant="outline" onClick={useCurrentView}>↻ Use current view</Button>
      <Button size="sm" variant="outline" onClick={() => h()?.flyToLocalFrame(lf.lon, lf.lat, lf.alt, lf.range)}>✈ Fly to (no transform)</Button>
      <Button size="sm" onClick={() => h()?.applyLocalFrame(lf.lon, lf.lat, lf.alt, lf.range)}>Apply & fly to</Button>
      <p className="text-xs text-muted-foreground">For tilesets with no geographic locator; places the origin at lon/lat/alt.</p>
    </SidebarCollapsibleSection>
  );
}
