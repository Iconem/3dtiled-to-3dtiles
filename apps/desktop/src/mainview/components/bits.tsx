/**
 * The small building blocks this window is made of, on top of the shadcn components: a labelled
 * field, a hint, a select with its options, the "Advanced" fold, a status line, a chip, and the
 * stepped progress bar of an export.
 */
import { Progress as ProgressPrimitive } from '@base-ui/react/progress';
import { ChevronRightIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { Steps } from '../urls';

export const Hint = ({ className, children, ...rest }: React.ComponentProps<'p'>) => (
  <p className={cn('m-0 text-xs font-normal text-muted-foreground', className)} {...rest}>{children}</p>
);

/** The small label above a control, or a card's title line. */
export const FieldLabel = ({ className, children, ...rest }: React.ComponentProps<'span'>) => (
  <span className={cn('block text-xs leading-none font-medium text-muted-foreground', className)} {...rest}>{children}</span>
);

/**
 * A label over its control, taking an equal share of the row. A field is never narrower than its label and a readable
 * value: a row of five selects wraps onto a second line rather than squeezing each to a few characters.
 */
export function Field({ label, title, compact, children, className }: { label: ReactNode; title?: string; compact?: boolean; children: ReactNode; className?: string }) {
  return (
    <label className={cn('flex min-w-[170px] flex-[1_1_170px] flex-col gap-1.5', compact && 'min-w-[90px] flex-[0_1_120px]', className)} title={title}>
      <FieldLabel>{label}</FieldLabel>
      {children}
    </label>
  );
}

const inputClass = 'h-9 rounded-md border-input bg-transparent px-[11px] text-[13px] shadow-xs placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 dark:bg-transparent';

/** A one-line text input, sized as the window's controls. */
export const TextInput = ({ className, ...rest }: React.ComponentProps<typeof Input>) => (
  <Input type="text" spellCheck={false} className={cn(inputClass, className)} {...rest} />
);

export interface Option { value: string; label: string; disabled?: boolean }

/**
 * A select with its options. The value is a string, the empty string included (the format's
 * "auto-detect"), so the choice is mapped onto a non-empty key for Base UI, which reserves null.
 */
export function Choice({ id, value, onChange, options, disabled, title, className }: {
  id?: string; value: string; onChange: (v: string) => void; options: Option[]; disabled?: boolean; title?: string; className?: string;
}) {
  const key = (v: string) => (v === '' ? '\0' : v);
  const items = options.map((o) => ({ value: key(o.value), label: o.label }));
  return (
    <Select value={key(value)} onValueChange={(v) => onChange(v === '\0' ? '' : String(v))} items={items} disabled={disabled}>
      <SelectTrigger id={id} title={title} data-value={value} className={cn('w-full', inputClass, 'cursor-pointer overflow-hidden pr-[9px] text-ellipsis', className)}>
        <SelectValue className="truncate" />
      </SelectTrigger>
      <SelectContent className="text-[13px]">
        {options.map((o) => (
          <SelectItem key={o.value} value={key(o.value)} disabled={o.disabled}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A checkbox with its label on one line. */
export function Check({ id, checked, onChange, title, children }: { id?: string; checked: boolean; onChange: (v: boolean) => void; title?: string; children: ReactNode }) {
  const auto = useId();
  const cid = id ?? auto;
  return (
    <Label htmlFor={cid} title={title} className="inline-flex cursor-pointer items-center gap-1.5 text-[12.5px] font-normal">
      <Checkbox id={cid} checked={checked} onCheckedChange={(v) => onChange(Boolean(v))} className="size-3.5 rounded-[3px] bg-transparent dark:bg-transparent" />
      {children}
    </Label>
  );
}

/** The "Advanced" fold under a card: a summary line with a chevron, and a border above. */
export function Advanced({ summary, hint, open, onOpenChange, className, children }: {
  summary: ReactNode; hint?: ReactNode; open?: boolean; onOpenChange?: (o: boolean) => void; className?: string; children: ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className={cn('mt-4 border-t border-border pt-3.5', className)}>
      <CollapsibleTrigger className="group/fold flex cursor-pointer items-center gap-0 rounded border-0 bg-transparent p-0 text-left text-[13px] font-medium text-foreground select-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none">
        <ChevronRightIcon className="mr-1.5 size-3.5 text-muted-foreground transition-transform duration-150 group-data-[panel-open]/fold:rotate-90" />
        {summary}{hint && <> <span className="ml-1 text-xs font-normal text-muted-foreground">{hint}</span></>}
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

export type Kind = 'ok' | 'err' | 'info';
export interface Message { msg: string; kind: Kind }

/** The status line under a card's actions. */
export function Result({ id, message, className }: { id?: string; message: Message | null; className?: string }) {
  const kind = message?.kind ?? 'info';
  return (
    <div id={id} className={cn('mt-3 min-h-[18px] text-[12.5px] break-words', kind === 'ok' && 'text-success', kind === 'err' && 'text-destructive', kind === 'info' && 'text-muted-foreground', className)}>
      {message?.msg}
    </div>
  );
}

export const Chip = ({ className, ...rest }: React.ComponentProps<typeof Badge>) => (
  <Badge variant="outline" className={cn('h-auto rounded-full border-border bg-muted px-[7px] py-[3px] text-[10.5px] leading-none font-medium text-muted-foreground', className)} {...rest} />
);

/** A row of flex-wrapping controls under a card. */
export const Actions = ({ className, ...rest }: React.ComponentProps<'div'>) => (
  <div className={cn('mt-3 flex flex-wrap gap-2', className)} {...rest} />
);

/** An input or a code line with its buttons on one row. */
export const UrlBar = ({ className, ...rest }: React.ComponentProps<'div'>) => (
  <div className={cn('flex items-stretch gap-2', className)} {...rest} />
);

export const Code = ({ className, empty, wrap, ...rest }: React.ComponentProps<'code'> & { empty?: boolean; wrap?: boolean }) => (
  <code
    className={cn('min-w-0 flex-1 rounded-md border border-border bg-muted/50 px-[11px] py-[9px] font-mono text-xs leading-[1.4] text-foreground',
      wrap ? 'h-auto overflow-visible text-[11.5px] leading-normal break-all whitespace-pre-wrap' : 'overflow-x-auto whitespace-nowrap',
      empty && 'text-muted-foreground', className)}
    {...rest}
  />
);

/**
 * The bar, one block per step of the run: those before are full, the current one shows its share, or runs
 * indeterminate while its total is unknown. No step given means finished: all full.
 */
export function StepProgress({ id, steps, hidden }: { id?: string; steps: Steps; hidden?: boolean }) {
  const blocks = Array.from({ length: Math.max(1, steps.steps) }, (_, i) => {
    const current = steps.step != null && i === steps.step - 1;
    const known = steps.total != null && steps.total > 0;
    const value = steps.step == null || i < steps.step - 1 ? 100 : current ? (known ? Math.round((100 * (steps.done ?? 0)) / steps.total!) : null) : 0;
    return { indeterminate: current && !known, value };
  });
  return (
    <div id={id} hidden={hidden} className="my-3 mb-1 flex gap-1">
      {blocks.map((b, i) => (
        <ProgressPrimitive.Root key={i} value={b.value} className="h-1.5 flex-1">
          <ProgressPrimitive.Track className="h-full overflow-hidden rounded-[3px] bg-muted">
            <ProgressPrimitive.Indicator className={cn('h-full bg-bar transition-[width] duration-300 ease-out', b.indeterminate && 'progress-indeterminate')} />
          </ProgressPrimitive.Track>
        </ProgressPrimitive.Root>
      ))}
    </div>
  );
}
