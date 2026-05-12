import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground border border-primary-border hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm border-destructive-border hover:bg-destructive/90",
        outline:
          "border border-[color:var(--button-outline)] shadow-xs bg-background hover:bg-accent hover:text-accent-foreground",
        secondary:
          "border bg-secondary text-secondary-foreground border-secondary-border hover:bg-secondary/80",
        ghost: "border border-transparent hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        hero:
          "bg-primary text-primary-foreground border-[3px] border-[color:var(--primary-deep)] shadow-chunky font-extrabold tracking-wide hover:-translate-y-0.5 hover:shadow-[0_8px_0_0_var(--primary-deep)] active:translate-y-1 active:shadow-chunky-sm transition-all duration-150",
        glass:
          "bg-card/80 backdrop-blur border-[3px] border-[color:var(--primary-deep)] text-foreground font-extrabold shadow-chunky-sm hover:-translate-y-0.5 active:translate-y-0.5 transition-all duration-150",
      },
      size: {
        default: "min-h-9 px-4 py-2",
        sm: "min-h-8 rounded-md px-3 text-xs",
        lg: "min-h-10 rounded-md px-8",
        xl: "min-h-12 rounded-xl px-10 text-base",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
