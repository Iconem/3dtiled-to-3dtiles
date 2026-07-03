import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { useViewerStore } from '@/state/store';
import { useUrlState } from '@/state/urlState';
import type { ViewerHandle } from '@/lib/viewer-handle';
import { SidebarSection } from './SidebarSection';

export default function TilesetLodSection({ activeHandleRef }: { activeHandleRef: React.RefObject<ViewerHandle | null> }) {
  const [url] = useUrlState();
  const s = useViewerStore();
  const h = () => activeHandleRef.current;

  return (
    <SidebarSection title="Tileset & LOD">
        <div className="flex items-center justify-between">
          <Label className="text-xs">Max SSE (px)</Label>
          <Input type="number" className="h-7 w-20" value={s.maxSSE ?? ''} placeholder="auto"
            onChange={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); s.setMaxSSE(v); h()?.setMaxSSE(v); }} />
        </div>
        <Label className="text-xs" title="Show/hide the loaded asset without unloading it">
          <Checkbox checked={s.assetVisible} onCheckedChange={(v) => { s.setAssetVisible(!!v); h()?.toggleAssetVisible(!!v); }} />
          Show asset
        </Label>
        <Label className="text-xs" title="Orthographic vs perspective camera">
          <Checkbox checked={s.ortho} onCheckedChange={(v) => { s.setOrtho(!!v); h()?.setOrtho(!!v); }} />
          Orthographic camera
        </Label>
        <Label className="text-xs" title="Draw tile bounding volumes, colour by depth">
          <Checkbox checked={s.debugTiles} onCheckedChange={(v) => { s.setDebugTiles(!!v); h()?.toggleDebug(!!v); }} />
          Debug tiles (bounds + depth)
        </Label>
        {url.renderer === 'cesium' && (
          <>
            <Label className="text-xs" title="Unlit rendering — avoids dark results on baked-lighting photogrammetry">
              <Checkbox checked={s.shadeless} onCheckedChange={(v) => { s.setShadeless(!!v); h()?.applyShading(!!v, s.brightness); }} />
              Shadeless (unlit)
            </Label>
            <div className="flex items-center justify-between">
              <Label className="text-xs">Brightness</Label>
              <Input type="number" step={0.1} className="h-7 w-20" value={s.brightness}
                onChange={(e) => { const v = Number(e.target.value) || 1; s.setBrightness(v); h()?.applyShading(s.shadeless, v); }} />
            </div>
          </>
        )}
        <div className="flex items-center justify-between">
          <Label className="text-xs">FOV (°)</Label>
          <Input type="number" className="h-7 w-20" value={s.fov} onChange={(e) => { const v = Number(e.target.value) || 60; s.setFov(v); h()?.setFov(v); }} />
        </div>

        {url.renderer === '3dtrjs' && (
          <>
            <div className="flex items-center justify-between">
              <Label className="text-xs">Controls mode</Label>
              <Select value={s.controlMode} onValueChange={(v) => { s.setControlMode(v as any); h()?.setControlMode?.(v as any); }}>
                <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="globe">Globe</SelectItem>
                  <SelectItem value="orbit">Orbit</SelectItem>
                  <SelectItem value="env">Environment</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-xs">Point size (px)</Label>
              <div className="flex w-32 items-center gap-2">
                <Slider min={0.5} max={10} step={0.5} value={[s.pointSize]} onValueChange={([v]) => { s.setPointSize(v); h()?.setPointSize?.(v); }} />
                <span className="w-8 text-right text-xs text-muted-foreground">{s.pointSize}</span>
              </div>
            </div>
          </>
        )}
    </SidebarSection>
  );
}
