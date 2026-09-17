/**
 * Builder state: the document (with undo/redo), the selection, and the rows added by URL.
 *
 * History is a bounded array of whole tree states — cheap because tree ops share every untouched
 * node object. Typing into a field commits on every keystroke, so consecutive commits with the same
 * `coalesce` key within a second replace the last entry instead of piling up one undo per letter.
 */
import { create } from 'zustand';
import { createTree, docOrder, type Row, type Tree } from './tree';
import { fromProject, toProject } from './export';

const HISTORY_MAX = 100;
const COALESCE_MS = 1000;
export const STORAGE_KEY = 'aggregate-builder:project';

export interface UrlError { url: string; error: string }

interface BuilderState {
  tree: Tree;
  past: Tree[];
  future: Tree[];
  lastCommit: { key: string; at: number } | null;
  /** Tree selection (node ids), the shift-click anchor, and the node the inspector shows. */
  selected: string[];
  anchor: string | null;
  focus: string | null;
  renaming: string | null;
  customRows: Row[];
  urlErrors: UrlError[];
  status: string;

  commit: (next: Tree, opts?: { select?: string[]; coalesce?: string; history?: boolean }) => void;
  undo: () => void;
  redo: () => void;
  select: (ids: string[], focus?: string | null) => void;
  setAnchor: (id: string | null) => void;
  setRenaming: (id: string | null) => void;
  addCustomRow: (r: Row) => void;
  setUrlErrors: (e: UrlError[]) => void;
  setStatus: (s: string) => void;
  loadDocument: (tree: Tree, customRows?: Row[]) => void;
}

function initial(): { tree: Tree; customRows: Row[] } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = fromProject(JSON.parse(raw));
      return { tree: p.tree, customRows: (p.customRows ?? []) as Row[] };
    }
  } catch { /* a corrupt autosave must not brick the page — start fresh */ }
  return { tree: createTree(), customRows: [] };
}

/** Selection entries that no longer exist (after undo, delete, import) are dropped. */
const prune = (tree: Tree, ids: string[]) => ids.filter((id) => tree.nodes[id]);

export const useBuilder = create<BuilderState>((set, get) => ({
  ...initial(),
  past: [],
  future: [],
  lastCommit: null,
  selected: [],
  anchor: null,
  focus: null,
  renaming: null,
  urlErrors: [],
  status: '',

  commit: (next, opts = {}) => {
    const s = get();
    if (next === s.tree) return;
    const now = Date.now();
    const coalesce = !!opts.coalesce && s.lastCommit?.key === opts.coalesce && now - s.lastCommit.at < COALESCE_MS;
    const past = opts.history === false || coalesce ? s.past : [...s.past, s.tree].slice(-HISTORY_MAX);
    const selected = opts.select ?? prune(next, s.selected);
    set({
      tree: next, past,
      future: opts.history === false ? s.future : [],
      lastCommit: opts.coalesce ? { key: opts.coalesce, at: now } : null,
      selected,
      focus: opts.select ? (opts.select[opts.select.length - 1] ?? null) : s.focus && next.nodes[s.focus] ? s.focus : null,
    });
  },
  undo: () => {
    const s = get();
    const prev = s.past[s.past.length - 1];
    if (!prev) return;
    set({ tree: prev, past: s.past.slice(0, -1), future: [s.tree, ...s.future], lastCommit: null,
      selected: prune(prev, s.selected), focus: s.focus && prev.nodes[s.focus] ? s.focus : null });
  },
  redo: () => {
    const s = get();
    const next = s.future[0];
    if (!next) return;
    set({ tree: next, past: [...s.past, s.tree], future: s.future.slice(1), lastCommit: null,
      selected: prune(next, s.selected), focus: s.focus && next.nodes[s.focus] ? s.focus : null });
  },
  select: (ids, focus) => set({ selected: ids, focus: focus === undefined ? (ids[ids.length - 1] ?? null) : focus }),
  setAnchor: (anchor) => set({ anchor }),
  setRenaming: (renaming) => set({ renaming }),
  addCustomRow: (r) => set((s) => ({ customRows: [...s.customRows.filter((x) => x.id !== r.id), r] })),
  setUrlErrors: (urlErrors) => set({ urlErrors }),
  setStatus: (status) => set({ status }),
  loadDocument: (tree, customRows) => {
    const s = get();
    set({ tree, past: [...s.past, s.tree].slice(-HISTORY_MAX), future: [], selected: [], focus: null, anchor: null,
      ...(customRows ? { customRows } : {}) });
  },
}));

// Autosave, debounced: a drag or a burst of typing writes once.
let saveTimer: ReturnType<typeof setTimeout> | undefined;
useBuilder.subscribe((s, prev) => {
  if (s.tree === prev.tree && s.customRows === prev.customRows) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(toProject(s.tree, s.customRows))); }
    catch (e) { useBuilder.getState().setStatus(`Autosave failed: ${(e as Error).message}`); }
  }, 400);
});

/**
 * Where "add" puts things: into the focused group, or next to the focused dataset's parent, else root.
 */
export function insertionTarget(tree: Tree, focus: string | null): string {
  if (!focus || !tree.nodes[focus]) return tree.rootId;
  if (tree.nodes[focus].kind === 'group') return focus;
  for (const id of docOrder(tree)) {
    const n = tree.nodes[id];
    if (n.kind === 'group' && n.children.includes(focus)) return id;
  }
  return tree.rootId;
}
