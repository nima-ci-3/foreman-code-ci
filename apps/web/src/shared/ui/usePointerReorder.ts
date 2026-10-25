import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react'

import { moveItemRelative } from './listOrder'

const MOUSE_DRAG_DISTANCE_PX = 6
const TOUCH_HOLD_MS = 350
const TOUCH_SCROLL_DISTANCE_PX = 10
const SEPARATOR = '\u0000'

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.join(SEPARATOR) === b.join(SEPARATOR)
}

interface DragSession {
  id: string
  pointerId: number
  pointerType: string
  startX: number
  startY: number
  active: boolean
  moved: boolean
  cancelled: boolean
  holdTimer: number | null
  originIds: readonly string[]
  revision: number | undefined
  previewIds: readonly string[] | null
}

export interface PointerReorderOptions {
  /** The committed order the gesture starts from. */
  orderedIds: readonly string[]
  listRef: RefObject<HTMLElement | null>
  /** The data attribute that carries each item's id, e.g. `reorder-id` for `data-reorder-id`. */
  itemAttribute: string
  /** How far a pointer is from an item, to pick the nearest one when no item is under it. */
  distance(rect: DOMRect, clientX: number, clientY: number): number
  labelOf(id: string): string
  commit(ids: readonly string[]): void
  announce(message: string): void
  disabled?: boolean
  revision?: number
}

/**
 * The pointer gesture shared by every reorderable list: a mouse drags after a short distance, touch claims the
 * gesture only after a hold (so scrolling and taps keep working), Escape cancels, the click that ends a drag is
 * suppressed once, and a gesture never survives an unmount or a change of the committed order.
 */
