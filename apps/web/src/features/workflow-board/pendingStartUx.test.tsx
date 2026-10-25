import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { RunStartCurrentInputSchema } from '@foreman-code/contracts/current'
import { server } from '../../mocks/server'
import { deferred } from '../../test/deferred'
import { useGraphDraftStore } from '../graph'
import { nextDraftKey } from '../board-core'
import { boardStartJournalKey, readBoardStart, reserveBoardStart } from './startOutbox'
import { installBoardTestLifecycle, mountMeasuredBoard, type InspectionFixture } from './eng05D.testSupport'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'

installBoardTestLifecycle()
let fixture: InspectionFixture
beforeEach(async () => {
  fixture = await inspectionBoardFixture('pending-start-ux')
  fixture.mock.controls.start = true
  server.use(...fixture.mock.handlers,
    http.get('*/api/browser/profiles', () => HttpResponse.json({ profiles: [], replicas: [], presentReplicas: [], pendingReplicas: [], nextCursor: null, revision: 0 })))
})
const href = () => `/workspaces/${fixture.mock.workspaceId}?workflowId=${fixture.after.workflowId}`
const runsPath = () => `*/api/management/workspaces/${fixture.mock.workspaceId}/workflows/${fixture.after.workflowId}/runs`

it('reconciles an accepted Start on remount without leaving the selected historical Run', async () => {
  const { mock, after, runs } = fixture
  const key = nextDraftKey(mock.workspaceId, after.workflowId)
  const mounted = await mountMeasuredBoard(href())
  await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]).toBeDefined())
  const retained = useGraphDraftStore.getState().nextDrafts[key]!
  mounted.unmount(); mounted.cache.clear()
  const pending = RunStartCurrentInputSchema.parse({ workspaceId: mock.workspaceId, workflowId: after.workflowId,
    workflowVersionId: after.id, executionSemanticsVersion: 3, expectedWorkflowRevision: retained.context.draft.publishedRevision,
    expectedAgentConfigurationVersionIds: after.agentConfigurationVersionIds,
    expectedLocationRevision: mock.controls.locationRevision, commandId: crypto.randomUUID(), input: {} })
  await reserveBoardStart(key, pending)
  const accepted = { ...runs.after.run, executionLocation: { runnerId: 'runner-synthetic', rootPath: '/synthetic/board',
    locationRevision: mock.controls.locationRevision, identityHash: `sha256:${'0'.repeat(64)}` } }
  const reply = deferred<Response>(), resolved: unknown[] = [], sent: unknown[] = []
  server.use(http.post(`${runsPath()}/start-resolution`, async ({ request }) => {
    resolved.push(await request.json())
    return reply.promise
  }), http.post(runsPath(), async ({ request }) => {
    sent.push(await request.json())
    return HttpResponse.json({ accepted: true, replayed: true, run: accepted })
  }))
  const reopened = await mountMeasuredBoard(`${href()}&selectedRunId=${runs.before.run.id}`)
  await screen.findByRole('region', { name: 'Selected Run board' })
  await waitFor(() => expect(resolved).toEqual([pending]))
  await act(async () => { reply.resolve(HttpResponse.json({ status: 'accepted', run: accepted })) })
  await waitFor(() => {
    expect(readBoardStart(key)).toBeUndefined()
    expect(reopened.router.state.status).toBe('idle')
  })
  expect(reopened.router.state.location.search.selectedRunId).toBe(runs.before.run.id)
  expect(screen.getByRole('region', { name: 'Selected Run board' })).toBeVisible()
  expect(screen.getByText('Selected Run', { selector: 'span' })).toBeVisible()
  expect(useGraphDraftStore.getState().nextDrafts[key]!.instanceId).toBe(retained.instanceId)
  expect(sent).toEqual([])
}, 15_000)

it('resolves a failed Start without resending it, keeps its real error and restores Run', async () => {
  const error = 'The Worker did not report its running bundle (transport). Retry shortly.'
  const sent: unknown[] = [], resolved: unknown[] = []
  server.use(http.post(runsPath(), async ({ request }) => {
    sent.push(await request.json())
    return HttpResponse.json({ error: { code: 'WORKER_BUNDLE_UNAVAILABLE', message: error } }, { status: 503 })
  }), http.post(`${runsPath()}/start-resolution`, async ({ request }) => {
    resolved.push(await request.json())
    return HttpResponse.json({ status: 'canceled' })
  }))
  await mountMeasuredBoard(href())
  const start = await screen.findByRole('button', { name: 'Start saved version' })
  await waitFor(() => expect(start).toBeEnabled())
  await userEvent.click(start)
  const confirm = await screen.findByRole('button', { name: 'Reconcile Start' })
  expect(confirm).toHaveTextContent('Confirm start')
  await userEvent.click(confirm)
  await waitFor(() => expect(resolved).toEqual([sent[0]]))
  const retry = await screen.findByRole('button', { name: 'Start saved version' })
  expect(retry).toHaveTextContent(/^Run$/)
  expect(retry).toBeEnabled()
  expect(screen.getByText(error)).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Reconcile Start' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Reload saved draft' })).not.toBeInTheDocument()
  expect(sent).toHaveLength(1)
}, 15_000)

it('resolves an unaccepted Start from an earlier session on load and saves Agent settings', async () => {
  const { mock, after, first } = fixture
  const draft = mock.drafts.get(after.workflowId)!
  const pending = RunStartCurrentInputSchema.parse({ workspaceId: mock.workspaceId, workflowId: after.workflowId,
    workflowVersionId: after.id, executionSemanticsVersion: 3, expectedWorkflowRevision: draft.publishedRevision,
    expectedAgentConfigurationVersionIds: after.agentConfigurationVersionIds,
    expectedLocationRevision: mock.controls.locationRevision, commandId: crypto.randomUUID(), input: {} })
  localStorage.setItem(boardStartJournalKey(nextDraftKey(mock.workspaceId, after.workflowId)), JSON.stringify(pending))
  const resolved: unknown[] = []
  server.use(http.post(`${runsPath()}/start-resolution`, async ({ request }) => {
    resolved.push(await request.json())
    return HttpResponse.json({ status: 'canceled' })
  }))
  await mountMeasuredBoard(href())
  await waitFor(() => expect(resolved).toEqual([pending]))
  expect(await screen.findByText('The earlier start was not accepted. You can run the workflow again.')).toBeVisible()
  await userEvent.click(await screen.findByRole('button', { name: `Open ${first.name} settings` }))
  const panel = within(await screen.findByRole('complementary', { name: 'Workflow side panel' }))
  await userEvent.click(panel.getByText('More settings'))
  const prompt = panel.getByRole('textbox', { name: 'Initial prompt' })
  await userEvent.clear(prompt)
  // One paste keeps this full-suite test inside its timeout; typing key by key added nothing it checks.
  await userEvent.paste('Saved after resolving the earlier start')
  await userEvent.click(panel.getByRole('button', { name: 'Save agent settings and workflow' }))
  expect(await screen.findByText('Saved.')).toBeVisible()
  expect(mock.versions.get(mock.drafts.get(after.workflowId)!.baseWorkflowVersionId!)!.definition.nodes[0])
    .toMatchObject({ id: first.id, initialPrompt: 'Saved after resolving the earlier start' })
  expect(screen.queryByRole('button', { name: 'Reconcile Start' })).not.toBeInTheDocument()
  expect([...mock.runs.values()].map(({ run }) => run.id)).toEqual(Object.values(fixture.runs).map(({ run }) => run.id))
}, 15_000)
