import pc from 'picocolors'

/** Strips ANSI escape codes so colored cells don't throw off column width math. */
function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length
}

function pad(s: string, width: number): string {
  const gap = width - visibleLength(s)
  return gap > 0 ? s + ' '.repeat(gap) : s
}

/** A clean, borderless table: header, a rule, then rows. No emoji, no box-drawing characters. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i] ?? ''))))
  const line = (cells: string[]) => cells.map((c, i) => pad(c ?? '', widths[i] ?? 0)).join('   ')
  const headerLine = pc.bold(line(headers))
  const rule = widths.map((w) => '-'.repeat(w)).join('   ')
  const body = rows.map(line)
  return [headerLine, rule, ...body].join('\n')
}

export function fmtPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`
}

/** A daemon protocol timestamp (ms since the daemon started) as seconds with two decimals. */
export function fmtTimestamp(t: number): string {
  return `${(t / 1000).toFixed(2)}s`
}

export function ok(label: string): string {
  return pc.green(label)
}

export function warn(label: string): string {
  return pc.yellow(label)
}

export function err(label: string): string {
  return pc.red(label)
}

export function dim(label: string): string {
  return pc.dim(label)
}
