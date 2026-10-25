import { createPortal } from 'react-dom'
import { Button } from '../../shared/ui/nocturne'
import type { AgentPanelRenderer, PinnedPanelNode } from '../graph'
import { useWorkflowBoard } from '../board-core'

/** Existing Agent components retain their stores; only their frame changes. */
export function WorkflowAgentPanel({ panels, findNode, active = true }: {
  panels: AgentPanelRenderer
  findNode(nodeId: string): PinnedPanelNode | false | undefined
  active?: boolean
}) {
  const board = useWorkflowBoard()
  const selection = board?.sidePanel
  if (!active || !board?.sidePanelHost || board.memoryOpen || selection?.kind !== 'agent'
    || selection.tab === 'chat' && (selection.executionId || board.executionChatMounted)) return null
  const node = findNode(selection.nodeId)
  // A draft edited from an earlier copy of the workflow can lack an Agent the saved workflow (and its Runs) has.
  const body = node === false ? <div role="status"><p>This Agent isn’t in your draft. Your draft was edited from an earlier copy of this workflow.</p>
    {board.openSavedWorkflow ? <Button size="sm" onClick={board.openSavedWorkflow}>Open saved workflow</Button> : null}</div>
    : panels(selection.nodeId, node)[selection.tab === 'details' ? 'info' : selection.tab]
  return createPortal(body, board.sidePanelHost)
}