export function usePointerReorder(options: PointerReorderOptions) {
  const { orderedIds, listRef, itemAttribute, distance, labelOf, commit, announce, disabled = false, revision } = options
  const dragRef = useRef<DragSession | null>(null)
  const cancelDragRef = useRef<(() => void) | null>(null)
  const suppressClickRef = useRef(false)
  const suppressClickTimerRef = useRef<number | null>(null)
  const [previewIds, setPreviewIds] = useState<readonly string[] | null>(null)

  const orderKey = orderedIds.join(SEPARATOR)
  useEffect(() => {
    cancelDragRef.current?.()
    setPreviewIds(null)
  }, [disabled, orderKey, revision])

  useEffect(() => () => {
    cancelDragRef.current?.()
    if (suppressClickTimerRef.current !== null) window.clearTimeout(suppressClickTimerRef.current)
  }, [])

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    // Pointer drags end on pointerup; the click that follows must not activate the item.
    if (!suppressClickRef.current || event.detail === 0) return
    suppressClickRef.current = false
    if (suppressClickTimerRef.current !== null) {
      window.clearTimeout(suppressClickTimerRef.current)
      suppressClickTimerRef.current = null
    }
    event.preventDefault()
    event.stopPropagation()
  }, [])

  const onDragStart = useCallback((event: ReactDragEvent<HTMLElement>) => {
    // Native link and image dragging would fight the pointer-based reorder.
    event.preventDefault()
  }, [])

  const beginDrag = useCallback((event: ReactPointerEvent<HTMLElement>, id: string) => {
    if (disabled || event.button !== 0 || dragRef.current) return
    if (!listRef.current || !orderedIds.includes(id)) return
    const session: DragSession = {
      id, pointerId: event.pointerId, pointerType: event.pointerType, startX: event.clientX, startY: event.clientY,
      active: false, moved: false, cancelled: false, holdTimer: null, originIds: orderedIds, revision, previewIds: null,
    }
    dragRef.current = session
    suppressClickRef.current = false
    const selector = `[data-${itemAttribute}]`

    function detach() {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('selectstart', onSelectStart)
      window.removeEventListener('contextmenu', onContextMenu)
      if (session.holdTimer !== null) window.clearTimeout(session.holdTimer)
      session.holdTimer = null
    }

    function activate() {
      if (session.active || session.cancelled) return
      session.active = true
      if (session.holdTimer !== null) window.clearTimeout(session.holdTimer)
      session.holdTimer = null
      session.previewIds = session.originIds
      setPreviewIds(session.originIds)
      window.addEventListener('selectstart', onSelectStart)
      window.addEventListener('contextmenu', onContextMenu)
      if (session.pointerType === 'touch') window.addEventListener('touchmove', onTouchMove, { passive: false })
    }

    function finish(commitOrder: boolean) {
      if (dragRef.current !== session) return
      detach()
      dragRef.current = null
      cancelDragRef.current = null
      const moved = session.active && session.moved
      const finalIds = session.previewIds
      setPreviewIds(null)
      if (!moved) return
      suppressClickRef.current = true
      suppressClickTimerRef.current = window.setTimeout(() => {
        suppressClickRef.current = false
        suppressClickTimerRef.current = null
      }, 0)
      if (!commitOrder || !finalIds) return
      commit(finalIds)
      announce(`Moved ${labelOf(id)} to position ${finalIds.indexOf(id) + 1} of ${finalIds.length}`)
    }

    function updatePreview(clientX: number, clientY: number) {
      const list = listRef.current
      if (!list || session.cancelled) return
      const listRect = list.getBoundingClientRect()
      if ((listRect.width || listRect.height) && (clientX < listRect.left || clientX > listRect.right
        || clientY < listRect.top || clientY > listRect.bottom)) return
      const hovered = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(clientX, clientY) : null
      if (hovered && !list.contains(hovered)) return
      const hoveredGroup = hovered?.closest('[data-reorder-group]')
      if (hoveredGroup && hoveredGroup !== list) return
      // Only this list's own items count; a nested list's items belong to that list.
      const ownItems = [...list.querySelectorAll<HTMLElement>(selector)]
        .filter(element => element.closest('[data-reorder-group]') === list)
      let target = hovered?.closest<HTMLElement>(selector) ?? null
      if (target && target.closest('[data-reorder-group]') !== list) target = null
      if (!target) {
        let nearest = Number.POSITIVE_INFINITY
        for (const element of ownItems) {
          const value = distance(element.getBoundingClientRect(), clientX, clientY)
          if (value < nearest) {
            nearest = value
            target = element
          }
        }
      }
      const targetId = target?.getAttribute(`data-${itemAttribute}`)
      if (!target || !targetId || targetId === session.id) return
      const current = session.previewIds ?? session.originIds
      const targetRect = target.getBoundingClientRect()
      const position = clientY > targetRect.top + targetRect.height / 2 ? 'after' : 'before'
      const next = moveItemRelative(current, session.id, targetId, position)
      if (sameOrder(next, current)) return
      session.previewIds = next
      session.moved = true
      setPreviewIds(next)
    }

    function onPointerMove(moveEvent: PointerEvent) {
      if (moveEvent.pointerId !== session.pointerId || session.cancelled) return
      if (!session.active) {
        const moved = Math.hypot(moveEvent.clientX - session.startX, moveEvent.clientY - session.startY)
        // Moving before the hold elapses means a touch is a scroll or a tap.
        if (session.pointerType === 'touch') { if (moved > TOUCH_SCROLL_DISTANCE_PX) finish(false) }
        else if (moved > MOUSE_DRAG_DISTANCE_PX) activate()
        return
      }
      updatePreview(moveEvent.clientX, moveEvent.clientY)
    }
    function onPointerUp(upEvent: PointerEvent) {
      if (upEvent.pointerId === session.pointerId) finish(!session.cancelled)
    }
    function onPointerCancel(cancelEvent: PointerEvent) {
      if (cancelEvent.pointerId !== session.pointerId) return
      session.cancelled = true
      finish(false)
    }
    function onKeyDown(keyEvent: KeyboardEvent) {
      if (keyEvent.key !== 'Escape' || !session.active || session.cancelled) return
      keyEvent.preventDefault()
      session.cancelled = true
      session.previewIds = null
      setPreviewIds(null)
    }
    function onTouchMove(touchEvent: TouchEvent) {
      if (session.active && session.moved) touchEvent.preventDefault()
    }
    function onSelectStart(selectEvent: Event) {
      if (session.active) selectEvent.preventDefault()
    }
    function onContextMenu(contextEvent: MouseEvent) {
      if (session.active && session.moved) contextEvent.preventDefault()
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    window.addEventListener('keydown', onKeyDown)
    cancelDragRef.current = () => {
      session.cancelled = true
      detach()
      if (dragRef.current === session) dragRef.current = null
      cancelDragRef.current = null
    }
    if (session.pointerType === 'touch') session.holdTimer = window.setTimeout(activate, TOUCH_HOLD_MS)
  }, [announce, commit, disabled, distance, itemAttribute, labelOf, listRef, orderedIds, revision])

  // A preview only applies to the order it started from.
  const previewIsCurrent = !disabled && dragRef.current !== null && dragRef.current.revision === revision
    && sameOrder(dragRef.current.originIds, orderedIds)
  return { orderedIds: previewIsCurrent ? previewIds ?? orderedIds : orderedIds, beginDrag, onClickCapture, onDragStart }
}
