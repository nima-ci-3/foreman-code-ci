import { useEffect, useId, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode, type RefCallback, type RefObject } from 'react'
import { useMovableWindow, windowResizeEdges } from './useMovableWindow'
import { Icon, IconButton } from './nocturne'
import { raiseFloating, useFloatingZ } from './floatingStack'
import { placeBeside } from './floatingWindow'

/** Beside the node that opened it; below the toolbar when a toolbar button opened it, so the toolbar stays usable. */
function placeNear(width: number, height: number, opener: HTMLElement | null) {
  const rect = opener?.getBoundingClientRect()
  const gap = 8
  if (!rect) {
    // Reopened from a link (no opener): top right, but below the Board toolbar so it never covers it.
    // The toolbar may not have rendered yet, so fall back to the views bar plus one toolbar row.
    const bar = [...document.querySelectorAll<HTMLElement>('.unified-workflow-board [role="toolbar"]')]
      .find(element => element.offsetParent !== null)?.getBoundingClientRect()
    const views = document.querySelector('.workflow-collaboration-toolbar')?.getBoundingClientRect()
    const below = bar ? bar.bottom : views ? views.bottom + 56 : undefined
    if (below !== undefined) return { left: Math.max(gap, window.innerWidth - width - 24),
      top: Math.max(gap, Math.min(below + gap, window.innerHeight - height - gap)) }
  }
  if (!rect || !opener?.closest('.board-topbar, [role="toolbar"]')) return placeBeside(width, height, rect)
  return { left: Math.max(gap, Math.min(rect.right - width, window.innerWidth - width - gap)),
    top: Math.max(gap, Math.min(rect.bottom + gap, window.innerHeight - height - gap)) }
}

/** Shared non-modal Board window for Agent chat and browsers. */
export function FloatingWindow({ active = true, modalOpen = false, opener, label, title, closeLabel, onClose, header, hint, footer, bodyRef, className = '', children }: {
  active?: boolean; modalOpen?: boolean; opener: RefObject<HTMLElement | null>; label: string; title: ReactNode
  closeLabel: string; onClose(): void; header?: ReactNode; hint?: ReactNode; footer?: ReactNode
  bodyRef?: RefCallback<HTMLDivElement>; className?: string; children?: ReactNode
}) {
  // Moving and resizing (pointer and arrow keys, kept inside the viewport) are the shared window behavior.
  const movable = useMovableWindow({ name: label.toLowerCase(), minWidth: 280, minHeight: 220, narrow: () => false })
  const { panelRef, placeAt } = movable
  const heldFocus = useRef(false)
  const stackId = useId()
  const zIndex = useFloatingZ(stackId, active && !modalOpen)
  // Open next to the node that opened it; keep the user's position while it stays open.
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!active || modalOpen || !panel) return
    if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true })
    if (panel.dataset.placed) return
    const { left, top } = placeNear(panel.offsetWidth, panel.offsetHeight, opener.current)
    placeAt(left, top)
    panel.dataset.placed = 'true'
  }, [active, modalOpen, opener, placeAt, panelRef])
  useEffect(() => { if (!active) delete panelRef.current?.dataset.placed }, [active, panelRef])
  // The header drags the window; its buttons keep their own clicks.
  const drag = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as Element).closest('button')) return
    movable.moveGrip.onPointerDown(event)
  }
  useEffect(() => {
    const panel = panelRef.current
    if (!active || modalOpen || !panel) {
      heldFocus.current = false
      return
    }
    if (document.activeElement && document.activeElement !== document.body) {
      heldFocus.current = panel.contains(document.activeElement)
    }
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const focused = document.activeElement
      const inside = panel.contains(focused)
      const orphaned = heldFocus.current && (!focused || focused === document.body)
      if (!(inside || orphaned) || document.querySelector('dialog[open]')
        || focused?.closest('[role="listbox"], .n-menu')) return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    const rememberFocus = (event: FocusEvent) => {
      heldFocus.current = panel.contains(event.target as Node | null)
    }
    // A removed focused portal control leaves focus on body; other surfaces retain their own Escape.
    document.addEventListener('keydown', close)
    document.addEventListener('focusin', rememberFocus)
    return () => {
      document.removeEventListener('keydown', close)
      document.removeEventListener('focusin', rememberFocus)
    }
  }, [active, modalOpen, onClose, panelRef])
  useEffect(() => {
    if (!active) return
    const openedFrom = opener.current
    return () => { if (openedFrom?.isConnected) openedFrom.focus() }
  }, [active, opener])
  return <aside ref={panelRef} tabIndex={-1} className={`workflow-floating-panel ${className}`} aria-label={label}
    hidden={!active || modalOpen} inert={!active || modalOpen} style={{ ...movable.style, zIndex }}
    onPointerDownCapture={() => raiseFloating(stackId)} onFocusCapture={() => raiseFloating(stackId)}>
    <header onPointerDown={drag} onPointerMove={movable.moveGrip.onPointerMove} onPointerUp={movable.moveGrip.onPointerUp}
      onPointerCancel={movable.moveGrip.onPointerCancel}>
      <h2>{title}</h2>
      {header}
      <IconButton label={closeLabel} variant="ghost" onClick={onClose}><Icon name="close" size={16} /></IconButton>
    </header>
    {hint}
    {windowResizeEdges.map(edge =>
      <button key={edge} type="button" className="workflow-panel-resize" data-edge={edge} {...movable.grip(edge)} />)}
    <div className="workflow-floating-panel-body" ref={bodyRef}>{children}</div>
    {footer}
  </aside>
}
