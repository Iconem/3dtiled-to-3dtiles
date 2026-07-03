import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useViewerStore } from '@/state/store';
import type { ViewerHandle } from '@/lib/viewer-handle';
import { SidebarCollapsibleSection } from './SidebarSection';

export default function IonAssetSection({ activeHandleRef }: { activeHandleRef: React.RefObject<ViewerHandle | null> }) {
  const ionAssetId = useViewerStore((s) => s.ionAssetId);
  const ionToken = useViewerStore((s) => s.ionToken);
  const setIonAssetId = useViewerStore((s) => s.setIonAssetId);
  const setIonToken = useViewerStore((s) => s.setIonToken);

  return (
    <SidebarCollapsibleSection title="Cesium Ion Asset">
      <div className="flex items-center justify-between">
        <Label className="text-xs">Asset ID</Label>
        <Input type="number" className="h-7 w-28" value={ionAssetId} onChange={(e) => setIonAssetId(Number(e.target.value))} />
      </div>
      <Textarea placeholder="access token" value={ionToken} onChange={(e) => setIonToken(e.target.value)} />
      <Button size="sm" onClick={() => activeHandleRef.current?.loadIonAsset(ionAssetId, ionToken, true)}>Load Ion asset</Button>
      <p className="text-xs text-muted-foreground">Demo asset: 4547222 (Melbourne photogrammetry).</p>
    </SidebarCollapsibleSection>
  );
}
