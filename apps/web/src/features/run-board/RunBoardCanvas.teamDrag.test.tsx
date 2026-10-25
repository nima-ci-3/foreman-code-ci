import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Agent } from '@foreman-code/contracts'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { WorkflowBoardProvider, nextDraftKey, type GraphGeometryChange, type WorkflowBoardValue } from '../board-core'
import { useGraphDraftStore } from '../graph'
import { fixture } from '../graph/nextDraft/core.cases'
import { RunBoardCanvas } from './RunBoardCanvas'
import { pinnedRunHandlers, runA, scope, versionReply } from './testFixtures'
import { installFlowLayout } from './testFlowLayout'

const clients: QueryClient[] = []
beforeEach(() => {
  installFlowLayout(1000, 720)
  server.use(...pinnedRunHandlers(scope), http.get('*/api/management/workspaces/:workspaceId/runs/:runId/subagents', () =>
    HttpResponse.json({ items: [], nextCursor: null, projection: 'caught-up' })))
})
afterEach(() => {
  cleanup(); clients.splice(0).forEach(client => client.clear())
  useGraphDraftStore.getState().clearAllDrafts(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

function placed(id: string) {
  const node = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!
  const [, x, y] = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(node.style.transform)!
  return { x: Number(x), y: Number(y) }
}

function drag(id: string) {
  const core = screen.getByRole('button', { name: new RegExp(`^${runA.nodes.find(node => node.id === id)!.name}, `) })
  const view = core.ownerDocument.defaultView!
  for (const [type, x, y] of [['mousedown', 100, 100], ['mousemove', 160, 150], ['mousemove', 220, 200], ['mouseup', 220, 200]] as const) {
    const event = new view.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' ? 0 : 1 })
    Object.defineProperty(event, 'view', { value: view })
    act(() => { (type === 'mousedown' ? core : view).dispatchEvent(event) })
  }
}

async function mount(hierarchy: boolean) {
  const context = fixture(['orchestrator', 'coder', 'coder'])
  const graph = versionReply(runA).version.definition
  graph.nodes = graph.nodes.map(node => ({ ...node, position: { ...node.position!, manual: true } }))
  if (hierarchy) graph.hierarchy = { version: 1, masterNodeId: 'node-x', parents: [
    { workflowNodeId: 'node-y', parentNodeId: 'node-x' }, { workflowNodeId: 'node-z', parentNodeId: 'node-y' },
  ] }
  context.draft = { ...context.draft, workspaceId: graph.workspaceId, workflowId: graph.id, graph }
  context.agents = context.agents.map((entry, index) => ({ ...entry, agent: { ...entry.agent,
    id: `agent-${['x', 'y', 'z'][index]}`, productRole: (hierarchy ? ['master', 'orchestrator', 'coder'] : ['orchestrator', 'coder', 'coder'])[index] as Agent['productRole'] } }))
  const key = nextDraftKey(graph.workspaceId, graph.id)
  useGraphDraftStore.getState().installNextDraft(key, context)
  const move = vi.fn()
  const value: WorkflowBoardValue = { workspaceId: runA.workspaceId, workflowId: runA.workflowId,
    inspection: {}, selectInspection: vi.fn(), selectRun: vi.fn(), openLocation: vi.fn(), openRuns: vi.fn(),
    activeRuns: 0, selectSidePanel: vi.fn(), moveDraftNodes: move }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  const router = createRouter({ routeTree: createRootRoute({ component: () => <WorkflowBoardProvider value={value}>
    <RunBoardCanvas snapshot={runA} definition={graph} onInspectNode={vi.fn()} />
  </WorkflowBoardProvider> }), history: createMemoryHistory({ initialEntries: ['/'] }) })
  await router.load()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  await screen.findByRole('button', { name: /^X before rename, / })
  return move
}

it.each([false, true])('moves the Run leader and its draft team together (hierarchy: %s)', async hierarchy => {
  const originalSnapshot = structuredClone(runA)
  const move = await mount(hierarchy)
  const before = Object.fromEntries(runA.nodes.map(node => [node.id, placed(node.id)]))
  drag('node-x')
  await waitFor(() => expect(move).toHaveBeenCalledOnce())
  const changes = move.mock.calls[0]![0] as GraphGeometryChange[]
  const ids = hierarchy ? ['node-x', 'node-y', 'node-z'] : ['node-x', 'node-y']
  expect(changes.map(change => change.id).sort()).toEqual(ids)
  const leader = changes.find(change => change.id === 'node-x')!.position!
  const delta = { x: leader.x - before['node-x']!.x, y: leader.y - before['node-x']!.y }
  expect(delta.x).toBeGreaterThan(0); expect(delta.y).toBeGreaterThan(0)
  for (const id of ids) {
    const position = { x: before[id]!.x + delta.x, y: before[id]!.y + delta.y }
    expect(changes.find(change => change.id === id)!.position).toEqual(position)
    expect(placed(id)).toEqual(position)
  }
  expect(runA).toEqual(originalSnapshot)
})
