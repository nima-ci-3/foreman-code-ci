import { createElement, type ReactNode } from 'react'
import { WorkflowExecutionChatAdapter } from './WorkflowExecutionChatAdapter'
import type { WorkflowExecutionChatSlotSelection, WorkflowExecutionChatViews } from './types'

export function createWorkflowExecutionChatSlot(views: WorkflowExecutionChatViews):
  (selection: WorkflowExecutionChatSlotSelection) => ReactNode {
  return selection => createElement(WorkflowExecutionChatAdapter, { selection, views,
    key: JSON.stringify([selection.workspaceId, selection.workflowId, selection.nodeId, selection.runId, selection.workflowVersionId]) })
}
