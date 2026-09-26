import * as React from 'react'
import { ShieldCheck, ShieldAlert } from 'lucide-react'
import type { Action } from '@shared/protocol'
import { useApproval } from '@/lib/approval'
import { cn } from '@/lib/utils'
import { Tip } from '../ui/controls'

/** Small badge for actions that run commands or open things: approved, or waiting for approval. */
export function ApprovalBadge({ action, compact }: { action: Action; compact?: boolean }): React.JSX.Element | null {
  const state = useApproval(action)
  if (state === 'none') return null
  const approved = state === 'approved'
  const Icon = approved ? ShieldCheck : ShieldAlert
  const badge = (
    <span
      className={cn(
        'inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[4px] px-1.5 text-[11px]',
        approved ? 'text-ink-2 shadow-[inset_0_0_0_1px_var(--hairline-strong)]' : 'text-danger shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--danger)_40%,transparent)]'
      )}
    >
      <Icon className="size-3" />
      {!compact && (approved ? 'Approved' : 'Needs approval')}
    </span>
  )
  return compact ? <Tip content={approved ? 'You approved this exact text' : 'Asks for your approval before it can run'}>{badge}</Tip> : badge
}

export function ApprovalNote({ action }: { action: Action }): React.JSX.Element | null {
  const state = useApproval(action)
  if (state === 'none') return null
  return (
    <div className="flex items-start gap-2.5 text-[12px] leading-relaxed text-ink-2">
      <ApprovalBadge action={action} />
      <p className="text-ink-3">
        {state === 'approved'
          ? 'You approved this exact text. Editing it asks again.'
          : 'When you save or test, macOS shows you the exact text to allow. Ghostkeys will not run it otherwise.'}
      </p>
    </div>
  )
}
