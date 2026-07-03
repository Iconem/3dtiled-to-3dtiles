import { useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useViewerStore } from '@/state/store';
import type { ViewerHandle } from '@/lib/viewer-handle';

export default function BasemapSection({ activeHandleRef }: { activeHandleRef: React.RefObject<ViewerHandle | null> }) {
  const basemap = useViewerStore((s) => s.basemap);
  const terrain = useViewerStore((s) => s.terrain);
  const setBasemap = useViewerStore((s) => s.setBasemap);
  const setTerrain = useViewerStore((s) => s.setTerrain);

  useEffect(() => { activeHandleRef.current?.setBasemap(basemap); }, [basemap, activeHandleRef]);

  return (
    <Card>
      <CardHeader><CardTitle>Basemap</CardTitle></CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <Label className="text-xs">Imagery</Label>
          <Select value={basemap} onValueChange={(v) => setBasemap(v as any)}>
            <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="google">Google Hybrid</SelectItem>
              <SelectItem value="osm">OpenStreetMap</SelectItem>
              <SelectItem value="none">None</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Label className="text-xs">
          <Checkbox checked={terrain} onCheckedChange={(v) => { setTerrain(!!v); activeHandleRef.current?.toggleTerrain(!!v); }} />
          Terrain (Ion)
        </Label>
      </CardContent>
    </Card>
  );
}
