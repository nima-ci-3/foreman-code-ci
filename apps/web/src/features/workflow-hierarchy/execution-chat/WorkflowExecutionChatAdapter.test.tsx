// @vitest-environment jsdom
import { useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { collaborationContractFixtures, WorkflowExecutionChatTargetSchema, type WorkflowExecutionChatResolution,
  type WorkflowExecutionChatTarget } from '@foreman-code/contracts'
import { useConversationDraftStore, WorkflowExecutionConversation, agentChatContextKey } from '../../conversations'
import { server } from '../../../mocks/server'
import { BoardAuthoringContext } from '../../board-core'
import { createWorkflowExecutionChatSlot } from './createWorkflowExecutionChatSlot'
import { executionChatScopeKey } from './client'
import type { WorkflowExecutionChatSlotSelection, WorkflowExecutionChatViewProps,
  WorkflowOutsideRunChatViewProps } from './types'

const fixture = collaborationContractFixtures
const executionTarget = WorkflowExecutionChatTargetSchema.options[0].parse(fixture.executionReadback.target)
const coordinatorTarget = WorkflowExecutionChatTargetSchema.options[1].parse(fixture.consultationReadback.target)
const scope = { workspaceId: fixture.node.workspaceId, workflowId: fixture.node.workflowId }
const base = '*/api/workspaces/:workspaceId/workflows/:workflowId/execution-chat'
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); useConversationDraftStore.getState().clearAllDrafts() })

// These supplied views consume the public adapter contract. The factory, target
// resolution, validation and HTTP client are the production implementations.
function ExecutionChat({ client, resolved, queryKey }: WorkflowExecutionChatViewProps) {
  const read = useQuery({ queryKey, queryFn: ({ signal }) => client.read({ target: resolved.target }, { signal }), retry: false })
  return <section aria-label="Execution conversation">
    <p>{resolved.workflowVersionId}</p>
    <p>{resolved.target.kind === 'workflow_execution' ? resolved.target.execution.executionId : resolved.target.waitingActivationId}</p>
    {read.data?.messages.map(message => <p key={message.id}>{message.content}</p>)}
    {read.isError ? <p role="alert">{read.error.message}</p> : null}
  </section>
}
function OutsideRunChat({ resolved }: WorkflowOutsideRunChatViewProps) {
  return <section aria-label="Outside run conversation">Outside run · {resolved.workflowVersionId} · {resolved.agent.agentId}</section>
}
const slot = createWorkflowExecutionChatSlot({ ExecutionChat, OutsideRunChat })

