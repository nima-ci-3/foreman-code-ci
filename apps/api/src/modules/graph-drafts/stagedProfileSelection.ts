import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import { sameWorkflowValue, type WorkflowDefinitionCurrent } from '@foreman-code/contracts/current'

/** A staged Agent's profile pin follows its node when the node is placed on another computer than the pin.
 * Without this, a Claude Agent edited on the Board re-pins to Main and its paired-computer placement is rejected. */
export async function stagedProfileSelection(graph: WorkflowDefinitionCurrent, agentId: string,
  requested: HarnessProfileSelection | undefined,
  placedTarget: (instanceId: string, instanceRevision: string) => Promise<HarnessProfileSelection['target'] | undefined>,
): Promise<HarnessProfileSelection | undefined> {
  const placement = graph.nodes.flatMap(node => node.kind !== 'job' && node.agentId === agentId && node.placement
    && node.placement.hostRef.kind === 'device' ? [node.placement] : [])[0]
  if (!placement?.instanceId || !placement.instanceRevision) return requested
  if (requested && sameWorkflowValue(requested.target.hostRef, placement.hostRef)) return requested
  const target = await placedTarget(placement.instanceId, placement.instanceRevision)
  if (!target || !sameWorkflowValue(target.hostRef, placement.hostRef)) return requested
  return { instanceId: placement.instanceId, instanceRevision: placement.instanceRevision, target }
}
