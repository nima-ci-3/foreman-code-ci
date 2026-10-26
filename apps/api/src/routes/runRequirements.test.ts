import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import type { OperatorServices } from '../mcp/operator/types.js'
import { localHumanPrincipal } from '../modules/access/localHuman.js'
import { registerRunRequirementsRoutes, repairComputerRequirements } from './runRequirements.js'
import { INSTALLATION_NAMES } from '@foreman-code/contracts/installation-names'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'

const mainId = '11111111-1111-4111-8111-111111111111'
const target = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
  keyRevision: null, authorizationRevision: null }
const request = { workspaceId: 'workspace', harness: 'codex', agentIds: [], browserProfiles: [],
  jobDefinitions: [], action: 'check' }

function fixture(options: { online?: boolean; signedIn?: boolean | null; mcp?: 'missing' | 'installed';
  repository?: boolean; repositoryReady?: boolean; claudeDefault?: boolean; selectionMismatch?: boolean; priorityCodex?: boolean;
  oldWorker?: boolean; browserMissing?: boolean } = {}) {
  let preset = options.mcp ?? 'missing'
  let browserReady = !options.browserMissing
  const selectedTarget = options.oldWorker ? { hostRef: { kind: 'device' as const, mainId,
    deviceId: '22222222-2222-4222-8222-222222222222' }, applicationInstallationId: '33333333-3333-4333-8333-333333333333',
    keyRevision: 1, authorizationRevision: 1 } : target
  const account = { tool: options.claudeDefault ? 'claude' : 'codex', installed: true,
    signedIn: options.signedIn === undefined ? false : options.signedIn, account: null, details: [] }
  const configuration = options.priorityCodex ? { ...DEFAULT_HARNESS_DEFAULTS.codex!, serviceTier: 'priority' }
    : { harness: 'claude', model: 'default', authMode: 'subscription', configDirectory: '/tmp/claude',
      permissionMode: 'default', sandbox: 'danger-full-access', tools: [], permissionRules: [], instructions: '', mcpServers: {} }
  const applyManaged = vi.fn(async () => { preset = 'installed'; return { status: 'applied' } })
  const readMaintenance = vi.fn(async (_principal: unknown, _source: unknown, _input: unknown) => ({ computers: [{ target: selectedTarget, status: options.online === false ? null
    : { ...(options.repository ? { repositoryProbe: { ready: options.repositoryReady === true,
      reason: options.repositoryReady ? null : 'Repository unavailable.' } } : {}),
      ...(options.browserMissing ? { browserRuntime: { ready: browserReady, reason: browserReady ? null : 'Browser runtime missing.' },
        browserProbe: { ready: browserReady, reason: browserReady ? null : 'Browser runtime missing.' } } : {}) },
    ...(options.oldWorker ? { workerReadiness: { ready: false, code: 'WORKER_VERSION_SKEW' } } : {}),
    observation: { status: options.online === false ? 'unavailable' : 'available' } }] }))
  const startMaintenance = vi.fn(async () => { browserReady = true; return { computers: [{ task: { state: 'succeeded' } }] } })
  const services = {
    computerAccounts: { list: async () => ({ computers: [{ target: selectedTarget }] }),
      readTarget: async () => ({ computers: [{ target: selectedTarget,
        accounts: options.online === false ? null : { accounts: [account] } }] }) },
    computerMaintenance: { readTarget: readMaintenance, start: startMaintenance },
    harnessSettings: { mcp: { list: async () => ({ presets: { [INSTALLATION_NAMES.mcp.server]: preset } }), applyManaged } },
    harnessInstances: { list: async () => ({ overrides: options.claudeDefault
      ? [{ enabled: true, driverId: 'claude', configuration, qualification: 'qualified' }] : [] }) },
    extensions: { native: { options: async () => ({ authenticated: true, models: [
      options.priorityCodex ? { id: configuration.model, reasoningEfforts: ['medium'], serviceTiers: ['priority'] }
        : { id: 'resolved-claude-model', defaultPriority: -1, reasoningEfforts: [], serviceTiers: [] },
    ] }) } },
    agents: { get: async () => ({ agent: { id: 'agent', harnessConfiguration: configuration } }) },
    workspaces: { get: async () => ({ workspace: options.repository ? { repository: { owner: 'owner', name: 'public' } } : {},
      locationValidation: { status: 'ready' } }) },
  } as unknown as OperatorServices
  const app = Fastify()
  app.addHook('onRequest', async req => { req.operatorPrincipal = localHumanPrincipal })
  registerRunRequirementsRoutes(app, services)
  const call = async (action: 'check' | 'fix') => (await app.inject({ method: 'POST',
    url: '/api/management/computers/run-requirements', payload: { ...request, action,
      ...(options.claudeDefault ? { harness: 'claude', agentIds: ['agent'] } : {}),
      ...(options.priorityCodex ? { agentIds: ['agent'] } : {}),
      ...(options.selectionMismatch ? { agentConfigurations: [{ agentId: 'agent', configuration,
        selection: { instanceId: '44444444-4444-4444-8444-444444444444', instanceRevision: 'revision-1',
          target: { hostRef: target.hostRef, applicationInstallationId: mainId,
            harnessInstallationId: 'claude', installationFingerprint: 'fingerprint' } } }] } : {}),
      ...(options.oldWorker ? { hostRef: selectedTarget.hostRef } : {}),
      ...(options.browserMissing || options.oldWorker ? { browserProfiles: [null] } : {}) } })).json()
  return { app, call, applyManaged, readMaintenance, startMaintenance }
}

