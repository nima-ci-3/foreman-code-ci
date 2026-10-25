import { useRef, useState } from 'react'
import { parseSessionCommand, type ChatDeliveryIntent, type DeliveryTarget, type SessionMode } from '@foreman-code/contracts'
import type { ConversationAttachments } from '../../attachments'
import { deliveryAction, prepareChatAttachments, useConversationDraftStore, type ChatAttachmentAttempt,
  type ComposerSessionControls } from '../../chat-core'
import { useChatDelivery } from './useChatDelivery'
import { useDeliveryDraftPin } from './useDeliveryDraftPin'

/**
 * The canonical delivery flow every chat composer shares (Agent and Operator chats): the draft, the turn the draft
 * targets, why it cannot be sent, and a submit that sends the exact draft with its attachments and clears exactly
 * that draft once the delivery is acknowledged.
 */
export function useCanonicalDelivery({ draftKey, target, enabled, turnKey, attachments, sessionControls, refresh, onDenied }: {
  draftKey: string; target: DeliveryTarget | undefined; enabled: boolean
  /** Changes when the conversation's turn changes, so delivery state is read again. */
  turnKey: string
  attachments: ConversationAttachments; sessionControls: ComposerSessionControls
  refresh(): void; onDenied(error: Error): void
}) {
  const draft = useConversationDraftStore(store => store.drafts[draftKey] ?? '')
  const [intent, setIntent] = useState<ChatDeliveryIntent>('auto')
  const attempt = useRef<{ content: string; version: number; files: ChatAttachmentAttempt } | undefined>(undefined)
  const delivery = useChatDelivery(target, enabled, turnKey, (_receipt, request) => {
    if (attempt.current?.content === request.content) {
      useConversationDraftStore.getState().clearExactDraft(draftKey, request.content, attempt.current.version)
      attempt.current.files.acknowledge?.()
    }
    refresh()
  }, { onDenied })
  const pin = useDeliveryDraftPin(draftKey, target, delivery.presentation.nativeTurnId, !!draft || attachments.hasAttachments,
    !!delivery.state)
  const command = parseSessionCommand(draft)
  const mode: SessionMode | undefined = command.kind === 'plan-task' ? 'plan' : sessionControls.state?.desiredMode
  const presentation = { ...delivery.presentation, hasAttachments: attachments.hasAttachments,
    changesMode: !!mode && sessionControls.state?.appliedMode !== mode }
  const controlsReason = !delivery.online ? 'You are offline. Controls are unavailable.' : undefined
  /** Why a message cannot be sent right now, beyond the composer's own reasons. */
  const deliveryReason = delivery.pendingControl ? 'Confirm the original Stop or queue control before sending.'
    : pin.stale ? 'The selected turn changed. Refresh the target to send this draft.'
      : !delivery.online ? 'You are offline. Your draft is kept.' : undefined
  const action = deliveryAction(presentation, intent)
  const receipts = delivery.state?.receipts ?? []
  /** Sends a message (not a session command); returns false when nothing was sent. */
  const sendMessage = (content: string, selectedMode: SessionMode | undefined, blockedReason: string | undefined) => {
    if (blockedReason || action.reason || delivery.busy || delivery.pending) return false
    const files = prepareChatAttachments(attachments)
    if (!files || !content.trim() && !files.attachments.length) return false
    attempt.current = { content, files, version: useConversationDraftStore.getState().versions[draftKey] ?? 0 }
    delivery.submit({ content, intent, ...(selectedMode ? { sessionMode: selectedMode } : {}),
      ...(intent !== 'next_turn' && pin.pin?.nativeTurnId ? { expectedNativeTurnId: pin.pin.nativeTurnId } : {}),
      ...(files.attachments.length ? { attachments: [...files.attachments] } : {}) })
    return true
  }
  return { draft, command, mode, intent, setIntent, delivery, pin, presentation, controlsReason, deliveryReason, action,
    receipts, sendMessage }
}
