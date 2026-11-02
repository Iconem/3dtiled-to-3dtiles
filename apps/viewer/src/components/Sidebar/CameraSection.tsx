import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useViewerStore } from '@/state/store';
import { useUrlState } from '@/state/urlState';
import type { ViewerHandle } from '@/lib/viewer-handle';
import { SidebarCollapsibleSection } from './SidebarSection';

/** How the camera moves and projects: controls scheme (3DTRjs), field of view, orthographic. */
export default function CameraSection({ activeHandleRef }: { activeHandleRef: React.RefObject<ViewerHandle | null> }) {
  const [url] = useUrlState();
  const s = useViewerStore();
  const h = () => activeHandleRef.current;

  return (
    <SidebarCollapsibleSection title="Camera & Controls" defaultOpen>
      {url.renderer === '3dtrjs' && (
        <div className="flex items-center justify-between">
          <Label className="text-xs" title="Auto: Globe from far away, Orbit below 3 km above the ground, back to Globe above 6 km; the switch waits for the end of a drag or a zoom. Globe: 3DTRjs GlobeControls (drag the globe, right-drag to orbit the point under the cursor, local vertical near the ground, north from far away). Orbit: three's OrbitControls around a target. Environment: 3DTRjs EnvironmentControls (a flat-world scheme around the picked point). Trackball: free rotation about the target, no up vector, like a model viewer. Fly: W A S D move, R F up/down, Q E roll, arrows turn, drag to look; speed scales with the height above ground.">Controls mode</Label>
          <Select value={s.controlMode} onValueChange={(v) => { s.setControlMode(v as any); h()?.setControlMode?.(v as any); }}>
            <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto (Globe far, Orbit near)</SelectItem>
              <SelectItem value="globe">Globe</SelectItem>
              <SelectItem value="orbit">Orbit</SelectItem>
              <SelectItem value="env">Environment</SelectItem>
              <SelectItem value="trackball">Trackball</SelectItem>
              <SelectItem value="fly">Fly (WASD, drag to look)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="flex items-center justify-between">
        <Label className="text-xs">FOV (°)</Label>
        <Input type="number" className="h-7 w-20" value={s.fov} onChange={(e) => { const v = Number(e.target.value) || 60; s.setFov(v); h()?.setFov(v); }} />
      </div>
      <Label className="text-xs" title="Orthographic vs perspective camera">
        <Checkbox checked={s.ortho} onCheckedChange={(v) => { s.setOrtho(!!v); h()?.setOrtho(!!v); }} />
        Orthographic camera
      </Label>
    </SidebarCollapsibleSection>
  );
}
