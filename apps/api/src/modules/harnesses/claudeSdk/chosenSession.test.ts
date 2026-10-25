import { describe, expect, it } from 'vitest'
import { start, fixture, drain } from './__tests__/sessionManager.js'

describe('Claude session chosen before the first input', () => {
  it('starts the new session with the chosen ID and reports it', async () => {
    const f = fixture(undefined, { newSessionId: 'native-session' })
    let observed: string | undefined
    const output = drain(f.manager.startInitialTurn(start, { prompt: 'first', clientCorrelationId: 'operator:one',
      onSessionObserved: async session => { observed = session.nativeSessionId } }))
    const message = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: 'native-session', uuid: 'reply', user_message_uuid: message.uuid })
    void f.frames.offer({ type: 'result', session_id: 'native-session', uuid: 'result', user_message_uuid: message.uuid,
      subtype: 'success', is_error: false, result: 'done' })
    await output
    expect(f.queries.mock.calls[0]![0].options.sessionId).toBe('native-session')
    expect(observed).toBe('native-session')
    await f.manager.dispose?.()
  })

  it('fails the first turn when Claude starts another session', async () => {
    const f = fixture(undefined, { newSessionId: 'chosen-session', initializationTimeoutMs: 1_000 })
    const output = drain(f.manager.startInitialTurn(start, { prompt: 'first', clientCorrelationId: 'operator:one',
      onSessionObserved: async () => undefined }))
    await f.nextMessage()
    await expect(output).rejects.toThrow('another session')
    await f.manager.dispose?.()
  })

  it('never asks the SDK for a new session ID when it resumes one', async () => {
    const f = fixture(undefined, { newSessionId: 'chosen-session' })
    const session = { harness: 'claude' as const, providerVersion: '2.1.284', nativeSessionId: 'native-session' }
    await f.manager.attachSession(session, start)
    expect(f.queries.mock.calls[0]![0].options.sessionId).toBeUndefined()
    await f.manager.dispose?.()
  })
})
