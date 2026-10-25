import { useCallback, useMemo, useRef } from 'react'
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefCallback,
} from 'react'

import { sameOrder, usePointerReorder } from '../../shared/ui/usePointerReorder'
import {
  applyStoredOrder,
  moveItemToIndex,
  useNavigationOrderStore,
} from './navigationOrder'

/** Non-visual keyboard alternative to pointer dragging. */
export const REORDER_KEY_SHORTCUTS = 'Alt+ArrowUp Alt+ArrowDown'

export interface ReorderableNavigationItem {
  id: string
  label: string
}

export interface ReorderContainerProps {
  ref: RefCallback<HTMLUListElement>
  'data-reorder-group': string
  onClickCapture: (event: ReactMouseEvent<HTMLUListElement>) => void
  onDragStart: (event: ReactDragEvent<HTMLUListElement>) => void
}

export interface ReorderItemProps {
  'data-reorder-id': string
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
}

export interface ReorderKeyboardProps {
  'aria-keyshortcuts': string
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void
}

export interface ReorderableNavigation {
  /** Rendered order; a live preview while a pointer drag is in progress. */
  orderedIds: readonly string[]
  containerProps: ReorderContainerProps
  getItemProps: (id: string) => ReorderItemProps
  getKeyboardProps: (id: string) => ReorderKeyboardProps
  move: (id: string, direction: -1 | 1) => void
}

interface ReorderOptions {
  onReorder?: (ids: readonly string[]) => void
  disabled?: boolean
  revision?: number
}

/**
 * Sibling reordering for one sidebar list. Pointer dragging only reorders the
 * ids that belong to this list: the drop target is read from the list's own
 * items and moves outside the list bounds are ignored, so an item can never
 * change parent or workspace. A plain click/tap is left to the underlying link
 * and button; Alt+Arrow Up/Down reorders the focused item for keyboard users
 * and the change is announced through the shared live region.
 */
export function useReorderableNavigation(
  parentKey: string,
  items: readonly ReorderableNavigationItem[],
  options: ReorderOptions = {},
): ReorderableNavigation {
  const storedOrder = useNavigationOrderStore((state) => state.orders[parentKey])
  const setOrder = useNavigationOrderStore((state) => state.setOrder)
  const announce = useNavigationOrderStore((state) => state.announce)
  const { onReorder, disabled = false, revision } = options
  const commitOrder = useCallback((ids: readonly string[]) => {
    if (onReorder) onReorder(ids)
    else setOrder(parentKey, ids)
  }, [onReorder, parentKey, setOrder])

  const orderedIds = useMemo(
    () => applyStoredOrder(items.map((item) => item.id), onReorder ? undefined : storedOrder),
    [items, onReorder, storedOrder],
  )
  const labelOf = useCallback((id: string) => items.find((item) => item.id === id)?.label ?? id, [items])

  const listRef = useRef<HTMLUListElement | null>(null)
  const pointer = usePointerReorder({ orderedIds, listRef, itemAttribute: 'reorder-id', labelOf, commit: commitOrder,
    announce, disabled, ...(revision !== undefined ? { revision } : {}),
    // A vertical list: the nearest item is the one closest by height.
    distance: verticalDistance })

  const containerRef = useCallback<RefCallback<HTMLUListElement>>((element) => {
    listRef.current = element
  }, [])

  const { beginDrag, onClickCapture, onDragStart } = pointer
  const containerProps = useMemo<ReorderContainerProps>(
    () => ({
      ref: containerRef,
      'data-reorder-group': parentKey,
      onClickCapture,
      onDragStart,
    }),
    [containerRef, onClickCapture, onDragStart, parentKey],
  )

  const getItemProps = useCallback(
    (id: string): ReorderItemProps => ({
      'data-reorder-id': id,
      onPointerDown: (event) => beginDrag(event, id),
    }),
    [beginDrag],
  )

  const moveByKeyboard = useCallback(
    (id: string, direction: -1 | 1) => {
      if (disabled) return
      const index = orderedIds.indexOf(id)
      if (index === -1) return
      const targetIndex = index + direction
      if (targetIndex < 0 || targetIndex >= orderedIds.length) return
      const next = moveItemToIndex(orderedIds, id, targetIndex)
      if (sameOrder(next, orderedIds)) return
      commitOrder(next)
      announce(`Moved ${labelOf(id)} to position ${targetIndex + 1} of ${next.length}`)
    },
    [announce, commitOrder, disabled, labelOf, orderedIds],
  )

  const getKeyboardProps = useCallback(
    (id: string): ReorderKeyboardProps => ({
      'aria-keyshortcuts': REORDER_KEY_SHORTCUTS,
      onKeyDown: (event) => {
        if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        moveByKeyboard(id, event.key === 'ArrowUp' ? -1 : 1)
      },
    }),
    [moveByKeyboard],
  )

  return {
    orderedIds: pointer.orderedIds,
    containerProps,
    getItemProps,
    getKeyboardProps,
    move: moveByKeyboard,
  }
}

const verticalDistance = (rect: DOMRect, _clientX: number, clientY: number) => Math.abs(clientY - (rect.top + rect.height / 2))