describe('computer Run requirements', () => {
  it('reports an unreadable computer without marking it ready', async () => {
    const f = fixture({ online: false })
    try {
      const result = await f.call('check')
      expect(result.items).toEqual([expect.objectContaining({ id: 'computer', state: 'unknown', fixable: false })])
    } finally { await f.app.close() }
  })

  it('repairs a missing managed connection while a human sign-in remains outstanding', async () => {
    const f = fixture()
    try {
      const before = await f.call('check')
      expect(before.items).toContainEqual(expect.objectContaining({ id: 'sign-in', state: 'missing', fixable: false }))
      expect(before.items).toContainEqual(expect.objectContaining({ id: 'mcp', state: 'missing', fixable: true }))
      const after = await f.call('fix')
      expect(f.applyManaged).toHaveBeenCalledOnce()
      expect(after.items).toContainEqual(expect.objectContaining({ id: 'sign-in', state: 'missing' }))
      expect(after.items).toContainEqual(expect.objectContaining({ id: 'mcp', state: 'ready' }))
    } finally { await f.app.close() }
  })

  it('reports unreadable authentication as unknown', async () => {
    const f = fixture({ signedIn: null, mcp: 'installed' })
    try {
      const result = await f.call('check')
      expect(result.items).toContainEqual(expect.objectContaining({ id: 'sign-in', state: 'unknown' }))
    } finally { await f.app.close() }
  })

  it('accepts a public repository when GitHub is signed out but the host can access it', async () => {
    const f = fixture({ signedIn: true, mcp: 'installed', repository: true, repositoryReady: true })
    try {
      const result = await f.call('check')
      expect(result.items).toContainEqual(expect.objectContaining({ id: 'repository', state: 'ready' }))
      expect(result.items.find((value: { id: string }) => value.id === 'github')).toBeUndefined()
    } finally { await f.app.close() }
  })

  it('recognizes the resolved native default model for Claude', async () => {
    const f = fixture({ signedIn: true, claudeDefault: true })
    try {
      const result = await f.call('check')
      expect(result.items).toContainEqual(expect.objectContaining({ id: 'model:agent', state: 'ready' }))
    } finally { await f.app.close() }
  })

  it('accepts the priority tier advertised for a Codex model', async () => {
    const f = fixture({ signedIn: true, mcp: 'installed', priorityCodex: true })
    try {
      const result = await f.call('check')
      expect(result.items).toContainEqual(expect.objectContaining({ id: 'model:agent', state: 'ready' }))
    } finally { await f.app.close() }
  })

  it('does not substitute an equivalent profile for the Agent’s selected profile', async () => {
    const f = fixture({ signedIn: true, claudeDefault: true, selectionMismatch: true })
    try {
      const result = await f.call('check')
      expect(result.items).toContainEqual(expect.objectContaining({ id: 'profile:agent', state: 'missing', fixable: false }))
    } finally { await f.app.close() }
  })

  it('updates an older Worker before attempting the new browser or repository probes', async () => {
    const f = fixture({ oldWorker: true, signedIn: true, mcp: 'installed' })
    try {
      const result = await f.call('check')
      expect(result.items).toContainEqual(expect.objectContaining({ id: 'worker', state: 'missing', fixable: true }))
      expect(f.readMaintenance).toHaveBeenCalledOnce()
      expect(f.readMaintenance.mock.calls[0]?.[2]).not.toHaveProperty('browserProbe')
    } finally { await f.app.close() }
  })

  it('applies both connection and browser repairs while keeping human requirements visible', async () => {
    const f = fixture({ signedIn: false, browserMissing: true })
    try {
      const result = await f.call('fix')
      expect(f.applyManaged).toHaveBeenCalledOnce()
      expect(f.startMaintenance).toHaveBeenCalledOnce()
      expect(result.items).toContainEqual(expect.objectContaining({ id: 'sign-in', state: 'missing' }))
      expect(result.items).toContainEqual(expect.objectContaining({ id: 'mcp', state: 'ready' }))
      expect(result.items).toContainEqual(expect.objectContaining({ id: 'browser', state: 'ready' }))
      expect(result.items).toContainEqual(expect.objectContaining({ id: 'browser-profile', state: 'missing' }))
    } finally { await f.app.close() }
  })

  it('prepares a saved workflow browser profile during computer upkeep', async () => {
    const configuration = DEFAULT_HARNESS_DEFAULTS.codex!
    let present = false
    const addExisting = vi.fn(async () => { present = true })
    const accounts = { accounts: [
      { tool: 'codex', installed: true, signedIn: true, account: null, details: [] },
      { tool: 'claude', installed: true, signedIn: true, account: null, details: [] },
    ] }
    const maintenance = { status: { browserRuntime: { ready: true, reason: null },
      browserProbe: { ready: true, reason: null } }, observation: { status: 'available' } }
    const services = {
      computerAccounts: { list: async () => ({ computers: [{ target }] }),
        readTarget: async () => ({ computers: [{ target, accounts }] }) },
      computerMaintenance: { readTarget: async () => ({ computers: [{ target, ...maintenance }] }) },
      harnessSettings: { mcp: { list: async () => ({ presets: { [INSTALLATION_NAMES.mcp.server]: 'installed' } }) } },
      workspaces: { list: async () => ({ items: [{ workspace: { id: 'workspace' } }], pageInfo: { nextCursor: null } }),
        get: async () => ({ workspace: {}, locationValidation: { status: 'ready' } }) },
      workflows: { list: async () => ({ items: [{ currentVersionId: 'version', workflow: { nodes: [
        { agentId: 'agent', browser: { enabled: true, profileId: 'browser-profile' } },
      ] } }], pageInfo: { nextCursor: null } }) },
      agents: { get: async () => ({ agent: { id: 'agent', harnessConfiguration: configuration } }) },
      harnessInstances: { list: async () => ({ overrides: [
        { enabled: true, driverId: 'codex', configuration, qualification: 'qualified' },
      ] }) },
      extensions: { native: { options: async () => ({ authenticated: true, models: [
        { id: configuration.model, reasoningEfforts: [configuration.reasoningEffort], serviceTiers: [] },
      ] }) } },
      browser: { profiles: { service: {
        get: async () => ({ profile: { id: 'browser-profile', name: 'Browser', revision: 1,
          distribution: 'shared', sourceComputerId: mainId } }),
        catalog: async () => ({ presentReplicas: present ? [{ profileId: 'browser-profile' }] : [] }),
        addExisting, prepareReplica: async () => undefined,
      } } },
    } as unknown as OperatorServices
    await repairComputerRequirements(services, localHumanPrincipal, target)
    expect(addExisting).toHaveBeenCalledOnce()
  })
})
