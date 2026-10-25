// @vitest-environment jsdom
import { type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { CANONICAL_RUN_GRAPH_ROUTES, makeCurrentWorkflowFixture, RepeatGraphCurrentStateSchema, repeatGraphTopologyCurrent } from '@foreman-code/contracts/current'
import { server } from '../../mocks/server'
import { useRunLiveNodes } from './useRunLiveNodes'

const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })

function mount(work: boolean, failures: { current: boolean; handoffs: boolean }) {
  const fixture = makeCurrentWorkflowFixture('live-node-read', 'single')
  const identity = fixture.identities[0]!
  const record = RepeatGraphCurrentStateSchema.parse({ kind: 'current', protocolVersion: 1, scope: fixture.scope,
    topology: repeatGraphTopologyCurrent(fixture.version), asOfSequence: '1', retentionFloor: '0', historyCoverage: 'from_admission',
    state: { run: { executionState: 'completed', outcome: 'succeeded', stopRequested: false,
      cleanupPending: false, unsettledReviewCount: 0, pendingInteractionCount: 0 },
    nodes: [{ state: { workflowNodeId: identity.workflowNodeId, lifecycle: 'succeeded', execution: identity },
      activity: { workflowNodeId: identity.workflowNodeId, status: 'none' },
      attention: { workflowNodeId: identity.workflowNodeId, pendingInteractionCount: 0, unsettledReviewCount: 0,
        cleanupPending: false, telemetry: 'current' } }],
    executions: [{ identity: { ...identity, occurrence: null }, state: 'completed', resultOutcome: 'succeeded',
      previousExecutionId: null, inputDigest: `sha256:${'1'.repeat(64)}`, ...(work ? { workActivationId: 'activation' } : {}) }],
    inputBindings: [], interactions: [], reviews: [], occurrences: [], resolutions: [], results: [], bindings: [], decisions: [] } })
  const failure = () => HttpResponse.json({ error: { code: 'TEMPORARILY_UNAVAILABLE', message: 'Read unavailable' } }, { status: 503 })
  server.use(http.get(`*${CANONICAL_RUN_GRAPH_ROUTES.current}`, () =>
    failures.current ? failure() : HttpResponse.json(record)),
  http.get('*/api/management/workspaces/:workspaceId/runs/:runId/handoffs', () => failures.handoffs ? failure() : HttpResponse.json({
    scope: fixture.scope, policy: 'work', runState: 'completed', connections: [], routes: [], notices: [],
    unresolved: [], directionWait: false, transfers: [],
  })))
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(cache)
  const names = new Map([[identity.workflowNodeId, 'Worker']]), cis = new Map(), edges: [] = []
  const result = renderHook(() => useRunLiveNodes(fixture.scope, names, cis, true, edges), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={cache}>{children}</QueryClientProvider>,
  })
  return { ...result, nodeId: identity.workflowNodeId }
}

it('reports unavailable Run facts instead of draft state and recovers on a successful refresh', async () => {
  const failures = { current: true, handoffs: false }
  const view = mount(false, failures)
  await waitFor(() => expect(view.result.current.nodes?.get(view.nodeId)).toEqual({ state: 'unavailable', label: 'Run state unavailable' }))
  expect(view.result.current.error).toBeTruthy()
  failures.current = false
  act(() => view.result.current.refresh())
  await waitFor(() => expect(view.result.current.nodes?.get(view.nodeId)?.label).toBe('Completed'))
  expect(view.result.current.error).toBeFalsy()
})

it('holds the node cut when its hand-off read fails and advances it after recovery', async () => {
  const failures = { current: false, handoffs: true }
  const view = mount(true, failures)
  await waitFor(() => expect(view.result.current.error).toBeTruthy())
  expect(view.result.current.nodes?.get(view.nodeId)?.label).toBe('Run state unavailable')
  failures.handoffs = false
  act(() => view.result.current.refresh())
  await waitFor(() => expect(view.result.current.nodes?.get(view.nodeId)?.label).toBe('Completed'))
})
