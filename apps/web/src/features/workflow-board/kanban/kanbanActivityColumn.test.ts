import { afterEach, expect, it, vi } from 'vitest'
import type { MemoryChange } from '../../memory-boards'
import { reportKanbanActivity, useKanbanActivity } from './kanbanActivity'

afterEach(() => { vi.useRealTimers(); useKanbanActivity.setState({ items: {} }) })

const change = (changes?: MemoryChange['changes']): MemoryChange => ({ id: 'change-1', boardId: 'board', sequence: 1, boardRevision: 1,
  entity: 'card', entityId: 'card-1', entityRevision: 2, actor: { kind: 'agent', id: 'agent-1', displayName: 'Worker' },
  occurredAt: '2026-10-25T00:00:00.000Z', ...(changes ? { changes } : {}) })

it('records the column a card moved to, so the Agent light lands there', () => {
  vi.useFakeTimers()
  reportKanbanActivity('scope', change({ status: { before: 'todo', after: 'doing' } }), [{ id: 'node-1', agentId: 'agent-1' }])
  expect(useKanbanActivity.getState().items.scope).toEqual([expect.objectContaining({ cardId: 'card-1', nodeId: 'node-1', status: 'doing' })])
})

it('leaves the column open when the change did not move the card', () => {
  vi.useFakeTimers()
  reportKanbanActivity('scope', change({ title: { before: 'a', after: 'b' } }), [{ id: 'node-1', agentId: 'agent-1' }])
  expect(useKanbanActivity.getState().items.scope?.[0]).not.toHaveProperty('status')
})
