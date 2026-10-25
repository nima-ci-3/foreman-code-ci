import { describe, expect, it } from 'vitest'
import type { NativeSessionReference } from '@foreman-code/contracts'
import { claudePromptUuid } from './sessionManager.js'
import { start, fixture, drain } from './__tests__/sessionManager.js'

/** Live SDK behaviour (claude-agent-sdk 0.3.284, Haiku): an input of priority 'next' joins the running turn after its
 * current tool call, and the turn ends with one result naming both messages. */
describe('Claude mid-turn steering', () => {
  async function activeTurn() {
    const f = fixture()
    let session: NativeSessionReference | undefined
    const result = drain(f.manager.startInitialTurn(start, { prompt: 'run three steps', clientCorrelationId: 'operator:one',
      onSessionObserved: async (observed) => { session = observed }, onMessageSubmitted: async () => undefined }))
    const first = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: 'native-session', uuid: 'reply-1', user_message_uuid: first.uuid,
      message: { id: 'api-first', content: [] } })
    await expect.poll(() => session).toBeDefined()
    return { f, first, result, session: () => session! }
  }

  it('joins the exact active turn and finishes it as one result naming both messages', async () => {
    const { f, first, result, session } = await activeTurn()
    await expect.poll(async () => f.manager.steerTurn!(session(), { prompt: 'Change of plan: stop after step two.',
      clientCorrelationId: 'operator:steer', expectedTurnId: first.uuid, controlCommandId: 'steer-1' })
      .then(value => value, () => undefined)).toEqual({ nativeTurnId: first.uuid })
    const steer = await f.nextMessage()
    expect(steer).toMatchObject({ type: 'user', priority: 'next', uuid: claudePromptUuid('steer:steer-1'),
      message: { role: 'user', content: 'Change of plan: stop after step two.' } })
    void f.frames.offer({ type: 'result', session_id: 'native-session', uuid: 'result-1', user_message_uuids: [first.uuid, steer.uuid],
      subtype: 'success', is_error: false, result: 'DONE-STEERED' })
    await result
    expect((await f.manager.reconcile(session(), 'operator:one')).terminalResult?.output).toBe('DONE-STEERED')
    await f.manager.dispose?.()
  })

  it('refuses a steer for a turn that is not the active one', async () => {
    const { f, first, result, session } = await activeTurn()
    await expect.poll(() => f.manager.steerTurn!(session(), { prompt: 'late', clientCorrelationId: 'operator:late',
      expectedTurnId: 'another-turn' }).then(() => 'accepted', (error: { code?: string }) => error.code))
      .toBe('CLAUDE_STEER_TURN_MISMATCH')
    void f.frames.offer({ type: 'result', session_id: 'native-session', uuid: 'result-1', user_message_uuid: first.uuid,
      subtype: 'success', is_error: false, result: 'done' })
    await result
    await f.manager.dispose?.()
  })
})
