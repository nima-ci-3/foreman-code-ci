import { BrowserOperationResponseSchemas, type BrowserSession, type BrowserRuntimeStatus } from '@foreman-code/contracts'
import { apiClient, ApiError } from '../shared/api/client'

const live = (session: BrowserSession) => session.state !== 'closed' && session.state !== 'failed'

/** Sessions are read independently per computer, so one unavailable host hides nothing else. */
export async function readBrowserSessions(computers: readonly { id: string; name: string }[], signal: AbortSignal, liveOnly = false) {
  const sessions: BrowserSession[] = [], unreachable: string[] = []
  const unavailable: { name: string; runtime: BrowserRuntimeStatus }[] = []
  let answered = 0, failure: unknown
  await Promise.all(computers.map(async computer => {
    try {
      let cursor: string | null = null
      for (let page = 0; page < 20; page++) {
        const input = { computerId: computer.id, limit: 100, ...(liveOnly ? { live: true } : {}), ...(cursor ? { cursor } : {}) }
        const result: { sessions: BrowserSession[]; nextCursor: string | null; runtime?: BrowserRuntimeStatus } = await apiClient.request(`/api/browser/sessions?${new URLSearchParams({ input: JSON.stringify(input) })}`,
          BrowserOperationResponseSchemas.browser_sessions_list, { signal })
        if (result.runtime && !result.runtime.ready) unavailable.push({ name: computer.name, runtime: result.runtime })
        sessions.push(...(liveOnly ? result.sessions.filter(live) : result.sessions))
        cursor = result.nextCursor
        if (!cursor) break
      }
      answered++
    } catch (error) {
      if (signal.aborted) throw error
      // A computer that is offline, outdated or failing hides only its own browsers, never the other computers'.
      unreachable.push(computer.name)
      if (!ApiError.is(error) || error.code !== 'BROWSER_COMPUTER_OFFLINE') failure ??= error
    }
  }))
  // With no computer answering, keep the last good list on screen and show why.
  if (!answered && failure) throw failure
  return { sessions, unreachable, unavailable }
}

export const readLiveBrowserSessions = (computers: readonly { id: string; name: string }[], signal: AbortSignal) =>
  readBrowserSessions(computers, signal, true)
