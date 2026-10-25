import { type ReactNode } from 'react'
import type { OperatorConversationState } from '@foreman-code/contracts'
import { Select } from '../../shared/ui/nocturne'
import type { useFileDrop } from '../../shared/ui/useFileDrop'
import type { ConversationAttachments } from '../attachments'
import { useConversationDraftStore, type ComposerSessionControls } from '../chat-core'
import { ChatDeliveryReceipts, DeliveryNotices, RetainedDeliveryInputs, newestQueuedInput, useCanonicalDelivery,
  useRetainedInputs } from '../conversations'
import { OperatorComposer } from './OperatorComposer'

/** Operator composer on the canonical delivery service, in the original floating-chat look.
 * Sending during an active turn steers it when the harness allows, otherwise it queues for the next turn. */
export function CanonicalOperatorComposer({ conversation, attachments, sessionControls, context, attachmentControl,
  fileDropProps, reason: unavailable, onNewChat, onDenied, refresh }: {
  conversation: OperatorConversationState; attachments: ConversationAttachments; sessionControls: ComposerSessionControls
  context?: ReactNode; attachmentControl?: ReactNode; fileDropProps?: ReturnType<typeof useFileDrop>['dropTargetProps']
  reason?: string; onNewChat(): void; onDenied(error: Error): void; refresh(): void
}) {
  const id = conversation.conversation.id
  const target = { kind: 'operator_conversation' as const, conversationId: id }
  const flow = useCanonicalDelivery({ draftKey: id, target, enabled: true,
    turnKey: `${conversation.turnState}:${conversation.activeRequestId ?? ''}`, attachments, sessionControls, refresh, onDenied })
  const { draft, mode, intent, setIntent, delivery, presentation, controlsReason, action, receipts } = flow
  const reason = unavailable ?? flow.deliveryReason
  // Settled receipts are already visible as transcript messages; only ones needing attention stay listed.
  // A failed turn is already explained by the turn's error message above; its receipt would repeat it.
  const openReceipts = receipts.filter(receipt => receipt.state === 'queued' || receipt.state === 'unknown')
  const retained = useRetainedInputs(target, onDenied)
  // ↑ in the empty composer takes the newest queued message back for editing, as in Agent chats.
  const recall = () => {
    const input = newestQueuedInput(receipts, retained.items)
    if (!input || delivery.pendingControl) return undefined
    delivery.cancel(input.receiptId)
    return input.content
  }
  return <>
    <DeliveryNotices flow={flow} />
    <ChatDeliveryReceipts receipts={openReceipts} controlsReason={controlsReason} onCancel={delivery.pendingControl ? undefined : receipt => delivery.cancel(receipt.id)} onRefresh={delivery.refresh} />
    {!delivery.denied ? <RetainedDeliveryInputs target={target} receipts={receipts} onDenied={delivery.revoke}
      representedCommandIds={conversation.messages.filter(message => message.role === 'user').flatMap(message => message.requestId ? [message.requestId] : [])} controlsReason={controlsReason}
      onRefresh={delivery.refresh} onCancel={delivery.pendingControl ? undefined : receipt => delivery.cancel(receipt.id)} /> : null}
    {draft.trim() && !unavailable && (reason ?? action.reason) ? <p className="operator-chat-handoff" role="status">{reason ?? action.reason}</p> : null}
    <OperatorComposer conversationId={id} sessionControls={sessionControls} context={context} attachmentControl={attachmentControl}
      deliveryControl={<Select label="Delivery action" value={intent} disabled={delivery.busy}
        options={[{ value: 'auto', label: 'Automatic' }, { value: 'next_turn', label: 'Queue next' },
          { value: 'steer', label: 'Steer now' }, { value: 'interrupt_and_send', label: 'Interrupt and send' }]}
        onChange={event => setIntent(event.target.value as typeof intent)} />}
      fileDropProps={fileDropProps} hasAttachments={attachments.hasAttachments} onNewChat={onNewChat} onRecall={recall}
      sendDisabled={!!reason || !!action.reason || attachments.hasBlockingAttachments || !!delivery.pending}
      isSending={delivery.busy} onCancel={!delivery.pendingControl && presentation.state === 'active' ? delivery.stop : undefined}
      onSubmit={(_trimmed, selectedMode = mode) => {
        // The exact draft is sent so the acknowledged receipt clears exactly that draft.
        flow.sendMessage(useConversationDraftStore.getState().drafts[id] ?? '', selectedMode, reason)
      }} />
  </>
}
