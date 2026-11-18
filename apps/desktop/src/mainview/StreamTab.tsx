/**
 * The tiled dataset (DatasetCard), shared by the Stream live and Export tabs, and the Stream live tab itself: a
 * paste-ready URL. Raw input that is not tiled yet has its own top-level tab (TilerCard), with its own input field.
 */
import { ChevronDownIcon, MapPinIcon, MoreHorizontalIcon, StarIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { AppModel, Renderer } from './App';
import { Card, CardTitle } from './components/Card';
import { cn } from '@/lib/utils';
import { Actions, CopyField, Field, Info, Result, Segmented, TextInput, Tip, UrlBar, type Message } from './components/bits';
import { base, pickDataset, pickerAvailable, readClipboard, viewerUrl } from './host';
import { newId } from './library';
import { guessFormat, nameFor, PLACEMENT, typeOfFormat } from './urls';

/** How many threads the app's server builds tiles on: one setting (next to the dataset, and in Settings), for the tiles it streams and the exports it runs. */
export const WORKERS = [
  { value: 'auto', label: 'Auto, up to 8 threads' },
  { value: '', label: 'One thread' },
  { value: '2', label: '2 worker threads' },
  { value: '4', label: '4 worker threads' },
  { value: '8', label: '8 worker threads' },
];
export const WORKERS_TITLE = 'Decode and encode tiles on worker threads: about 3 to 4 times faster on 8 cores for COPC and Potree, less for splats and meshes. The same tiles, around 50 MB more memory a worker. One setting for the tiles this app streams and the exports it runs; the offline converter uses workers for COPC and Potree only.';
const FORMATS = [
  { value: '', label: 'Detect from the name' }, { value: 'copc', label: 'COPC' }, { value: 'potree', label: 'Potree' },
  { value: 'vpc', label: 'VPC (virtual point cloud)' },
  { value: 'sog', label: 'SOG (streamed)' }, { value: 'lcc', label: 'LCC' }, { value: 'lcc2', label: 'LCC2' }, { value: 'rad', label: 'RAD' },
  { value: 'i3s', label: 'I3S' }, { value: 'threemx', label: '3MX' }, { value: 'osgb', label: 'OSGB' }, { value: 'nexus', label: 'Nexus' }, { value: 'geosplats', label: 'GeoSplats' },
];
/** The thread count as the dataset bar shows it. */
const workersShort = (v: string) => (v === 'auto' ? 'auto' : v === '' ? '1' : v);
/** The format as the dataset bar shows it: its name without the gloss the menu gives. */
const formatLabel = (value: string) => (FORMATS.find((f) => f.value === value)?.label ?? value).replace(/ \(.*\)$/, '');
const MODES = [
  { value: 'none', label: 'Stream', title: 'cache=none: tiles are built when they are asked for, nothing is stored' },
  { value: 'hierarchy', label: 'Index first', title: 'cache=hierarchy: the whole hierarchy is read once and kept in memory, tiles are still built on demand' },
  { value: 'full', label: 'Convert once', title: 'cache=full: the dataset is converted once to the local disk cache, then served from it' },
];
const PLACEMENT_FIELDS: Record<(typeof PLACEMENT)[number], { label: string; placeholder: string }> = {
  lon: { label: 'Longitude', placeholder: '2.2945' },
  lat: { label: 'Latitude', placeholder: '48.8584' },
  alt: { label: 'Altitude (m)', placeholder: '0' },
  heading: { label: 'Heading (°)', placeholder: '0' },
};

// One file dialog, no folder dialog: a dataset that is a folder (Potree, a streamed SOG, an unpacked 3D Tiles tree,
// an OSGB tree) is opened by its entry file (cloud.js, metadata.json, lod-meta.json, tileset.json, metadata.xml),
// and most datasets are a URL anyway, hence Paste first. A folder path can still be typed or pasted.
// A label for the Windows dialog's type list (`label=ext,ext;…`, see pickWindows). Tiled sources only: raw input
// is picked in the "Tile raw input" tab.
const DATASET_FILE_TYPES = 'Tiled datasets=laz,vpc,rad,lcc,lcc2,json,js,xml,osgb,zip,3tz,slpk,nxs,nxz,glb,b3dm';

/** The dataset and its options: one card, shown above both the Stream live and the Export tab. */
export function DatasetCard({ app }: { app: AppModel }) {
  const { form, patchForm, say } = app;
  const guessed = guessFormat(form.src);
  const placed = form.lon.trim() !== '' && form.lat.trim() !== '';
  const saved = app.lib.bookmarks.find((b) => b.src === form.src.trim());

  /**
   * A dataset that arrives whole (pasted, picked) is a new one: the format chosen for the last is not its format.
   * The field is replaced as typing would replace it, so that Ctrl+Z in it gives back what it held.
   */
  function replaceSrc(text: string) {
    const el = document.getElementById('src') as HTMLInputElement | null;
    let typed = false;
    if (el) {
      el.focus(); el.select();
      try { typed = document.execCommand('insertText', false, text); } catch { typed = false; }
    }
    patchForm(typed ? { format: '' } : { src: text, format: '' });
  }

  /** Typed or Ctrl+V: a format chosen for the dataset before is dropped when the new name plainly says another. */
  function typed(src: string) {
    const says = guessFormat(src);
    patchForm(says && form.format && says !== form.format && says !== guessFormat(form.src) ? { src, format: '' } : { src });
  }

  async function browse() {
    try {
      const picked = await pickDataset({ directory: false, allowedFileTypes: DATASET_FILE_TYPES });
      if (picked?.[0]) replaceSrc(picked[0]);      // cancelled: nothing changes
    } catch (e) { say(`File picker failed: ${e}`, 'err'); }
  }

  /** The clipboard's first line becomes the dataset: the host reads it, as a webview asks for a permission first. */
  async function paste() {
    try {
      const text = pickerAvailable() ? await readClipboard() : await navigator.clipboard.readText();
      // Windows "Copy as path" wraps the path in quotes
      const first = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.replace(/^"(.*)"$/, '$1') ?? '';
      if (!first) return say('The clipboard holds no text.', 'err');
      replaceSrc(first);
    } catch (e) { say(`Could not read the clipboard (${e}): paste in the field with Ctrl+V.`, 'err'); }
  }

  /** The star: adds the dataset to the Library, or takes it out when it is there. */
  function bookmark() {
    const f = app.dataset();
    if (!f.src) return say('Enter a dataset first.', 'err');
    if (saved) {
      app.updateLib((l) => { l.bookmarks = l.bookmarks.filter((b) => b.id !== saved.id); });
      return say(`${saved.name} is no longer in the Library.`);
    }
    app.updateLib((l) => { l.bookmarks.push({ id: newId(), name: nameFor(f.src), addedAt: Date.now(), ...f }); });
    say(`${nameFor(f.src)} is in the Library.`, 'ok');
  }

  return (
    <Card id="dataset-card">
      <UrlBar>
        <TextInput id="src" aria-label="Dataset: a URL or a path on this machine" value={form.src} onChange={(e) => typed(e.target.value)} placeholder="Dataset URL or path: https://…/cloud.js, C:\data\scan.copc.laz" className="flex-1" />
        <Tip text="Replace the field with the dataset URL or path in the clipboard. Ctrl+Z in the field gives back what it held"><Button id="paste-src" onClick={paste}>Paste</Button></Tip>
        {/* Outside the Electrobun host (the bundle rendered in a plain browser) the native dialog cannot exist. */}
        {pickerAvailable() && <Tip text="Pick a dataset file: .copc.laz, .rad, .lcc, .3tz, .slpk, .nxs…, or the entry file of a dataset that is a folder (cloud.js, metadata.json, lod-meta.json, tileset.json, metadata.xml)"><Button id="browse-file" onClick={browse}>File…</Button></Tip>}
        <Tip text={saved ? 'In the Library. Click to take it out' : 'Bookmark this dataset in the Library'}>
          <Button id="save" size="icon" className={cn('size-9', saved && 'text-foreground')} data-saved={saved ? 'true' : 'false'} aria-pressed={!!saved} aria-label="Bookmark this dataset" disabled={!form.src.trim()} onClick={bookmark}><StarIcon className={cn('size-4', saved && 'fill-current')} /></Button>
        </Tip>
      </UrlBar>

      <div className="mt-3 flex flex-wrap items-center gap-1">
        <DropdownMenu>
          <Tip text="The format of the dataset. Detected from its name unless you choose one">
            <DropdownMenuTrigger render={<Button id="format" data-value={form.format} variant="ghost" className="gap-1.5 px-2" />}>
              <span className="text-muted-foreground">Format</span>
              <span className="text-foreground">{form.format ? formatLabel(form.format) : guessed ? formatLabel(guessed) : 'auto'}</span>
              <ChevronDownIcon className="size-3.5" />
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent className="min-w-48">
            {/* "auto" stands for the empty format: a menu item needs a value */}
            <DropdownMenuRadioGroup value={form.format || 'auto'} onValueChange={(v) => patchForm({ format: v === 'auto' ? '' : String(v) })}>
              {FORMATS.map((f) => <DropdownMenuRadioItem key={f.value} value={f.value || 'auto'} data-format={f.value || 'auto'} closeOnClick>{f.label}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Tile threads: the server's one setting, for the tiles it streams and the exports it runs (also in Settings). */}
        <DropdownMenu>
          <Tip text={WORKERS_TITLE}>
            <DropdownMenuTrigger render={<Button id="workers" data-value={app.workers} variant="ghost" className="gap-1.5 px-2" />}>
              <span className="text-muted-foreground">Threads</span>
              <span className="text-foreground">{workersShort(app.workers)}</span>
              <ChevronDownIcon className="size-3.5" />
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent className="min-w-48">
            {/* "one" stands for the empty value: a menu item needs one */}
            <DropdownMenuRadioGroup value={app.workers || 'one'} onValueChange={(v) => app.setWorkers(v === 'one' ? '' : String(v))}>
              {WORKERS.map((w) => <DropdownMenuRadioItem key={w.value} value={w.value || 'one'} data-workers={w.value || 'one'} closeOnClick>{w.label}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="flex-1" />
        <Segmented id="cache" value={form.cache} onChange={(v) => patchForm({ cache: v })} options={MODES} className="h-8" />

        <Popover>
          <Tip text="Where the dataset goes on the globe, for one that carries no georeference">
            <PopoverTrigger render={<Button id="place" variant="ghost" className="gap-1.5 px-2" />}>
              <MapPinIcon className="size-3.5" />
              <span className={placed ? 'text-foreground' : undefined}>{placed ? `${form.lon.trim()}, ${form.lat.trim()}` : 'Place on globe'}</span>
            </PopoverTrigger>
          </Tip>
          <PopoverContent id="manual-georef-local-tileset" align="end" className="w-80 gap-3">
            <div className="grid grid-cols-2 gap-3">
              {PLACEMENT.map((k) => (
                <Field key={k} label={PLACEMENT_FIELDS[k].label}>
                  <TextInput id={k} value={form[k]} onChange={(e) => patchForm({ [k]: e.target.value })} placeholder={PLACEMENT_FIELDS[k].placeholder} />
                </Field>
              ))}
            </div>
            <p className="m-0 text-xs text-muted-foreground">Written in the tileset as a root transform, so every client gets it. A dataset with its own georeference ignores these.</p>
            {placed && <Button id="place-clear" size="sm" variant="ghost" className="self-start" onClick={() => patchForm({ lon: '', lat: '', alt: '', heading: '' })}>Clear</Button>}
          </PopoverContent>
        </Popover>
      </div>
    </Card>
  );
}

const RENDERER_KEY = '3dtiled-desktop-renderer';
const RENDERERS = [
  { value: 'cesium', label: 'Cesium', title: 'Stock CesiumJS, with nothing fixed up on the viewer side: what any 3D Tiles client gets' },
  { value: '3dtrjs', label: '3DTRjs', title: 'The demo viewer (3DTilesRendererJS); the page itself needs an internet connection' },
];
/** Preview, in the renderer chosen next to it and remembered. */
export function PreviewControl({ id, primary, disabled, onPreview }: { id: string; primary?: boolean; disabled?: boolean; onPreview: (r: Renderer) => void }) {
  const [renderer, setRenderer] = useState<Renderer>(() => (localStorage.getItem(RENDERER_KEY) === '3dtrjs' ? '3dtrjs' : 'cesium'));
  const choose = (v: string) => { setRenderer(v as Renderer); localStorage.setItem(RENDERER_KEY, v); };
  return (
    <>
      <Button id={id} variant={primary ? 'default' : 'outline'} disabled={disabled} onClick={() => onPreview(renderer)}>Preview</Button>
      <Segmented id={`${id}-renderer`} value={renderer} onChange={choose} options={RENDERERS} className="h-9" />
    </>
  );
}

/** Stream live: a tileset URL converted on demand while this app runs. */
export function StreamTab({ app }: { app: AppModel }) {
  const { form, url } = app;
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<{ url: string; message: Message } | null>(null);

  async function check() {
    setChecking(true);
    setChecked({ url, message: { msg: 'Requesting…', kind: 'info' } });
    const report = (msg: string, kind: Message['kind']) => setChecked({ url, message: { msg, kind } });
    try {
      const t0 = performance.now();
      const r = await fetch(url);
      const ms = Math.round(performance.now() - t0);
      if (!r.ok) return report(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`, 'err');
      const j = await r.json();
      app.noteServedNow();
      const root = j.root ?? {};
      const bv = root.boundingVolume ?? {};
      const kind = bv.region ? 'region' : bv.box ? 'box' : bv.sphere ? 'sphere' : 'none';
      report(`OK in ${ms} ms: 3D Tiles ${j.asset?.version ?? '?'}, geometric error ${Math.round(root.geometricError ?? 0)}, `
        + `bounding ${kind}, ${root.children?.length ?? 0} root children${root.transform ? ', placed by a root transform' : ''}`, 'ok');
    } catch (e) { report(`Request failed: ${e}`, 'err'); }
    finally { setChecking(false); }
  }

  function preview(renderer: Renderer) {
    app.noteServedNow();
    app.previewIn(renderer, url, typeOfFormat(form.format || guessFormat(form.src)), nameFor(form.src.trim()));
  }

  function hierarchy() {
    if (!base) return;
    // Prefer the viewer app's multi-tileset explorer when one is reachable; the server's own page is
    // the always-available single-tileset fallback.
    const target = viewerUrl ? `${viewerUrl}/hierarchy` : `${base}/hierarchy`;
    app.openTool(url ? `${target}?url=${encodeURIComponent(url)}` : target, 'Hierarchy graph');
  }

  return (
    <section>
      <Card id="stream-card">
        <div className="mb-3 flex items-center gap-1.5">
          <CardTitle>Tileset URL</CardTitle>
          <Info label="About this URL">
            <p className="m-0">A 3D Tiles URL for Cesium for Unreal or Unity, QGIS or CesiumJS. The dataset is converted on demand <strong>while this app runs</strong>; nothing is uploaded or written to disk.</p>
            <p className="m-0"><strong>Point cloud in Cesium for Unreal:</strong> set the tileset's <em>Maximum Screen Space Error</em> to 1 or 2 (its default, 16, suits meshes), then turn on <em>Attenuation</em> under <em>Point Cloud Shading</em>, or every point stays 1 px.</p>
          </Info>
        </div>
        <CopyField id="url" copyId="copy" value={url} placeholder="Enter a dataset above" label="Copy URL" onCopied={() => app.noteServedNow()} />
        <Actions>
          <PreviewControl id="preview" disabled={!url} onPreview={preview} />
          <span className="flex-1" />
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button id="stream-more" variant="ghost" className="gap-1.5 px-2" />}><MoreHorizontalIcon className="size-4" />More</DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem id="check" disabled={!url || checking} onClick={check}>Test the endpoint</DropdownMenuItem>
              <DropdownMenuItem id="hierarchy" onClick={hierarchy}>Hierarchy graph</DropdownMenuItem>
              <DropdownMenuItem id="playground" onClick={() => { if (base) app.openTool(`${base}/playground`, 'API playground'); }}>API playground</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </Actions>
        {/* the answer of a test stays while it is this URL's */}
        <Result id="result" message={checked?.url === url ? checked.message : null} />
      </Card>
    </section>
  );
}
