/**
 * The library: bookmarks you keep, and a history of what was served or exported from this app.
 *
 * PERSISTENCE. The file `library.json` in the user's data folder is the source of truth, read and written
 * by the main process (readLibrary, writeLibrary), so it survives an update and can be backed up.
 * `localStorage` is a synchronous copy for the first paint, the only store in a plain browser, and where
 * bookmarks of earlier versions are picked up from. Not shared with the CLI or the web viewer.
 *
 * We store the SOURCE plus the options, never just the built URL, so an entry can be re-opened into
 * the builder and edited — and so a later change to how URLs are built doesn't strand the library.
 * A source can be a share link or a signed URL, so an exported library is as private as those links.
 */

/** What identifies a dataset and how it is served. */
export interface DatasetOptions {
  /** Dataset source: a local path or a remote URL. */
  src: string;
  format: string;
  cache: string;
  lon?: string;
  lat?: string;
  alt?: string;
  heading?: string;
}

export interface LibraryEntry extends DatasetOptions {
  id: string;
  name: string;
  addedAt: number;
  /**
   * Last structural check, from /stats — cached so the list isn't re-walking on every render.
   * `truncated` means the walk hit its node budget, so every number here is a LOWER BOUND; it is
   * stored (and surfaced) because "2 000 tiles, depth 8" otherwise reads as the real shape when it
   * is really just where we stopped counting.
   */
  stats?: { tiles: number; depth: number; leaves: number; truncated: boolean; checkedAt: number };
}

export interface HistoryEntry extends DatasetOptions {
  id: string;
  name: string;
  kind: 'served' | 'exported';
  at: number;
  /** served: how many times its URL was copied, previewed or tested. */
  count?: number;
  /** exported: where to, and how it ended. */
  outDir?: string;
  method?: string;
  state?: 'done' | 'failed' | 'cancelled';
  files?: number;
  bytes?: number;
}

export interface Library {
  bookmarks: LibraryEntry[];
  history: HistoryEntry[];
}

const KEY = '3dtiled-desktop-library-v1';
const HISTORY_MAX = 200;

/** Reads this file's JSON, or a plain array of bookmarks as earlier versions exported. */
export function parseLibrary(json: string, current: Library = { bookmarks: [], history: [] }): Library {
  const parsed = JSON.parse(json);
  const lib = Array.isArray(parsed) ? { bookmarks: parsed, history: current.history } : parsed;
  if (!Array.isArray(lib?.bookmarks)) throw new Error('expected { bookmarks: [...], history: [...] } or an array of bookmarks');
  const history = Array.isArray(lib.history) ? lib.history : current.history;
  const valid = (e: { src?: unknown }) => typeof e?.src === 'string';
  return { bookmarks: lib.bookmarks.filter(valid), history: history.filter(valid) };
}

export function loadLibrary(): Library {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return parseLibrary(raw);
  } catch {
    // A corrupt blob must not brick the app — an empty library is recoverable, a thrown exception
    // during startup is not.
  }
  return { bookmarks: [], history: [] };
}

export function serialize(lib: Library): string {
  return JSON.stringify({ schema: '3dtiled-library/1', ...lib }, null, 2);
}

export function saveLocal(lib: Library): void {
  try { localStorage.setItem(KEY, serialize(lib)); }
  catch { /* quota or disabled storage — the session still works, it just won't persist */ }
}

const sameDataset = (a: DatasetOptions, b: DatasetOptions) =>
  (['src', 'format', 'cache', 'lon', 'lat', 'alt', 'heading'] as const).every((k) => (a[k] || '') === (b[k] || ''));

/** The same dataset served again moves back to the top rather than filling the list. */
export function noteServed(lib: Library, name: string, o: DatasetOptions): void {
  const i = lib.history.findIndex((h) => h.kind === 'served' && sameDataset(h, o));
  const count = i >= 0 ? (lib.history[i].count ?? 1) + 1 : 1;
  if (i >= 0) lib.history.splice(i, 1);
  lib.history.unshift({ ...o, id: newId(), name, kind: 'served', at: Date.now(), count });
  lib.history.length = Math.min(lib.history.length, HISTORY_MAX);
}

export function noteExported(lib: Library, name: string, o: DatasetOptions, out: Pick<HistoryEntry, 'outDir' | 'method' | 'state' | 'files' | 'bytes'>): void {
  lib.history.unshift({ ...o, ...out, id: newId(), name, kind: 'exported', at: Date.now() });
  lib.history.length = Math.min(lib.history.length, HISTORY_MAX);
}

let counter = 0;
/** Ids only need to be unique within this library, and Date.now() alone collides on fast adds. */
export function newId(): string {
  return `e${Date.now().toString(36)}${(counter++).toString(36)}`;
}
