/**
 * A small dropdown menu. The app has no Radix dropdown package, and adding one for a list of buttons
 * is not worth a dependency. Rendered in a portal with fixed positioning so it escapes the tree
 * panel's scroll container instead of being clipped by it.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

export type MenuItem =
  | { label: string; onSelect: () => void; icon?: React.ReactNode; disabled?: boolean; hint?: string; danger?: boolean; testId?: string }
  | { separator: true }
  | { heading: string };

export function Menu({ trigger, items: itemsProp, className, title, testId }: {
  trigger: React.ReactNode;
  /** A function is only called when the menu opens: a row menu costs nothing until it is used. */
  items: MenuItem[] | (() => MenuItem[]);
  className?: string;
  title?: string;
  testId?: string;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pos) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.target instanceof Node && (menu.current?.contains(e.target) || btn.current?.contains(e.target))) return;
      setPos(null);
    };
    addEventListener('pointerdown', close, true);
    addEventListener('keydown', close, true);
    addEventListener('blur', close);
    return () => {
      removeEventListener('pointerdown', close, true);
      removeEventListener('keydown', close, true);
      removeEventListener('blur', close);
    };
  }, [pos]);

  // Keep the menu on screen: flip above / shift left once its real size is known.
  useLayoutEffect(() => {
    const el = menu.current;
    if (!pos || !el) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(4, Math.min(pos.x, innerWidth - r.width - 4));
    const y = r.bottom > innerHeight - 4 ? Math.max(4, pos.y - r.height - (btn.current?.offsetHeight ?? 0) - 4) : pos.y;
    if (x !== pos.x || y !== pos.y) setPos({ x, y });
  }, [pos]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        title={title}
        data-testid={testId}
        className={cn('inline-flex items-center gap-1 rounded-md', className)}
        onClick={(e) => {
          e.stopPropagation();
          if (pos) { setPos(null); return; }
          const r = e.currentTarget.getBoundingClientRect();
          setPos({ x: r.right - 200, y: r.bottom + 4 });
        }}
      >
        {trigger}
      </button>
      {pos && (() => { const items = typeof itemsProp === 'function' ? itemsProp() : itemsProp; return createPortal(
        <div
          ref={menu}
          role="menu"
          style={{ left: pos.x, top: pos.y }}
          className="fixed z-50 min-w-[200px] rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
        >
          {items.map((it, i) =>
            'separator' in it ? <div key={i} className="my-1 h-px bg-border" />
            : 'heading' in it ? <div key={i} className="px-2 pt-1.5 pb-0.5 text-[11px] font-medium text-muted-foreground">{it.heading}</div>
            : (
              <button
                key={i}
                type="button"
                role="menuitem"
                data-testid={it.testId}
                disabled={it.disabled}
                onClick={(e) => { e.stopPropagation(); setPos(null); it.onSelect(); }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0',
                  it.danger && 'text-destructive',
                )}
              >
                {it.icon}
                <span className="flex-1">{it.label}</span>
                {it.hint && <span className="text-xs text-muted-foreground">{it.hint}</span>}
              </button>
            ))}
        </div>,
        document.body,
      ); })()}
    </>
  );
}
