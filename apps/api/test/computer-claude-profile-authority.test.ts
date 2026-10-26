import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { FleetMaintenanceService } from '../src/modules/computers/fleet.js'
import { fakeComputer } from './helpers/fleetSync.js'

const live: ManagementPrincipal = { id: randomUUID(), name: 'Owner', audience: 'operator', revokedAt: null,
  expiresAt: '2099-01-01T00:00:00.000Z', grants: [{ actions: ['settings:read', 'harnesses:read'], scope: {} }] }
vi.mock('../src/modules/access/liveManagementPrincipal.js', () => ({ readLiveManagementPrincipal: async () => live }))

it('does not let a narrowed caller borrow the live owner’s Claude profile access', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'claude-authority-')))
  try {
    const profileDirectory = join(directory, 'profile')
    await mkdir(profileDirectory)
    const mainId = randomUUID(), instanceId = randomUUID()
    const target = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
      keyRevision: null, authorizationRevision: null }
    const profile = { instanceId, revision: 1, instanceRevision: '1',
      target: { hostRef: target.hostRef, applicationInstallationId: mainId, harnessInstallationId: 'claude', installationFingerprint: 'installed' },
      presetId: 'claude', enabled: true, driverId: 'claude', configurationFingerprint: 'configuration', qualification: 'qualified',
      configuration: { harness: 'claude', model: 'model', authMode: 'subscription', configDirectory: profileDirectory,
        permissionMode: 'default', sandbox: 'danger-full-access', tools: ['Write'], permissionRules: [], instructions: '', mcpServers: {} } }
    const sql = { query: async () => ({ rows: [{ record: profile }] }), release: () => {} }
    const computer = fakeComputer(), run = computer.ports.run
    let probes = 0
    computer.ports.run = async (binary, args, options) => {
      if (binary.endsWith('claude') && args[0] === 'auth') {
        probes++
        return { code: 0, stdout: '{"loggedIn":true}', stderr: '' }
      }
      return run(binary, args, options)
    }
    const sources = { codexUserMcpServers: async () => ({}), claudeUserMcpServers: async () => ({}),
      codexPlugins: async () => [], codexMarketplaces: async () => [],
      claudePlugins: async () => ({ plugins: [], marketplaces: [] }) }
    const commands = { recordDenied: vi.fn() }
    const fleet = new FleetMaintenanceService({ connect: async () => sql } as never, mainId, () => undefined,
      commands as never, computer.maintenance, sources)
    const input = { target, claudeProfileProbe: { instanceId, instanceRevision: '1' } }
    const narrowed: ManagementPrincipal = { ...live, grants: [{ actions: ['settings:read'], scope: {} }] }
    await expect(fleet.readTarget(narrowed, 'http', input)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(probes).toBe(0)
    const result = await fleet.readTarget(live, 'http', input)
    expect(result.computers[0]?.status?.claudeProfileProbe).toEqual({ authenticated: true, reason: null })
    expect(probes).toBe(1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
