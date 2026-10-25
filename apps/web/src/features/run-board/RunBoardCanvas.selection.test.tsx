import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkflowBoardProvider, type WorkflowBoardValue } from '../board-core'
import { RunBoardCanvas } from './RunBoardCanvas'
import { runA, versionReply } from './testFixtures'
import { installFlowLayout } from './testFlowLayout'

const clients: QueryClient[] = []
beforeEach(() => { installFlowLayout() })
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks() })

async function mount() {
  const selectSidePanel = vi.fn(), connectDraftNodes = vi.fn()
  const value: WorkflowBoardValue = { workspaceId: runA.workspaceId, workflowId: runA.workflowId,
    inspection: {}, selectInspection: vi.fn(), selectRun: vi.fn(), openLocation: vi.fn(), openRuns: vi.fn(),
    activeRuns: 0, selectSidePanel, connectDraftNodes, moveDraftNodes: vi.fn() }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const inspect = (nodeId: string) => selectSidePanel({ kind: 'agent', nodeId, tab: 'details' })
  const router = createRouter({ routeTree: createRootRoute({ component: () => <WorkflowBoardProvider value={value}>
    <RunBoardCanvas snapshot={runA} definition={versionReply(runA).version.definition} onInspectNode={inspect} />
  </WorkflowBoardProvider> }), history: createMemoryHistory({ initialEntries: ['/'] }) })
  await router.load()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  await screen.findByRole('button', { name: /^X before rename, / })
  return { selectSidePanel, connectDraftNodes }
}

it('selects an Agent without opening Details and connects two selected draft Agents', async () => {
  const { selectSidePanel, connectDraftNodes } = await mount()
  const first = screen.getByRole('button', { name: /^X before rename, / })
  fireEvent.click(first)
  expect(first).toHaveAttribute('aria-pressed', 'true')
  expect(selectSidePanel).not.toHaveBeenCalled()
  expect(connectDraftNodes).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /^Y, / }))
  expect(connectDraftNodes).toHaveBeenCalledExactlyOnceWith('node-x', 'node-y')
  expect(selectSidePanel).not.toHaveBeenCalledWith(expect.objectContaining({ tab: 'details' }))
  expect(first).toHaveAttribute('aria-pressed', 'false')
})

it('opens Details, Chat and Settings only through their actions and resets selection', async () => {
  const { selectSidePanel, connectDraftNodes } = await mount()
  fireEvent.click(screen.getByRole('button', { name: /^X before rename, / }))
  const node = within(screen.getByRole('group', { name: 'X before rename, saved agent, read only' }))
  for (const [action, tab] of [['information', 'details'], ['chat', 'chat'], ['settings', 'settings']] as const) {
    fireEvent.click(node.getByRole('button', { name: `Open X before rename ${action}` }))
    expect(selectSidePanel).toHaveBeenLastCalledWith({ kind: 'agent', nodeId: 'node-x', tab })
  }
  fireEvent.click(screen.getByRole('button', { name: /^Y, / }))
  await waitFor(() => expect(screen.getByRole('button', { name: /^Y, / })).toHaveAttribute('aria-pressed', 'true'))
  expect(connectDraftNodes).not.toHaveBeenCalled()
})
