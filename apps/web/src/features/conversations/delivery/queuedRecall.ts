import { create } from 'zustand'
import type { ChatDeliveryReceipt } from '@foreman-code/contracts'
import type { RetainedInput } from './client'

/** The newest message still waiting in the queue whose full text is here, so ↑ can take it back into the composer. */
export function newestQueuedInput(receipts: readonly ChatDeliveryReceipt[], inputs: readonly RetainedInput[]) {
  const queued = new Set(receipts.filter(receipt => receipt.state === 'queued').map(receipt => receipt.id))
  return inputs.filter(input => queued.has(input.receiptId) && !input.truncated && !input.attachments.length)
    .reduce<RetainedInput | undefined>((newest, input) => !newest || input.createdAt > newest.createdAt ? input : newest, undefined)
}

/** Session commands (/new, /compact, mode) typed while the Agent is mid-turn wait here, in this viewer, until the turn ends. */
export type QueuedCommand = { id: string; content: string; mode?: string; queuedAt: string }
export const useQueuedCommands = create<{ items: Record<string, readonly QueuedCommand[]> }>(() => ({ items: {} }))
export const queueCommand = (key: string, content: string, mode?: string) => useQueuedCommands.setState(state => ({ items: { ...state.items,
  [key]: [...state.items[key] ?? [], { id: crypto.randomUUID(), content, ...(mode ? { mode } : {}), queuedAt: new Date().toISOString() }] } }))
export const dropCommand = (key: string, id: string) => useQueuedCommands.setState(state => ({ items: { ...state.items,
  [key]: (state.items[key] ?? []).filter(item => item.id !== id) } }))
