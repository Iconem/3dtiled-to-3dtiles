/**
 * Inspector: the focused node's fields. Every edit is a tree commit (so it is undoable), coalesced
 * per field so typing a name is one undo step, not one per letter.
 */
import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { GROUP_BYS, counts, isValidDate, leaves, shownChildren, updateNode, updateNodes, type BNode, type DatasetNode, type DisplayMode, type GroupNode, type KV } from './tree';
import { leafGE } from './export';
import { useBuilder } from './store';
import { actions } from './TreePanel';
import { Dot, fmtRadius } from './Library';

function edit(id: string, patch: Partial<BNode>, field: string) {
  const st = useBuilder.getState();
  st.commit(updateNode(st.tree, id, patch as any), { coalesce: `${id}:${field}` });
}

const MODE_HELP: Record<DisplayMode, string> = {
  all: 'Every child is exported and drawn together (refine ADD). Pieces of one site, or unrelated sites.',
  latest: 'Only the newest dated child is exported — a diachronic series of one site (e.g. Mes Aynak 2010 → 2022). A child group counts with its own date, else its newest descendant’s.',
  first: 'Only the first child is exported — a manual pick among alternatives. Reorder to change it.',
};

export default function Inspector() {
  const tree = useBuilder((s) => s.tree);
  const focus = useBuilder((s) => s.focus);
  const selected = useBuilder((s) => s.selected);
  const node = focus ? tree.nodes[focus] : null;

  return (
    <section className="flex min-h-0 flex-col border-l" data-testid="inspector">
      <div className="border-b p-2">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Inspector</h2>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 text-sm">
        {selected.length > 1 && <MultiSelection ids={selected} />}
        {node ? <NodeFields key={node.id} node={node} /> : <Summary />}
      </div>
    </section>
  );
}

function Summary() {
  const tree = useBuilder((s) => s.tree);
  const c = counts(tree);
  return (
    <div className="space-y-3 text-muted-foreground">
      <p><b className="text-foreground">{tree.nodes[tree.rootId].name}</b> — {c.datasets} datasets in {c.groups - 1} groups.</p>
      <p>Select a node to edit its name, date, notes and metadata. Groups also choose their refine and display mode.</p>
      <ul className="list-disc space-y-1 pl-4 text-xs">
        <li>Drag from the library into any group; drag within the tree to reorder or re-parent.</li>
        <li>Shift / Ctrl-click to multi-select, <b>Ctrl+G</b> to group, <b>F2</b> to rename, <b>Del</b> to delete.</li>
        <li><b>Ctrl+Z</b> / <b>Ctrl+Shift+Z</b> undo and redo. The project autosaves in this browser.</li>
      </ul>
    </div>
  );
}

