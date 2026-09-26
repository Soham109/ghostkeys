import * as React from 'react'
import { Switch as SwitchPrimitive, Slider as SliderPrimitive, ToggleGroup as ToggleGroupPrimitive, Tooltip as TooltipPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'
import { useStore } from '@/lib/store'

// ---------------------------------------------------------------- Switch (macOS mini proportion, quiet)

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>): React.JSX.Element {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer group/sw relative inline-flex h-4 w-[26px] shrink-0 items-center rounded-full transition-colors duration-200 ease-[var(--ease-snap)]',
        'bg-hairline-strong data-[state=checked]:bg-ink-2 hover:data-[state=checked]:bg-ink focus-visible:data-[state=checked]:bg-ink disabled:opacity-40',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block size-3 rounded-full bg-ink-2 transition-transform duration-200 ease-[var(--ease-snap)]',
          'translate-x-[2px] data-[state=checked]:translate-x-[12px] data-[state=checked]:bg-bg'
        )}
      />
    </SwitchPrimitive.Root>
  )
}

// ---------------------------------------------------------------- Checkbox (outline only)

export function Check({ checked, className }: { checked: boolean; className?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-3.5 shrink-0 items-center justify-center rounded-[3px] transition-shadow duration-150',
        checked ? 'shadow-[inset_0_0_0_1px_var(--ink)]' : 'shadow-[inset_0_0_0_1px_var(--ink-3)]',
        className
      )}
    >
      {checked && (
        <svg viewBox="0 0 10 10" className="size-2.5" fill="none" stroke="var(--ink)" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 5.2 4.1 7.2 8 2.8" />
        </svg>
      )}
    </span>
  )
}

// ---------------------------------------------------------------- Slider (macOS look)

export function Slider({ className, ticks, ...props }: React.ComponentProps<typeof SliderPrimitive.Root> & { ticks?: number }): React.JSX.Element {
  const count = (props.value ?? props.defaultValue ?? [0]).length
  return (
    <div className={cn('relative w-full', className)}>
      <SliderPrimitive.Root
        data-slot="slider"
        className="relative flex h-5 w-full touch-none items-center select-none data-[disabled]:opacity-40"
        {...props}
      >
        <SliderPrimitive.Track className="relative h-1 grow overflow-hidden rounded-full bg-hairline-strong">
          <SliderPrimitive.Range className="absolute h-full bg-ink-2" />
        </SliderPrimitive.Track>
        {Array.from({ length: count }, (_, i) => (
          <SliderPrimitive.Thumb
            key={i}
            className="block size-4 rounded-full bg-ink shadow-[inset_0_0_0_1px_var(--hairline-strong)] transition-transform duration-150 active:scale-95"
          />
        ))}
      </SliderPrimitive.Root>
      {ticks && ticks > 1 && (
        <div className="pointer-events-none absolute inset-x-2 -bottom-1.5 flex justify-between" aria-hidden>
          {Array.from({ length: ticks }, (_, i) => (
            <span key={i} className="h-1 w-px bg-ink-3" />
          ))}
        </div>
      )}
    </div>
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
      className={cn('inline-flex h-7 items-center rounded-[6px] bg-fill p-[2px] shadow-[inset_0_0_0_1px_var(--hairline)]', className)}
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
        <TooltipPrimitive.Content side={side} sideOffset={6} className="material z-50 max-w-64 rounded-[6px] px-2 py-1 text-[12px] text-ink">
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

// ---------------------------------------------------------------- Inputs

const fieldBase =
  'w-full min-w-0 rounded-[6px] bg-fill text-[13px] text-ink placeholder:text-ink-3 shadow-[inset_0_0_0_1px_var(--hairline)] transition-shadow duration-150 outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--ink-3)] focus-visible:outline-none'

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(fieldBase, 'h-7 px-2.5', className)} {...props} />
})

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(function Textarea(
  { className, ...props },
  ref
) {
  return <textarea ref={ref} className={cn(fieldBase, 'min-h-20 px-2.5 py-2', className)} {...props} />
})

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return <kbd className={cn('inline-flex items-center font-mono text-[11px] leading-none tracking-[0.04em] text-ink-2', className)}>{children}</kbd>
}

export function SectionLabel({ children, className, right }: { children: React.ReactNode; className?: string; right?: React.ReactNode }): React.JSX.Element {
  return (
    <div className={cn('flex h-8 items-end justify-between pb-2', className)}>
      <h2 className="label-mono">{children}</h2>
      {right}
    </div>
  )
}

/** Zone identity is a mono index, not a color (critique item 1). */
export function ZoneIndex({ n, className, lit }: { n: number | null | undefined; className?: string; lit?: boolean }): React.JSX.Element {
  return (
    <span
      className={cn(
        'num inline-block w-5 shrink-0 text-[11px] tracking-[0.06em] transition-colors duration-[900ms]',
        lit ? 'text-signal duration-150' : 'text-ink-3',
        className
      )}
    >
      {n ? String(n).padStart(2, '0') : '--'}
    </span>
  )
}

/** Small mono tag that marks a Pro feature. Never blocks. */
export function ProTag({ feature, className }: { feature?: string; className?: string }): React.JSX.Element | null {
  const tier = useStore((s) => s.license.tier)
  if (tier !== 'free') return null
  return (
    <span
      title={feature ? `${feature} is part of Pro` : 'Part of Pro'}
      className={cn('tag-mono inline-flex h-4 shrink-0 items-center rounded-[3px] px-1 text-ink-3 shadow-[inset_0_0_0_1px_var(--hairline-strong)]', className)}
    >
      Pro
    </span>
  )
}
