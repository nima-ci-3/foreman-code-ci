import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentSubject, BrowserSession, BrowserRuntimeStatus } from '@foreman-code/contracts'
import { BrowserSidebar, type BrowserSidebarStatus, type BrowserSidebarTab, tabLabel } from '../features/agent-browser'
import { useBrowserSidebar, useBrowserSidebarTabs } from '../features/workflow-board'
import { useWorkflowBoard } from '../features/board-core'
import { useManagedWorkflowQuery } from '../shared/api/query'
import { Button, Select } from '../shared/ui/nocturne'
import { errorMessage } from '../shared/errorMessage'
import { browserSessionClient } from './browserRecovery'
import { browserAuthBoundary, useBrowserComputers } from './browserComputerFacts'
import { readBrowserSessions } from './liveBrowserSessions'
import { WorkflowBrowserTarget } from './WorkflowBrowser'

export interface WorkflowBrowserSidebarProps { workspaceId: string; workflowId: string; runId?: string; workflowVersionId?: string }

const POLL_MS = 3000
/** A browser whose page, tabs or state changed within this window counts as working. */
const WORKING_MS = 20_000
const runOf = (subject: AgentSubject) => subject.kind === 'execution' ? subject.execution.runId
  : subject.kind === 'coordinator_consultation' ? subject.binding.runId : undefined

/** Every live browser session this person can see, read per online computer so one that cannot answer hides nothing else. */
function useComputerBrowserSessions(liveOnly: boolean, enabled = true) {
  const facts = useBrowserComputers()
  const computers = facts.computers.filter(computer => computer.online).map(computer => computer.id).sort()
  return useQuery({ queryKey: ['browser-sidebar', browserAuthBoundary(), liveOnly ? 'sessions' : 'history', computers], enabled: enabled && computers.length > 0,
    refetchInterval: liveOnly ? POLL_MS : false, refetchOnWindowFocus: false,
    queryFn: ({ signal }) => readBrowserSessions(computers.map(id => ({ id,
      name: facts.computers.find(computer => computer.id === id)?.name ?? 'A computer' })), signal, liveOnly) })
}

function inWorkflow(session: BrowserSession, workspaceId: string, workflowId: string, runId?: string) {
  const subject = session.subject
  if (!subject || subject.agent.workspaceId !== workspaceId || subject.agent.workflowId !== workflowId) return false
  const sessionRun = runOf(subject)
  return !runId || !sessionRun || sessionRun === runId
}

type Activity = { signature: string; changedAt: number; page?: string }
/** Working or idle comes from whether the Agent's browser actually changed recently. */
function useBrowserActivity(sessions: readonly BrowserSession[]) {
  const queryClient = useQueryClient()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(timer) }, [])
  const reads = useQueries({ queries: sessions.map(session => {
    const queryKey = ['browser-sidebar', browserAuthBoundary(), 'activity', session.id] as const
    return { queryKey, refetchInterval: POLL_MS, refetchOnWindowFocus: false, retry: false,
      queryFn: async ({ signal }: { signal: AbortSignal }): Promise<Activity> => {
        const read = await browserSessionClient.readSession(session.id, signal)
        const selected = read.tabs.find(tab => tab.tabId === read.session.selectedTabId)
        const signature = JSON.stringify([read.session.state, read.session.browserGeneration, read.session.selectedTabId,
          read.tabs.map(tab => [tab.tabId, tab.url, tab.title])])
        const previous = queryClient.getQueryData<Activity>(queryKey)
        const page = selected ? tabLabel(selected) : undefined
        // The first read is a baseline, not activity: a browser that has sat still reads as idle.
        return { signature, page, changedAt: !previous ? 0 : previous.signature === signature ? previous.changedAt : Date.now() }
      } }
  }) })
  return new Map(sessions.map((session, index) => {
    const activity = reads[index]?.data
    const status: BrowserSidebarStatus = session.state === 'starting' || session.state === 'recovering'
      || (activity && now - activity.changedAt < WORKING_MS) ? 'working' : 'idle'
    return [session.id, { status, page: activity?.page }] as const
  }))
}

