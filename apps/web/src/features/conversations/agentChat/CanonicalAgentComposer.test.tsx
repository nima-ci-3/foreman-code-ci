import { createRef } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { agentChatFixtures } from '@foreman-code/contracts/agent-chat'
import { server } from '../../../mocks/server'
import type { ConversationAttachments } from '../../attachments'
import { type ComposerSessionControls, useConversationDraftStore } from '../../chat-core'
import { useQueuedCommands } from '../delivery/queuedRecall'
import { CanonicalAgentComposer } from './CanonicalAgentComposer'

const clients: QueryClient[] = []
beforeEach(() => {
  localStorage.clear()
  useConversationDraftStore.getState().clearAllDrafts()
  useQueuedCommands.setState({ items: {} })
})
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); useQueuedCommands.setState({ items: {} }) })

async function mount() {
  const state = structuredClone(agentChatFixtures.active)
  const target = { kind: 'agent_conversation' as const, conversationId: state.conversation!.id, agent: state.context }
  const root = `/api/workspaces/${state.context.workspaceId}/agent-chat/deliveries`
  let active = true
  server.use(http.post(`${root}/read`, async ({ request }) => {
    const input = await request.json() as { deliveryInputs?: unknown }
    if (input.deliveryInputs) return HttpResponse.json({ target, deliveryInputs: { items: [], nextCursor: null, hasMore: false, revision: 1 } })
    return HttpResponse.json({ target, state, receipts: [], delivery: { state: active ? 'active' : 'idle',
      capabilities: { steer: 'native_expected_turn', queue: true, interruptAndSend: true },
      ...(active ? { nativeTurnId: 'active-turn' } : {}) } })
  }))
  const attachments: ConversationAttachments = { items: [], readyRefs: [], hasAttachments: false,
    hasBlockingAttachments: false, isUploading: false, canAdd: true, available: true,
    addFiles: vi.fn(), remove: vi.fn(), retry: vi.fn(), prepareSend: () => ({ attachments: [] }), acknowledgeSent: vi.fn() }
  const sessionControls = { mutation: { isPending: false } } as ComposerSessionControls
  const onSessionCommand = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><CanonicalAgentComposer state={state} name="Ava" draftKey="queued-session-command"
    inputRef={createRef<HTMLTextAreaElement>()} attachments={attachments} sessionControls={sessionControls}
    onSessionCommand={onSessionCommand} refresh={vi.fn()} target={target} onDenied={vi.fn()} /></QueryClientProvider>)
  await screen.findByRole('button', { name: 'Stop active turn' })
  return { onSessionCommand, finish: async () => {
    active = false
    state.activeTurn = null
    state.sessionState = 'idle'
    await act(async () => { await client.invalidateQueries() })
  } }
}

it('queues /new during an active turn and runs it only after that turn ends', async () => {
  const mounted = await mount()
  const input = screen.getByRole('textbox', { name: 'Message' })
  fireEvent.change(input, { target: { value: '/new' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  const queued = await screen.findByRole('group', { name: 'Queued command' })
  expect(queued).toHaveTextContent('/new')
  expect(within(queued).getByRole('button', { name: 'Cancel queued command' })).toBeEnabled()
  expect(input).toHaveValue('')
  expect(mounted.onSessionCommand).not.toHaveBeenCalled()
  await mounted.finish()
  await waitFor(() => expect(mounted.onSessionCommand).toHaveBeenCalledExactlyOnceWith('/new', undefined))
  expect(screen.queryByRole('group', { name: 'Queued command' })).not.toBeInTheDocument()
})

it('cancels a queued session command without running it after the turn ends', async () => {
  const mounted = await mount()
  const input = screen.getByRole('textbox', { name: 'Message' })
  fireEvent.change(input, { target: { value: '/new' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel queued command' }))
  expect(screen.queryByRole('group', { name: 'Queued command' })).not.toBeInTheDocument()
  await mounted.finish()
  expect(mounted.onSessionCommand).not.toHaveBeenCalled()
})
