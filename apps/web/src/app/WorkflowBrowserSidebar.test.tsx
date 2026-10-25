import { createRef } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it, vi } from 'vitest'
import type { BrowserSession } from '@foreman-code/contracts'
import { currentWorkflowFixture } from '../shared/mocks/currentWorkflow'
import { server } from '../mocks/server'
import { browserRead, subject } from '../features/agent-browser/testFixtures'
import { RunsSelectorSearchSchema } from '../features/runs-selector'
import { useBrowserSidebarTabs, WorkflowSidePanel } from '../features/workflow-board'
import { installBoardTestLifecycle, newBoardQueryClient } from '../features/workflow-board/eng05D.testSupport'
import { WorkflowBrowserSidebar } from './WorkflowBrowserSidebar'
import { browserSessionClient } from './browserRecovery'
import browserStyles from '../features/agent-browser/browserSidebar.css?inline'

installBoardTestLifecycle()

async function mountSidebar(options: { startedAt?: string; runtime?: unknown; chat?: boolean; sessions?: BrowserSession[]; pages?: boolean; initialEntry?: string; preserveTabs?: boolean } = {}) {
  if (!options.preserveTabs) useBrowserSidebarTabs.setState({ opened: {}, closed: {}, pages: {} })
  const sessions: BrowserSession[] = options.sessions ?? [
    { ...browserRead('chat-session').session, subject: { kind: 'conversation', agent: subject.agent, conversationId: 'conversation' } },
    { ...browserRead('run-session').session, ...(options.startedAt ? { startedAt: options.startedAt } : {}) },
    { ...browserRead('retry-session').session, subject: { ...subject, kind: 'execution', execution: {
      runId: 'run', workflowVersionId: 'version', executionId: 'retry-execution', attempt: 2 } } },
  ]
  const targets: Record<string, unknown>[] = []
  server.use(
    http.get('/api/management/workspaces/workspace/workflows/workflow', () => HttpResponse.json({
      workflow: { ...currentWorkflowFixture().version.definition, id: 'workflow', workspaceId: 'workspace', name: 'Website',
        nodes: [...new Map(sessions.map(session => [session.subject!.agent.workflowNodeId, {
          id: session.subject!.agent.workflowNodeId, agentId: session.subject!.agent.agentId, name: session.subject!.agent.displayName,
        }])).values()] }, revision: 1, currentVersionId: 'version', archivedAt: null })),
    http.get('/api/devices/main', () => HttpResponse.json({ mainId: '11111111-1111-4111-8111-111111111111',
      mainPublicKey: 'fixture-key', mainPublicKeyFingerprint: 'a'.repeat(64) })),
    http.get('/api/devices', () => HttpResponse.json({ devices: [] })),
    http.post('/api/management/computers/maintenance/read', async ({ request }) => {
      const { target } = await request.json() as { target: unknown }
      return HttpResponse.json({ computers: [{ target, status: null }] })
    }),
    http.get('/api/browser/profiles', () => HttpResponse.json({ profiles: [], replicas: [], presentReplicas: [], pendingReplicas: [], nextCursor: null, revision: 0 })),
    http.get('/api/browser/sessions', () => HttpResponse.json({ sessions, nextCursor: null, ...(options.runtime ? { runtime: options.runtime } : {}) })),
    http.post('/api/browser/sessions/:id/input', () => HttpResponse.json(null)),
    http.get('/api/browser/sessions/:id', ({ params }) => {
      const read = browserRead(String(params.id))
      if (options.pages) {
        read.tabs[0]!.title = `${sessions.find(session => session.id === params.id)?.subject?.agent.displayName} page`
        read.tabs.push({ ...read.tabs[0]!, id: 'report-lease', tabId: 'report', title: 'Report page', url: 'https://fixture.test/report' })
      }
      if (sessions.find(session => session.id === params.id)?.state === 'closed') {
        read.tabs = []
        read.files = [{ id: 'download', name: 'report.txt', mimeType: 'text/plain', byteLength: 3,
          receivedBytes: 3, state: 'ready', purpose: 'download' }]
      }
      return HttpResponse.json({ ...read, files: read.files.map(file => ({ ...file, sha256: null })),
        session: sessions.find(session => session.id === params.id) })
    }),
    http.get('/api/browser/target', ({ request }) => {
      const input = JSON.parse(new URL(request.url).searchParams.get('input')!)
      targets.push(input)
      const session = sessions.find(item => item.subject?.agent.workflowNodeId === input.workflowNodeId
        && (!input.executionId || item.subject.kind === 'execution' && item.subject.execution.executionId === input.executionId))
      if (options.pages && session) return HttpResponse.json({ kind: 'selected', subject: session.subject,
        browser: { enabled: true, profileId: 'profile' }, computerId: 'main', historical: session.state === 'closed', readOnly: true })
      return HttpResponse.json({ kind: 'unavailable', reason: 'node_unavailable' })
    }),
  )
  const opener = createRef<HTMLElement>()
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId',
    validateSearch: RunsSelectorSearchSchema.parse,
    component: () => <>
      {options.chat ? <WorkflowSidePanel scope="browser-test" workspaceId="workspace" workflowId="workflow" opener={opener}
        selection={{ kind: 'agent', nodeId: 'node', tab: 'chat' }} agentSelection={{ kind: 'agent', nodeId: 'node', tab: 'chat' }}
        savedNodeName="Builder chat" onSelect={() => undefined} onSelectTarget={() => undefined} onSelectRun={() => undefined}
        bodyRef={() => undefined} modalOpen={false} slots={{ executionChat: () => <p>Agent chat stays open</p> }} /> : null}
      <WorkflowBrowserSidebar workspaceId="workspace" workflowId="workflow" runId="run" workflowVersionId="version" />
    </> })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({
    initialEntries: [options.initialEntry ?? '/workspaces/workspace?workflowId=workflow&selectedRunId=run&boardBrowsers=1'],
  }) })
  await router.load()
  const view = render(<QueryClientProvider client={newBoardQueryClient()}><RouterProvider router={router} /></QueryClientProvider>)
  await screen.findByRole('tab', { name: 'Builder' })
  return { targets, router, view }
}

