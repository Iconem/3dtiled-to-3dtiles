import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

// shadcn's button on Base UI, sized as this window's controls: 36 px tall, 13 px text, the theme's
// radius − 2 px, and the plain button is the outline variant (`default` is the primary action).
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md border text-[13px] font-medium whitespace-nowrap shadow-xs transition-[background-color,border-color,color,opacity] duration-150 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-primary bg-primary font-semibold text-primary-foreground hover:bg-primary/90",
        outline: "border-input bg-transparent text-foreground hover:bg-accent",
        ghost: "border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-accent hover:text-foreground",
      },
      size: {
        default: "h-9 px-[15px]",
        sm: "h-7 px-2.5 text-xs",
        icon: "size-8 p-0 text-muted-foreground hover:text-foreground [&_svg]:size-[15px]",
      },
    },
    defaultVariants: {
      variant: "outline",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "outline",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
