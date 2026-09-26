import * as React from 'react'
import { Switch as SwitchPrimitive, Slider as SliderPrimitive, ToggleGroup as ToggleGroupPrimitive, Tooltip as TooltipPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------- Switch

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>): React.JSX.Element {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full transition-colors duration-200 ease-[var(--ease-snap)]',
        'bg-fill-active data-[state=checked]:bg-ink disabled:opacity-40',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block size-[14px] rounded-full bg-[var(--ink)] transition-transform duration-200 ease-[var(--ease-snap)]',
          'translate-x-[2px] data-[state=checked]:translate-x-[14px] data-[state=checked]:bg-[var(--bg)]'
        )}
      />
    </SwitchPrimitive.Root>
  )
}

// ---------------------------------------------------------------- Slider

export function Slider({ className, ...props }: React.ComponentProps<typeof SliderPrimitive.Root>): React.JSX.Element {
  const count = (props.value ?? props.defaultValue ?? [0]).length
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn('relative flex h-5 w-full touch-none items-center select-none data-[disabled]:opacity-40', className)}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-[2px] grow overflow-hidden rounded-full bg-hairline-strong">
        <SliderPrimitive.Range className="absolute h-full bg-ink" />
      </SliderPrimitive.Track>
      {Array.from({ length: count }, (_, i) => (
        <SliderPrimitive.Thumb
          key={i}
          className="block size-[14px] rounded-full bg-ink shadow-[0_0_0_3px_var(--bg)] transition-transform duration-150 hover:scale-110 focus-visible:scale-110"
        />
      ))}
    </SliderPrimitive.Root>
  )
}

// ---------------------------------------------------------------- Segmented control

export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  className,
  'aria-label': ariaLabel
}: {
  value: T
  onValueChange: (v: T) => void
  options: { value: T; label: React.ReactNode }[]
  className?: string
  'aria-label'?: string
}): React.JSX.Element {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      aria-label={ariaLabel}
      onValueChange={(v) => v && onValueChange(v as T)}
      className={cn('inline-flex h-7 items-center rounded-[6px] bg-fill p-[2px]', className)}
    >
      {options.map((o) => (
        <ToggleGroupPrimitive.Item
          key={o.value}
          value={o.value}
          className={cn(
            'h-6 rounded-[4px] px-2.5 text-[12px] text-ink-2 transition-colors duration-150',
            'hover:text-ink data-[state=on]:bg-fill-active data-[state=on]:text-ink'
          )}
        >
          {o.label}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  )
}

// ---------------------------------------------------------------- Tooltip

export function TooltipProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <TooltipPrimitive.Provider delayDuration={450} skipDelayDuration={200}>
      {children}
    </TooltipPrimitive.Provider>
  )
}

export function Tip({
  content,
  children,
  side = 'top'
}: {
  content: React.ReactNode
  children: React.ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
}): React.JSX.Element {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-50 max-w-64 rounded-[6px] bg-popover px-2 py-1 text-[12px] text-ink shadow-[var(--pop-shadow)]"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

// ---------------------------------------------------------------- Inputs

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(function Input(
  { className, ...props },
  ref
) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-7 w-full min-w-0 rounded-[6px] bg-fill px-2.5 text-[13px] text-ink placeholder:text-ink-3',
        'shadow-[inset_0_0_0_1px_var(--hairline)] transition-shadow duration-150 outline-none',
        'focus-visible:shadow-[inset_0_0_0_1px_var(--ink-3)] focus-visible:outline-none',
        className
      )}
      {...props}
    />
  )
})

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(function Textarea(
  { className, ...props },
  ref
) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'min-h-20 w-full rounded-[6px] bg-fill px-2.5 py-2 text-[13px] text-ink placeholder:text-ink-3',
        'shadow-[inset_0_0_0_1px_var(--hairline)] outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--ink-3)] focus-visible:outline-none',
        className
      )}
      {...props}
    />
  )
})

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] px-1 font-mono text-[11px] leading-none text-ink-2',
        'shadow-[inset_0_0_0_1px_var(--hairline-strong)]',
        className
      )}
    >
      {children}
    </kbd>
  )
}

export function SectionLabel({ children, className, right }: { children: React.ReactNode; className?: string; right?: React.ReactNode }): React.JSX.Element {
  return (
    <div className={cn('flex h-8 items-end justify-between pb-2', className)}>
      <h2 className="label-mono">{children}</h2>
      {right}
    </div>
  )
}

export function ZoneDot({ color, className }: { color: string; className?: string }): React.JSX.Element {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', className)} style={{ background: color }} />
}
