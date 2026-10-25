import type { RepeatGraphCurrentState, WorkflowVersionCurrent } from '@foreman-code/contracts/current'

type ExecutionFact = RepeatGraphCurrentState['state']['executions'][number]
type ResolutionFact = RepeatGraphCurrentState['state']['resolutions'][number]
type NodeFact = RepeatGraphCurrentState['state']['nodes'][number]
/** Display-only input. The current query validates the complete canonical cut. */
export type PinnedNodeDisplayCut = { state: {
  nodes: readonly { state: NodeFact['state']; resolution?: Pick<NonNullable<NodeFact['resolution']>, 'resolution'> }[]
  executions: readonly (Pick<ExecutionFact, 'identity' | 'state' | 'resultOutcome'> & Partial<Pick<ExecutionFact, 'tickIndex'>>)[]
  resolutions: readonly { ref: Pick<ResolutionFact['ref'], 'nodeId' | 'occurrence'>;
    value: Pick<ResolutionFact['value'], 'resolution'|'execution'|'outcome'> }[]
} }

/** Linear in the bounded current cut; never scan all executions per canvas node.
 * This is only a display projection, not Run history or a scheduling decision. */
export function pinnedNodeStates(record?: PinnedNodeDisplayCut) {
  const states = new Map<string, { label: string; occurrenceIndex: number; attempt: number }>()
  if (!record) return states
  const resolutions = new Map<string, number>()
  for (const resolution of record.state.resolutions) {
    const index = resolution.ref.occurrence?.occurrenceIndex ?? 0
    resolutions.set(resolution.ref.nodeId, Math.max(resolutions.get(resolution.ref.nodeId) ?? 0, index))
  }
  const executions = new Map(record.state.executions.filter(fact => !fact.tickIndex).map(fact => [fact.identity.executionId, fact]))
  // The server selects the current activation and qualifies its native lifecycle. Attempt numbers alone
  // cannot select it: they restart for every work activation of the same node.
  for (const { state, resolution } of record.state.nodes) {
    const execution = state.execution ? executions.get(state.execution.executionId) : undefined
    states.set(state.workflowNodeId, { label: resolution?.resolution === 'excluded' ? 'excluded' : state.lifecycle,
      occurrenceIndex: execution?.identity.occurrence?.occurrenceIndex ?? resolutions.get(state.workflowNodeId) ?? 0,
      attempt: execution?.identity.attempt ?? 0 })
  }
  return states
}
/** The unfinished interval check of each node, by check number. A check wakes the Agent without
 * changing its graph state, so it is read beside pinnedNodeStates, not inside it. */
export function runningIntervalChecks(record?: PinnedNodeDisplayCut) {
  const checks = new Map<string, { check: number; queued: boolean }>()
  for (const fact of record?.state.executions ?? []) {
    if (!fact.tickIndex || fact.state === 'completed') continue
    const id = fact.identity.workflowNodeId
    if ((checks.get(id)?.check ?? 0) < fact.tickIndex) checks.set(id, { check: fact.tickIndex, queued: fact.state === 'queued' })
  }
  return checks
}
/** How a node looks while an interval check is unfinished. */
export const checkingView = (check: number, queued = false) => queued
  ? { state: 'queued' as const, label: `Loop ${check} queued` } : { state: 'running' as const, label: `Looping · loop ${check}` }
export function pinnedTopology(version: WorkflowVersionCurrent) {
  const blocks = new Map(version.definition.repeat?.blocks.flatMap((block) =>
    block.nodeIds.map((nodeId) => [nodeId, block.id] as const)) ?? [])
  return {
    nodes: version.definition.nodes.map((node,index)=>{
      const common={id:node.id,label:node.name??node.label??node.id,entry:node.id===version.entryNodeId,blockId:blocks.get(node.id),position:node.position??{x:(index%4)*300,y:Math.floor(index/4)*200}}
      return node.kind==='job'?{...common,kind:'job' as const,jobDefinitionId:node.jobDefinitionId,jobDefinitionRevision:node.jobDefinitionRevision,jobDefinitionVersionId:node.jobDefinitionVersionId}:{...common,kind:'agent' as const,agentId:node.agentId,configurationId:version.agentConfigurationVersionIds[node.agentId]!,intervalSeconds:node.interval?.everySeconds}
    }),
    edges: version.definition.edges,
  }
}
