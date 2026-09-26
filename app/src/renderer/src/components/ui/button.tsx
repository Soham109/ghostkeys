import * as React from 'react'
import { Slot } from 'radix-ui'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

// Text-only buttons. One primary per screen; everything else is quiet.
const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] transition-[background-color,color,opacity,box-shadow] duration-150 ease-[var(--ease-snap)] disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      variant: {
        primary: 'bg-ink font-medium text-bg hover:opacity-90 active:opacity-80',
        secondary: 'bg-fill-hover text-ink hover:bg-fill-active',
        outline: 'text-ink shadow-[inset_0_0_0_1px_var(--hairline-strong)] hover:bg-fill-hover',
        ghost: 'text-ink-2 hover:bg-fill-hover hover:text-ink',
        text: 'px-0 text-ink-2 hover:text-ink',
        /** Only inside a destructive confirm. */
        danger: 'bg-danger font-medium text-white hover:opacity-90'
      },
      size: {
        sm: 'h-6 px-2 text-[12px]',
        md: 'h-7 px-3 text-[13px]',
        lg: 'h-8 px-4 text-[13px]',
        icon: 'size-7 text-[13px]'
      }
    },
    compoundVariants: [{ variant: 'text', class: 'px-0' }],
    defaultVariants: { variant: 'secondary', size: 'md' }
  }
)

export interface ButtonProps extends React.ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export function Button({ className, variant, size, asChild, ...props }: ButtonProps): React.JSX.Element {
  const Comp = asChild ? Slot.Root : 'button'
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

export { buttonVariants }
