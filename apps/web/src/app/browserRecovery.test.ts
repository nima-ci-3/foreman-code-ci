import { expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../mocks/server'
import { browserSessionClient, returnBrowserControl } from './browserRecovery'
import type { BrowserSession } from '../features/agent-browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { BrowserRecovery } from './BrowserRecovery'
import { createElement } from 'react'
import { deferred } from '../features/agent-browser/testFixtures'

it('joins shell navigation and panel cleanup into one acknowledged control return', async () => {
  const session: BrowserSession = { id: 'browser', profileId: 'profile', setupForProfileId: 'profile', computerId: 'computer',
    browserGeneration: 1, state: 'ready', selectedTabId: null }
  const commands: string[] = []
  const returned = { sessionId: session.id, state: 'paused', epoch: 2, controllingViewerId: null, reason: 'Browser ready for setup.' }
  server.use(
    http.post('/api/browser/sessions/browser/control/acquire', () => HttpResponse.json({ ...returned, state: 'user', epoch: 1, controllingViewerId: 'viewer' })),
    http.post('/api/browser/sessions/browser/control/release', async ({ request }) => {
      const input = await request.json() as { commandId: string }
      commands.push(input.commandId)
      return HttpResponse.json(returned)
    }),
  )
  await browserSessionClient.acquire(session, 'viewer', 'acquire')
  const navigation = returnBrowserControl()
  const disposal = browserSessionClient.release(session, 'viewer', 1, 'panel-cleanup')
  await navigation
  expect(await disposal).toEqual(returned)
  expect(commands).toHaveLength(1)
})

it('retires the old control claim and cleanup warning after an authoritative browser process replacement', async () => {
  const session: BrowserSession = { id: 'restored-browser', profileId: 'profile', setupForProfileId: 'profile', computerId: 'computer',
    browserGeneration: 1, state: 'ready', selectedTabId: null }
  const control = { sessionId: session.id, state: 'paused', epoch: 3, controllingViewerId: null, reason: 'Browser process restored.' }
  let releases = 0
  server.use(
    http.post('/api/browser/sessions/restored-browser/control/acquire', () => HttpResponse.json({ ...control, state: 'user', epoch: 1, controllingViewerId: 'viewer' })),
    http.post('/api/browser/sessions/restored-browser/control/release', () => {
      releases++
      return HttpResponse.json({ error: { code: 'BROWSER_STALE_EPOCH', message: 'The old browser control is gone.' } }, { status: 409 })
    }),
    http.get('/api/browser/sessions/restored-browser', () => HttpResponse.json({ session: { ...session, browserGeneration: 2 },
      control, tabs: [], uploadChooser: null, dialog: null, files: [] })),
  )
  await browserSessionClient.acquire(session, 'viewer', 'acquire-before-restart')
  await expect(returnBrowserControl()).rejects.toThrow('Browser control return needs attention.')
  render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(BrowserRecovery)))
  expect(screen.getByRole('button', { name: 'Retry browser cleanup' })).toBeVisible()
  await act(async () => { await browserSessionClient.readSession(session.id, new AbortController().signal) })
  await expect(returnBrowserControl()).resolves.toBeUndefined()
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry browser cleanup' })).not.toBeInTheDocument())
  expect(releases).toBe(1)
})

it('keeps a newly acquired claim when the retired process’s pending release fails late', async () => {
  const previous: BrowserSession = { id: 'pending-browser', profileId: 'profile', setupForProfileId: 'profile', computerId: 'computer',
    browserGeneration: 1, state: 'ready', selectedTabId: null }
  const restored = { ...previous, browserGeneration: 2 }, oldReply = deferred<void>(), epochs: number[] = []
  const control = { sessionId: previous.id, state: 'paused', epoch: 3, controllingViewerId: null, reason: 'Browser restored.' }
  server.use(
    http.post('/api/browser/sessions/pending-browser/control/acquire', async ({ request }) => {
      const input = await request.json() as { browserGeneration: number; viewerId: string }
      return HttpResponse.json({ ...control, state: 'user', epoch: input.browserGeneration === 1 ? 1 : 4, controllingViewerId: input.viewerId })
    }),
    http.post('/api/browser/sessions/pending-browser/control/release', async ({ request }) => {
      const { epoch } = await request.json() as { epoch: number }
      epochs.push(epoch)
      if (epoch !== 1) return HttpResponse.json({ ...control, epoch: 5 })
      await oldReply.promise
      return HttpResponse.json({ error: { code: 'BROWSER_STALE_EPOCH', message: 'The old browser control is gone.' } }, { status: 409 })
    }),
    http.post('/api/browser/sessions/open', () => HttpResponse.json({ session: restored, control,
      tabs: [], uploadChooser: null, dialog: null, files: [] })),
  )
  await browserSessionClient.acquire(previous, 'old-viewer', 'before-restart')
  const pendingRelease = returnBrowserControl()
  await waitFor(() => expect(epochs).toEqual([1]))
  await browserSessionClient.reconnect(previous, 'restore-owned-session')
  await browserSessionClient.acquire(restored, 'new-viewer', 'after-restart')
  oldReply.resolve()
  await expect(pendingRelease).resolves.toBeUndefined()
  await returnBrowserControl()
  expect(epochs).toEqual([1, 4])
})
