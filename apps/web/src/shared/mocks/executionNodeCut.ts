import { RepeatGraphCurrentStateSchema } from '@foreman-code/contracts/current'

/** Synthetic cuts with one current activation per node. The last execution for a node is current. */
export function executionNodeCut(input: unknown) {
  const cut = RepeatGraphCurrentStateSchema.parse(input)
  const executions = new Map(cut.state.executions.filter(fact => !fact.tickIndex)
    .map(fact => [fact.identity.workflowNodeId, fact]))
  return RepeatGraphCurrentStateSchema.parse({ ...cut, state: { ...cut.state,
    nodes: cut.topology.nodes.map(({ workflowNodeId }) => {
      const execution = executions.get(workflowNodeId)
      return {
        state: { workflowNodeId, lifecycle: execution
          ? execution.state === 'completed' ? execution.resultOutcome ?? 'unknown' : execution.state : 'not_activated',
          ...(execution ? { execution: execution.identity } : {}) },
        activity: { workflowNodeId, status: 'none' },
        attention: { workflowNodeId, pendingInteractionCount: 0, unsettledReviewCount: 0, cleanupPending: false, telemetry: 'current' },
      }
    }),
  } })
}
