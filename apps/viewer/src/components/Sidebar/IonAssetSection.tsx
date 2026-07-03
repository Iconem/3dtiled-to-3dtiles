import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { ChevronDown } from 'lucide-react';
import { useViewerStore } from '@/state/store';
import type { ViewerHandle } from '@/lib/viewer-handle';

export default function IonAssetSection({ activeHandleRef }: { activeHandleRef: React.RefObject<ViewerHandle | null> }) {
  const ionAssetId = useViewerStore((s) => s.ionAssetId);
  const ionToken = useViewerStore((s) => s.ionToken);
  const setIonAssetId = useViewerStore((s) => s.setIonAssetId);
  const setIonToken = useViewerStore((s) => s.setIonToken);

  return (
    <Card>
      <Collapsible>
        <CollapsibleTrigger className="flex w-full items-center justify-between px-4 text-xs font-semibold tracking-wide uppercase text-muted-foreground">
          Cesium Ion Asset <ChevronDown className="size-4" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent>
            <div className="flex items-center justify-between">
              <Label className="text-xs">Asset ID</Label>
              <Input type="number" className="h-7 w-28" value={ionAssetId} onChange={(e) => setIonAssetId(Number(e.target.value))} />
            </div>
            <Textarea placeholder="access token" value={ionToken} onChange={(e) => setIonToken(e.target.value)} />
            <Button size="sm" onClick={() => activeHandleRef.current?.loadIonAsset(ionAssetId, ionToken, true)}>Load Ion asset</Button>
            <p className="text-xs text-muted-foreground">Demo asset: 4547222 (Melbourne photogrammetry).</p>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
