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

export function SidebarCollapsibleSection({ title, defaultOpen, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="px-3 py-2.5">
      <CollapsibleTrigger className="flex w-full items-center justify-between text-[11px] font-normal tracking-wide text-muted-foreground uppercase">
        {title} <ChevronDown className="size-3.5" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5 flex flex-col gap-1.5">{children}</CollapsibleContent>
    </Collapsible>
  );
}
