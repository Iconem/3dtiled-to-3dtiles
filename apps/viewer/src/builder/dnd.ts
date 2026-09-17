/**
 * Native HTML5 drag and drop between the library and the tree.
 *
 * The payload is kept in a module variable, not only in the DataTransfer: browsers hide
 * `getData()` during `dragover` (only the types are readable), and dragover is exactly where the
 * tree has to decide whether a drop is allowed — a group cannot go into its own descendant. The
 * custom MIME type is still set, so drags that did not start here (files, links) are ignored.
 */
import type { Row } from './tree';

export type DragPayload = { kind: 'rows'; rows: Row[] } | { kind: 'nodes'; ids: string[] };

export const DRAG_MIME = 'application/x-aggregate-builder';
let current: DragPayload | null = null;

export function startDrag(e: React.DragEvent, payload: DragPayload) {
  current = payload;
  e.dataTransfer.setData(DRAG_MIME, payload.kind);
  // Something useful when dropped outside the page (a text editor, the viewer's URL field).
  e.dataTransfer.setData('text/plain', payload.kind === 'rows' ? payload.rows.map((r) => r.url).join('\n') : '');
  e.dataTransfer.effectAllowed = payload.kind === 'rows' ? 'copy' : 'move';
  const n = payload.kind === 'rows' ? payload.rows.length : payload.ids.length;
  if (n > 1) {
    // A count badge as the drag image, so a 40-row drag doesn't look like a single row.
    const ghost = document.createElement('div');
    ghost.textContent = `${n} ${payload.kind === 'rows' ? 'datasets' : 'nodes'}`;
    ghost.style.cssText = 'position:fixed;top:-100px;padding:4px 8px;border-radius:6px;background:#38bdf8;color:#0b1220;font:600 12px system-ui';
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 10, 10);
    setTimeout(() => ghost.remove(), 0);
  }
}

export function readDrag(e: React.DragEvent): DragPayload | null {
  return e.dataTransfer.types.includes(DRAG_MIME) ? current : null;
}

export function endDrag() {
  current = null;
}
