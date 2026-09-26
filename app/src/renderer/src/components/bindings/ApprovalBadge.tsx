import * as React from 'react'
import type { Action } from '@shared/protocol'
import { approvalState } from '@/lib/approval'
import { cn } from '@/lib/utils'

/** Plain words, no alarm colors: approval is a fact, not an emergency. */
export function ApprovalTag({ action, className }: { action: Action; className?: string }): React.JSX.Element | null {
  const state = approvalState(action)
  if (state === 'none') return null
  return (
    <span className={cn('tag-mono shrink-0 text-ink-3', className)} title={state === 'approved' ? 'You approved this exact text' : 'Asks for your approval before it can run'}>
      {state === 'approved' ? 'Approved' : 'Needs approval'}
    </span>
  )
}

export function ApprovalNote({ action, compact, onRevoke }: { action: Action; compact?: boolean; onRevoke?: () => void }): React.JSX.Element | null {
  const state = approvalState(action)
  if (state === 'none') return null
  if (compact) return <ApprovalTag action={action} />
  return (
    <div className="flex items-baseline gap-3 text-[12px] leading-relaxed text-ink-2">
      <span className="tag-mono shrink-0 text-ink-3">{state === 'approved' ? 'Approved' : 'Requires your approval'}</span>
      <p className="flex-1">
        {state === 'approved'
          ? 'You approved this exact text. Editing it asks again.'
          : 'macOS will ask you to approve this exact text before it can run.'}
      </p>
      {state === 'approved' && onRevoke && (
        <button type="button" className="shrink-0 text-ink-2 hover:text-ink" onClick={onRevoke}>
          Revoke
        </button>
      )}
    </div>
  )
}
