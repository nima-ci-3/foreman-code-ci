import type { Node, NodeChange } from '@xyflow/react'
import type { Agent } from '@foreman-code/contracts'
import type { WorkflowDefinitionCurrent } from '@foreman-code/contracts/current'

/** A leader's team moves by the same delta in both the draft and Run canvases. */
export function withTeamPositionChanges<T extends Node>(changes: NodeChange<T>[], graph: WorkflowDefinitionCurrent,
  agents: readonly Agent[], nodes: readonly Pick<T, 'id' | 'position'>[]): NodeChange<T>[] {
  const roleOf = (nodeId: string) => {
    const node = graph.nodes.find(item => item.id === nodeId)
    return node && node.kind !== 'job' ? agents.find(agent => agent.id === node.agentId)?.productRole : undefined
  }
  const followersOf = (parent: string): string[] => graph.hierarchy
    ? graph.hierarchy.parents.filter(member => member.parentNodeId === parent).map(member => member.workflowNodeId)
    : roleOf(parent) !== 'orchestrator' ? [] : graph.edges.filter(edge => edge.kind === 'execution' && (edge.source === parent || edge.target === parent))
      .map(edge => edge.source === parent ? edge.target : edge.source).filter(id => roleOf(id) === 'coder')
  const moving = new Set(changes.flatMap(change => change.type === 'position' ? [change.id] : []))
  const extra: NodeChange<T>[] = []
  for (const change of changes) {
    if (change.type !== 'position') continue
    const leader = nodes.find(node => node.id === change.id)
    if (!leader) continue
    const delta = change.position ? { x: change.position.x - leader.position.x, y: change.position.y - leader.position.y } : undefined
    const pending = followersOf(change.id), seen = new Set<string>()
    while (pending.length) {
      const id = pending.pop()!
      if (seen.has(id) || moving.has(id)) continue
      seen.add(id); pending.push(...followersOf(id))
      const follower = nodes.find(node => node.id === id)
      if (!follower) continue
      extra.push({ type: 'position', id, ...(change.dragging === undefined ? {} : { dragging: change.dragging }),
        ...(delta ? { position: { x: follower.position.x + delta.x, y: follower.position.y + delta.y } } : {}) })
    }
  }
  return extra.length ? [...changes, ...extra] : changes
}
