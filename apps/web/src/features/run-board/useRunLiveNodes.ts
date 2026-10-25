import { useEffect, useMemo, useRef, useState } from 'react'
import type { CiActivity, ExecutionQueueEntry } from '@foreman-code/contracts'
import type { RunBoardEdgeSnapshot } from '@foreman-code/contracts/run-snapshots'
import type { RepeatGraphScopeCurrent, RunHandoffsRead } from '@foreman-code/contracts/current'
import { relationshipLines, RunLiveNodes, RunLivePulses, type RunLiveNodeView } from '../board-core'
import type { EdgePulse } from '../graph'
import { useInteractionsQuery } from '../../shared/api/query'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import {
  useCurrentRunQuery, useRunHandoffsQuery, useRunChoreography, runningIntervalChecks, interactionWaits,
  liveNodeView, useRunDirectionWait, withDirectionWait,
} from '../workflow-board'

export { RunLiveNodes, RunLivePulses }
export type { RunLiveNodeView }

/** Each node's turn, queue, CI and pending-decision state from the Run's canonical current cut.
 * Reads only while the Board is shown; unavailable facts are never presented as draft nodes. */
export function useRunLiveNodes(scope: RepeatGraphScopeCurrent, names: ReadonlyMap<string, string>,
  cis: ReadonlyMap<string, CiActivity>, visible: boolean, edges: readonly RunBoardEdgeSnapshot[], executionQueue?: readonly ExecutionQueueEntry[]) {
  const current = useCurrentRunQuery(visible ? scope : undefined, visible)
  const denied = useProtectedAccessError(current)
  const record = denied || current.isError ? undefined : current.data
  const live = Boolean(visible && record && record.state.run.executionState !== 'completed')
  // The same pending-request read as the approval inbox; this Run's requests name why its Agents wait.
  const pending = useInteractionsQuery({ workspaceId: scope.workspaceId, workflowId: scope.workflowId, status: 'pending', limit: 100 }, live)
  const direction = useRunDirectionWait(live ? scope : undefined)
  const waits = useMemo(() => withDirectionWait(interactionWaits(record, pending.isError ? [] : pending.data?.items ?? [], names), direction),
    [record, pending.data, pending.isError, names, direction])
  const checking = useMemo(() => live ? runningIntervalChecks(record) : new Map<string, { check: number; queued: boolean }>(), [record, live])
  // Work hand-offs are read beside the cut. A new cut is shown once the hand-offs read has caught up with it,
  // so a receiver never starts its work before the light carrying that work has left.
  const working = Boolean(visible && record?.state.executions.some((execution) => execution.workActivationId))
  const handoffs = useRunHandoffsQuery(scope, working)
  const { refetch } = handoffs
  const scopeKey = JSON.stringify([sessionGeneration(), scope.workspaceId, scope.workflowId, scope.runId, scope.workflowVersionId])
  const activeScope = useRef<string | undefined>(scopeKey)
  activeScope.current = scopeKey
  useEffect(() => {
    activeScope.current = scopeKey
    return () => { activeScope.current = undefined }
  }, [scopeKey])
  // Presentation holds the cut and its transfers together while the next hand-off read catches up.
  const [caughtUp, setCaughtUp] = useState<{ scopeKey: string; record: typeof record; transfers?: RunHandoffsRead['transfers'] }>({ scopeKey, record: undefined })
  useEffect(() => {
    if (!working) return
    void refetch({ cancelRefetch: false }).then(result => {
      if (activeScope.current !== scopeKey || !result.isSuccess) return
      setCaughtUp(previous => previous.scopeKey === scopeKey && previous.record && record
        && BigInt(previous.record.asOfSequence) > BigInt(record.asOfSequence) ? previous
        : { scopeKey, record, transfers: result.data.transfers })
    })
  }, [working, record, refetch, scopeKey, handoffs.isError])
  const shown = record && (working ? caughtUp.scopeKey === scopeKey ? caughtUp.record : undefined : record)
  const choreography = useRunChoreography(shown, edges, working ? caughtUp.transfers : undefined, scopeKey)
  // One line per agent pair: an approval beside a handoff travels on the handoff's line.
  const lines = useMemo(() => relationshipLines(edges), [edges])
  const flights: [string, EdgePulse[]][] = []
  for (const [id, items] of choreography.pulses) {
    const line = lines.alias.get(id)
    if (line) flights.push([line.lineId, items.map(({ key, signal, reversed, startsAt, word }) => ({ key, signal, startsAt,
      reversed: reversed !== line.flipped, ...(word ? { word } : {}) }))])
  }
  const flightKey = JSON.stringify(flights)
  const pulses = useMemo(() => {
    const merged = new Map<string, EdgePulse[]>()
    for (const [lineId, items] of JSON.parse(flightKey) as [string, EdgePulse[]][]) merged.set(lineId, [...merged.get(lineId) ?? [], ...items])
    for (const items of merged.values()) items.sort((a, b) => a.startsAt - b.startsAt)
    return merged
  }, [flightKey])
  const queued = new Map(executionQueue?.map(entry => [entry.workflowNodeId, entry.reason]))
  const views: [string, RunLiveNodeView][] = []
  for (const nodeId of visible ? names.keys() : []) {
    const ci = cis.get(nodeId)
    const base = shown ? choreography.nodes.get(nodeId) ?? { state: 'idle' as const, label: 'Not started' } : undefined
    if (!base) {
      views.push([nodeId, { state: 'unavailable', label: denied || current.isError || handoffs.isError ? 'Run state unavailable' : 'Loading Run state' }])
      continue
    }
    const view = liveNodeView(base, waits.get(nodeId), ci, undefined, checking.get(nodeId), live && base.state === 'queued' ? queued.get(nodeId) : undefined)
    views.push([nodeId, { state: view.state, label: view.label,
      ...(base.transition && view.state === base.state ? { transition: base.transition, transitionKey: base.transitionKey } : {}) }])
  }
  const key = views.length ? JSON.stringify(views) : undefined
  const nodes = useMemo(() => key ? new Map(JSON.parse(key) as [string, RunLiveNodeView][]) : undefined, [key])
  return { nodes, pulses, error: denied ?? current.error ?? (working ? handoffs.error : null), refresh: () => {
    void current.refetch()
    if (working) void handoffs.refetch()
  } }
}
