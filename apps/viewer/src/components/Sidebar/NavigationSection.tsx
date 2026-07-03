import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useViewerStore } from '@/state/store';
import type { ViewerHandle } from '@/lib/viewer-handle';

export default function NavigationSection({ activeHandleRef }: { activeHandleRef: React.RefObject<ViewerHandle | null> }) {
  const collisionEnabled = useViewerStore((s) => s.collisionEnabled);
  const setCollisionEnabled = useViewerStore((s) => s.setCollisionEnabled);

  return (
    <Card>
      <CardHeader><CardTitle>Navigation</CardTitle></CardHeader>
      <CardContent>
        <Label className="text-xs">
          <Checkbox checked={!collisionEnabled} onCheckedChange={(v) => { const disable = !!v; setCollisionEnabled(!disable); activeHandleRef.current?.toggleCollision(!disable); }} />
          Disable collision
        </Label>
        <Button size="sm" variant="outline" onClick={() => activeHandleRef.current?.flyToOrigin()}>⊙ Fly to origin</Button>
      </CardContent>
    </Card>
  );
}
