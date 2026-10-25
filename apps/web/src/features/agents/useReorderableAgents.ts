import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefCallback,
} from 'react'

import { sameOrder, usePointerReorder } from '../../shared/ui/usePointerReorder'
import {
  applyAgentOrder,
  moveAgentToIndex,
  useAgentDirectoryStore,
} from './agentDirectoryStore'

export const AGENT_REORDER_KEY_SHORTCUTS = 'Alt+ArrowUp Alt+ArrowDown'

const SETTLE_DURATION_MS = 190

function motionAllowed(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches !== true
}

export interface ReorderableAgent {
  id: string
  label: string
}

export interface AgentReorderContainerProps {
  ref: RefCallback<HTMLDivElement>
  'data-reorder-group': string
  onClickCapture: (event: ReactMouseEvent<HTMLDivElement>) => void
  onDragStart: (event: ReactDragEvent<HTMLDivElement>) => void
}

export interface AgentReorderCardProps {
  ref: RefCallback<HTMLDivElement>
  'data-agent-id': string
  'aria-keyshortcuts': string
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
}

export interface ReorderableAgentsResult {
  orderedIds: readonly string[]
  containerProps: AgentReorderContainerProps
  getCardProps: (id: string) => AgentReorderCardProps
}

/**
 * Pointer and keyboard sibling ordering for the agents directory. A short
 * click remains inert; touch waits for a hold before it claims the gesture,
 * leaving ordinary scrolling and taps alone.
 */
export function useReorderableAgents(
  workspaceId: string,
  items: readonly ReorderableAgent[],
): ReorderableAgentsResult {
  const storedOrder = useAgentDirectoryStore((state) => state.orders[workspaceId])
  const setOrder = useAgentDirectoryStore((state) => state.setOrder)
  const announce = useAgentDirectoryStore((state) => state.announce)
  const orderedIds = useMemo(
    () => applyAgentOrder(items.map((item) => item.id), storedOrder),
    [items, storedOrder],
  )
  const listRef = useRef<HTMLDivElement | null>(null)
  const cardRefs = useRef(new Map<string, HTMLDivElement>())
  const labelOf = useCallback((id: string) => items.find((item) => item.id === id)?.label ?? id, [items])
  const commitOrder = useCallback((ids: readonly string[]) => setOrder(workspaceId, ids), [setOrder, workspaceId])
  const pointer = usePointerReorder({ orderedIds, listRef, itemAttribute: 'agent-id', labelOf, commit: commitOrder,
    announce, distance: gridDistance })
  const previousRectsRef = useRef(new Map<string, DOMRect>())
  const previousOrderRef = useRef<readonly string[]>(orderedIds)

  const setCardRef = useCallback((id: string, card: HTMLDivElement | null) => {
    if (card) cardRefs.current.set(id, card)
    else cardRefs.current.delete(id)
  }, [])

  useLayoutEffect(() => {
    const nextRects = new Map<string, DOMRect>()
    for (const id of orderedIds) {
      const card = cardRefs.current.get(id)
      if (card) nextRects.set(id, card.getBoundingClientRect())
    }

    const changed = !sameOrder(previousOrderRef.current, orderedIds)
    const cleanup: Array<() => void> = []
    if (changed && motionAllowed()) {
      for (const [id, nextRect] of nextRects) {
        const previousRect = previousRectsRef.current.get(id)
        if (!previousRect) continue
        const deltaX = previousRect.left - nextRect.left
        const deltaY = previousRect.top - nextRect.top
        if (deltaX === 0 && deltaY === 0) continue
        const card = cardRefs.current.get(id)
        if (!card) continue
        card.dataset.reorderSettling = 'true'
        card.style.transform = `translate(${deltaX}px, ${deltaY}px)`
        // Force the initial transform to be committed before clearing it so
        // the card takes the shortest visual path to its new grid position.
        void card.offsetWidth
        const clear = () => {
          card.style.transform = ''
          delete card.dataset.reorderSettling
        }
        const frame = window.requestAnimationFrame?.(clear)
        const timeout = window.setTimeout(clear, SETTLE_DURATION_MS)
        cleanup.push(() => {
          if (frame !== undefined) window.cancelAnimationFrame?.(frame)
          window.clearTimeout(timeout)
          clear()
        })
      }
    }

    previousRectsRef.current = nextRects
    previousOrderRef.current = orderedIds
    return () => cleanup.forEach((cancel) => cancel())
  }, [orderedIds])

  const containerRef = useCallback<RefCallback<HTMLDivElement>>((element) => {
    listRef.current = element
  }, [])

  const { beginDrag, onClickCapture, onDragStart } = pointer
  const containerProps = useMemo<AgentReorderContainerProps>(
    () => ({
      ref: containerRef,
      'data-reorder-group': `workspace:${workspaceId}:agents`,
      onClickCapture,
      onDragStart,
    }),
    [containerRef, onClickCapture, onDragStart, workspaceId],
  )

  const moveByKeyboard = useCallback(
    (id: string, direction: -1 | 1) => {
      const index = orderedIds.indexOf(id)
      const targetIndex = index + direction
      if (index === -1 || targetIndex < 0 || targetIndex >= orderedIds.length) return
      const next = moveAgentToIndex(orderedIds, id, targetIndex)
      if (sameOrder(next, orderedIds)) return
      commitOrder(next)
      announce(`Moved ${labelOf(id)} to position ${targetIndex + 1} of ${next.length}`)
    },
    [announce, commitOrder, labelOf, orderedIds],
  )

  const getCardProps = useCallback(
    (id: string): AgentReorderCardProps => ({
      ref: (card) => setCardRef(id, card),
      'data-agent-id': id,
      'aria-keyshortcuts': AGENT_REORDER_KEY_SHORTCUTS,
      onPointerDown: (event) => beginDrag(event, id),
      onKeyDown: (event) => {
        if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        moveByKeyboard(id, event.key === 'ArrowUp' ? -1 : 1)
      },
    }),
    [beginDrag, moveByKeyboard, setCardRef],
  )

  return {
    orderedIds: pointer.orderedIds,
    containerProps,
    getCardProps,
  }
}

/** Cards sit in a grid: the nearest card is the closest by straight-line distance. */
const gridDistance = (rect: DOMRect, clientX: number, clientY: number) =>
  Math.hypot(clientX - (rect.left + rect.width / 2), clientY - (rect.top + rect.height / 2))
