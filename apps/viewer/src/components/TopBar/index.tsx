import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useUrlState } from '@/state/urlState';
import { useViewerStore } from '@/state/store';
import { FORMATS, PSEUDO_FORMATS, fmtMeta, canCentroids, MW } from '@/lib/formats';
import { buildMiddlewareUrl, currentPresets, type MiddlewareParams, type Preset } from '@/lib/middleware';
import type { ViewerHandle } from '@/lib/viewer-handle';
import { cn } from '@/lib/utils';

const MODE_PILLS: [string, string][] = [
  ['stream', '⚡ Live streaming'],
  ['offline', '💾 Prebuilt offline'],
  ['tools', '⚙ Tools'],
];
const CACHE_PILLS: [string, string][] = [
  ['none', '◔ cache=none'],
  ['hierarchy', '◑ cache=hierarchy'],
  ['all', '● cache=all'],
];
const TOOL_PILLS: [string, string][] = [
  ['implicit-to-explicit', '⬡→⬢ implicit→explicit'],
  ['upgrade', '⬆ upgrade'],
  ['packages', '📦 packages'],
];
const TILING_PILLS: [string, string][] = [
  ['implicit', '⬡ implicit'],
  ['explicit', '⬢ explicit'],
];

function Pill({ active, onClick, title, children }: { active: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <Button size="sm" variant={active ? 'default' : 'outline'} onClick={onClick} title={title} className="h-7 px-2 text-xs">
      {children}
    </Button>
  );
}

// Each pill group gets a faint per-category tint (instead of vertical dividers) so groups stay
// visually distinguishable — and each becomes a single flex-wrap unit that wraps as a whole rather
// than splitting mid-group on narrow screens.
function PillGroup({ tint, className, children }: { tint: string; className?: string; children: React.ReactNode }) {
  return <div className={cn('flex flex-wrap items-center gap-1 rounded-md p-1', tint, className)}>{children}</div>;
}

