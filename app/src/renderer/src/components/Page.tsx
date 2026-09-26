import * as React from 'react'
import { cn } from '@/lib/utils'

/** Top of every screen: a 52px drag region holding the title and the screen's actions. */
export function PageHeader({
  title,
  subtitle,
  actions,
  className
}: {
  title: React.ReactNode
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <header className={cn('drag flex h-[52px] shrink-0 items-center gap-4 px-6', className)}>
      <div className="flex min-w-0 items-baseline gap-3">
        <h1 className="text-[15px] font-medium tracking-[-0.01em]">{title}</h1>
        {subtitle && <p className="truncate text-[12px] text-ink-3">{subtitle}</p>}
      </div>
      <div className="no-drag ml-auto flex items-center gap-1.5">{actions}</div>
    </header>
  )
}

/** A spec-sheet fact: small mono label above a value. */
export function Fact({ label, children, className }: { label: string; children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <span className="label-mono">{label}</span>
      <span className="flex items-center gap-2 truncate text-[13px] text-ink">{children}</span>
    </div>
  )
}

export function Empty({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col items-start gap-2 px-4 py-10">
      <p className="text-[13px] text-ink">{title}</p>
      {children && <p className="max-w-[40ch] text-[12px] leading-relaxed text-ink-3">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
