import { useRef, useState } from 'react'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { ConfirmDialog } from '../../shared/ui/nocturne'

/**
 * Confirms removing one reference file (project or workflow files). A removal whose outcome is unknown keeps its
 * command id and locks the dialog until a retry settles it, so the same file is never removed under two commands.
 */
export function FileRemovalDialog({ filename, description, remove, onRemoved, onClose, blockedReason }: {
  filename: string
  description: string
  /** Removes the file under this command id; a retry after an unknown outcome passes the same id. */
  remove(commandId: string): Promise<unknown>
  onRemoved(): void
  onClose(): void
  /** Why the file cannot be removed here; confirming does nothing. */
  blockedReason?: string | undefined
}) {
  const attempt = useRef(new CommandAttempt<Record<string, never>>())
  const inFlight = useRef(false)
  const [state, setState] = useState<'idle' | 'pending' | 'failed'>('idle')
  const locked = state === 'pending' || attempt.current.unresolved
  const confirm = async () => {
    if (blockedReason || inFlight.current) return
    inFlight.current = true
    setState('pending')
    const generation = sessionGeneration()
    try {
      await remove(attempt.current.input({}).commandId)
      assertSession(generation)
      attempt.current.succeeded()
      setState('idle')
      onRemoved()
      onClose()
    } catch (error) {
      attempt.current.failed(error)
      setState('failed')
    } finally { inFlight.current = false }
  }
  return <ConfirmDialog open title={`Remove ${filename}?`} description={description}
    dismissalReason={attempt.current.unresolved
      ? 'Removal is unconfirmed. Retry checks the original removal before you can close this dialog.' : undefined}
    pending={state === 'pending'} confirmLabel={state === 'failed' ? 'Retry' : 'Remove'}
    error={blockedReason ?? (state === 'failed' ? 'Couldn’t remove the file.' : undefined)}
    onOpenChange={(open) => { if (!open && !locked) onClose() }} onConfirm={() => { void confirm() }} />
}