function selected(target: WorkflowExecutionChatTarget = executionTarget): WorkflowExecutionChatResolution {
  return { kind: 'selected', target, agent: fixture.agent, workflowVersionId: fixture.execution.workflowVersionId,
    source: target.kind === 'workflow_execution' ? 'execution' : 'consultation',
    state: target.kind === 'workflow_execution' ? 'active' : 'waiting_children' }
}
function install(initial = selected()) {
  const controls = { resolution: initial, status: 200 }
  const resolutions: URL[] = []
  const reads: WorkflowExecutionChatTarget[] = []
  server.use(http.get(`${base}/target`, ({ request }) => {
    resolutions.push(new URL(request.url))
    if (controls.status !== 200) return HttpResponse.json({ error: {
      code: controls.status === 403 ? 'FORBIDDEN' : 'TEMPORARILY_UNAVAILABLE', message: 'Chat resolution failed',
    } }, { status: controls.status })
    return HttpResponse.json(controls.resolution)
  }), http.post(`${base}/read`, async ({ request }) => {
    const { target } = await request.json() as { target: WorkflowExecutionChatTarget }
    reads.push(target)
    return HttpResponse.json(target.kind === 'workflow_execution' ? fixture.executionReadback : fixture.consultationReadback)
  }))
  server.use(http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/summaries', () => HttpResponse.json({
    items: [{ runId: 'run', shortId: 'run', startedAt: '2026-10-01T00:00:00Z', status: 'succeeded', trigger: 'manual' }],
    pageInfo: { nextCursor: null },
  })))
  return { controls, resolutions, reads }
}
function mount(initial: Partial<WorkflowExecutionChatSlotSelection> = {}, currentAgentId?: string, chatSlot = slot) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(cache)
  function Shell() {
    const [visible, setVisible] = useState(true)
    const [pins, setPins] = useState({ ...scope, nodeId: fixture.node.workflowNodeId, ...initial })
    return <>
      <button onClick={() => setVisible(value => !value)}>Toggle chat</button>
      <output aria-label="Chat selection">{JSON.stringify(pins)}</output>
      {visible ? chatSlot({ ...pins, onSelectRun: run => setPins({ ...scope, nodeId: pins.nodeId, ...run }),
        onSelectTarget: (target, workflowVersionId) => setPins({ ...scope, nodeId: pins.nodeId, workflowVersionId,
          ...(target.kind === 'workflow_execution'
            ? { runId: target.execution.runId, executionId: target.execution.executionId }
            : { runId: target.runId, waitingActivationId: target.waitingActivationId }) }) }) : null}
    </>
  }
  render(<QueryClientProvider client={cache}><BoardAuthoringContext.Provider
    value={currentAgentId ? { draftNodeAgentId: () => currentAgentId } : null}><Shell /></BoardAuthoringContext.Provider></QueryClientProvider>)
  return cache
}

it.each(['execution', 'coordinator'] as const)('pins the resolved %s before mounting the supplied view and reading history', async kind => {
  const target = kind === 'execution' ? executionTarget : coordinatorTarget
  const wire = install(selected(target))
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Open Run run' }))
  await screen.findByText('Working on the task.')
  expect(wire.reads).toEqual([target])
  const pins = wire.resolutions.at(-1)!.searchParams
  expect(pins.get('runId')).toBe('run')
  expect(pins.get('workflowVersionId')).toBe('version')
  expect(pins.get(kind === 'execution' ? 'executionId' : 'waitingActivationId'))
    .toBe(kind === 'execution' ? 'execution' : 'activation')
  expect(pins.has(kind === 'execution' ? 'waitingActivationId' : 'executionId')).toBe(false)
})

it('requires an explicit Run choice, opens its attempt and never follows a successor on refresh', async () => {
  const wire = install({ kind: 'run_selection_required', items: [{ runId: 'run', workflowVersionId: 'version' }],
    revision: 1, nextCursor: null, hasMore: false })
  const cache = mount()
  await screen.findByRole('button', { name: 'Run run' })
  expect(wire.reads).toEqual([])
  const choice = selected()
  if (choice.kind !== 'selected') throw new Error('Expected selected fixture')
  const candidate = { target: choice.target, agent: choice.agent, workflowVersionId: choice.workflowVersionId,
    source: choice.source, state: choice.state }
  let pinned: WorkflowExecutionChatResolution = choice
  server.use(http.get(`${base}/target`, ({ request }) => HttpResponse.json(new URL(request.url).searchParams.get('executionId')
    ? pinned : { kind: 'selection_required', items: [candidate], revision: 1, nextCursor: null, hasMore: false })))
  fireEvent.click(screen.getByRole('button', { name: 'Run run' }))
  await screen.findByText('Working on the task.')
  pinned = selected({ ...executionTarget,
    execution: { ...fixture.execution, executionId: 'successor', activationId: 'successor-activation' } })
  await act(async () => { await cache.invalidateQueries({ queryKey: [...executionChatScopeKey(scope), 'selection'] }) })
  expect(await screen.findByRole('alert')).toHaveTextContent('another saved selection')
  expect(screen.getByLabelText('Chat selection')).toHaveTextContent('"executionId":"execution"')
  expect(wire.reads.every(target => target.kind === 'workflow_execution' && target.execution.executionId === 'execution')).toBe(true)
  expect(screen.queryByRole('region', { name: 'Execution conversation' })).not.toBeInTheDocument()
})