function MultiSelection({ ids }: { ids: string[] }) {
  const [date, setDate] = useState('');
  const valid = !date || isValidDate(date);
  function apply() {
    const st = useBuilder.getState();
    let t = st.tree;
    for (const id of ids) if (t.nodes[id]) t = updateNode(t, id, { date: date || undefined });
    st.commit(t);
    st.setStatus(`Date ${date || '(cleared)'} set on ${ids.length} nodes.`);
  }
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-2">
      <div className="font-medium">{ids.length} selected</div>
      <div className="flex gap-1">
        <Input value={date} onChange={(e) => setDate(e.target.value.trim())} placeholder="date for all (YYYY[-MM[-DD]])" className={cn('h-7 text-xs', !valid && 'border-destructive')} />
        <Button size="sm" variant="outline" className="h-7" disabled={!valid} onClick={apply}>Set</Button>
      </div>
      <div className="flex gap-1">
        <Button size="sm" variant="outline" className="h-7 flex-1" onClick={actions.groupSelection}>Group</Button>
        <Button size="sm" variant="outline" className="h-7 flex-1 text-destructive" onClick={() => actions.remove()}>Delete</Button>
      </div>
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function NodeFields({ node }: { node: BNode }) {
  const tree = useBuilder((s) => s.tree);
  const isRoot = node.id === tree.rootId;
  // Date: edited locally, committed only when valid (or empty), so a half-typed "2021-0" never lands.
  const [date, setDate] = useState(node.date ?? '');
  useEffect(() => setDate(node.date ?? ''), [node.date]);
  const dateOk = !date || isValidDate(date);

  return (
    <>
      <div className="flex items-center gap-2">
        {node.kind === 'dataset' ? <Dot format={node.format} /> : null}
        <span className="text-xs text-muted-foreground uppercase">{isRoot ? 'Tileset root' : node.kind}</span>
      </div>
      <Field label="Name">
        <Input value={node.name} onChange={(e) => edit(node.id, { name: e.target.value }, 'name')} className="h-8" data-testid="insp-name" />
      </Field>
      <Field label="Date" hint={dateOk ? 'YYYY · YYYY-MM · YYYY-MM-DD · interval start/end' : <span className="text-destructive">Not a date: use YYYY, YYYY-MM, YYYY-MM-DD or start/end</span>}>
        <Input
          value={date}
          placeholder={node.kind === 'group' ? 'optional — else newest child' : 'e.g. 2022-05'}
          onChange={(e) => {
            const v = e.target.value.trim();
            setDate(v);
            if (!v || isValidDate(v)) edit(node.id, { date: v || undefined }, 'date');
          }}
          className={cn('h-8 font-mono', !dateOk && 'border-destructive')}
          data-testid="insp-date"
        />
      </Field>
      <Field label="Notes">
        <Textarea value={node.notes ?? ''} onChange={(e) => edit(node.id, { notes: e.target.value || undefined }, 'notes')} rows={3} className="text-xs" />
      </Field>
      {node.kind === 'group' ? <GroupFields node={node} /> : <DatasetFields node={node} />}
      <KVEditor node={node} />
    </>
  );
}

function GroupFields({ node }: { node: GroupNode }) {
  const tree = useBuilder((s) => s.tree);
  const shown = shownChildren(tree, node);
  const nLeaves = leaves(tree, node.id).length;
  return (
    <>
      <div className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
        {node.children.length} children · {nLeaves} datasets below · <b className="text-foreground">{shown.length}</b> exported
        {shown.length === 1 && node.mode !== 'all' && <> (“{tree.nodes[shown[0]]?.name}”)</>}
      </div>
      <Field label="Display mode" hint={MODE_HELP[node.mode]}>
        <ToggleGroup type="single" variant="outline" size="sm" value={node.mode} data-testid="insp-mode"
          onValueChange={(v) => v && edit(node.id, { mode: v as DisplayMode }, 'mode')}>
          {(['all', 'latest', 'first'] as const).map((m) => <ToggleGroupItem key={m} value={m} className="h-7 px-3 text-xs">{m}</ToggleGroupItem>)}
        </ToggleGroup>
      </Field>
      <Field
        label="Refine"
        hint={node.refine === 'ADD'
          ? 'ADD: children draw in addition to their parent. The usual choice for a mosaic.'
          : 'REPLACE: children replace their parent. A group has no content of its own, so nothing visible is replaced — but Cesium then refines only once every visible child is ready, so siblings appear together.'}
      >
        <ToggleGroup type="single" variant="outline" size="sm" value={node.refine}
          onValueChange={(v) => v && edit(node.id, { refine: v as GroupNode['refine'] }, 'refine')}>
          <ToggleGroupItem value="ADD" className="h-7 px-3 text-xs">ADD</ToggleGroupItem>
          <ToggleGroupItem value="REPLACE" className="h-7 px-3 text-xs">REPLACE</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      <Field label="Group children by">
        <div className="flex gap-1">
          {GROUP_BYS.map((b) => (
            <Button key={b} size="sm" variant="outline" className="h-7 flex-1 px-1 text-xs" onClick={() => actions.groupBy(node.id, b)} data-testid={`insp-group-by-${b}`}>{b}</Button>
          ))}
        </div>
      </Field>
    </>
  );
}

function CopyButton({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <Button size="icon" variant="outline" className="size-8 shrink-0" title="Copy"
      onClick={() => navigator.clipboard?.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); })}>
      {ok ? <Check /> : <Copy />}
    </Button>
  );
}

