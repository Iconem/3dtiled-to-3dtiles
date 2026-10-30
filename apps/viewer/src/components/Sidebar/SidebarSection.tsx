import { useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

// Sections are full-width, separated by a hairline (Sidebar/index.tsx wraps them in divide-y) —
// no per-section card/border/shadow, to keep the panel tight and avoid boxed-in-a-box nesting.
export function SidebarSection({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1.5 px-3 py-2.5', className)}>
      <h3 className="text-[11px] font-normal tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </div>
  );
}

const STORAGE_PREFIX = 'sidebar-open:';
function readOpen(title: string, fallback: boolean): boolean {
  try { const v = localStorage.getItem(STORAGE_PREFIX + title); return v == null ? fallback : v === '1'; } catch { return fallback; }
}

/**
 * A foldable section. Its open state is remembered per title (localStorage), so the panel comes back
 * the way it was left; `defaultOpen` is only the first-visit state. Sections used on every visit
 * (basemap, camera, tileset, material) start open, the occasional ones (crop & extract, local frame)
 * start folded.
 */
export function SidebarCollapsibleSection({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(() => readOpen(title, defaultOpen));
  const onOpenChange = (v: boolean) => { setOpen(v); try { localStorage.setItem(STORAGE_PREFIX + title, v ? '1' : '0'); } catch { /* private mode */ } };
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="px-3 py-2.5">
      <CollapsibleTrigger className="flex w-full items-center justify-between text-[11px] font-normal tracking-wide text-muted-foreground uppercase">
        {title} <ChevronDown className={cn('size-3.5 transition-transform', !open && '-rotate-90')} />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5 flex flex-col gap-1.5">{children}</CollapsibleContent>
    </Collapsible>
  );
}