it('opens the latest attempt of a finished Run and keeps history switching available', async () => {
  const choice = selected()
  if (choice.kind !== 'selected') throw new Error('Expected selected fixture')
  const candidate = (executionId: string, attempt: number) => ({ target: { ...choice.target,
    execution: { ...fixture.execution, executionId, attempt } },
  agent: choice.agent, workflowVersionId: choice.workflowVersionId, source: choice.source, state: 'idle' as const })
  install()
  // Newest first, as the server lists them; attempt numbers restart for each activation.
  const items = [candidate('check', 1), candidate('execution', 2)]
  server.use(http.get(`${base}/target`, ({ request }) => {
    const pinned = items.find(item => item.target.execution.executionId === new URL(request.url).searchParams.get('executionId'))
    return HttpResponse.json(pinned ? { ...choice, target: pinned.target, state: 'idle' }
      : { kind: 'selection_required', items, revision: 1, nextCursor: null, hasMore: false })
  }))
  mount({ runId: 'run' })
  expect(await screen.findByRole('region', { name: 'Execution conversation' })).toHaveTextContent('check')
  expect(screen.getByLabelText('Chat selection')).toHaveTextContent('"executionId":"check"')
  fireEvent.click(screen.getByRole('button', { name: 'Other attempts' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Execution execution · Attempt 2' }))
  await waitFor(() => expect(screen.getByLabelText('Chat selection')).toHaveTextContent('"executionId":"execution"'))
})

it('opens the newest execution again for another Agent of the same Run', async () => {
  const choice = selected()
  if (choice.kind !== 'selected') throw new Error('Expected selected fixture')
  install()
  const item = (nodeId: string, executionId: string) => ({ target: { ...choice.target,
    agent: { ...choice.target.agent, workflowNodeId: nodeId }, execution: { ...fixture.execution, executionId } },
  agent: { ...choice.agent, workflowNodeId: nodeId }, workflowVersionId: choice.workflowVersionId, source: choice.source, state: 'idle' as const })
  server.use(http.get(`${base}/target`, ({ request }) => {
    const params = new URL(request.url).searchParams, node = params.get('workflowNodeId')!
    const items = [item(node, `${node}-new`), item(node, `${node}-old`)]
    const pinned = items.find(entry => entry.target.execution.executionId === params.get('executionId'))
    return HttpResponse.json(pinned ? { ...choice, agent: pinned.agent, target: pinned.target, state: 'idle' }
      : { kind: 'selection_required', items, revision: 1, nextCursor: null, hasMore: false })
  }))
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(cache)
  function Shell() {
    const [pins, setPins] = useState<Omit<WorkflowExecutionChatSlotSelection, 'onSelectRun' | 'onSelectTarget'>>(
      { ...scope, nodeId: 'first', runId: 'run' })
    return <>
      <button onClick={() => setPins({ ...scope, nodeId: 'second', runId: 'run' })}>Second Agent</button>
      <output aria-label="Chat selection">{JSON.stringify(pins)}</output>
      {slot({ ...pins, onSelectRun: run => setPins({ ...scope, nodeId: pins.nodeId, ...run }),
        onSelectTarget: (target, workflowVersionId) => setPins({ ...scope, nodeId: pins.nodeId, workflowVersionId,
          runId: 'run', ...(target.kind === 'workflow_execution' ? { executionId: target.execution.executionId } : {}) }) })}
    </>
  }
  render(<QueryClientProvider client={cache}><Shell /></QueryClientProvider>)
  await waitFor(() => expect(screen.getByLabelText('Chat selection')).toHaveTextContent('"executionId":"first-new"'))
  fireEvent.click(screen.getByRole('button', { name: 'Second Agent' }))
  await waitFor(() => expect(screen.getByLabelText('Chat selection')).toHaveTextContent('"executionId":"second-new"'))
})

it('retains transient status, hides denied history through a failed retry, and resumes only after a successful read', async () => {
  const wire = install()
  const cache = mount({ runId: 'run', workflowVersionId: 'version', executionId: 'execution' })
  await screen.findByText('Working on the task.')
  const refresh = () => act(async () => {
    await cache.invalidateQueries({ queryKey: [...executionChatScopeKey(scope), 'selection'] })
  })
  wire.controls.status = 503
  await refresh()
  await screen.findByRole('alert')
  expect(screen.getByText('Working on the task.')).toBeVisible()
  wire.controls.status = 403
  await refresh()
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Execution conversation' })).not.toBeInTheDocument())
  wire.controls.status = 503
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled())
  expect(screen.queryByText('Working on the task.')).not.toBeInTheDocument()
  expect(screen.getByLabelText('Chat selection')).toHaveTextContent('"executionId":"execution"')
  wire.controls.status = 200
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('Working on the task.')
})

it('mounts outside-run chat only for an unpinned current workflow and performs no hidden reads', async () => {
  const wire = install({ kind: 'outside_run', agent: fixture.node, workflowVersionId: 'version', reason: 'NO_LIVE_RUN' })
  const cache = mount()
  await screen.findByRole('region', { name: 'Outside run conversation' })
  expect(wire.reads).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: 'Toggle chat' }))
  const count = wire.resolutions.length
  await act(async () => { await cache.invalidateQueries({ queryKey: executionChatScopeKey(scope) }) })
  expect(wire.resolutions).toHaveLength(count)
  expect(wire.reads).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: 'Toggle chat' }))
  await screen.findByRole('region', { name: 'Outside run conversation' })
  await waitFor(() => expect(wire.resolutions).toHaveLength(count + 1))
})

