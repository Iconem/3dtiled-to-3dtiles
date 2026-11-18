/**
 * The building blocks this window is made of, on top of the shadcn components (Base UI): a labelled field, a select,
 * a segmented choice, a tooltip, an info popover, a multiple choice with chips, a read-only value with its copy button,
 * the "More options" fold, a card that folds, a job's status line, a chip, and the stepped progress bar.
 *
 * Three text sizes only (index.css): `text-xs` for labels and secondary lines, `text-sm` for everything else,
 * `text-lg` for the window's title. Colour is for status (success, destructive, warning), never for decoration.
 * A sentence of explanation belongs in an `Info` popover or a tooltip (`Tip`, never a bare `title`), not on the page.
 */
import { Progress as ProgressPrimitive } from '@base-ui/react/progress';
import { CheckIcon, ChevronRightIcon, CopyIcon, InfoIcon } from 'lucide-react';
import { useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Combobox, ComboboxChip, ComboboxChips, ComboboxChipsInput, ComboboxContent, ComboboxEmpty, ComboboxItem, ComboboxList } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { Steps } from '../urls';

export const Hint = ({ className, children, ...rest }: React.ComponentProps<'p'>) => (
  <p className={cn('m-0 text-xs font-normal text-muted-foreground', className)} {...rest}>{children}</p>
);

/**
 * A tooltip on the one control it describes: what a `title` attribute would say, shown by the theme instead of the
 * system. Lines are kept (a sample's origin, then its address). No text: the control as it is.
 */
export function Tip({ text, side, children }: { text?: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right'; children: ReactElement }) {
  if (!text) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side} className="max-w-sm break-words whitespace-pre-line">{text}</TooltipContent>
    </Tooltip>
  );
}

/** The small label above a control. */
export const FieldLabel = ({ className, children, ...rest }: React.ComponentProps<'span'>) => (
  <span className={cn('flex items-center gap-1 text-xs leading-none font-medium text-muted-foreground', className)} {...rest}>{children}</span>
);

/** An (i) that opens the explanation a control would otherwise carry as a paragraph. */
export function Info({ id, label = 'What is this?', children, className }: { id?: string; label?: string; children: ReactNode; className?: string }) {
  return (
    <Popover>
      <PopoverTrigger id={id} aria-label={label} onClick={(e) => e.preventDefault()}
        className={cn('inline-grid size-4 flex-none cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none', className)}>
        <InfoIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-2 text-xs leading-relaxed text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">{children}</PopoverContent>
    </Popover>
  );
}

/**
 * A label over its control, taking an equal share of the row. A field is never narrower than its label and a readable
 * value: a row of five selects wraps onto a second line rather than squeezing each to a few characters. `info` is the
 * explanation, behind an (i) next to the label.
 */
export function Field({ label, title, info, compact, children, className }: { label: ReactNode; title?: string; info?: ReactNode; compact?: boolean; children: ReactNode; className?: string }) {
  return (
    <Tip text={title}>
      <div className={cn('flex min-w-0 flex-[1_1_170px] flex-col gap-1.5', compact && 'min-w-24 flex-[0_1_120px]', className)}>
        <FieldLabel>{label}{info && <Info>{info}</Info>}</FieldLabel>
        {children}
      </div>
    </Tip>
  );
}

const inputClass = 'h-9 rounded-md border-input bg-transparent px-3 text-sm shadow-xs placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 dark:bg-transparent';

/** A one-line text input, sized as the window's controls. */
export const TextInput = ({ className, ...rest }: React.ComponentProps<typeof Input>) => (
  <Input type="text" spellCheck={false} className={cn(inputClass, className)} {...rest} />
);

