import * as React from 'react'
import { GestureDemo, type DemoId } from './GestureDemo'

// Screenshot-only: fixed frames of a few demos, left to right in time, to judge motion in a still image.
const ROWS: { g: DemoId; at: number[] }[] = [
  { g: 'double', at: [0.35, 0.7, 0.8, 0.92, 1.1] },
  { g: 'sequence', at: [0.4, 0.62, 0.85, 1.0, 1.2] },
  { g: 'pinch_hold', at: [0.3, 0.5, 0.9, 1.3, 2.0] },
  { g: 'cover_hold', at: [0.3, 0.6, 1.0, 1.6, 2.2] },
  { g: 'lid_nudge', at: [0.4, 0.8, 1.0, 1.3, 1.8] }
]

export function FrameSheet(): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-[100] flex flex-col gap-3 overflow-hidden bg-bg p-6">
      {ROWS.map((r) => (
        <div key={r.g} className="flex items-center gap-3">
          <span className="w-24 font-mono text-[11px] text-ink-3 uppercase">{r.g.replace('_', ' ')}</span>
          {r.at.map((t) => (
            <div key={t} className="flex flex-col gap-1">
              <GestureDemo gesture={r.g} at={t} className="h-[124px] w-[194px] rounded-[6px] bg-sunken shadow-[inset_0_0_0_1px_var(--hairline)]" />
              <span className="font-mono text-[10px] text-ink-3">{t.toFixed(2)} s</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
