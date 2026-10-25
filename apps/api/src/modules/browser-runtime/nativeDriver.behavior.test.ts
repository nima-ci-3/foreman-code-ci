import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { BrowserCdpConnection } from './cdp.js'
import { ManagedBrowserNativeDriver, type BrowserNativeDriverOptions } from './nativeDriver.js'

const servers: WebSocketServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(done => { for (const c of server.clients) c.terminate(); server.close(done) }))) })

async function healthyBrowser(options: Partial<BrowserNativeDriverOptions>) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); servers.push(server); await new Promise(done => server.once('listening', done))
  const peer = new Promise<WebSocket>(resolve => server.once('connection', resolve))
  const connection = await BrowserCdpConnection.connect(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`)
  const browser = await peer
  const onDisconnected = vi.fn(), reportFailure = vi.fn()
  const driver = new ManagedBrowserNativeDriver({ runtime: {} as never, actionDirectory: '/nonexistent', profileDirectory: async () => ({ directory: '/nonexistent', generation: 1 }),
    allocateGeneration: async () => 1, onOrigin: async () => undefined, onDisconnected, reportFailure, downloadDirectory: () => '/nonexistent/downloads', ...options } as BrowserNativeDriverOptions)
  const profile = { generation: 1, process: null, identity: { directory: '/nonexistent', generation: 1 }, connection, headless: true, pendingPopups: new Set(),
    tabs: new Map([['tab', { id: 'tab', sessionId: 'session', title: '', url: '', keys: new Map(), buttons: new Set(), pointer: { x: 0, y: 0 }, dialog: null, frameIds: new Set(['frame']), chooser: null }]]) }
  ;(driver as unknown as { profiles: Map<string, unknown> }).profiles.set('profile', profile)
  connection.onEvent(event => (driver as unknown as { event(id: string, p: unknown, e: unknown): void }).event('profile', profile, event))
  // The fixture browser accepts every command and records when it arrived.
  const commands: { method: string; at: number }[] = []
  browser.on('message', data => {
    const { id, method } = JSON.parse(String(data)) as { id?: number; method: string }
    commands.push({ method, at: performance.now() })
    if (id !== undefined) browser.send(JSON.stringify({ id, result: {} }))
  })
  const emit = (value: object) => browser.send(JSON.stringify(value))
  const settle = () => new Promise(done => setTimeout(done, 50))
  return { onDisconnected, reportFailure, emit, settle, driver, commands }
}

describe('native driver bookkeeping failures', () => {
  it('does not report a healthy browser as disconnected when origin bookkeeping fails', async () => {
    const failure = new Error('profile.json write failed')
    const { onDisconnected, reportFailure, emit, settle } = await healthyBrowser({ onOrigin: async () => { throw failure } })
    emit({ method: 'Page.frameNavigated', sessionId: 'session', params: { frame: { id: 'frame', url: 'https://example.test/page' } } })
    await settle()
    expect(onDisconnected).not.toHaveBeenCalled()
    expect(reportFailure).toHaveBeenCalledWith(failure)
  })

  it('does not report a healthy browser as disconnected when download bookkeeping fails', async () => {
    const failure = new Error('download size mismatch')
    const { onDisconnected, reportFailure, emit, settle } = await healthyBrowser({ onDownload: async () => { throw failure } })
    emit({ method: 'Browser.downloadWillBegin', params: { guid: 'abc', frameId: 'frame', suggestedFilename: 'a.txt' } })
    await settle()
    expect(onDisconnected).not.toHaveBeenCalled()
    expect(reportFailure).toHaveBeenCalledWith(failure)
  })
})

describe('native driver screencast', () => {
  it('shows a viewer that joins a running screencast its latest frame at once', async () => {
    const { driver, emit, settle } = await healthyBrowser({})
    const first: unknown[] = [], second: unknown[] = []
    await driver.capture('profile', 1, 'tab', frame => first.push(frame))
    emit({ method: 'Page.screencastFrame', sessionId: 'session',
      params: { sessionId: 7, data: Buffer.from('static page').toString('base64'), metadata: { deviceWidth: 800, deviceHeight: 600 } } })
    await settle()
    expect(first).toHaveLength(1)
    await driver.capture('profile', 1, 'tab', frame => second.push(frame))
    expect(second).toEqual([expect.objectContaining({ data: Buffer.from('static page'), width: 800, height: 600 })])
  })

  it('acknowledges frames at no more than about 30 per second', async () => {
    const { driver, emit, settle, commands } = await healthyBrowser({})
    await driver.capture('profile', 1, 'tab', () => {})
    const frameEvent = (id: number) => ({ method: 'Page.screencastFrame', sessionId: 'session',
      params: { sessionId: id, data: Buffer.from('frame').toString('base64'), metadata: {} } })
    emit(frameEvent(1)); emit(frameEvent(2))
    await settle()
    const acks = commands.filter(command => command.method === 'Page.screencastFrameAck')
    expect(acks).toHaveLength(2)
    expect(acks[1]!.at - acks[0]!.at).toBeGreaterThanOrEqual(25)
  })
})
