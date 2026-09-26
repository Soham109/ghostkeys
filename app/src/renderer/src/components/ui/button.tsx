import * as React from 'react'
import { Slot } from 'radix-ui'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] font-medium transition-[background-color,color,opacity] duration-150 ease-[var(--ease-snap)] disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-ink text-bg hover:opacity-90 active:opacity-80',
        secondary: 'bg-fill-hover text-ink hover:bg-fill-active',
        ghost: 'text-ink-2 hover:bg-fill-hover hover:text-ink',
        outline: 'text-ink shadow-[inset_0_0_0_1px_var(--hairline-strong)] hover:bg-fill-hover',
        danger: 'text-danger hover:bg-[color-mix(in_srgb,var(--danger)_12%,transparent)]'
      },
      size: {
        sm: 'h-6 px-2 text-[12px] [&_svg]:size-3.5',
        md: 'h-7 px-3 text-[13px] [&_svg]:size-3.5',
        lg: 'h-8 px-4 text-[13px] [&_svg]:size-4',
        icon: 'size-7 [&_svg]:size-3.5',
        'icon-sm': 'size-6 [&_svg]:size-3.5'
      }
    },
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
