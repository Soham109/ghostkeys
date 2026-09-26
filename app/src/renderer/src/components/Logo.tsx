import * as React from 'react'

/** The mark from docs/design/logo.svg: a keycap, its ghost, and the point where a finger lands. */
export function Logo({ className, dotClassName }: { className?: string; dotClassName?: string }): React.JSX.Element {
  return (
    <svg viewBox="24 24 80 80" className={className} fill="none" stroke="currentColor" strokeWidth={7} strokeLinejoin="round" aria-hidden>
      <rect x="36" y="28" width="64" height="64" rx="16" opacity="0.35" />
      <rect x="28" y="36" width="64" height="64" rx="16" />
      <circle cx="60" cy="68" r="8" fill="currentColor" stroke="none" className={dotClassName} />
    </svg>
  )
}