export interface Option { value: string; label: string; disabled?: boolean; title?: string }

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
      <SelectTrigger id={id} aria-description={title} data-value={value} className={cn('w-full', inputClass, 'cursor-pointer overflow-hidden pr-2 text-ellipsis', className)}>
        <SelectValue className="truncate" />
      </SelectTrigger>
      <SelectContent className="text-sm">
        {options.map((o) => (
          <SelectItem key={o.value} value={key(o.value)} disabled={o.disabled}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Two to four exclusive choices, all visible: what a select hides behind a click. Each item is a button with
 * `data-value`, and the group carries the current one.
 */
export function Segmented({ id, value, onChange, options, disabled, className }: {
  id?: string; value: string; onChange: (v: string) => void; options: Option[]; disabled?: boolean; className?: string;
}) {
  return (
    <ToggleGroup id={id} data-value={value} value={[value]} disabled={disabled} spacing={0}
      onValueChange={(v) => { const next = v[v.length - 1]; if (next != null) onChange(String(next)); }}
      className={cn('h-9 rounded-md border border-input p-0.5', className)}>
      {options.map((o) => (
        <Tip key={o.value} text={o.title}>
          <ToggleGroupItem value={o.value} data-value={o.value} disabled={o.disabled}
            className="h-full shrink-0 grow cursor-pointer rounded-sm px-3 text-sm font-medium whitespace-nowrap text-muted-foreground hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground data-pressed:bg-accent data-pressed:text-foreground">
            {o.label}
          </ToggleGroupItem>
        </Tip>
      ))}
    </ToggleGroup>
  );
}

/** A checkbox with its label on one line. */
export function Check({ id, checked, onChange, title, children }: { id?: string; checked: boolean; onChange: (v: boolean) => void; title?: string; children: ReactNode }) {
  const auto = useId();
  const cid = id ?? auto;
  return (
    <Tip text={title}>
      <Label htmlFor={cid} className="inline-flex h-9 cursor-pointer items-center gap-2 text-sm font-normal">
        <Checkbox id={cid} checked={checked} onCheckedChange={(v) => onChange(Boolean(v))} className="size-4 bg-transparent dark:bg-transparent" />
        {children}
      </Label>
    </Tip>
  );
}

/** The fold under a card for what few people change: a summary line with a chevron, and a border above. */
export function Advanced({ id, summary = 'More options', hint, open, onOpenChange, className, children }: {
  id?: string; summary?: ReactNode; hint?: ReactNode; open?: boolean; onOpenChange?: (o: boolean) => void; className?: string; children: ReactNode;
}) {
  return (
    <Collapsible id={id} open={open} onOpenChange={onOpenChange} className={cn('mt-4 border-t border-border pt-3', className)}>
      <CollapsibleTrigger data-fold className="group/fold flex cursor-pointer items-center gap-0 rounded border-0 bg-transparent p-0 text-left text-sm font-medium text-muted-foreground select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none">
        <ChevronRightIcon className="mr-1.5 size-3.5 transition-transform duration-150 group-data-[panel-open]/fold:rotate-90" />
        {summary}{hint && <span className="ml-2 text-xs font-normal">{hint}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

const FOLD_KEY = '3dtiled-desktop-fold-';
/**
 * A card that folds under its title, and remembers on this machine whether it was open. `actions` stay on the title
 * line, to the right, whether it is open or not.
 */
export function FoldCard({ id, title, count, hint, defaultOpen = true, actions, children }: {
  id: string; title: ReactNode; count?: number; hint?: ReactNode; defaultOpen?: boolean; actions?: ReactNode; children: ReactNode;
}) {
  const [open, setOpen] = useState(() => { const v = localStorage.getItem(FOLD_KEY + id); return v == null ? defaultOpen : v === '1'; });
  const change = (o: boolean) => { setOpen(o); localStorage.setItem(FOLD_KEY + id, o ? '1' : '0'); };
  return (
    <Collapsible id={id} open={open} onOpenChange={change} className="mb-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-xs">
      <div className="flex min-h-7 items-center gap-2">
        <CollapsibleTrigger data-fold className="group/fold flex cursor-pointer items-center gap-0 rounded border-0 bg-transparent p-0 text-left text-sm font-medium text-foreground select-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none">
          <ChevronRightIcon className="mr-1.5 size-3.5 text-muted-foreground transition-transform duration-150 group-data-[panel-open]/fold:rotate-90" />
          {title}
          {count != null && count > 0 && <span className="ml-2 text-xs font-normal text-muted-foreground">{count}</span>}
          {hint && <span className="ml-2 text-xs font-normal text-muted-foreground">{hint}</span>}
        </CollapsibleTrigger>
        {actions && <div className="ml-auto flex flex-wrap items-center justify-end gap-1">{actions}</div>}
      </div>
      <CollapsibleContent><div className="pt-2">{children}</div></CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Several values out of a list, shown as chips, kept as one string joined by `sep`: what a tool takes as
 * `--attributes a,b`. A value that is not in the list can be typed (Enter adds it), and a whole list can be pasted.
 *
 * The chips select as the recipients of a mail do: each is one word. A click selects one, Shift+click a run;
 * with the caret at the start of the field, Left and Right step through them and Shift extends the run; Ctrl+A
 * takes them all. Ctrl+C copies the run (the whole list when none is selected) joined as the tool takes it,
 * Ctrl+X cuts it, Backspace or Delete removes it.
 */
export function MultiCombo({ id, value, onChange, choices, sep = ',', placeholder, disabled }: {
  id?: string; value: string; onChange: (v: string) => void; choices: string[]; sep?: string; placeholder?: string; disabled?: boolean;
}) {
  // names may hold a space when the list is joined by commas ("return number")
  const split = (text: string) => (sep === ',' || /[,\n]/.test(text) ? text.split(/[,\n]+/) : text.split(/\s+/)).map((x) => x.trim()).filter(Boolean);
  const selected = split(value);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement | null>(null);
  const highlighted = useRef<string | undefined>(undefined);
  const known = [...new Set([...choices, ...selected])];
  const typed = query.trim();
  const items = typed && !known.some((k) => k.toLowerCase() === typed.toLowerCase()) ? [...known, typed] : known;
  const set = (list: string[]) => { onChange([...new Set(list)].join(sep === ',' ? ',' : sep)); setQuery(''); };
  // the list as one string, as the tool takes it
  const [copied, setCopied] = useState(false);
  // the run of chips selected: from the one it started at to the one the keys or the mouse last reached
  const [run, setRun] = useState<{ from: number; to: number } | null>(null);
  const lo = run ? Math.min(run.from, run.to) : -1, hi = run ? Math.max(run.from, run.to) : -1;
  const inRun = (i: number) => !!run && i >= lo && i <= hi && i < selected.length;
  const picked = run ? selected.filter((_, i) => inRun(i)) : selected;
  const copy = async (list: string[] = selected) => { try { await navigator.clipboard.writeText(list.join(sep === ',' ? ', ' : sep)); } catch { return; } setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const dropRun = () => { set(selected.filter((_, i) => !inRun(i))); setRun(null); };
  function chipKeys(e: React.KeyboardEvent<HTMLInputElement>) {
    const el = e.currentTarget, n = selected.length, mod = e.ctrlKey || e.metaKey, k = e.key;
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
    const mine = () => { e.preventDefault(); (e as unknown as { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.(); };
    if (!n) return;
    if (k === 'ArrowLeft' && (run || atStart)) {
      mine();
      const to = run ? Math.max(0, run.to - 1) : n - 1;
      setRun(e.shiftKey && run ? { from: run.from, to } : { from: to, to });
    } else if (k === 'ArrowRight' && run) {
      mine();
      const to = run.to + 1;
      // past the last chip the caret is back in the field: a run that Shift extends stays, a single one ends
      if (to >= n) { if (!e.shiftKey || run.from >= n - 1 && run.to >= n - 1) setRun(e.shiftKey && run.from < n - 1 ? { from: run.from, to: n - 1 } : null); }
      else setRun(e.shiftKey ? { from: run.from, to } : { from: to, to });
    } else if (k === 'Home' && (run || atStart) && !query) { mine(); setRun(e.shiftKey && run ? { from: run.from, to: 0 } : { from: 0, to: 0 }); }
    else if (k === 'End' && run) { mine(); setRun(e.shiftKey ? { from: run.from, to: n - 1 } : null); }
    else if (mod && k.toLowerCase() === 'a' && !query) { mine(); setRun({ from: 0, to: n - 1 }); }
    else if (mod && k.toLowerCase() === 'c' && (run || !query)) { mine(); void copy(picked); }
    else if (mod && k.toLowerCase() === 'x' && run) { mine(); void copy(picked); dropRun(); }
    else if ((k === 'Backspace' || k === 'Delete') && run) { mine(); dropRun(); }
    else if (k === 'Escape' && run) { mine(); setRun(null); }
    else if (run && !mod && k.length === 1) setRun(null);   // typing goes to the field
  }
  return (
    <Combobox multiple items={items} value={selected} onValueChange={(v) => set(v as string[])} inputValue={query} onInputValueChange={setQuery} open={open} onOpenChange={setOpen}
      onItemHighlighted={(item) => { highlighted.current = item as string | undefined; }} disabled={disabled}>
      <div className="flex items-start gap-2">
      <ComboboxChips ref={anchor} data-value={value} className="min-w-0 flex-1">
        {selected.map((v, i) => (
          <ComboboxChip key={v} aria-label={v} data-chip={v} data-selected={inRun(i) ? 'true' : undefined}
            className={cn('cursor-default select-none', inRun(i) && 'bg-primary text-primary-foreground [&_button]:text-primary-foreground/70')}
            onMouseDown={(e) => {
              if ((e.target as HTMLElement).closest('button')) return;   // the chip's own remove button
              e.preventDefault(); e.stopPropagation();
              setRun(e.shiftKey && run ? { from: run.from, to: i } : { from: i, to: i });
              const field = (e.currentTarget.parentElement as HTMLElement).querySelector('input'); field?.focus(); field?.setSelectionRange(0, 0);
            }}>{v}</ComboboxChip>
        ))}
        <ComboboxChipsInput id={id} placeholder={selected.length ? '' : placeholder} onBlur={() => setRun(null)}
          onPaste={(e) => { const list = split(e.clipboardData.getData('text')); if (list.length > 1) { e.preventDefault(); set([...selected, ...list]); } }}
          onKeyDown={(e) => {
            chipKeys(e);
            if (e.defaultPrevented) return;
            // Escape closes the list; with the list closed it would empty the field, which nobody expects of a form
            if (e.key === 'Escape' && !open) (e as unknown as { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
            if (e.key === 'Enter' && typed && !highlighted.current) { e.preventDefault(); set([...selected, ...split(typed)]); }
          }} />
      </ComboboxChips>
      <Tip text="Copy the list as one string. In the field: Ctrl+C copies it, or the chips selected with Shift+arrows or a click">
        <Button data-copy-list data-copied={copied ? 'true' : 'false'} size="icon" className="size-9 flex-none" disabled={disabled || !selected.length} aria-label="Copy the list" onClick={() => void copy()}>
          {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
        </Button>
      </Tip>
      </div>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>Type a name, then Enter.</ComboboxEmpty>
        <ComboboxList>
          {(item: string) => <ComboboxItem key={item} value={item} data-choice={item}>{known.includes(item) ? item : `Add "${item}"`}</ComboboxItem>}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

export type Kind = 'ok' | 'err' | 'info';
export interface Message { msg: string; kind: Kind }

/** Where a running job says where it is and how it ended. Passing messages are toasts (App's `say`). */
export function Result({ id, message, className }: { id?: string; message: Message | null; className?: string }) {
  const kind = message?.kind ?? 'info';
  if (!message?.msg) return <div id={id} hidden />;
  return (
    <div id={id} role="status" className={cn('mt-3 text-xs break-words', kind === 'ok' && 'text-success', kind === 'err' && 'text-destructive', kind === 'info' && 'text-muted-foreground', className)}>
      {message.msg}
    </div>
  );
}

export const Chip = ({ className, ...rest }: React.ComponentProps<typeof Badge>) => (
  <Badge variant="outline" className={cn('h-5 rounded-full border-border bg-muted px-2 text-xs leading-none font-normal text-muted-foreground', className)} {...rest} />
);

/** A row of flex-wrapping controls under a card. */
export const Actions = ({ className, ...rest }: React.ComponentProps<'div'>) => (
  <div className={cn('mt-3 flex flex-wrap items-center gap-2', className)} {...rest} />
);

/** An input or a code line with its buttons on one row. */
export const UrlBar = ({ className, ...rest }: React.ComponentProps<'div'>) => (
  <div className={cn('flex items-stretch gap-2', className)} {...rest} />
);

/** A command or a path shown whole, wrapped. */
export const Code = ({ className, empty, ...rest }: React.ComponentProps<'code'> & { empty?: boolean }) => (
  <code className={cn('min-w-0 flex-1 rounded-md border border-border bg-muted/50 px-3 py-2 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-foreground', empty && 'text-muted-foreground', className)} {...rest} />
);

/** A copy button that shows a tick for a moment once the text is on the clipboard. */
export function CopyButton({ id, text, label, title, variant, disabled, onCopied, className }: {
  id?: string; text: string; label?: string; title?: string; variant?: 'default' | 'outline' | 'ghost'; disabled?: boolean; onCopied?: () => void; className?: string;
}) {
  const [done, setDone] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(text); } catch { return; }
    setDone(true); onCopied?.();
    setTimeout(() => setDone(false), 1500);
  }
  return (
    <Tip text={title ?? (label ? undefined : 'Copy')}>
      <Button id={id} variant={variant} size={label ? 'default' : 'icon'} disabled={disabled || !text} aria-label={title ?? label ?? 'Copy'} onClick={copy} className={cn(label ? 'gap-2' : 'size-9', className)}>
        {done ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}{label}
      </Button>
    </Tip>
  );
}

/** A value to take away (a URL): one line, selected on click, with its copy button. No scrollbar: the field scrolls with the caret. */
export function CopyField({ id, copyId, value, placeholder, label, onCopied }: { id?: string; copyId?: string; value: string; placeholder?: string; label?: string; onCopied?: () => void }) {
  return (
    <UrlBar>
      {/* a <code> for scripts and screen readers that read the text, shown as a read-only field */}
      <input id={id} readOnly value={value} placeholder={placeholder} spellCheck={false} onFocus={(e) => e.target.select()}
        className="h-9 min-w-0 flex-1 rounded-md border border-input bg-muted/40 px-3 font-mono text-xs text-foreground outline-none placeholder:font-sans placeholder:text-sm placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25" />
      <CopyButton id={copyId} text={value} label={label} variant={label ? 'default' : 'outline'} onCopied={onCopied} />
    </UrlBar>
  );
}

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
    <div id={id} hidden={hidden} className="mt-3 flex gap-1">
      {blocks.map((b, i) => (
        <ProgressPrimitive.Root key={i} value={b.value} className="h-1.5 flex-1">
          <ProgressPrimitive.Track className="h-full overflow-hidden rounded-sm bg-muted">
            <ProgressPrimitive.Indicator className={cn('h-full bg-foreground/70 transition-[width] duration-300 ease-out', b.indeterminate && 'progress-indeterminate')} />
          </ProgressPrimitive.Track>
        </ProgressPrimitive.Root>
      ))}
    </div>
  );
}

/** A tool's or an export's output: the last lines, folded unless it failed. */
export function LogFold({ id, wrapId, label, lines, open, onOpenChange, logRef }: {
  id?: string; wrapId?: string; label: string; lines: string[] | null; open: boolean; onOpenChange: (o: boolean) => void; logRef: React.Ref<HTMLPreElement>;
}) {
  return (
    <details id={wrapId} hidden={lines == null} open={open} onToggle={(e) => onOpenChange((e.target as HTMLDetailsElement).open)} className="mt-2">
      <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">{label}</summary>
      <pre id={id} ref={logRef} className="mt-2 mb-0 max-h-56 overflow-auto rounded-md border border-border bg-muted/50 px-3 py-2 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">{lines?.join('\n')}</pre>
    </details>
  );
}
