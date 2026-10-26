import { describe, expect, it, vi } from 'vitest'
import type { Logger } from 'pino'
import { exitAfterShutdown } from './processLifecycle.js'

const logger = () => ({ error: vi.fn(), warn: vi.fn() }) as unknown as Logger & { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }

describe('exitAfterShutdown', () => {
  it('exits once shutdown finishes even while a handle keeps the event loop alive', async () => {
    const lingering = setInterval(() => undefined, 60_000)
    const exit = vi.fn()
    const log = logger()
    try {
      await exitAfterShutdown(async () => undefined, log, exit)
      expect(exit).toHaveBeenCalledWith(0)
      expect(log.warn).toHaveBeenCalledWith({ handles: expect.arrayContaining(['Timeout']) }, 'handles still open after shutdown')
    } finally { clearInterval(lingering) }
  })

  it('exits with 1 and logs the error when shutdown fails', async () => {
    const exit = vi.fn()
    const log = logger()
    const failure = new Error('database close failed')
    await exitAfterShutdown(async () => { throw failure }, log, exit)
    expect(log.error).toHaveBeenCalledWith({ err: failure }, 'shutdown failed')
    expect(exit).toHaveBeenCalledWith(1)
  })
})