/** The Board's floating browser window: every live Agent browser in this workflow's selected Run, one tab per Agent. */
export function WorkflowBrowserSidebar({ workspaceId, workflowId, runId, workflowVersionId }: WorkflowBrowserSidebarProps) {
  const sidebar = useBrowserSidebar(workspaceId, workflowId)
  const board = useWorkflowBoard()
  const location = useLocation(), navigate = useNavigate()
  const workflow = useManagedWorkflowQuery(workspaceId, workflowId)
  const listed = useComputerBrowserSessions(true)
  const [downloadsOpen, setDownloadsOpen] = useState(false)
  const history = useComputerBrowserSessions(false, downloadsOpen)
  const opened = useBrowserSidebarTabs(state => state.opened[sidebar.scope])
  const closed = useBrowserSidebarTabs(state => state.closed[sidebar.scope])
  // Sessions of this workflow: the selected Run's executions, plus Agent chats, which belong to no Run.
  const sessions = useMemo(() => (listed.data?.sessions ?? []).filter(session => inWorkflow(session, workspaceId, workflowId, runId)),
    [listed.data, workspaceId, workflowId, runId])
  const byNode = useMemo(() => {
    const groups = new Map<string, BrowserSession[]>()
    for (const session of sessions) {
      const nodeId = session.subject!.agent.workflowNodeId
      groups.set(nodeId, [...groups.get(nodeId) ?? [], session])
    }
    return groups
  }, [sessions])
  const seen = useRef(new Set<string>())
  for (const nodeId of byNode.keys()) seen.current.add(nodeId)
  const preferred = (group: BrowserSession[]) => group.find(session => session.id === location.search.browserSessionId)
    ?? group.find(session => runId ? runOf(session.subject!) === runId : session.subject?.kind === 'conversation') ?? group[0]
  const activity = useBrowserActivity(sessions)
  // A browser that starts shows up as a tab and stays (as Ended) after it closes, until the person closes the tab.
  useEffect(() => {
    for (const nodeId of byNode.keys()) {
      if (opened?.includes(nodeId) || closed?.includes(nodeId)) continue
      useBrowserSidebarTabs.getState().add(sidebar.scope, nodeId)
    }
  }, [byNode, opened, closed, sidebar.scope])
  const nodeName = (nodeId: string) => {
    const node = workflow.data?.workflow.nodes.find(item => item.id === nodeId)
    return byNode.get(nodeId)?.[0]?.subject?.agent.displayName ?? node?.name ?? node?.label ?? 'Agent'
  }
  const ids = [...new Set([...opened ?? [], ...sidebar.selected && !opened?.includes(sidebar.selected) && !closed?.includes(sidebar.selected) ? [sidebar.selected] : []])]
  const tabs: BrowserSidebarTab[] = ids.map(nodeId => {
    const primary = preferred(byNode.get(nodeId) ?? [])
    const state = primary ? activity.get(primary.id) : undefined
    return { id: nodeId, name: nodeName(nodeId), status: state?.status ?? (primary ? 'idle' : seen.current.has(nodeId) ? 'ended' : 'not_started'), ...(state?.page ? { page: state.page } : {}) }
  })
  const selectedId = sidebar.selected && ids.includes(sidebar.selected) ? sidebar.selected : ids[0]
  const choices = selectedId ? byNode.get(selectedId) ?? [] : []
  const requestedSessionId = location.search.browserSessionId
  const requestedHistory = !!requestedSessionId && !choices.some(session => session.id === requestedSessionId)
  const selectedSession = useQuery({ queryKey: ['browser-sidebar', browserAuthBoundary(), 'selected-session', requestedSessionId],
    enabled: requestedHistory && !!selectedId,
    queryFn: ({ signal }) => browserSessionClient.readSession(requestedSessionId!, signal), refetchOnWindowFocus: false })
  const historicalSessions = (history.data?.sessions ?? []).filter(session => inWorkflow(session, workspaceId, workflowId, runId)
    && session.subject!.agent.workflowNodeId === selectedId && (session.state === 'closed' || session.state === 'failed'))
  const requested = historicalSessions.find(session => session.id === requestedSessionId) ?? selectedSession.data?.session
  const historical = requested && inWorkflow(requested, workspaceId, workflowId, runId)
    && requested.subject!.agent.workflowNodeId === selectedId ? requested : undefined
  const primary = requestedHistory ? historical : preferred(choices)
  const contexts = primary && !choices.some(session => session.id === primary.id) ? [primary, ...choices] : choices
  const hidden = [...byNode.keys()].filter(nodeId => closed?.includes(nodeId))
  const notice = listed.error ? <p className="browser-sidebar-notice" role="alert">{errorMessage(listed.error, 'Agent browsers could not be read.')}</p>
    : listed.data?.unreachable.length ? <p className="browser-sidebar-notice">{listed.data.unreachable.join(', ')} could not be reached; its browsers are not shown.</p>
      : null
  return <BrowserSidebar tabs={tabs} selectedId={selectedId} notice={<>{notice}{listed.data?.unavailable.map(({ name, runtime }) =>
      <BrowserRuntimeNotice key={runtime.computerId} name={name} runtime={runtime} />)}{hidden.length ? <section aria-label="Reopen browsers">
      {hidden.map(nodeId => <button key={nodeId} type="button" onClick={() => sidebar.open(nodeId)}>Reopen {nodeName(nodeId)} browser</button>)}
    </section> : null}</>}
    emptyText={hidden.length ? 'Active browsers are hidden. Reopen an Agent browser above.' : runId ? 'No agent browsers are active in this run.' : 'No agent browsers are active in this workflow.'}
    onSelect={sidebar.select} onClose={sidebar.close}
    onCloseTab={nodeId => {
      const index = ids.indexOf(nodeId)
      sidebar.closeTab(nodeId, ids[index + 1] ?? ids[index - 1])
    }}>
    {contexts.length > 1 ? <Select label="Browser context" value={primary?.id}
      onChange={event => { const browserSessionId = event.currentTarget.value
        void navigate({ to: location.pathname, replace: true, search: previous => ({ ...previous, browserSessionId, browserTabId: undefined }) })
      }} options={contexts.map(session => ({ value: session.id, label: `${workflow.data?.workflow.name ?? 'Workflow'} · ${nodeName(selectedId!)} · ${session.startedAt
        ? new Date(session.startedAt).toLocaleString() : 'Start time unavailable'} · ${session.subject?.kind === 'execution'
        ? `Attempt ${session.subject.execution.attempt}` : session.subject?.kind === 'coordinator_consultation' ? 'Consultation' : 'Agent chat'}` }))} /> : null}
    {selectedId ? <details open={downloadsOpen} onToggle={event => setDownloadsOpen(event.currentTarget.open)}>
      <summary>Browser downloads</summary>
      {downloadsOpen ? <>
        {history.isPending ? <p role="status">Loading browser downloads…</p> : null}
        {history.error ? <p role="alert">{errorMessage(history.error, 'Browser downloads could not be read.')} <Button size="sm" onClick={() => void history.refetch()}>Retry downloads</Button></p> : null}
        {history.data?.unreachable.length ? <p role="status">Downloads on {history.data.unreachable.join(', ')} could not be read.</p> : null}
        {historicalSessions.map(session => <Button key={session.id} size="sm" onClick={() => {
          void navigate({ to: location.pathname, replace: true, search: previous => ({ ...previous,
            browserTab: selectedId, browserSessionId: session.id, browserTabId: undefined }) })
          setDownloadsOpen(false)
        }}>Downloads · {session.subject?.kind === 'execution' ? `Attempt ${session.subject.execution.attempt}` : 'Agent chat'}
          {session.startedAt ? ` · ${new Date(session.startedAt).toLocaleString()}` : ''}</Button>)}
        {history.isSuccess && !historicalSessions.length ? <p>No ended browser sessions.</p> : null}
      </> : null}
    </details> : null}
    {selectedId && requestedHistory && !primary ? <p role={selectedSession.isPending ? 'status' : 'alert'}>
      {selectedSession.isPending ? 'Loading selected browser…' : 'This browser session is unavailable.'}
      {selectedSession.isError ? <Button size="sm" onClick={() => void selectedSession.refetch()}>Retry selected browser</Button> : null}
    </p> : selectedId ? <SidebarBrowser key={`${selectedId}:${primary?.id ?? ''}`} workspaceId={workspaceId} workflowId={workflowId}
      nodeId={selectedId} session={primary} runId={runId} workflowVersionId={workflowVersionId}
      onOpenSettings={() => board?.selectSidePanel?.({ kind: 'agent', nodeId: selectedId, tab: 'settings' })} /> : null}
  </BrowserSidebar>
}

