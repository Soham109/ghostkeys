import * as React from 'react'
import { cn } from '@/lib/utils'

const cache = new Map<string, Promise<string | null>>()

/** The real macOS icon for a bundle id, from NSWorkspace. Nothing is drawn if the app is not installed. */
export function AppIcon({ bundleId, className }: { bundleId: string; className?: string }): React.JSX.Element | null {
  const [src, setSrc] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (bundleId === '*') return
    let alive = true
    let p = cache.get(bundleId)
    if (!p) {
      p = window.gk.appIcon(bundleId).catch(() => null)
      cache.set(bundleId, p)
    }
    void p.then((u) => alive && setSrc(u))
    return () => {
      alive = false
    }
  }, [bundleId])
  if (bundleId === '*' || !src) return null
  return <img src={src} alt="" aria-hidden className={cn('size-4 shrink-0', className)} draggable={false} />
}