it('omits the browser context picker when the Agent has only one context', async () => {
  const { targets } = await mountSidebar({ sessions: [browserRead('run-session').session] })
  await waitFor(() => expect(targets.length).toBeGreaterThan(0))
  expect(screen.queryByRole('combobox', { name: 'Browser context' })).not.toBeInTheDocument()
})

it('keeps the selected page when switching Agent tabs and reopening the app at the same link', async () => {
  vi.spyOn(browserSessionClient, 'openView').mockResolvedValue({ close: async () => undefined })
  vi.spyOn(browserSessionClient, 'releasePressed').mockResolvedValue(undefined)
  const first = browserRead('run-session').session
  const second: BrowserSession = { ...browserRead('review-session').session, subject: { ...subject,
    agent: { ...subject.agent, workflowNodeId: 'reviewer', agentId: 'review-agent', displayName: 'Reviewer' } } }
  const { router, view } = await mountSidebar({ sessions: [first, second], pages: true })
  await userEvent.click(await screen.findByRole('tab', { name: 'Report page' }))
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Report page' })).toHaveAttribute('aria-selected', 'true'))
  await userEvent.click(screen.getByRole('tab', { name: 'Reviewer' }))
  expect(await screen.findByRole('tab', { name: 'Reviewer page', selected: true })).toBeVisible()
  expect(router.state.location.search.browserSessionId).toBe('review-session')
  await userEvent.click(screen.getByRole('tab', { name: 'Builder' }))
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Report page' })).toHaveAttribute('aria-selected', 'true'))
  expect(router.state.location.search.browserTabId).toBe('report')
  const initialEntry = router.state.location.href
  view.unmount()
  await mountSidebar({ sessions: [first, second], pages: true, initialEntry })
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Report page' })).toHaveAttribute('aria-selected', 'true'))
}, 15_000)

