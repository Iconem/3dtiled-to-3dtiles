import { useEffect } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/state/store';
import type { ViewerHandle } from '@/lib/viewer-handle';
import { SidebarSection } from './SidebarSection';

export default function BasemapSection({ activeHandleRef }: { activeHandleRef: React.RefObject<ViewerHandle | null> }) {
  const basemap = useViewerStore((s) => s.basemap);
  const terrainMode = useViewerStore((s) => s.terrainMode);
  const setBasemap = useViewerStore((s) => s.setBasemap);
  const setTerrainMode = useViewerStore((s) => s.setTerrainMode);
  const collisionEnabled = useViewerStore((s) => s.collisionEnabled);
  const setCollisionEnabled = useViewerStore((s) => s.setCollisionEnabled);

  useEffect(() => { activeHandleRef.current?.setBasemap(basemap); }, [basemap, activeHandleRef]);
  useEffect(() => { activeHandleRef.current?.setTerrainMode(terrainMode); }, [terrainMode, activeHandleRef]);

  return (
    <SidebarSection title="Basemap & Navigation">
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
      <div className="flex items-center justify-between">
        <Label className="text-xs">Terrain</Label>
        <Select value={terrainMode} onValueChange={(v) => setTerrainMode(v as any)}>
          <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="wgs84">WGS84 (none)</SelectItem>
            <SelectItem value="cesium">Cesium World Terrain</SelectItem>
            <SelectItem value="reearth-qm">Mapterhorn · quantized mesh (ellipsoid)</SelectItem>
            <SelectItem value="mapterhorn-ellipsoid">Mapterhorn · Terrarium (ellipsoid)</SelectItem>
            <SelectItem value="mapterhorn">Mapterhorn · Terrarium (sea level)</SelectItem>
            <SelectItem value="terrarium">AWS Terrain Tiles (sea level)</SelectItem>
            <SelectItem value="google">Google 3D</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Label className="text-xs">
        <Checkbox checked={!collisionEnabled} onCheckedChange={(v) => { const disable = !!v; setCollisionEnabled(!disable); activeHandleRef.current?.toggleCollision(!disable); }} />
        Disable collision
      </Label>
      <Button size="sm" variant="outline" onClick={() => activeHandleRef.current?.autoZoomToTileset()}>⊙ Auto-zoom to tileset</Button>
    </SidebarSection>
  );
}
