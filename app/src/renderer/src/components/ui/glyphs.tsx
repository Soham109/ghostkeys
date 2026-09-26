import * as React from 'react'

// A few hand-drawn glyphs on a 12pt grid with rounded joins, matching the logo. Not an icon set.
const base = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export function Chevron({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" className={className ?? 'size-3'} {...base} aria-hidden>
      <path d="M3.5 4.75 6 7.25l2.5-2.5" />
    </svg>
  )
}

export function Tick({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" className={className ?? 'size-3'} {...base} aria-hidden>
      <path d="M2.75 6.25 5 8.5l4.25-5" />
    </svg>
  )
}

export function Grip({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" className={className ?? 'size-3'} fill="currentColor" aria-hidden>
      {[3, 6, 9].flatMap((y) => [4.5, 7.5].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r={0.8} />))}
    </svg>
  )
}