it('recovers a missing exact execution by explicitly clearing only its attempt pin', async () => {
  const wire = install()
  wire.controls.status = 404
  mount({ runId: 'run', workflowVersionId: 'version', executionId: 'missing-execution' })
  await screen.findByRole('alert')
  expect(screen.getByLabelText('Chat selection')).toHaveTextContent('missing-execution')
  wire.controls.status = 200
  const choice = selected()
  if (choice.kind !== 'selected') throw new Error('Expected selected fixture')
  wire.controls.resolution = { kind: 'selection_required', items: [{ target: choice.target, agent: choice.agent,
    workflowVersionId: choice.workflowVersionId, source: choice.source, state: choice.state }], revision: 1, nextCursor: null, hasMore: false }
  fireEvent.click(screen.getByRole('button', { name: 'Other attempts' }))
  expect(await screen.findByRole('button', { name: 'Execution execution · Attempt 1' })).toBeInTheDocument()
  expect(screen.getByLabelText('Chat selection')).toHaveTextContent('"runId":"run"')
  expect(screen.getByLabelText('Chat selection')).toHaveTextContent('"workflowVersionId":"version"')
  expect(screen.getByLabelText('Chat selection')).not.toHaveTextContent('missing-execution')
})

it('keeps Current selected until a destination is chosen and opens separate chat with the Current Agent', async () => {
  const wire = install()
  mount({}, 'current-agent')
  expect(await screen.findByRole('button', { name: 'Open Run run' })).toBeInTheDocument()
  expect(screen.getByLabelText('Chat selection')).not.toHaveTextContent('"runId"')
  expect(wire.reads).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: 'Separate chat' }))
  expect(await screen.findByRole('region', { name: 'Outside run conversation' })).toHaveTextContent('current-agent')
  expect(screen.getByLabelText('Chat selection')).not.toHaveTextContent('"runId"')
  expect(wire.reads).toEqual([])
})

