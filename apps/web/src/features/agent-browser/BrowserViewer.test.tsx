import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BrowserViewer } from './BrowserViewer'
import type { BrowserController } from './controller'
import { frame } from './testFixtures'
import type { BrowserControllerSnapshot } from './types'

const snapshot: BrowserControllerSnapshot = { notice: 'user', error: null, frame: frame(), stale: false, pendingInputs: 0,
  control: { sessionId: 'session', state: 'user', epoch: 1, controllingViewerId: 'viewer', reason: null } }
beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
    { x: 0, y: 0, left: 0, top: 0, width: 640, height: 400, right: 640, bottom: 400, toJSON: () => ({}) })
  URL.createObjectURL ??= () => 'blob:frame'
  URL.revokeObjectURL ??= () => {}
})
afterEach(() => vi.restoreAllMocks())

function mount() {
  const send = vi.fn(async () => {})
  render(<BrowserViewer controller={{ send } as unknown as BrowserController} snapshot={snapshot} readOnly={false} onLeavePage={() => {}} />)
  return { send, page: screen.getByRole('group', { name: 'Browser page' }) }
}

it('forwards a shift double-click with its click count and modifiers', () => {
  const { send, page } = mount()
  fireEvent.pointerDown(page, { clientX: 100, clientY: 50, button: 0, buttons: 1, detail: 2, shiftKey: true })
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pointer', phase: 'down', x: 200, y: 100, clickCount: 2, modifiers: 8 }))
})

it('scrolls the remote page without scrolling the app behind it', () => {
  const { send, page } = mount()
  const event = new WheelEvent('wheel', { deltaY: 40, clientX: 100, clientY: 50, bubbles: true, cancelable: true })
  page.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'wheel', deltaY: 80 }))
})

it('lets the paste shortcut reach the local clipboard instead of sending it as keys', () => {
  const { send, page } = mount()
  const allowed = fireEvent.keyDown(page, { key: 'v', code: 'KeyV', ctrlKey: true })
  expect(allowed).toBe(true)
  expect(send).not.toHaveBeenCalled()
})
