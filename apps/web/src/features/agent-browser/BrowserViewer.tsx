import { useEffect, useRef, useState, type CompositionEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { TextField } from '../../shared/ui/nocturne'
import type { BrowserController } from './controller'
import type { BrowserControllerSnapshot, PageFrame, PageGesture } from './types'

/** Paints each frame straight into the image element, without a React render per frame. The previous image stays on
 * screen until the next one replaces it, so the page never blanks between frames. */
function useFramePainter(frame: PageFrame | null) {
  const image = useRef<HTMLImageElement>(null)
  const [painted, setPainted] = useState(false)
  useEffect(() => {
    if (!frame) return
    const next = URL.createObjectURL(frame.image)
    if (image.current) image.current.src = next
    setPainted(true)
    // Revoked once the next image has had time to paint over it.
    return () => { setTimeout(() => URL.revokeObjectURL(next), 2000) }
  }, [frame])
  return { image, painted }
}

function modifierBits(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  return Number(event.altKey) + Number(event.ctrlKey) * 2 + Number(event.metaKey) * 4 + Number(event.shiftKey) * 8
}

function pagePoint(event: { clientX: number; clientY: number }, element: Element, frame: PageFrame) {
  const bounds = element.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0) return null
  const y = (event.clientY - bounds.top) * frame.height / bounds.height - (frame.viewportOffsetTop ?? 0)
  if (y < 0) return null
  return { x: Math.min(frame.width, Math.max(0, (event.clientX - bounds.left) * frame.width / bounds.width)),
    y: Math.min(frame.height - (frame.viewportOffsetTop ?? 0), y) }
}

export function BrowserViewer({ controller, snapshot, readOnly, onLeavePage }: {
  controller: BrowserController; snapshot: BrowserControllerSnapshot; readOnly: boolean; onLeavePage(): void
}) {
  const { image, painted } = useFramePainter(snapshot.frame)
  const keyboard = useRef<HTMLInputElement>(null)
  const page = useRef<HTMLDivElement>(null)
  const writable = !readOnly && !snapshot.stale && snapshot.notice !== 'denied' && snapshot.notice !== 'closed'
  const send = (gesture: PageGesture) => { if (writable) void controller.send(gesture) }
  const pointer = (event: PointerEvent<HTMLDivElement>, phase: 'down' | 'up' | 'move') => {
    if (!snapshot.frame || !writable) return
    const point = pagePoint(event, event.currentTarget, snapshot.frame)
    if (!point) return
    if (phase === 'down') {
      event.preventDefault(); keyboard.current?.focus()
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }
    if (phase === 'move' && snapshot.notice !== 'user' && snapshot.notice !== 'taking') return
    send({ kind: 'pointer', phase, ...point, button: event.button, buttons: event.buttons,
      ...(phase === 'move' ? {} : { clickCount: Math.min(3, Math.max(1, event.detail || 1)) }), modifiers: modifierBits(event) })
  }
  const key = (event: KeyboardEvent<HTMLDivElement>, phase: 'down' | 'up') => {
    // Escape leaves page capture. Unmodified Tab navigates the remote page.
    if (event.key === 'Escape') { event.preventDefault(); keyboard.current?.blur(); onLeavePage(); return }
    if (!writable || event.nativeEvent.isComposing) return
    // The local paste shortcut fills the keyboard field, whose paste handler types the clipboard text remotely.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'v') return
    event.preventDefault()
    send({ kind: 'key', phase, key: event.key, code: event.code, alt: event.altKey,
      control: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey, repeat: event.repeat })
  }
  const composition = (event: CompositionEvent<HTMLDivElement>, phase: 'start' | 'update' | 'end') => {
    send({ kind: 'composition', phase, text: event.data })
  }
  // A native non-passive listener: React's wheel listener is passive, so the app behind the page would scroll too.
  const wheel = useRef<(event: globalThis.WheelEvent) => void>(() => {})
  wheel.current = event => {
    const element = page.current
    if (!snapshot.frame || !writable || !element) return
    const point = pagePoint(event, element, snapshot.frame)
    if (!point) return
    const bounds = element.getBoundingClientRect()
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1
    event.preventDefault()
    send({ kind: 'wheel', ...point, deltaX: event.deltaX * unit * snapshot.frame.width / bounds.width,
      deltaY: event.deltaY * unit * snapshot.frame.height / bounds.height })
  }
  useEffect(() => {
    const element = page.current
    if (!element) return
    const listener = (event: globalThis.WheelEvent) => wheel.current(event)
    element.addEventListener('wheel', listener, { passive: false })
    return () => element.removeEventListener('wheel', listener)
  }, [])
  return <div className="agent-browser-page" role="group" aria-label="Browser page" tabIndex={0}
    aria-describedby="browser-page-help" aria-disabled={!writable}
    data-control={snapshot.notice === 'user' || snapshot.notice === 'taking' ? snapshot.notice : undefined}
    style={{ aspectRatio: snapshot.frame ? `${snapshot.frame.width}/${snapshot.frame.height}` : '16/10' }}
    onFocus={event => { if (event.target === event.currentTarget && writable) keyboard.current?.focus() }}
    onPointerDown={event => pointer(event, 'down')} onPointerUp={event => pointer(event, 'up')}
    onPointerMove={event => pointer(event, 'move')} onKeyDown={event => key(event, 'down')}
    onKeyUp={event => key(event, 'up')} onCompositionStart={event => composition(event, 'start')}
    onCompositionUpdate={event => composition(event, 'update')} onCompositionEnd={event => composition(event, 'end')}
    ref={page}>
    <img ref={image} alt="Page in the selected agent browser" draggable={false} hidden={!painted}
      style={snapshot.frame ? { position: 'absolute', top: `${100 * (snapshot.frame.viewportOffsetTop ?? 0) / snapshot.frame.height}%`,
        height: `${100 * (1 - (snapshot.frame.viewportOffsetTop ?? 0) / snapshot.frame.height)}%` } : { position: 'absolute' }} />
    {painted ? null : <p>{snapshot.notice === 'denied' ? 'Browser access is unavailable.' : 'Waiting for a browser image…'}</p>}
    <TextField label="Browser keyboard input" ref={keyboard} tabIndex={-1} className="agent-browser-keyboard"
      autoComplete="off" spellCheck={false} disabled={!writable}
      onPaste={event => { event.preventDefault(); send({ kind: 'composition', phase: 'end', text: event.clipboardData.getData('text/plain') }) }}
      onInput={event => { if (!(event.nativeEvent as InputEvent).isComposing) event.currentTarget.value = '' }} />
    {snapshot.stale && snapshot.frame ? <span className="agent-browser-stale">Connection paused</span> : null}
  </div>
}