it('reopens retained Agent downloads from the workflow after its browser has ended and the app reopens', async () => {
  const capture = vi.spyOn(browserSessionClient, 'openView').mockResolvedValue({ close: async () => undefined })
  vi.spyOn(browserSessionClient, 'releasePressed').mockResolvedValue(undefined)
  const session = browserRead('run-session').session
  const { view } = await mountSidebar({ sessions: [session], pages: true })
  await screen.findByRole('tab', { name: 'Builder page' })
  const captureCount = capture.mock.calls.length
  const savedTabs = localStorage.getItem('foreman-browser-sidebar-tabs')!
  view.unmount()
  session.state = 'closed'; session.selectedTabId = null
  useBrowserSidebarTabs.setState({ opened: {}, closed: {}, pages: {} })
  localStorage.setItem('foreman-browser-sidebar-tabs', savedTabs)
  await useBrowserSidebarTabs.persist.rehydrate()
  await mountSidebar({ sessions: [session], pages: true, preserveTabs: true })
  await userEvent.click(await screen.findByRole('button', { name: /Downloads.*ended/i }))
  expect(await screen.findByRole('button', { name: 'Save file' })).toBeVisible()
  expect(capture).toHaveBeenCalledTimes(captureCount)
}, 15_000)

it('opens an ended attempt’s downloads while the same Agent has a live browser, including after reopening its link', async () => {
  const capture = vi.spyOn(browserSessionClient, 'openView').mockResolvedValue({ close: async () => undefined })
  vi.spyOn(browserSessionClient, 'releasePressed').mockResolvedValue(undefined)
  const live: BrowserSession = { ...browserRead('retry-session').session, subject: { ...subject, kind: 'execution',
    execution: { ...subject.execution, executionId: 'retry-execution', attempt: 2 } } }
  const ended: BrowserSession = { ...browserRead('finished-session').session, state: 'closed', selectedTabId: null }
  const { router, view, targets } = await mountSidebar({ sessions: [live, ended], pages: true })
  await screen.findByRole('tab', { name: 'Builder page' })
  const captureCount = capture.mock.calls.length
  await userEvent.click(screen.getByText('Browser downloads', { selector: 'summary' }))
  await userEvent.click(await screen.findByRole('button', { name: /Downloads.*Attempt 1/ }))
  expect(await screen.findByRole('button', { name: 'Save file' })).toBeVisible()
  expect(targets.at(-1)).toMatchObject({ executionId: 'execution' })
  expect(capture).toHaveBeenCalledTimes(captureCount)
  const initialEntry = router.state.location.href
  view.unmount()
  await mountSidebar({ sessions: [live, ended], pages: true, initialEntry })
  expect(await screen.findByRole('button', { name: 'Save file' })).toBeVisible()
  expect(capture).toHaveBeenCalledTimes(captureCount)
}, 15_000)

it('keeps chat and execution browser sessions selectable within the Agent tab', async () => {
  const { targets } = await mountSidebar()
  const picker = await screen.findByRole('combobox', { name: 'Browser context' })
  expect(within(picker).getAllByRole('option')).toHaveLength(3)
  expect(picker).toHaveValue('run-session')
  await waitFor(() => expect(targets.at(-1)).toMatchObject({ runId: 'run', executionId: 'execution' }))
  await userEvent.selectOptions(picker, 'retry-session')
  await waitFor(() => expect(targets.at(-1)).toMatchObject({ runId: 'run', executionId: 'retry-execution' }))
  await userEvent.selectOptions(picker, 'chat-session')
  await waitFor(() => expect(targets.at(-1)).not.toHaveProperty('runId'))
  expect(picker).toHaveValue('chat-session')
}, 15_000)

