import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export function uid(prefix = 'id'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}

export function pct(v: number, digits = 0): string {
  return `${(v * 100).toFixed(digits)}%`
}

export function relTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 5) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.round(m / 60)}h`
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** "Left palm rest", "Left palm rest and lid", "Left palm rest, lid and top strip", "Left palm rest, lid and 4 other zones". */
export function nameList(names: string[], max = 3): string {
  const n = names.map((x, i) => (i === 0 ? x : x.toLowerCase()))
  if (n.length <= 1) return n[0] ?? ''
  if (n.length > max) return `${n.slice(0, max - 1).join(', ')} and ${n.length - (max - 1)} other zones`
  return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`
}
