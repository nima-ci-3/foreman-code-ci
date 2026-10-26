import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import type { OperatorServices } from '../mcp/operator/types.js'
import { localHumanPrincipal } from '../modules/access/localHuman.js'
import { registerRunRequirementsRoutes } from './runRequirements.js'

const mainId = '11111111-1111-4111-8111-111111111111'
const target = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
  keyRevision: null, authorizationRevision: null }
const request = { workspaceId: 'workspace', harness: 'codex', agentIds: [], browserProfiles: [],
  jobDefinitions: [], action: 'check' }

function fixture(options: { online?: boolean; signedIn?: boolean | null; mcp?: 'missing' | 'installed' } = {}) {
  let preset = options.mcp ?? 'missing'
  const account = { tool: 'codex', installed: true, signedIn: options.signedIn === undefined ? false : options.signedIn, account: null, details: [] }
  const applyManaged = vi.fn(async () => { preset = 'installed'; return { status: 'applied' } })
  const services = {
    computerAccounts: { list: async () => ({ computers: [{ target }] }),
      readTarget: async () => ({ computers: [{ target,
        accounts: options.online === false ? null : { accounts: [account] } }] }) },
    computerMaintenance: { readTarget: async () => ({ computers: [{ target, status: options.online === false ? null : {},
      observation: { status: options.online === false ? 'unavailable' : 'available' } }] }) },
    harnessSettings: { mcp: { list: async () => ({ presets: { graphql: preset } }), applyManaged } },
    agents: { get: vi.fn() },
    workspaces: { get: async () => ({ workspace: {}, locationValidation: { status: 'ready' } }) },
  } as unknown as OperatorServices
  const app = Fastify()
  app.addHook('onRequest', async req => { req.operatorPrincipal = localHumanPrincipal })
  registerRunRequirementsRoutes(app, services)
  const call = async (action: 'check' | 'fix') => (await app.inject({ method: 'POST',
    url: '/api/management/computers/run-requirements', payload: { ...request, action } })).json()
  return { app, call, applyManaged }
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
})
