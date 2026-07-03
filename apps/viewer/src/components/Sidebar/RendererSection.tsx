import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useUrlState } from '@/state/urlState';
import { SidebarSection } from './SidebarSection';

export default function RendererSection() {
  const [url, setUrl] = useUrlState();
  return (
    <SidebarSection title="Renderer">
      <ToggleGroup type="single" variant="outline" value={url.renderer} onValueChange={(v) => v && setUrl({ renderer: v as any })} className="w-full">
        <ToggleGroupItem value="cesium" className="flex-1">CesiumJS</ToggleGroupItem>
        <ToggleGroupItem value="3dtrjs" className="flex-1">3DTRJS</ToggleGroupItem>
      </ToggleGroup>
    </SidebarSection>
  );
}