it.each(['NO_EXECUTION', 'NODE_UNAVAILABLE', 'WORKFLOW_UNAVAILABLE', 'missing-run', 'missing-version'] as const)(
  'offers an explicit destination escape from %s without losing the exact execution draft', async reason => {
    const wire = install()
    const choice = selected()
    if (choice.kind !== 'selected') throw new Error('Expected selected fixture')
    const candidate = { target: choice.target, agent: choice.agent, workflowVersionId: choice.workflowVersionId,
      source: choice.source, state: choice.state }
    server.use(http.get(`${base}/target`, ({ request }) => {
      const params = new URL(request.url).searchParams
      if (!params.has('runId')) return HttpResponse.json({ kind: 'run_selection_required',
        items: [{ runId: 'run', workflowVersionId: 'version' }], revision: 1, nextCursor: null, hasMore: false })
      if (params.has('executionId')) return HttpResponse.json(selected())
      if (params.get('runId') === 'run') return HttpResponse.json({ kind: 'selection_required', items: [candidate],
        revision: 1, nextCursor: null, hasMore: false })
      if (reason === 'missing-run' || reason === 'missing-version') return HttpResponse.json({ error: {
        code: reason === 'missing-run' ? 'RUN_NOT_FOUND' : 'WORKFLOW_VERSION_PIN_MISMATCH', message: 'Pinned destination unavailable',
      } }, { status: reason === 'missing-run' ? 404 : 409 })
      return HttpResponse.json({ kind: 'unavailable', reason })
    }), http.post('*/agent-chat/deliveries/read', async ({ request }) => {
      const input = await request.json() as { deliveryInputs?: unknown }
      return HttpResponse.json(input.deliveryInputs ? { target: executionTarget,
        deliveryInputs: { items: [], nextCursor: null, hasMore: false, revision: 1 } } : fixture.executionReadback)
    }))
    const draftKey = JSON.stringify([agentChatContextKey({ ...executionTarget.agent, runId: 'run' }), 'execution'])
    useConversationDraftStore.getState().setDraft(draftKey, 'Unsent exact execution question')
    const productionSlot = createWorkflowExecutionChatSlot({ ExecutionChat: WorkflowExecutionConversation, OutsideRunChat })
    mount({ runId: 'unavailable-run', workflowVersionId: 'unavailable-version' }, undefined, productionSlot)
    const escape = await screen.findByRole('button', { name: 'Choose chat destination' })
    expect(screen.getByLabelText('Chat selection')).toHaveTextContent('unavailable-run')
    fireEvent.click(escape)
    fireEvent.click(await screen.findByRole('button', { name: 'Run run' }))
    expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveValue('Unsent exact execution question')
    expect(wire.reads).toEqual([])
    expect(screen.getByLabelText('Chat selection')).not.toHaveTextContent('unavailable-version')
  })

it('escapes a missing exact pin even when clearing it reveals no executions in that Run', async () => {
  install()
  server.use(http.get(`${base}/target`, ({ request }) => {
    const params = new URL(request.url).searchParams
    return params.has('executionId') ? HttpResponse.json({ error: { code: 'EXECUTION_NOT_FOUND', message: 'Missing exact execution' } }, { status: 404 })
      : HttpResponse.json(params.has('runId') ? { kind: 'unavailable', reason: 'NO_EXECUTION' }
        : { kind: 'outside_run', agent: fixture.node, workflowVersionId: 'version', reason: 'NO_LIVE_RUN' })
  }))
  mount({ runId: 'run', workflowVersionId: 'version', executionId: 'missing-execution' })
  fireEvent.click(await screen.findByRole('button', { name: 'Other attempts' }))
  await screen.findByText(/This saved node has no available execution/)
  fireEvent.click(screen.getByRole('button', { name: 'Choose chat destination' }))
  fireEvent.click(screen.getByRole('button', { name: 'Current Agent' }))
  expect(await screen.findByRole('region', { name: 'Outside run conversation' })).toBeVisible()
  expect(screen.getByLabelText('Chat selection')).not.toHaveTextContent('runId')
})

