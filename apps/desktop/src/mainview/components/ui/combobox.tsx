"use client"

// shadcn's base-nova combobox, without its input-group dependency: the parts this window uses (a trigger with the
// search field inside the popup, groups, and chips for a multiple choice).
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"

const Combobox = ComboboxPrimitive.Root

function ComboboxValue({ ...props }: ComboboxPrimitive.Value.Props) {
  return <ComboboxPrimitive.Value data-slot="combobox-value" {...props} />
}

function ComboboxTrigger({ className, children, ...props }: ComboboxPrimitive.Trigger.Props) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      className={cn(
        "flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-left text-sm shadow-xs outline-none select-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-default disabled:opacity-50",
        className
      )}
      {...props}
    >
      {children}
      <ChevronDownIcon className="pointer-events-none size-4 flex-none text-muted-foreground" />
    </ComboboxPrimitive.Trigger>
  )
}

function ComboboxContent({
  className,
  side = "bottom",
  sideOffset = 6,
  align = "start",
  alignOffset = 0,
  anchor,
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<ComboboxPrimitive.Positioner.Props, "side" | "align" | "sideOffset" | "alignOffset" | "anchor">) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner side={side} sideOffset={sideOffset} align={align} alignOffset={alignOffset} anchor={anchor} className="isolate z-50">
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            "group/combobox-content relative max-h-(--available-height) w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  )
}

/** The search field at the top of the popup. */
function ComboboxSearch({ className, ...props }: ComboboxPrimitive.Input.Props) {
  return (
    <ComboboxPrimitive.Input
      data-slot="combobox-search"
      className={cn("h-9 w-full border-0 border-b border-border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground/70", className)}
      {...props}
    />
  )
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn("max-h-72 scroll-py-1 overflow-y-auto overscroll-contain p-1 data-empty:p-0", className)}
      {...props}
    />
  )
}

function ComboboxItem({ className, children, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      {children}
      <ComboboxPrimitive.ItemIndicator render={<span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />}>
        <CheckIcon className="pointer-events-none size-4" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  )
}

function ComboboxGroup({ className, ...props }: ComboboxPrimitive.Group.Props) {
  return <ComboboxPrimitive.Group data-slot="combobox-group" className={cn(className)} {...props} />
}

function ComboboxLabel({ className, ...props }: ComboboxPrimitive.GroupLabel.Props) {
  return <ComboboxPrimitive.GroupLabel data-slot="combobox-label" className={cn("px-2 py-1.5 text-xs text-muted-foreground", className)} {...props} />
}

function ComboboxCollection({ ...props }: ComboboxPrimitive.Collection.Props) {
  return <ComboboxPrimitive.Collection data-slot="combobox-collection" {...props} />
}

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return <ComboboxPrimitive.Empty data-slot="combobox-empty" className={cn("px-3 py-2 text-sm text-muted-foreground empty:hidden", className)} {...props} />
}

function ComboboxChips({ className, ...props }: ComboboxPrimitive.Chips.Props) {
  return (
    <ComboboxPrimitive.Chips
      data-slot="combobox-chips"
      className={cn(
        "flex min-h-9 w-full cursor-text flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-xs focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25",
        className
      )}
      {...props}
    />
  )
}

function ComboboxChip({ className, children, ...props }: ComboboxPrimitive.Chip.Props) {
  return (
    <ComboboxPrimitive.Chip
      data-slot="combobox-chip"
      className={cn("flex h-6 w-fit items-center gap-1 rounded-sm bg-muted pr-0.5 pl-1.5 text-xs font-medium whitespace-nowrap text-foreground", className)}
      {...props}
    >
      {children}
      <ComboboxPrimitive.ChipRemove data-slot="combobox-chip-remove" aria-label="Remove"
        className="flex size-4 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-muted-foreground hover:text-foreground">
        <XIcon className="pointer-events-none size-3" />
      </ComboboxPrimitive.ChipRemove>
    </ComboboxPrimitive.Chip>
  )
}

function ComboboxChipsInput({ className, ...props }: ComboboxPrimitive.Input.Props) {
  return <ComboboxPrimitive.Input data-slot="combobox-chip-input" className={cn("h-6 min-w-16 flex-1 border-0 bg-transparent p-0 text-sm outline-none placeholder:text-muted-foreground/70", className)} {...props} />
}

export {
  Combobox,
  ComboboxValue,
  ComboboxTrigger,
  ComboboxContent,
  ComboboxSearch,
  ComboboxList,
  ComboboxItem,
  ComboboxGroup,
  ComboboxLabel,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxChips,
  ComboboxChip,
  ComboboxChipsInput,
}
