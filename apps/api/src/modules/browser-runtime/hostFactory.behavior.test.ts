import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createBrowserHost, type BrowserHostOptions } from './hostFactory.js'
import { ManagedBrowserNativeDriver } from './nativeDriver.js'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

it('closes every other profile and the virtual display when one profile will not close', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'browser-host-close-'))
  directories.push(stateDirectory)
  vi.spyOn(ManagedBrowserNativeDriver.prototype, 'ownedProfileIds').mockReturnValue(['stuck', 'other'])
  const closeProfile = vi.spyOn(ManagedBrowserNativeDriver.prototype, 'closeProfile').mockImplementation(async profileId => {
    if (profileId === 'stuck') throw new Error('BROWSER_PROCESS_OWNERSHIP')
  })
  const closeDisplay = vi.spyOn(ManagedBrowserNativeDriver.prototype, 'closeVirtualDisplay').mockResolvedValue(undefined)
  const host = await createBrowserHost({ stateDirectory, computerId: 'computer', installationId: 'installation',
    runtime: { rootDirectory: stateDirectory, pythonExecutable: 'python', chromiumExecutable: 'chromium', bridgeScript: 'bridge.py',
      runtimeVersion: '1', profileFormat: 1 },
    subjectAuthority: {} as BrowserHostOptions['subjectAuthority'], pairing: {} as BrowserHostOptions['pairing'],
    keys: {} as BrowserHostOptions['keys'], assertHostOwnership: async () => undefined, reportFailure: () => undefined })
  await expect(host.close()).rejects.toThrow('BROWSER_PROCESS_OWNERSHIP')
  expect(closeProfile).toHaveBeenCalledWith('other')
  expect(closeDisplay).toHaveBeenCalledTimes(1)
})

it('suspends open pages on host shutdown and restores them when the host starts again', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'browser-host-restart-'))
  directories.push(stateDirectory)
  let generation = 0, target = 0
  const tabs = new Map<string, { targetId: string; title: string; url: string }>()
  vi.spyOn(ManagedBrowserNativeDriver.prototype, 'openProfile').mockImplementation(async () => ({ generation: ++generation }))
  vi.spyOn(ManagedBrowserNativeDriver.prototype, 'reconnectProfile').mockResolvedValue(null)
  vi.spyOn(ManagedBrowserNativeDriver.prototype, 'ownedProfileIds').mockReturnValue(['profile'])
  vi.spyOn(ManagedBrowserNativeDriver.prototype, 'closeVirtualDisplay').mockResolvedValue(undefined)
  vi.spyOn(ManagedBrowserNativeDriver.prototype, 'closeProfile').mockImplementation(async () => { tabs.clear() })
  vi.spyOn(ManagedBrowserNativeDriver.prototype, 'createTab').mockImplementation(async () => {
    const tab = { targetId: `target-${++target}`, title: 'Saved page', url: 'about:blank' }
    tabs.set(tab.targetId, tab); return tab
  })
  vi.spyOn(ManagedBrowserNativeDriver.prototype, 'restoreTab').mockImplementation(async (_profile, _generation, targetId) => tabs.get(targetId) ?? null)
  vi.spyOn(ManagedBrowserNativeDriver.prototype, 'closeTab').mockImplementation(async (_profile, _generation, targetId) => { tabs.delete(targetId) })
  vi.spyOn(ManagedBrowserNativeDriver.prototype, 'settlePopups').mockResolvedValue(undefined)
  vi.spyOn(ManagedBrowserNativeDriver.prototype, 'facts').mockImplementation((_profile, _generation, targetId) => ({
    dialog: null, uploadChooser: null, page: tabs.get(targetId)!,
  }))
  vi.spyOn(ManagedBrowserNativeDriver.prototype, 'dispatch').mockImplementation(async (_profile, _generation, targetId, method, params) => {
    if (method === 'Page.navigate') tabs.get(targetId)!.url = String(params.url)
    return {}
  })
  const options: BrowserHostOptions = { stateDirectory, computerId: 'computer', installationId: 'installation',
    runtime: { rootDirectory: stateDirectory, pythonExecutable: 'python', chromiumExecutable: 'chromium', bridgeScript: 'bridge.py',
      runtimeVersion: '1', profileFormat: 1 },
    subjectAuthority: {} as BrowserHostOptions['subjectAuthority'], pairing: {} as BrowserHostOptions['pairing'],
    keys: {} as BrowserHostOptions['keys'], assertHostOwnership: async () => undefined, reportFailure: () => undefined }
  const host = await createBrowserHost(options)
  const session = await host.broker.openSetup('profile', 'setup')
  tabs.values().next().value!.url = 'https://fixture.test/current-page'
  await host.close()
  const restarted = await createBrowserHost(options)
  try {
    expect(restarted.broker.read(session.id)).toMatchObject({ session: { id: session.id, state: 'paused', selectedTabId: session.selectedTabId },
      tabs: [{ tabId: session.selectedTabId, url: 'https://fixture.test/current-page' }] })
  } finally { await restarted.close() }
})
