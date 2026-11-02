import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useViewerStore } from '@/state/store';
import { useUrlState } from '@/state/urlState';
import type { ViewerHandle } from '@/lib/viewer-handle';
import { SidebarCollapsibleSection } from './SidebarSection';

/** The loaded tileset: refinement target, visibility, debug bounds, how mosaics read Potree sources. */
export default function TilesetLodSection({ activeHandleRef }: { activeHandleRef: React.RefObject<ViewerHandle | null> }) {
  const [url, setUrl] = useUrlState();
  const s = useViewerStore();
  const h = () => activeHandleRef.current;

  return (
    <SidebarCollapsibleSection title="Tileset & LOD" defaultOpen>
      <div className="flex items-center justify-between">
        <Label className="text-xs" title="Screen-space error target: CesiumJS maximumScreenSpaceError, 3DTRjs errorTarget. Empty = the format's default (2 px for points, 16 for meshes, 0.5 for splats).">Max SSE (px)</Label>
        <Input type="number" className="h-7 w-20" value={s.maxSSE ?? ''} placeholder={s.autoSSE != null ? `auto · ${s.autoSSE}` : 'auto'}
          onChange={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); s.setMaxSSE(v); h()?.setMaxSSE(v); }} />
      </div>
      <Label className="text-xs" title="Show/hide the loaded asset without unloading it">
        <Checkbox checked={s.assetVisible} onCheckedChange={(v) => { s.setAssetVisible(!!v); h()?.toggleAssetVisible(!!v); }} />
        Show asset
      </Label>
      <div className="flex items-center justify-between">
        <Label className="text-xs" title="cells: the loaded tileset's own tiles — a mosaic's quadtree cells (colour by depth) and its dataset roots (white). tiles: every tile the renderer holds, bounds + depth colour.">Debug</Label>
        <Select value={s.debugMode} onValueChange={(v) => { s.setDebugMode(v as any); h()?.setDebugMode(v as any); }}>
          <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="off">Off</SelectItem>
            <SelectItem value="cells">Cells + dataset roots</SelectItem>
            <SelectItem value="tiles">All tiles (bounds + depth)</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {url.renderer === '3dtrjs' && (
        <Label className="text-xs" title="Mosaics only. Each Potree dataset in an /aggregate mosaic is read directly by 3DTRjs's PotreePlugin (adaptive point size, Potree's own octree) instead of through /stream's 3D Tiles. Switches in place: both readers stay mounted per dataset and only the chosen one draws and loads, so toggling back is instant. The mosaic still carries the /stream link, so CesiumJS and other clients are unaffected. Potree 1.x .bin and 2.0 DEFAULT only; COPC, Brotli and LAS/LAZ-node clouds stay on /stream.">
          <Checkbox checked={url.native} onCheckedChange={(v) => setUrl({ native: !!v })} />
          Native Potree leaves
        </Label>
      )}
    </SidebarCollapsibleSection>
  );
}