export default function TopBar({ activeHandleRef }: { activeHandleRef: React.RefObject<ViewerHandle | null> }) {
  const [url, setUrl] = useUrlState();
  const store = useViewerStore;
  const urlField = useViewerStore((s) => s.urlField);
  const rawUrlMode = useViewerStore((s) => s.rawUrlMode);
  const inputRef = useRef<HTMLInputElement>(null);

  const params: MiddlewareParams = {
    selectedFormat: url.format,
    viewerMode: url.mode,
    cacheScope: url.cache,
    prefetchN: url.prefetch,
    transformOp: url.transform,
    centroidsOnly: url.centroids,
    tilingMode: url.tiling,
  };

  const presets = currentPresets({ ...params, toolName: url.tool });
  const fmtOfSelected = fmtMeta(url.format);

  function doLoad(loadUrl: string, type: Preset['type'], flyTo?: Preset['flyTo']) {
    store.getState().setCurrentType(type);
    store.getState().setLastLoadUrl(loadUrl);
    store.getState().tlogReset(`${url.mode} · ${url.format}${flyTo ? ' [fly]' : ''}`);
    activeHandleRef.current?.load(loadUrl, type);
    if (flyTo) activeHandleRef.current?.flyToCity(flyTo.lon, flyTo.lat, flyTo.height);
  }

  function selectPreset(p: Preset) {
    setUrl({ preset: p.id });
    if (p.custom) {
      store.getState().setUrlField('');
      store.getState().setStatus(rawUrlMode ? `Custom · paste a RAW ${url.format} dataset URL, then Load.` : 'Custom · paste a full middleware/tileset URL, then Load.');
      inputRef.current?.focus();
      return;
    }
    if (!p.url) return;
    const field = rawUrlMode && p.rawSrc ? p.rawSrc : p.url;
    store.getState().setUrlField(field);
    const loadUrl = rawUrlMode && p.rawSrc ? buildMiddlewareUrl(p.rawSrc, params) : p.url;
    doLoad(loadUrl, p.type, p.flyTo);
  }

  function handleLoadClick() {
    const field = urlField.trim();
    if (!field) return;
    const loadUrl = rawUrlMode && !field.startsWith(MW) ? buildMiddlewareUrl(field, params) : field;
    doLoad(loadUrl, store.getState().currentType);
  }

  // Whenever mode/format/tool changes (including the very first mount, where `url.preset` may
  // already be populated from a shared/bookmarked link — the actual tileset URL is deliberately NOT
  // persisted, see urlState.ts, so it must be re-derived and reloaded here, not skipped), load the
  // preset the URL already names, or fall back to the first available one.
  useEffect(() => {
    const wanted = url.preset && presets.find((p) => p.id === url.preset && p.url);
    const target = wanted || presets.find((p) => p.url);
    if (target) selectPreset(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url.mode, url.format, url.tool]);

  return (
    <header className="flex flex-col gap-2 border-b bg-background/95 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-1 shrink-0 text-sm font-semibold">3D Tiles</h1>

        <PillGroup tint="bg-blue-500/10">
          {MODE_PILLS.map(([v, l]) => (
            <Pill key={v} active={url.mode === v} onClick={() => setUrl({ mode: v as any })}>{l}</Pill>
          ))}
        </PillGroup>

        {url.mode === 'stream' && (
          <PillGroup tint="bg-amber-500/10">
            {CACHE_PILLS.map(([v, l]) => (
              <Pill key={v} active={url.cache === v} onClick={() => setUrl({ cache: v as any })}>{l}</Pill>
            ))}
            {url.cache === 'none' && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                prefetch
                <Input type="number" min={-1} step={1} value={url.prefetch} onChange={(e) => setUrl({ prefetch: parseInt(e.target.value, 10) || 0 })} className="h-7 w-14" />
              </span>
            )}
            <Select value={url.transform || 'none'} onValueChange={(v) => setUrl({ transform: v === 'none' ? '' : v })}>
              <SelectTrigger size="sm" className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">transform: none</SelectItem>
                <SelectItem value="meshopt">meshopt ↓</SelectItem>
                <SelectItem value="draco">draco ↓ (mesh)</SelectItem>
                <SelectItem value="decompress">decompress ↑</SelectItem>
              </SelectContent>
            </Select>
          </PillGroup>
        )}

        <PillGroup tint="bg-emerald-500/10">
          {url.mode === 'tools' ? (
            TOOL_PILLS.map(([v, l]) => (
              <Pill key={v} active={url.tool === v} onClick={() => setUrl({ tool: v as any, preset: '' })}>{l}</Pill>
            ))
          ) : (
            <>
              {FORMATS.map((f) => (
                <Pill key={f.fmt} active={url.format === f.fmt} onClick={() => setUrl({ format: f.fmt, preset: '' })}>{f.icon} {f.label}</Pill>
              ))}
              {url.mode !== 'offline' &&
                PSEUDO_FORMATS.map(([v, l]) => (
                  <Pill key={v} active={url.format === v} onClick={() => setUrl({ format: v, preset: '' })}>{l}</Pill>
                ))}
              {url.mode === 'stream' && fmtOfSelected?.octree &&
                TILING_PILLS.map(([v, l]) => (
                  <Pill key={v} active={url.tiling === v} onClick={() => setUrl({ tiling: v as any })}>{l}</Pill>
                ))}
              {url.mode === 'stream' && canCentroids(url.format) && (
                <Pill active={url.centroids} onClick={() => setUrl({ centroids: !url.centroids })} title="Render splat centres as glTF POINTS instead of full gaussians">◦ centroids</Pill>
              )}
            </>
          )}
        </PillGroup>

        <PillGroup tint="bg-fuchsia-500/10" className="min-w-0 flex-1">
          {presets.map((p) => (
            <Button
              key={p.id}
              size="sm"
              variant={url.preset === p.id ? 'default' : 'outline'}
              disabled={!p.url}
              onClick={() => selectPreset(p)}
              className={cn('h-7 px-2 text-xs', !p.url && 'opacity-40')}
              title={!p.url ? `${url.format} has no ${url.mode} adapter` : undefined}
            >
              {p.label}
            </Button>
          ))}
        </PillGroup>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" title="ON: field holds the RAW dataset URL — wrapped with the current format+cache+params. OFF: a ready middleware/tileset URL, loaded as-is.">
          <Checkbox checked={rawUrlMode} onCheckedChange={(v) => store.getState().setRawUrlMode(!!v)} />
          raw url
        </Label>
        <Input
          ref={inputRef}
          value={urlField}
          onChange={(e) => store.getState().setUrlField(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleLoadClick(); }}
          placeholder={rawUrlMode ? 'raw dataset URL (e.g. https://host/cloud.copc.laz) — wrapped with current format + cache' : 'http://localhost:3001/…/tileset.json'}
          className="min-w-[240px] flex-1 font-mono text-xs"
        />
        <Button size="sm" onClick={handleLoadClick}>Load</Button>
      </div>
    </header>
  );
}
