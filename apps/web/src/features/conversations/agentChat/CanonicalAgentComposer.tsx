import { useEffect, type ReactNode, type RefObject } from 'react'
import { parseSessionCommand, type ChatDeliveryReceipt, type DeliveryTarget, type SessionMode } from '@foreman-code/contracts'
import type { AgentChatState } from '@foreman-code/contracts/agent-chat'
import type { ConversationAttachments } from '../../attachments'
import { Icon, IconButton, MessageBubble } from '../../../shared/ui/nocturne'
import { type ComposerSessionControls, useConversationDraftStore } from '../../chat-core'
import { ChatDeliveryActions } from '../delivery/ChatDeliveryActions'
import { ChatDeliveryReceipts } from '../delivery/ChatDeliveryReceipts'
import { RetainedDeliveryInputs, type DirectRecovery } from '../delivery/RetainedDeliveryInputs'
import { useCanonicalDelivery } from '../delivery/useCanonicalDelivery'
import { DeliveryNotices } from '../delivery/DeliveryNotices'
import { useRetainedInputs } from '../delivery/useRetainedInputs'
import { dropCommand, newestQueuedInput, queueCommand, useQueuedCommands } from '../delivery/queuedRecall'
import { AgentChatComposer } from './AgentChatComposer'

export function CanonicalAgentComposer({ state, name, draftKey, inputRef, attachments, sessionControls,
  attachmentControl, actions, writeReason, onSessionCommand, refresh, target, onDenied, onRecover }: {
  state: AgentChatState; name: string; draftKey: string
  inputRef: RefObject<HTMLTextAreaElement | null>; attachments: ConversationAttachments
  sessionControls: ComposerSessionControls; attachmentControl?: ReactNode; actions?: ReactNode
  writeReason?: string; onSessionCommand(content: string, mode?: SessionMode): void; refresh(): void
  target?: DeliveryTarget; onDenied(error: Error): void
  onRecover?(recovery: DirectRecovery): void
}) {
  const flow = useCanonicalDelivery({ draftKey, target, enabled: !writeReason,
    turnKey: `${state.sessionState}:${state.activeTurn?.requestId ?? ''}`, attachments, sessionControls, refresh, onDenied })
  const { draft, command, mode, intent, setIntent, delivery, pin, presentation, controlsReason, action, receipts } = flow
  const reason = writeReason ?? (command.kind === 'invalid' ? command.message
    : !target ? 'No available target. Refresh this conversation.' : flow.deliveryReason)
  const active = presentation.state === 'active'
  const commands = useQueuedCommands(store => store.items[draftKey]) ?? []
  const submit = (content = draft, selectedMode = mode) => {
    const parsed = parseSessionCommand(content)
    if (parsed.kind === 'new' || parsed.kind === 'compact' || parsed.kind === 'mode') {
      // Mid-turn, a session command waits for the turn to end, like a queued message.
      if (active) { queueCommand(draftKey, content, selectedMode); useConversationDraftStore.getState().setDraft(draftKey, ''); return }
      onSessionCommand(content, selectedMode); return
    }
    flow.sendMessage(content, selectedMode, reason)
  }
  // The turn ended: queued commands run in the order they were typed, one per turn.
  const nextCommand = !active && !delivery.busy && !delivery.pending ? commands[0] : undefined
  useEffect(() => {
    if (!nextCommand) return
    dropCommand(draftKey, nextCommand.id)
    onSessionCommand(nextCommand.content, nextCommand.mode as SessionMode | undefined)
  }, [nextCommand, draftKey, onSessionCommand])
  const retained = useRetainedInputs(target, onDenied)
  const recall = () => {
    const command = commands.at(-1), input = newestQueuedInput(receipts, retained.items)
    if (command && (!input || command.queuedAt >= input.createdAt)) { dropCommand(draftKey, command.id); return command.content }
    if (!input || delivery.pendingControl) return undefined
    delivery.cancel(input.receiptId)
    return input.content
  }
  return <>
    <DeliveryNotices flow={flow} />
    {/* Only unconfirmed deliveries show here; a queued message shows its state and Cancel in its own bubble. */}
    <ChatDeliveryReceipts receipts={receipts.filter(receipt => receipt.state === 'unknown')} controlsReason={controlsReason} onCancel={delivery.pendingControl ? undefined : receipt => delivery.cancel(receipt.id)} onRefresh={delivery.refresh} />
    {target && !delivery.denied ? <RetainedDeliveryInputs target={target} receipts={receipts} onDenied={delivery.revoke}
      representedCommandIds={[...state.messages.filter(message => message.role === 'user').flatMap(message => message.requestId ? [message.requestId] : []),
        ...state.turns.map(turn => turn.requestId)]}
      controlsReason={controlsReason} onRecover={onRecover} onRefresh={delivery.refresh}
      onCancel={delivery.pendingControl ? undefined : receipt => delivery.cancel(receipt.id)}
      {...(active && presentation.capabilities.steer !== 'unavailable' && pin.pin?.nativeTurnId && !delivery.pendingControl
        && !delivery.busy && !delivery.pending && !reason ? { onSendNow: (receipt: ChatDeliveryReceipt, content: string) => {
          delivery.cancel(receipt.id)
          delivery.submit({ content, intent: 'steer', expectedNativeTurnId: pin.pin!.nativeTurnId! })
        } } : {})} /> : null}
    {commands.map(command => <div key={command.id} className="agent-chat-message agent-chat-message--user" role="group" aria-label="Queued command">
      <MessageBubble author="You" role="user"><div className="conversation-message-content">{command.content}</div>
        <ul className="chat-delivery-receipts" aria-label="Delivery receipts"><li><p><strong>Queued</strong> · runs after the current turn</p>
          <div className="n-actions"><IconButton size="sm" variant="ghost" label="Cancel queued command" className="chat-delivery-cancel"
            title="Cancel · ↑ in the empty composer edits it" onClick={() => dropCommand(draftKey, command.id)}><Icon name="close" size={12} /></IconButton></div>
        </li></ul></MessageBubble></div>)}
    <AgentChatComposer name={name} onRecall={recall} draftKey={draftKey} inputRef={inputRef} disabled={false}
      reason={reason ?? action.reason} controlReason={writeReason} pending={delivery.busy || !!delivery.pending}
      controlPending={sessionControls.mutation.isPending} hasAttachments={attachments.hasAttachments}
      attachmentControl={attachmentControl} actions={actions} canStop={false} onStop={delivery.stop} onSubmit={submit}
      deliveryActions={<ChatDeliveryActions presentation={presentation} intent={intent} onIntentChange={setIntent}
        controlsReason={controlsReason}
        pending={delivery.busy || !!delivery.pending} empty={!draft.trim() && !attachments.hasAttachments || attachments.hasBlockingAttachments}
        reason={reason} onSubmit={() => submit()} onStop={!delivery.pendingControl && presentation.state === 'active' ? delivery.stop : undefined}
        onCancelQueued={delivery.pendingControl ? undefined : delivery.cancelAll} queueCount={receipts.filter(receipt => receipt.state === 'queued').length} />} />
  </>
}