it('offers closed live browsers for reopening instead of claiming none are active', async () => {
  await mountSidebar()
  await userEvent.click(screen.getByRole('button', { name: 'Close Builder browser' }))
  expect(await screen.findByText(/Active browsers are hidden/)).toBeVisible()
  expect(screen.queryByText('No agent browsers are active in this run.')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Reopen Builder browser' }))
  expect(await screen.findByRole('tab', { name: 'Builder' })).toHaveAttribute('aria-selected', 'true')
}, 15_000)


it('moves the browser window while its Agent chat stays independently usable', async () => {
  await mountSidebar({ chat: true })
  const panel = screen.getByRole('complementary', { name: 'Agent browsers' })
  const chat = screen.getByRole('complementary', { name: 'Workflow side panel' })
  const chatPosition = [chat.style.left, chat.style.top]
  const title = screen.getByRole('heading', { name: 'Agent browsers' })
  const left = panel.style.left, top = panel.style.top
  fireEvent(title, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 30, clientY: 40 }))
  fireEvent(window, new MouseEvent('pointermove', { clientX: 180, clientY: 160 }))
  fireEvent(window, new MouseEvent('pointerup'))
  expect(panel.style.left).not.toBe(left)
  expect(panel.style.top).not.toBe(top)
  expect(within(panel).getByRole('tab', { name: 'Builder' })).toBeVisible()
  expect([chat.style.left, chat.style.top]).toEqual(chatPosition)
  expect(within(chat).getByText('Agent chat stays open')).toBeVisible()
  fireEvent.pointerDown(chat)
  expect(Number(chat.style.zIndex)).toBeGreaterThan(Number(panel.style.zIndex))
})

it('names browser contexts with the workflow, Agent and start time', async () => {
  const startedAt = '2026-10-24T10:30:00.000Z'
  await mountSidebar({ startedAt })
  const picker = screen.getByRole('combobox', { name: 'Browser context' })
  await waitFor(() => expect(within(picker).getByRole('option', { selected: true })).toHaveTextContent(
    `Website · Builder · ${new Date(startedAt).toLocaleString()}`))
  expect(picker).not.toHaveTextContent('run-session')
  expect(picker).not.toHaveTextContent('retry-session')
})

it('explains a reachable computer runtime failure and preserves its real reason in details', async () => {
  const reason = 'Chromium: No usable sandbox! Install the Foreman AppArmor profile runtime/browser/apparmor/foreman-browser-runtime.'
  await mountSidebar({ runtime: { computerId: 'main', ready: false, phase: 'failed', reason } })
  expect(await screen.findByText(/agent browser isn't installed yet: Chromium can't start its sandbox/)).toBeVisible()
  expect(screen.queryByText(/could not be reached/)).not.toBeInTheDocument()
  await userEvent.click(screen.getByText('Browser runtime details', { selector: 'summary' }))
  expect(screen.getByText(reason)).toBeVisible()
})


it('keeps expanded installation diagnostics inside a scrollable window area', async () => {
  render(<style>{browserStyles}</style>)
  const reason = `Chromium: No usable sandbox!\n${'Installer command and stderr diagnostics.\n'.repeat(300)}End of installation diagnostics.`
  await mountSidebar({ runtime: { computerId: 'main', ready: false, phase: 'failed', reason } })
  await userEvent.click(screen.getByText('Browser runtime details', { selector: 'summary' }))
  const diagnostic = screen.getByText(/End of installation diagnostics/)
  expect(diagnostic).toBeVisible()
  const panel = screen.getByRole('complementary', { name: 'Agent browsers' })
  let scrollable = false
  const overflow = []
  for (let ancestor = diagnostic.parentElement; ancestor && ancestor !== panel; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor)
    overflow.push({ element: ancestor.tagName, className: ancestor.className, overflow: style.overflow, overflowY: style.overflowY })
    if (['auto', 'scroll'].includes(style.overflowY || style.overflow)) scrollable = true
  }
  expect(scrollable, JSON.stringify(overflow)).toBe(true)
})
