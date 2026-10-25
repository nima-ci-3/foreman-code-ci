import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { attachJob, WorkflowBoardProvider, type WorkflowBoardValue } from '../board-core'
import { definition as jobDefinition } from '../jobs/fixtures'
import { RunBoardCanvas } from './RunBoardCanvas'
import { runA, versionReply } from './testFixtures'
import { installFlowLayout } from './testFlowLayout'

const clients: QueryClient[] = []
const savedJob = { kind: 'job' as const, id: 'job-node', name: 'Build',
  jobDefinitionId: jobDefinition.id, jobDefinitionRevision: jobDefinition.revision, jobDefinitionVersionId: jobDefinition.versionId,
  position: { x: 1200, y: 40 }, size: { width: 200, height: 160 } }
beforeEach(() => { installFlowLayout() })
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks() })

async function mount(includeJob = false) {
  const selectSidePanel = vi.fn(), connectDraftNodes = vi.fn()
  const value: WorkflowBoardValue = { workspaceId: runA.workspaceId, workflowId: runA.workflowId,
    inspection: {}, selectInspection: vi.fn(), selectRun: vi.fn(), openLocation: vi.fn(), openRuns: vi.fn(),
    activeRuns: 0, selectSidePanel, connectDraftNodes, moveDraftNodes: vi.fn() }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const base = includeJob ? { ...runA, edges: [] } : runA
  const snapshot = includeJob ? { ...base, nodes: [...base.nodes, savedJob] } : base
  const definition = versionReply(base).version.definition
  const graph = includeJob ? attachJob(definition, { ...jobDefinition, workspaceId: runA.workspaceId, name: savedJob.name }, savedJob.id) : definition
  const inspect = (nodeId: string) => selectSidePanel({ kind: 'agent', nodeId, tab: 'details' })
  const router = createRouter({ routeTree: createRootRoute({ component: () => <WorkflowBoardProvider value={value}>
    <RunBoardCanvas snapshot={snapshot} definition={graph} onInspectNode={inspect} />
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

it.each([true, false])('keeps Jobs out of automatic Agent connections (Agent selected first: %s)', async agentFirst => {
  const { connectDraftNodes } = await mount(true)
  const first = screen.getByRole('button', { name: /^X before rename, / })
  const job = screen.getByRole('button', { name: /^Build, / })
  if (agentFirst) fireEvent.click(first)
  fireEvent.click(job)
  expect(job).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(first)
  expect(connectDraftNodes).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /^Y, / }))
  expect(connectDraftNodes).toHaveBeenCalledExactlyOnceWith('node-x', 'node-y')
})

it('offers saved Job settings and information without an Agent Chat action', async () => {
  const { selectSidePanel } = await mount(true)
  expect(screen.queryByRole('button', { name: 'Open Build chat' })).not.toBeInTheDocument()
  for (const [action, tab] of [['information', 'details'], ['settings', 'settings']] as const) {
    fireEvent.click(screen.getByRole('button', { name: `Open Build ${action}` }))
    expect(selectSidePanel).toHaveBeenLastCalledWith({ kind: 'agent', nodeId: savedJob.id, tab })
  }
})