function DatasetFields({ node }: { node: DatasetNode }) {
  const [ge, setGe] = useState(node.ge != null ? String(node.ge) : '');
  useEffect(() => setGe(node.ge != null ? String(node.ge) : ''), [node.ge]);
  const geOk = !ge || (Number.isFinite(+ge) && +ge > 0);
  return (
    <>
      <Field label="URL" hint="The child URL a renderer loads (point clouds go through /stream).">
        <div className="flex gap-1">
          <Input readOnly value={node.url} className="h-8 font-mono text-[11px]" onFocus={(e) => e.currentTarget.select()} />
          <CopyButton text={node.url} />
          <Button size="icon" variant="outline" className="size-8 shrink-0" title="Open" asChild>
            <a href={node.url} target="_blank" rel="noopener noreferrer"><ExternalLink /></a>
          </Button>
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border bg-muted/30 p-2 font-mono text-[11px]">
        <span className="text-muted-foreground">format</span><span>{node.format}</span>
        <span className="text-muted-foreground">lon</span><span>{node.lon.toFixed(6)}°</span>
        <span className="text-muted-foreground">lat</span><span>{node.lat.toFixed(6)}°</span>
        <span className="text-muted-foreground">height</span><span>{node.height.toFixed(1)} m</span>
        <span className="text-muted-foreground">radius</span><span>{fmtRadius(node.radius)}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Project">
          <Input value={node.project ?? ''} onChange={(e) => edit(node.id, { project: e.target.value || undefined }, 'project')} className="h-8 text-xs" />
        </Field>
        <Field label="Scene">
          <Input value={node.scene ?? ''} onChange={(e) => edit(node.id, { scene: e.target.value || undefined }, 'scene')} className="h-8 text-xs" />
        </Field>
      </div>
      <Field label="Provider" hint="Who the data comes from — exported as the tile's `provider` property.">
        <Input value={node.provider ?? ''} onChange={(e) => edit(node.id, { provider: e.target.value || undefined }, 'provider')} className="h-8 text-xs" data-testid="insp-provider" />
      </Field>
      <Field label="Attribution" hint="The credit line owed to the provider (`attribution`).">
        <Input value={node.attribution ?? ''} onChange={(e) => edit(node.id, { attribution: e.target.value || undefined }, 'attribution')} className="h-8 text-xs" data-testid="insp-attribution" />
      </Field>
      <Field label="Licence">
        <Input value={node.licence ?? ''} onChange={(e) => edit(node.id, { licence: e.target.value || undefined }, 'licence')} className="h-8 text-xs" />
      </Field>
      <Field label="Geometric error override" hint={geOk ? `Unset: max(radius, 1) = ${leafGE({ ...node, ge: null }).toFixed(1)}. Larger loads the dataset from farther away.` : <span className="text-destructive">A positive number, or empty.</span>}>
        <Input
          value={ge}
          inputMode="decimal"
          placeholder={leafGE({ ...node, ge: null }).toFixed(1)}
          onChange={(e) => {
            const v = e.target.value.trim();
            setGe(v);
            if (!v) edit(node.id, { ge: null }, 'ge');
            else if (Number.isFinite(+v) && +v > 0) edit(node.id, { ge: +v }, 'ge');
          }}
          className={cn('h-8 font-mono', !geOk && 'border-destructive')}
        />
      </Field>
    </>
  );
}

function KVEditor({ node }: { node: BNode }) {
  const set = (kv: KV[]) => edit(node.id, { kv }, 'kv');
  return (
    <Field label="Metadata" hint="Custom key / value pairs, exported as STRING properties of the tile's metadata class.">
      <div className="space-y-1" data-testid="insp-kv">
        {node.kv.map((x, i) => (
          <div key={i} className="flex gap-1">
            <Input value={x.key} placeholder="key" className="h-7 w-2/5 font-mono text-xs"
              onChange={(e) => set(node.kv.map((y, j) => (j === i ? { ...y, key: e.target.value } : y)))} />
            <Input value={x.value} placeholder="value" className="h-7 flex-1 text-xs"
              onChange={(e) => set(node.kv.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)))} />
            <Button size="icon" variant="ghost" className="size-7 shrink-0" title="Remove" onClick={() => set(node.kv.filter((_, j) => j !== i))}><X /></Button>
          </div>
        ))}
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => set([...node.kv, { key: '', value: '' }])}><Plus />Add field</Button>
      </div>
    </Field>
  );
}
