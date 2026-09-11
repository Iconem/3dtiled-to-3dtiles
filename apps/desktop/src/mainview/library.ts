/**
 * The tracked-tileset library.
 *
 * PERSISTENCE. Entries live in the webview's `localStorage`, not in a file the main process owns.
 * That is a deliberate limitation, not an oversight: localStorage is durable per app install and
 * needs no RPC round-trip, no file-permission prompt and no schema migration story — right for a
 * list of bookmarks. It is also therefore NOT shared with the CLI or the web viewer, and it does not
 * survive clearing the app's webview data. If the library ever needs to be shared or exported, it
 * should move to a JSON file under the app's data dir via the main process; `serialize()` /
 * `replaceAll()` below exist so that migration is a small change rather than a rewrite.
 *
 * We store the SOURCE plus the options, never just the built URL, so an entry can be re-opened into
 * the builder and edited — and so a later change to how URLs are built doesn't strand the library.
 */

export interface LibraryEntry {
  id: string;
  name: string;
  /** Dataset source: a local path or a remote URL. */
  src: string;
  format: string;
  cache: string;
  lon?: string;
  lat?: string;
  alt?: string;
  heading?: string;
  addedAt: number;
  /**
   * Last structural check, from /stats — cached so the list isn't re-walking on every render.
   * `truncated` means the walk hit its node budget, so every number here is a LOWER BOUND; it is
   * stored (and surfaced) because "2 000 tiles, depth 8" otherwise reads as the real shape when it
   * is really just where we stopped counting.
   */
  stats?: { tiles: number; depth: number; leaves: number; truncated: boolean; checkedAt: number };
}

const KEY = '3dtiled-desktop-library-v1';

export function loadLibrary(): LibraryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A corrupt blob must not brick the app — an empty library is recoverable, a thrown exception
    // during startup is not.
    return [];
  }
}

export function saveLibrary(entries: LibraryEntry[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(entries)); }
  catch { /* quota or disabled storage — the session still works, it just won't persist */ }
}

export function serialize(entries: LibraryEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

export function replaceAll(json: string): LibraryEntry[] {
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('expected a JSON array of entries');
  return parsed;
}

let counter = 0;
/** Ids only need to be unique within this library, and Date.now() alone collides on fast adds. */
export function newId(): string {
  return `e${Date.now().toString(36)}${(counter++).toString(36)}`;
}
