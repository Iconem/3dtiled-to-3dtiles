import { cn } from '@/lib/utils';

/** A card of this window: the theme's radius, a hairline border, and 18 px of padding. */
export const Card = ({ className, ...rest }: React.ComponentProps<'div'>) => (
  <div className={cn('mb-3.5 rounded-lg border border-border bg-card p-[18px] text-card-foreground shadow-xs', className)} {...rest} />
);

/** A card's title line with its actions to the right. */
export const CardHead = ({ className, ...rest }: React.ComponentProps<'div'>) => (
  <div className={cn('mb-2 flex items-center gap-2.5', className)} {...rest} />
);

export const CardHeadActions = ({ className, ...rest }: React.ComponentProps<'div'>) => (
  <div className={cn('ml-auto flex flex-wrap items-center justify-end gap-1', className)} {...rest} />
);
