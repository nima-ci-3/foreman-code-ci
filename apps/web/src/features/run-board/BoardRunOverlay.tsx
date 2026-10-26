import { useEffect, useMemo, type ReactNode } from 'react'
import { Button } from '../../shared/ui/nocturne'
import type { CiActivity } from '@foreman-code/contracts'
import type { RunBoardEdgeSnapshot } from '@foreman-code/contracts/run-snapshots'
import { RunLiveNodes, RunLivePulses, RunLiveCi, RunDisplayedSnapshot, type RunLivePulse } from '../board-core'
import { runBoardCi } from './model'
import { useRunLiveNodes } from './useRunLiveNodes'
import { ciNodeActivities, isActiveCi } from '../workflow-board'
import { useRunCiJobs } from './useRunCiJobs'
import type { BoardRun, useBoardRunSnapshot } from './useBoardRunSnapshot'

const noEdges: readonly RunBoardEdgeSnapshot[] = []
const noPulses: ReadonlyMap<string, readonly RunLivePulse[]> = new Map()
const noCis: ReadonlyMap<string, CiActivity> = new Map()

/** The workflow's latest Run shown on the Board itself: live node states and hand-off lights while it runs,
 * its final states afterwards. Nodes and lines are matched by id, so a node added since that Run stays a draft node.
 * The providers are always mounted, so a Run appearing or leaving never remounts the draft beneath them. */
export function BoardRunOverlay({ run, read, visible, onPainted, children }: {
  run?: BoardRun; read: ReturnType<typeof useBoardRunSnapshot>; visible: boolean; onPainted?(runId: string | undefined): void; children: ReactNode
}) {
  const { snapshot, activity } = read
  const painted = snapshot?.runId
  useEffect(() => { onPainted?.(painted) }, [onPainted, painted])
  const scope = useMemo(() => ({ workspaceId: snapshot?.workspaceId ?? run?.workspaceId ?? '', workflowId: snapshot?.workflowId ?? run?.workflowId ?? '',
    runId: snapshot?.runId ?? run?.runId ?? '', workflowVersionId: snapshot?.workflowVersionId ?? '', executionSemanticsVersion: 3 as const }),
  [snapshot?.workspaceId, snapshot?.workflowId, snapshot?.runId, snapshot?.workflowVersionId, run?.workspaceId, run?.workflowId, run?.runId])
  const names = useMemo(() => new Map((snapshot?.nodes ?? []).map(node => [node.id, node.name])), [snapshot?.nodes])
  const activityCis = useMemo(() => snapshot ? runBoardCi(snapshot, activity) : noCis, [snapshot, activity])
  const { panel, nodeJobs } = useRunCiJobs(scope, { enabled: visible && !!snapshot,
    active: !!run?.live || [...activityCis.values()].some(isActiveCi) })
  const { jobs, truncated, error, loading, readError, onRefresh } = panel
  const ci = useMemo(() => snapshot ? { scope, names, jobs, truncated, error, loading, readError, onRefresh } : undefined,
    [snapshot, scope, names, jobs, truncated, error, loading, readError, onRefresh])
  const cis = useMemo(() => snapshot ? new Map([...activityCis, ...ciNodeActivities(nodeJobs ?? [])]) : noCis,
    [snapshot, activityCis, nodeJobs])
  const live = useRunLiveNodes(scope, names, cis, visible && !!snapshot, snapshot?.edges ?? noEdges, read.executionQueue)
  return <RunDisplayedSnapshot.Provider value={snapshot}><RunLiveNodes.Provider value={snapshot ? live.nodes : undefined}>
    <RunLivePulses.Provider value={snapshot ? live.pulses : noPulses}><RunLiveCi.Provider value={ci}>
      {visible && live.error ? <p role="alert">Run state could not be refreshed. <Button size="sm" onClick={live.refresh}>Retry Run state</Button></p> : null}
      {children}</RunLiveCi.Provider></RunLivePulses.Provider>
  </RunLiveNodes.Provider></RunDisplayedSnapshot.Provider>
}
