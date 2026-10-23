/**
 * The mosaic's tree: groups and datasets, edited by drag and drop, keyboard and per-row menus.
 *
 * Rows have a fixed height, so the list is windowed like the library: a 660-dataset mosaic mounts
 * only the rows in view. Row props are kept stable (handlers behind a ref, no `tree` prop), so an
 * edit re-renders the rows whose node changed, not all of them.
 *
 * Drop position comes from where the pointer sits in the row: top quarter = before, bottom quarter =
 * after, middle = inside (groups only; datasets split in halves). Validity is checked during
 * dragover, so a forbidden drop (a group into its own descendant) never shows an indicator.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownAZ, CalendarArrowDown, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, Folder, FolderOpen,
  FolderPlus, Group, Layers, MoreHorizontal, Pencil, Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  GROUP_BYS, addGroup, canMove, docOrder, duplicateNode, groupChildrenBy, groupNodes, insertRows, moveNodes, removeNodes, shownChildren,
  sortChildren, updateNode, updateNodes, visibleRows, type BNode, type GroupBy, type GroupNode, type Tree, type VisibleRow,
} from './tree';
import { endDrag, readDrag, startDrag, type DragPayload } from './dnd';
import { useBuilder } from './store';
import { Menu, type MenuItem } from './Menu';
import { Dot } from './Library';

type DropPos = 'before' | 'after' | 'inside';
interface Drop { id: string; pos: DropPos }

const ROW_H = 30;

// ── actions shared by the toolbar, row menus and keyboard ────────────────────────────────────────

export const actions = {
  newGroup(parent?: string) {
    const st = useBuilder.getState();
    const t = st.tree;
    const target = parent ?? (st.focus && t.nodes[st.focus]?.kind === 'group' ? st.focus : t.rootId);
    const { tree, id } = addGroup(expand(t, target), target, undefined, 'New group');
    st.commit(tree, { select: [id] });
    st.setRenaming(id);
  },
  groupSelection() {
    const st = useBuilder.getState();
    if (!st.selected.length) return;
    const { tree, id } = groupNodes(st.tree, st.selected, 'New group');
    if (!id) return;
    st.commit(tree, { select: [id] });
    st.setRenaming(id);
  },
  remove(ids?: string[]) {
    const st = useBuilder.getState();
    const list = (ids ?? st.selected).filter((id) => id !== st.tree.rootId);
    if (!list.length) return;
    st.commit(removeNodes(st.tree, list), { select: [] });
    st.setStatus(`Deleted ${list.length} node${list.length > 1 ? 's' : ''} — Ctrl+Z to undo.`);
  },
  duplicate(id?: string) {
    const st = useBuilder.getState();
    const src = id ?? st.focus;
    if (!src || src === st.tree.rootId) return;
    const { tree, id: nid } = duplicateNode(st.tree, src);
    if (nid) st.commit(tree, { select: [nid] });
  },
  groupBy(groupId: string, by: GroupBy) {
    const st = useBuilder.getState();
    const next = groupChildrenBy(st.tree, groupId, by);
    if (next === st.tree || next.nodes[groupId] === st.tree.nodes[groupId]) { st.setStatus(`Nothing to group by ${by} here.`); return; }
    st.commit(expand(next, groupId));
  },
  sort(groupId: string, by: 'name' | 'date') {
    const st = useBuilder.getState();
    st.commit(sortChildren(st.tree, groupId, by));
  },
  setCollapsed(ids: string[], collapsed: boolean) {
    const st = useBuilder.getState();
    let t = st.tree;
    for (const id of ids) {
      const n = t.nodes[id];
      if (n?.kind === 'group' && !!n.collapsed !== collapsed && id !== t.rootId) t = updateNode<GroupNode>(t, id, { collapsed });
    }
    // Folding is view state: it is saved with the project but is not an undo step.
    st.commit(t, { history: false });
  },
  drop(payload: DragPayload, parent: string, index?: number) {
    const st = useBuilder.getState();
    const t = expand(st.tree, parent);
    if (payload.kind === 'rows') {
      const { tree, ids } = insertRows(t, parent, index, payload.rows);
      st.commit(tree, { select: ids });
      st.setStatus(`Added ${ids.length} dataset${ids.length > 1 ? 's' : ''} to “${tree.nodes[parent].name}”.`);
    } else {
      if (!canMove(t, payload.ids, parent)) return;
      st.commit(moveNodes(t, payload.ids, parent, index), { select: payload.ids });
    }
  },
};

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

function expand(t: Tree, id: string): Tree {
  const n = t.nodes[id];
  return n?.kind === 'group' && n.collapsed ? updateNode<GroupNode>(t, id, { collapsed: false }) : t;
}

export function nodeMenu(t: Tree, n: BNode): MenuItem[] {
  const isRoot = n.id === t.rootId;
  const items: MenuItem[] = [{ label: 'Rename', hint: 'F2', icon: <Pencil />, onSelect: () => useBuilder.getState().setRenaming(n.id) }];
  if (n.kind === 'group') {
    items.push(
      { label: 'New group inside', icon: <FolderPlus />, onSelect: () => actions.newGroup(n.id) },
      { heading: 'Group children by' },
      ...GROUP_BYS.map((b): MenuItem => ({ label: cap(b), icon: <Layers />, onSelect: () => actions.groupBy(n.id, b), testId: `group-by-${b}` })),
      { heading: 'Sort children' },
      { label: 'By name', icon: <ArrowDownAZ />, onSelect: () => actions.sort(n.id, 'name') },
      { label: 'By date', icon: <CalendarArrowDown />, onSelect: () => actions.sort(n.id, 'date') },
    );
  }
  if (!isRoot) {
    items.push(
      { separator: true },
      { label: 'Duplicate', hint: 'Ctrl+D', icon: <Copy />, onSelect: () => actions.duplicate(n.id) },
      { label: 'Delete', hint: 'Del', icon: <Trash2 />, danger: true, onSelect: () => actions.remove(useBuilder.getState().selected.includes(n.id) ? undefined : [n.id]) },
    );
  }
  return items;
}

// ── panel ────────────────────────────────────────────────────────────────────────────────────────

export default function TreePanel() {
  const tree = useBuilder((s) => s.tree);
  const selected = useBuilder((s) => s.selected);
  const focus = useBuilder((s) => s.focus);
  const renaming = useBuilder((s) => s.renaming);
  const rows = useMemo(() => visibleRows(tree), [tree]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const [drop, setDrop] = useState<Drop | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(600);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    setHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the focused row in view when it moves by keyboard (it may not be mounted: scroll by index).
  useEffect(() => {
    const el = listRef.current;
    const i = focus ? rows.findIndex((r) => r.id === focus) : -1;
    if (!el || i < 0) return;
    const top = i * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  function click(e: React.MouseEvent, id: string) {
    const st = useBuilder.getState();
    if (e.shiftKey && st.anchor) {
      const ids = rows.map((r) => r.id);
      const a = ids.indexOf(st.anchor), b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
        st.select(e.ctrlKey || e.metaKey ? [...new Set([...st.selected, ...range])] : range, id);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      st.select(st.selected.includes(id) ? st.selected.filter((x) => x !== id) : [...st.selected, id], id);
    } else {
      st.select([id], id);
    }
    st.setAnchor(id);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const st = useBuilder.getState();
    const idx = rows.findIndex((r) => r.id === st.focus);
    const cur = idx >= 0 ? tree.nodes[rows[idx].id] : null;
    const go = (i: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (!r) return;
      if (e.shiftKey && st.anchor) {
        const ids = rows.map((x) => x.id);
        const a = ids.indexOf(st.anchor), b = ids.indexOf(r.id);
        st.select(ids.slice(Math.min(a, b), Math.max(a, b) + 1), r.id);
      } else { st.select([r.id], r.id); st.setAnchor(r.id); }
    };
    const k = e.key;
    if (k === 'ArrowDown') go(idx + 1);
    else if (k === 'ArrowUp') go(idx - 1);
    else if (k === 'Home') go(0);
    else if (k === 'End') go(rows.length - 1);
    else if (k === 'ArrowRight' && cur?.kind === 'group') {
      if (cur.collapsed) actions.setCollapsed([cur.id], false); else if (cur.children.length) go(idx + 1);
    } else if (k === 'ArrowLeft' && cur) {
      if (cur.kind === 'group' && !cur.collapsed && cur.id !== tree.rootId) actions.setCollapsed([cur.id], true);
      else if (rows[idx].parent) go(rows.findIndex((r) => r.id === rows[idx].parent));
    } else if (k === 'F2' && cur) st.setRenaming(cur.id);
    else if (k === 'Delete' || k === 'Backspace') actions.remove();
    else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'd') actions.duplicate();
    else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'g') actions.groupSelection();
    else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'a') st.select(rows.map((r) => r.id).filter((id) => id !== tree.rootId), st.focus);
    else if (k === 'Escape') st.select([], null);
    else return;
    e.preventDefault();
  }

  const targetOf = (r: VisibleRow, pos: DropPos): { parent: string; index?: number } => {
    const n = tree.nodes[r.id];
    if (pos === 'inside' || !r.parent) return { parent: r.id };
    // "After" an expanded group reads, visually, as "first inside it".
    if (pos === 'after' && n.kind === 'group' && !n.collapsed && n.children.length) return { parent: r.id, index: 0 };
    return { parent: r.parent, index: pos === 'before' ? r.index : r.index + 1 };
  };

  function dragOver(e: React.DragEvent, r: VisibleRow | null) {
    const p = readDrag(e);
    if (!p) return;
    e.stopPropagation();
    let pos: DropPos = 'inside';
    if (r && r.parent) {
      const box = e.currentTarget.getBoundingClientRect();
      const f = (e.clientY - box.top) / box.height;
      pos = tree.nodes[r.id].kind === 'group' ? (f < 0.25 ? 'before' : f > 0.75 ? 'after' : 'inside') : f < 0.5 ? 'before' : 'after';
    }
    const target = r ? targetOf(r, pos) : { parent: tree.rootId };
    if (p.kind === 'nodes' && !canMove(tree, p.ids, target.parent)) { setDrop(null); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = p.kind === 'rows' ? 'copy' : 'move';
    const id = r?.id ?? tree.rootId;
    if (drop?.id !== id || drop.pos !== pos) setDrop({ id, pos });
  }

  function onDrop(e: React.DragEvent, r: VisibleRow | null) {
    const p = readDrag(e);
    setDrop(null);
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    const pos = r && drop?.id === r.id ? drop.pos : 'inside';
    const target = r ? targetOf(r, pos) : { parent: tree.rootId };
    actions.drop(p, target.parent, target.index);
    endDrag();
  }

  // Rows get stable handlers that call the latest closures, so memo(TreeRow) holds across renders.
  const handlers = useRef({ click, dragOver, onDrop });
  handlers.current = { click, dragOver, onDrop };
  const stable = useMemo(() => ({
    click: (e: React.MouseEvent, id: string) => handlers.current.click(e, id),
    dragOver: (e: React.DragEvent, r: VisibleRow) => handlers.current.dragOver(e, r),
    drop: (e: React.DragEvent, r: VisibleRow) => handlers.current.onDrop(e, r),
  }), []);

  const first = Math.max(0, Math.floor(scroll / ROW_H) - 8);
  const last = Math.min(rows.length, Math.ceil((scroll + height) / ROW_H) + 8);

  const focusedGroup = focus && tree.nodes[focus]?.kind === 'group' ? focus : tree.rootId;
  const groupIds = useMemo(() => docOrder(tree).filter((id) => tree.nodes[id].kind === 'group' && id !== tree.rootId), [tree]);

  return (
    <section className="flex min-h-0 flex-col" data-testid="tree">
      <div className="flex flex-wrap items-center gap-1 border-b p-2">
        <h2 className="mr-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Tree</h2>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => actions.newGroup()} data-testid="new-group"><FolderPlus />New group</Button>
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!selected.some((id) => id !== tree.rootId)} onClick={actions.groupSelection}
          title="Wrap the selection in a new group (Ctrl+G)" data-testid="group-selection"><Group />Group selection</Button>
        <Menu
          className="h-7 border px-2 text-xs hover:bg-accent"
          trigger={<><Layers className="size-3.5" />Group by…</>}
          title={`Group the direct children of “${tree.nodes[focusedGroup].name}”`}
          testId="toolbar-group-by"
          items={[
            { heading: `Children of “${tree.nodes[focusedGroup].name}”` },
            ...GROUP_BYS.map((b): MenuItem => ({ label: cap(b), onSelect: () => actions.groupBy(focusedGroup, b), testId: `toolbar-group-by-${b}` })),
          ]}
        />
        <div className="ml-auto flex gap-0.5">
          <Button size="icon" variant="ghost" className="size-7" title="Expand all" onClick={() => actions.setCollapsed(groupIds, false)}><ChevronsUpDown /></Button>
          <Button size="icon" variant="ghost" className="size-7" title="Collapse all" onClick={() => actions.setCollapsed(groupIds, true)}><ChevronsDownUp /></Button>
          <Button size="icon" variant="ghost" className="size-7" title="Delete selection (Del)" disabled={!selected.some((id) => id !== tree.rootId)} onClick={() => actions.remove()}><Trash2 /></Button>
        </div>
      </div>
      <div
        ref={listRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onDragOver={(e) => dragOver(e, null)}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null); }}
        onDrop={(e) => onDrop(e, null)}
        onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
        className="relative min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-1 focus-visible:ring-ring/60"
        data-testid="tree-list"
      >
        <div style={{ height: rows.length * ROW_H + 4 }} />
        {rows.slice(first, last).map((r, k) => {
          const node = tree.nodes[r.id];
          return (
            <TreeRow
              key={r.id}
              top={(first + k) * ROW_H + 2}
              depth={r.depth}
              parent={r.parent}
              index={r.index}
              node={node}
              isRoot={r.id === tree.rootId}
              shown={node.kind === 'group' ? shownChildren(tree, node).length : 0}
              selected={selectedSet.has(r.id)}
              focused={focus === r.id}
              renaming={renaming === r.id}
              drop={drop?.id === r.id ? drop.pos : null}
              onClick={stable.click}
              onDragOver={stable.dragOver}
              onDrop={stable.drop}
            />
          );
        })}
        {rows.length === 1 && (
          <div className="mx-4 mt-6 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            Drag datasets here from the library — or select them and press <b>Add</b>.
            <div className="mt-1 text-xs">Groups: <b>New group</b>, or select nodes and <b>Group selection</b> (Ctrl+G).</div>
          </div>
        )}
      </div>
    </section>
  );
}

const TreeRow = memo(function TreeRow({ top, depth, parent, index, node, isRoot, shown, selected, focused, renaming, drop, onClick, onDragOver, onDrop }: {
  top: number;
  /** VisibleRow's fields as primitives: visibleRows() makes new objects on every edit. */
  depth: number;
  parent: string | null;
  index: number;
  node: BNode;
  isRoot: boolean;
  /** Children the export keeps (groups only). */
  shown: number;
  selected: boolean;
  focused: boolean;
  renaming: boolean;
  drop: DropPos | null;
  onClick: (e: React.MouseEvent, id: string) => void;
  onDragOver: (e: React.DragEvent, r: VisibleRow) => void;
  onDrop: (e: React.DragEvent, r: VisibleRow) => void;
}) {
  const isGroup = node.kind === 'group';
  return (
    <div
      data-node={node.id}
      data-testid="tree-row"
      draggable={!isRoot && !renaming}
      onDragStart={(e) => {
        const st = useBuilder.getState();
        const ids = st.selected.includes(node.id) ? st.selected.filter((id) => id !== st.tree.rootId) : [node.id];
        startDrag(e, { kind: 'nodes', ids });
      }}
      onDragEnd={endDrag}
      onDragOver={(e) => onDragOver(e, { id: node.id, depth, parent, index })}
      onDrop={(e) => onDrop(e, { id: node.id, depth, parent, index })}
      onClick={(e) => onClick(e, node.id)}
      onDoubleClick={() => useBuilder.getState().setRenaming(node.id)}
      style={{ top, paddingLeft: 6 + depth * 16, height: ROW_H }}
      className={cn(
        'group absolute inset-x-0 flex cursor-default items-center gap-1.5 pr-1 text-sm select-none',
        selected ? 'bg-sky-500/20' : 'hover:bg-accent/50',
        focused && 'shadow-[inset_2px_0_0_0_rgb(56_189_248)]',
        drop === 'inside' && 'bg-sky-500/30 ring-1 ring-sky-400 ring-inset',
      )}
    >
      {drop === 'before' && <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-sky-400" style={{ left: 6 + depth * 16 }} />}
      {drop === 'after' && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-sky-400" style={{ left: 6 + depth * 16 }} />}
      {isGroup ? (
        <button type="button" className="flex size-4 items-center justify-center text-muted-foreground" disabled={isRoot}
          onClick={(e) => { e.stopPropagation(); actions.setCollapsed([node.id], !node.collapsed); }}>
          {isRoot ? null : node.collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>
      ) : <span className="size-4" />}
      {isGroup
        ? (node.collapsed ? <Folder className="size-4 shrink-0 text-amber-300/80" /> : <FolderOpen className="size-4 shrink-0 text-amber-300/80" />)
        : <Dot format={node.format} className="mx-1" />}
      {renaming ? <RenameInput node={node} /> : (
        <span className={cn('min-w-0 flex-1 truncate', isRoot && 'font-semibold')} title={node.kind === 'dataset' ? node.url : undefined}>{node.name}</span>
      )}
      {node.date && <Badge variant="outline" className="h-5 px-1 text-[10px] font-normal text-muted-foreground">{node.date.replace('/', '→')}</Badge>}
      {isGroup && node.mode !== 'all' && <Badge variant="secondary" className="h-5 px-1 text-[10px]" title="Display mode: what the export keeps">{node.mode}</Badge>}
      {isGroup && node.refine === 'REPLACE' && <Badge variant="secondary" className="h-5 px-1 text-[10px]">REPLACE</Badge>}
      {node.kind === 'dataset' && node.ge != null && <Badge variant="secondary" className="h-5 px-1 text-[10px]" title="Geometric-error override">GE {node.ge}</Badge>}
      {isGroup && (
        <span className="w-10 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums" title={`${node.children.length} children, ${shown} exported`}>
          {shown !== node.children.length ? `${shown}/${node.children.length}` : node.children.length}
        </span>
      )}
      <Menu
        className="invisible size-6 justify-center text-muted-foreground group-hover:visible hover:bg-accent hover:text-foreground"
        trigger={<MoreHorizontal className="size-4" />}
        title="Actions"
        testId="row-menu"
        items={() => nodeMenu(useBuilder.getState().tree, node)}
      />
    </div>
  );
});

function RenameInput({ node }: { node: BNode }) {
  const [value, setValue] = useState(node.name);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const st = useBuilder.getState();
    st.setRenaming(null);
    if (save && value.trim() && value.trim() !== node.name) st.commit(updateNode(st.tree, node.id, { name: value.trim() }));
    // Give the keyboard back to the tree so F2 → type → Enter → arrows keeps flowing.
    requestAnimationFrame(() => (document.querySelector('[data-testid="tree-list"]') as HTMLElement | null)?.focus());
  };
  return (
    <input
      autoFocus
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
      data-testid="rename-input"
      className="h-6 min-w-0 flex-1 rounded border bg-background px-1 text-sm outline-none focus:ring-1 focus:ring-ring"
    />
  );
}