it.each([true, false])('offers historical Runs when the Agent is unavailable in Current (pinned: %s)', async pinned => {
  install()
  server.use(http.get(`${base}/target`, ({ request }) => HttpResponse.json(new URL(request.url).searchParams.get('runId') === 'run'
    ? { ...selected(), state: 'idle' } : { kind: 'unavailable', reason: 'NODE_UNAVAILABLE' })),
  http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/summaries', () => HttpResponse.json({
    items: [{ runId: 'run', shortId: 'run', startedAt: '2026-10-01T00:00:00Z', status: 'succeeded', trigger: 'manual' }],
    pageInfo: { nextCursor: null },
  })))
  mount(pinned ? { runId: 'unavailable-run', workflowVersionId: 'unavailable-version' } : {})
  fireEvent.click(await screen.findByRole('button', { name: 'Choose chat destination' }))
  const choice = await screen.findByRole('button', { name: 'Run run' })
  expect(screen.getByLabelText('Chat selection')).toHaveTextContent(pinned ? 'unavailable-run' : 'master')
  expect(screen.queryByRole('region', { name: 'Execution conversation' })).not.toBeInTheDocument()
  fireEvent.click(choice)
  expect(await screen.findByText('Working on the task.')).toBeVisible()
  expect(screen.getByLabelText('Chat selection')).toHaveTextContent('"runId":"run"')
  expect(screen.getByLabelText('Chat selection')).not.toHaveTextContent('unavailable-version')
})


it('labels the attempt and separates its history control in plain words', async () => {
  install()
  mount({ runId: 'run', workflowVersionId: 'version', executionId: 'execution' })
  await screen.findByText('Working on the task.')
  expect(screen.getByTestId('agent-chat-scope')).toHaveTextContent('Attempt 1 · Other attempts')
  fireEvent.click(screen.getByRole('button', { name: 'Other attempts' }))
  expect(screen.getByLabelText('Chat selection')).not.toHaveTextContent('"executionId"')
})

it('discovers an execution that starts after its Run chat was opened', async () => {
  const wire = install({ kind: 'unavailable', reason: 'NO_EXECUTION' })
  mount({ runId: 'run', workflowVersionId: 'version' })
  await screen.findByText(/This saved node has no available execution/)
  wire.controls.resolution = selected()
  expect(await screen.findByText('Working on the task.', {}, { timeout: 7000 })).toBeVisible()
  expect(screen.getByLabelText('Chat selection')).toHaveTextContent('"executionId":"execution"')
})

it('prepares each newly selected draft Agent instead of retaining the previous Agent preparation flags', async () => {
  install()
  const saved = new Set<string>()
  const saveChatAgent = vi.fn(async (nodeId: string) => { saved.add(nodeId); return undefined })
  server.use(http.get(`${base}/target`, ({ request }) => {
    const nodeId = new URL(request.url).searchParams.get('workflowNodeId')!
    return HttpResponse.json(saved.has(nodeId) ? { kind: 'outside_run', reason: 'NO_LIVE_RUN',
      agent: { ...fixture.node, workflowNodeId: nodeId }, workflowVersionId: 'version' }
      : { kind: 'unavailable', reason: 'NODE_UNAVAILABLE' })
  }))
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(cache)
  function Shell() {
    const [nodeId, setNodeId] = useState('first')
    return <><button onClick={() => setNodeId('second')}>Next draft Agent</button>
      {slot({ ...scope, nodeId, onSelectRun: () => undefined, onSelectTarget: () => undefined })}</>
  }
  render(<QueryClientProvider client={cache}><BoardAuthoringContext.Provider value={{
    draftNodeAgentId: nodeId => `agent-${nodeId}`, saveChatAgent,
  }}><Shell /></BoardAuthoringContext.Provider></QueryClientProvider>)
  await screen.findByRole('region', { name: 'Outside run conversation' })
  expect(saveChatAgent).toHaveBeenCalledWith('first')
  fireEvent.click(screen.getByRole('button', { name: 'Next draft Agent' }))
  await waitFor(() => expect(saveChatAgent).toHaveBeenCalledWith('second'))
  expect(await screen.findByRole('region', { name: 'Outside run conversation' })).toBeVisible()
})