function BrowserRuntimeNotice({ name, runtime }: { name: string; runtime: BrowserRuntimeStatus }) {
  const sandbox = runtime.phase === 'failed' && /No usable sandbox|can(?:not|'t) start.*sandbox/i.test(runtime.reason ?? '')
  const profileAction = /Install.*(?:AppArmor|foreman-browser-runtime)/i.test(runtime.reason ?? '') ? 'Install' : 'Check'
  return <div className="browser-sidebar-notice" role="status">
    <p>{sandbox ? `${name}'s agent browser isn't installed yet: Chromium can't start its sandbox. ${profileAction} the Foreman AppArmor profile on ${name}.`
      : runtime.phase === 'starting' ? `${name}'s agent browser is starting.`
        : `${name}'s agent browser isn't available yet (${runtime.phase}). Repair or update its browser runtime.`}</p>
    <details><summary>Browser runtime details</summary><p>{runtime.reason ?? 'No failure reason was reported.'}</p></details>
  </div>
}

/** The selected tab's browser. A live session pins the exact Agent subject; without one, the node's browser in this Run. */
function SidebarBrowser({ session, runId, workflowVersionId, ...props }: {
  workspaceId: string; workflowId: string; nodeId: string; session?: BrowserSession; runId?: string; workflowVersionId?: string
  onOpenSettings(): void
}) {
  const subject = session?.subject
  const board = useWorkflowBoard()
  const location = useLocation(), navigate = useNavigate()
  // A node not saved in the workflow yet finds its chat's browser through its Agent.
  const agentId = subject?.agent.agentId ?? board?.draftNodeAgentId?.(props.nodeId)
  const [picked, setPicked] = useState<{ runId: string; workflowVersionId: string; executionId?: string; waitingActivationId?: string }>()
  const sessionId = session?.id ?? (location.search.browserTab === props.nodeId ? location.search.browserSessionId : undefined)
  const pageKey = JSON.stringify([browserAuthBoundary(), sessionId])
  const rememberedPage = useBrowserSidebarTabs(state => state.pages[pageKey])
  const tabId = sessionId === location.search.browserSessionId ? location.search.browserTabId ?? rememberedPage : rememberedPage
  // Only inactive selections are remembered locally; the displayed page is linkable through the URL.
  useEffect(() => {
    if (!sessionId || location.search.browserSessionId === sessionId && location.search.browserTabId === tabId) return
    void navigate({ to: location.pathname, replace: true, search: previous => ({ ...previous,
      browserTab: props.nodeId, browserSessionId: sessionId, browserTabId: tabId }) })
  }, [sessionId, tabId, location.pathname, location.search.browserSessionId, location.search.browserTabId, navigate, props.nodeId])
  const target = picked ?? (subject?.kind === 'execution' ? { runId: subject.execution.runId, workflowVersionId: subject.execution.workflowVersionId,
    executionId: subject.execution.executionId }
    : subject?.kind === 'coordinator_consultation' ? { runId: subject.binding.runId, workflowVersionId: subject.binding.workflowVersionId,
      waitingActivationId: subject.binding.waitingActivationId }
      : subject?.kind === 'conversation' ? {} : runId && workflowVersionId ? { runId, workflowVersionId } : {})
  return <WorkflowBrowserTarget key={JSON.stringify(target)} {...props} {...target} {...(agentId ? { agentId } : {})} compact
    {...(sessionId ? { sessionId } : {})} {...(tabId ? { tabId } : {})}
    onSelect={(sessionId, tabId) => {
      if (sessionId && tabId) useBrowserSidebarTabs.getState().selectPage(JSON.stringify([browserAuthBoundary(), sessionId]), tabId)
      void navigate({ to: location.pathname, replace: true, search: previous => ({ ...previous,
        browserTab: props.nodeId, browserSessionId: sessionId, browserTabId: tabId }) })
    }}
    onPickTarget={(pickedRun, pickedVersion, executionId, waitingActivationId) => {
      void navigate({ to: location.pathname, replace: true, search: previous => ({ ...previous, browserSessionId: undefined, browserTabId: undefined }) })
      setPicked({ runId: pickedRun, workflowVersionId: pickedVersion, executionId, waitingActivationId })
    }} />
}
