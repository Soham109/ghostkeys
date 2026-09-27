import type { RejectedMsg, Settings } from '@shared/protocol'

export interface Why {
  sentence: string
  /** The one thing that fixes it. */
  action?: { label: string; run: 'shorten-typing' | 'teach' | 'resume' | 'raise-sensitivity' | 'lower-certainty' | 'none' }
}

/** One plain sentence for why a tap was dropped, and the single action that helps. */
export function explain(r: RejectedMsg | null, settings: Settings | undefined, zoneName: (id: string) => string): Why {
  if (!r) {
    return {
      sentence: 'Ghostkeys didn’t feel a tap in the last 30 seconds. Try a slightly firmer tap, or raise the sensitivity.',
      action: { label: 'Raise sensitivity', run: 'raise-sensitivity' }
    }
  }
  const where = r.zone ? ` on the ${zoneName(r.zone).toLowerCase()}` : ''
  switch (r.reason) {
    case 'typing':
      return {
        sentence: `That tap${where} came right after a key press, so Ghostkeys treated it as typing. Wait half a second after typing, or shorten the typing pause.`,
        action: (settings?.typingGateMs ?? 450) > 200 ? { label: 'Shorten typing pause', run: 'shorten-typing' } : undefined
      }
    case 'trackpad':
      return { sentence: `That tap${where} happened while the trackpad was in use, so it was ignored. Lift your other hand off the trackpad first.` }
    case 'motion':
      return { sentence: 'The laptop itself was moving, so the bump looked like handling, not a tap. Rest it on something steady and try again.' }
    case 'burst':
      return { sentence: 'Several bumps came at once, which looks like the laptop being knocked. Tap once, cleanly.' }
    case 'low_confidence':
      return {
        sentence: 'Ghostkeys felt a tap but couldn\u2019t tell which zone it was. Tell it where you tapped, and it learns for next time.',
        action: { label: 'Where did you tap?', run: 'teach' }
      }
    case 'paused':
      return { sentence: 'Ghostkeys is paused, so nothing runs.', action: { label: 'Resume', run: 'resume' } }
  }
}
