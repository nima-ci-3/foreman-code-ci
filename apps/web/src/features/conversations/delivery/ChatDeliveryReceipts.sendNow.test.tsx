import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChatDeliveryReceipt } from '@foreman-code/contracts'
import { ChatDeliveryReceipts } from './ChatDeliveryReceipts'

afterEach(cleanup)

const queued = { id: 'receipt-1', commandId: 'command-1', requestedIntent: 'auto', appliedIntent: 'next_turn', state: 'queued',
  target: { kind: 'agent_conversation', workspaceId: 'workspace', agentId: 'agent', conversationId: 'conversation' },
  createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z' } as unknown as ChatDeliveryReceipt

it('offers Send now for a queued message when the running turn can be steered', () => {
  const onSendNow = vi.fn()
  render(<ChatDeliveryReceipts receipts={[queued]} onCancel={vi.fn()} onSendNow={onSendNow} />)
  fireEvent.click(screen.getByRole('button', { name: 'Send now' }))
  expect(onSendNow).toHaveBeenCalledWith(queued)
  expect(screen.getByRole('button', { name: 'Cancel queued message' })).toBeVisible()
})

it('shows no Send now when the turn cannot be steered', () => {
  render(<ChatDeliveryReceipts receipts={[queued]} onCancel={vi.fn()} />)
  expect(screen.queryByRole('button', { name: 'Send now' })).not.toBeInTheDocument()
})
