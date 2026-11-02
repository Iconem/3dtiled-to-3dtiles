import { useEffect } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/state/store';
import type { ViewerHandle } from '@/lib/viewer-handle';
import { SidebarCollapsibleSection } from './SidebarSection';
import { BASEMAPS } from '@/lib/basemaps';
import { useUrlState } from '@/state/urlState';
import { CESIUM_ION_TOKEN } from '@/lib/ion';
import { GOOGLE_MAPS_API_KEY } from '@/lib/google';

const NEEDS_KEY = 'Needs VITE_GOOGLE_MAPS_API_KEY or VITE_CESIUM_ION_TOKEN, see apps/viewer/.env.example';

export default function BasemapSection({ activeHandleRef }: { activeHandleRef: React.RefObject<ViewerHandle | null> }) {
  const basemap = useViewerStore((s) => s.basemap);
  const terrainMode = useViewerStore((s) => s.terrainMode);
  const setBasemap = useViewerStore((s) => s.setBasemap);
  const setTerrainMode = useViewerStore((s) => s.setTerrainMode);
  const globeVisible = useViewerStore((s) => s.globeVisible);
  const setGlobeVisible = useViewerStore((s) => s.setGlobeVisible);
  const collisionEnabled = useViewerStore((s) => s.collisionEnabled);
  const setCollisionEnabled = useViewerStore((s) => s.setCollisionEnabled);
  const terrainBehind = useViewerStore((s) => s.terrainBehind);
  const setTerrainBehind = useViewerStore((s) => s.setTerrainBehind);
  const [url] = useUrlState();

  useEffect(() => { activeHandleRef.current?.setBasemap(basemap); }, [basemap, activeHandleRef]);
  useEffect(() => { activeHandleRef.current?.setTerrainMode(terrainMode); }, [terrainMode, activeHandleRef]);

  return (
    <SidebarCollapsibleSection title="Basemap & Terrain" defaultOpen>
      <div className="flex items-center justify-between">
        <Label className="text-xs">Imagery</Label>
        <Select value={basemap} onValueChange={(v) => setBasemap(v as any)}>
          <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(BASEMAPS).map(([id, b]) => b && <SelectItem key={id} value={id}>{b.label}</SelectItem>)}
            <SelectItem value="none">None</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center justify-between">
        <Label className="text-xs" title="Unchecked: no globe at all (no terrain, no ellipsoid), for datasets that sit under the terrain or to look at a cloud from below. The tileset stays; the terrain choice is kept for when it comes back.">
          <Checkbox checked={globeVisible} onCheckedChange={(v) => { setGlobeVisible(!!v); activeHandleRef.current?.setGlobeVisible?.(!!v); }} />
          Terrain
        </Label>
        <Select value={terrainMode} onValueChange={(v) => setTerrainMode(v as any)} disabled={!globeVisible}>
          <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="wgs84">WGS84 ellipsoid (flat)</SelectItem>
            <SelectItem value="google" disabled={!(url.renderer === 'cesium' ? CESIUM_ION_TOKEN : GOOGLE_MAPS_API_KEY)} title={NEEDS_KEY}>Google 3D</SelectItem>
            <SelectItem value="auto" title="3DTRjs: mapterhorn.com's Terrarium webp tiles, heights above sea level. Cesium: the same DEM on the ellipsoid, as a quantized mesh.">Mapterhorn</SelectItem>
            <SelectItem value="terrarium" title="Mapzen / AWS Open Data Terrarium tiles, heights above sea level">AWS Terrain Tiles</SelectItem>
            <SelectItem value="cesium" disabled={!CESIUM_ION_TOKEN} title={NEEDS_KEY}>Cesium World Terrain</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Label className="text-xs">
        <Checkbox checked={!collisionEnabled} onCheckedChange={(v) => { const disable = !!v; setCollisionEnabled(!disable); activeHandleRef.current?.toggleCollision(!disable); }} />
        Disable collision
      </Label>
      {url.renderer === '3dtrjs' && (
        <Label className="text-xs" title="Draw the globe and terrain first, then the data on a cleared depth buffer: datasets below the DEM (a cloud not yet snapped to ground, a tunnel) stay visible. The terrain then never hides the data, so the data also shows through hills in front of it.">
          <Checkbox checked={terrainBehind} onCheckedChange={(v) => setTerrainBehind(!!v)} />
          Terrain behind data
        </Label>
      )}
      <Button size="sm" variant="outline" onClick={() => activeHandleRef.current?.autoZoomToTileset()}>⊙ Auto-zoom to tileset</Button>
    </SidebarCollapsibleSection>
  );
}
