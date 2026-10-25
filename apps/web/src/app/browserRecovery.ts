import { create } from 'zustand'
import { sessionGeneration } from '../shared/api/sessionBoundary'
import { validateBrowserRead, type BrowserControl, type BrowserSession, type BrowserSessionRead, type BrowserUiPort } from '../features/agent-browser'
import { browserUiClient, browserProfilesClient } from './browserClients'

interface Cleanup {
  id: string; generation: number; message: string; retry(): Promise<void>
}
// These are retained command identities and launch selections, never a mirror of browser query state.
export const useBrowserRecovery = create<{
  pending: Cleanup[]; setup: { session: BrowserSession; generation: number } | null
  retain(value: Cleanup): void; remove(id: string): void; openSetup(session: BrowserSession | null): void
}>(set => ({ pending: [], setup: null,
  retain: value => set(state => ({ pending: [...state.pending.filter(item => item.id !== value.id), value] })),
  remove: id => set(state => ({ pending: state.pending.filter(item => item.id !== id) })),
  openSetup: session => set({ setup: session ? { session, generation: sessionGeneration() } : null }),
}))
const held = new Map<string, { session: BrowserSession; viewerId: string; epoch: number; commandId: string; generation: number }>()
async function retained(id: string, message: string, work: () => Promise<void>, generation = sessionGeneration()) {
  try { await work(); useBrowserRecovery.getState().remove(id) }
  catch (error) {
    useBrowserRecovery.getState().retain({ id, generation, message, retry: () => retained(id, message, work, generation) })
    throw error
  }
}
type ReleaseAttempt = { args: Parameters<BrowserUiPort['release']>; generation: number; pending?: Promise<BrowserControl> | undefined; result?: BrowserControl }
const releases = new Map<string, ReleaseAttempt>()
function reconcileControl(sessionId: string, read: BrowserSessionRead): BrowserSessionRead {
  if (read.session.id !== sessionId) throw new Error('The browser response belongs to another session.')
  const generation = sessionGeneration()
  const replaced = (session: BrowserSession) => session.id === sessionId && session.profileId === read.session.profileId
    && session.browserGeneration < read.session.browserGeneration
  const claim = held.get(sessionId)
  if (claim?.generation === generation && replaced(claim.session)) held.delete(sessionId)
  for (const attempt of releases.values()) if (!attempt.result && attempt.generation === generation && replaced(attempt.args[0])) {
    // The authoritative replacement proves the retired process cannot still hold its old control claim.
    attempt.result = read.control
    useBrowserRecovery.getState().remove(attempt.args[3])
  }
  return read
}
async function releaseOnce(args: Parameters<BrowserUiPort['release']>): Promise<BrowserControl> {
  const generation = sessionGeneration()
  const key = JSON.stringify([generation, args[0].id, args[0].browserGeneration, args[1], args[2]])
  let attempt = releases.get(key)
  if (!attempt) { attempt = { args, generation }; releases.set(key, attempt) }
  if (attempt.result) return attempt.result
  attempt.pending ??= sendRelease(attempt)
  return attempt.pending
}
async function sendRelease(attempt: ReleaseAttempt): Promise<BrowserControl> {
  try {
    const result = await browserUiClient.release(...attempt.args)
    if (attempt.result) return attempt.result
    if (result.controllingViewerId === attempt.args[1]) throw new Error('Browser control is still held. Reconnect its view before returning control.')
    attempt.result = result
    const claim = held.get(attempt.args[0].id)
    if (claim?.session.browserGeneration === attempt.args[0].browserGeneration && claim.viewerId === attempt.args[1]
      && claim.epoch === attempt.args[2]) held.delete(attempt.args[0].id)
    useBrowserRecovery.getState().remove(attempt.args[3])
    return result
  } catch (error) {
    if (attempt.result) return attempt.result
    useBrowserRecovery.getState().retain({ id: attempt.args[3], generation: attempt.generation,
      message: 'Browser control has not been returned yet.', retry: async () => { await releaseOnce(attempt.args) } })
    throw error
  } finally { attempt.pending = undefined }
}
export const browserSessionClient: BrowserUiPort = { ...browserUiClient,
  async readSession(...args) {
    return reconcileControl(args[0], validateBrowserRead(await browserUiClient.readSession(...args)))
  },
  async reconnect(...args) {
    return reconcileControl(args[0].id, validateBrowserRead(await browserUiClient.reconnect(...args)))
  },
  async acquire(...args) {
    const control = await browserUiClient.acquire(...args)
    if (control.controllingViewerId === args[1]) held.set(args[0].id, { session: args[0], viewerId: args[1], epoch: control.epoch,
      commandId: crypto.randomUUID(), generation: sessionGeneration() })
    return control
  },
  release: (...args) => releaseOnce(args),
  async pause(...args) {
    const control = await browserUiClient.pause(...args)
    const claim = held.get(args[0].id)
    if (claim && claim.viewerId === args[1] && claim.session.browserGeneration === args[0].browserGeneration) {
      held.set(args[0].id, { ...claim, epoch: control.epoch })
    }
    return control
  },
  async closeSession(...args) {
    let result!: Awaited<ReturnType<BrowserUiPort['closeSession']>>
    await retained(args[1], 'Browser cleanup is still pending.', async () => {
      result = await browserUiClient.closeSession(...args)
      if (result === 'pending') throw new Error('Browser cleanup is still pending.')
      held.delete(args[0].id)
    })
    return result
  },
}
export const browserProfileClient = { ...browserProfilesClient, closeSetup: browserSessionClient.closeSession }
export async function returnBrowserControl() {
  const current = [...held.values()].filter(item => item.generation === sessionGeneration())
  const results = await Promise.allSettled(current.map(item => browserSessionClient.release(item.session, item.viewerId, item.epoch, item.commandId)))
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length) throw new AggregateError(failures, 'Browser control return needs attention.')
}
export function retainSetupCleanup(session: BrowserSession, message: string) {
  const commandId = crypto.randomUUID(), generation = sessionGeneration()
  useBrowserRecovery.getState().retain({ id: commandId, generation, message,
    retry: async () => { await browserSessionClient.closeSession(session, commandId) } })
}
