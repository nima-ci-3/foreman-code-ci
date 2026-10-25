import { expect, it, vi } from 'vitest'
import type { BrowserBroker } from './broker.js'
import { BrowserMediaService } from './media.js'
import type { BrowserHostFrame } from './types.js'

it('streams page changes faster than ten frames per second', async () => {
  const records = new Map<string, unknown>()
  let emit: ((frame: BrowserHostFrame) => void) | undefined
  const broker = {
    options: { journal: { read: async (key: string) => records.get(key), write: async (key: string, value: unknown) => { records.set(key, value) } } },
    capture: async (_session: string, _tab: string, _generation: number, frame: (value: BrowserHostFrame) => void) => {
      emit = frame
      return async () => {}
    },
    retireCapture: async () => {},
    read: () => ({ session: { browserGeneration: 1, state: 'open' }, tabs: [{ tabId: 'tab', browserGeneration: 1 }] }),
  } as unknown as BrowserBroker
  const media = new BrowserMediaService(broker)
  const view = await media.open({ ownerId: 'owner', viewerId: 'viewer', sessionId: 'session', tabId: 'tab', browserGeneration: 1 })
  const frame = (n: number): BrowserHostFrame => ({ data: new Uint8Array([n]), mimeType: 'image/jpeg', width: 100, height: 80,
    viewportOffsetTop: 0, capturedAt: new Date().toISOString() })
  emit!(frame(1))
  await new Promise(resolve => setTimeout(resolve, 40))
  emit!(frame(2))
  expect(media.read(view.id, 'owner').frame?.data).toEqual(new Uint8Array([2]))
  await media.close(view.id, 'owner')
})

it('shows the last change of a burst once the frame interval ends', async () => {
  const records = new Map<string, unknown>()
  let emit: ((frame: BrowserHostFrame) => void) | undefined
  const broker = {
    options: { journal: { read: async (key: string) => records.get(key), write: async (key: string, value: unknown) => { records.set(key, value) } } },
    capture: async (_session: string, _tab: string, _generation: number, frame: (value: BrowserHostFrame) => void) => {
      emit = frame
      return async () => {}
    },
    retireCapture: async () => {},
    read: () => ({ session: { browserGeneration: 1, state: 'open' }, tabs: [{ tabId: 'tab', browserGeneration: 1 }] }),
  } as unknown as BrowserBroker
  const media = new BrowserMediaService(broker)
  const view = await media.open({ ownerId: 'owner', viewerId: 'viewer', sessionId: 'session', tabId: 'tab', browserGeneration: 1 })
  const frame = (n: number): BrowserHostFrame => ({ data: new Uint8Array([n]), mimeType: 'image/jpeg', width: 100, height: 80,
    viewportOffsetTop: 0, capturedAt: new Date().toISOString() })
  emit!(frame(1)); emit!(frame(2))
  expect(media.read(view.id, 'owner').frame?.data).toEqual(new Uint8Array([1]))
  await new Promise(resolve => setTimeout(resolve, 60))
  expect(media.read(view.id, 'owner').frame?.data).toEqual(new Uint8Array([2]))
  await media.close(view.id, 'owner')
})

it('retries a capture cleanup that failed when the viewer closed', async () => {
  vi.useFakeTimers()
  try {
    const records = new Map<string, unknown>()
    const stop = vi.fn().mockRejectedValueOnce(new Error('stop failed')).mockResolvedValue(undefined)
    const broker = {
      options: { journal: { read: async (key: string) => records.get(key), write: async (key: string, value: unknown) => { records.set(key, value) } } },
      capture: async () => stop,
      retireCapture: async () => {},
      read: () => ({ session: { browserGeneration: 1, state: 'open' }, tabs: [{ tabId: 'tab', browserGeneration: 1 }] }),
    } as unknown as BrowserBroker
    const media = new BrowserMediaService(broker, () => {})
    const view = await media.open({ ownerId: 'owner', viewerId: 'viewer', sessionId: 'session', tabId: 'tab', browserGeneration: 1 })
    await expect(media.close(view.id, 'owner')).rejects.toThrow('stop failed')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(stop).toHaveBeenCalledTimes(2)
  } finally { vi.useRealTimers() }
})
