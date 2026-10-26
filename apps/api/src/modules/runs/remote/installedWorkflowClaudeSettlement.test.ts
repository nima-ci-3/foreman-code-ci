import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import type { ClaudeSdkClient } from '../../harnesses/claudeSdk/port.js'
import { ClaudeBoundedQueue } from '../../harnesses/claudeSdk/queue.js'
import { installedWorkflowClaudeAdapter, type InstalledClaudeWorkflowCapture } from '../../harnesses/installedWorkflowClaude.js'
import { freezePlacement } from '../../placement/binding.js'
import { nativePlacementDigest } from '../../placement/executionBinding.js'
import { RemoteExecutionRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { INSTALLATION_NAMES } from '@foreman-code/contracts/installation-names'
import { sourceFixture, nativeFixture, journals } from './__tests__/installedWorkflowHost.js'
import { createInstalledWorkflowHost, type InstalledWorkflowHostOptions } from './installedWorkflowHost.js'
import { RemoteOperationJournal } from './operationJournal.js'
import { RemoteNativeSessionManager } from './nativeManagerProxy.js'
import { createRemoteWorkflowPhysicalVerification } from './workflowPhysicalVerification.js'
import { remoteWorkflowSourceDigest } from './workflowPhysicalReadout.js'
import * as mcp from './workerMcpEndpoint.js'
import { assertOriginalWorkflowTerminal } from '../../interactions/workflowTerminalSource.js'

const sdk = vi.hoisted(() => ({ client: undefined as ClaudeSdkClient | undefined }))
vi.mock('../../harnesses/claudeSdk/official.js', () => ({ loadOfficialClaudeSdk: async () => sdk.client }))
vi.mock('../../harnesses/claudeSdk/configuration.js', () => ({
  compileClaudeConfiguration: (configuration: { mcpServers: unknown }, cwd: string) => ({ configuration, cwd,
    mcpServers: configuration.mcpServers, env: {}, qualification: { basicTurns: true, resume: true,
      fork: true, history: true, policy: { alwaysAppliedToolHook: true } } }),
}))
vi.mock('../../harnesses/claudeSdk/mcpPolicy.js', () => ({ acceptedClaudeAppTools: async () => [] }))

it.each([false, true])('settles and retires installed Claude after delayed terminal reads and a lost event ACK response without Stop (corrective=%s)', async corrective => {
  const f = await sourceFixture(), native = nativeFixture()
  const configuration = { ...f.request.configuration, harness: { harness: 'claude' as const, model: 'claude-haiku-4-5',
    authMode: 'subscription' as const, configDirectory: join(f.root, 'profile'), permissionMode: 'default' as const,
    sandbox: 'danger-full-access' as const, tools: [], permissionRules: [], instructions: '',
    mcpServers: { graphql: { type: 'http' as const, url: 'http://127.0.0.1:3041/mcp' } } } }
  const { bindingHash: _binding, ...pins } = f.placement
  void _binding
  if (pins.payload.kind !== 'agent') throw new Error('Expected Agent placement')
  const placement = freezePlacement({ ...pins, payload: { ...pins.payload, driverId: 'claude' } })
  const intent = { ...f.intent, bindingHash: placement.bindingHash }
  const { bindingHash: _nativeBinding, ...nativePins } = f.nativePlacement
  void _nativeBinding
  const nativeFields = { ...nativePins, acceptedBindingHash: placement.bindingHash }
  const nativePlacement = { ...nativeFields, bindingHash: nativePlacementDigest(nativeFields) }
  nativePlacement.materialization.finalDispatchBindingHash = nativePlacement.bindingHash
  const request = { ...f.request, configuration }
  const journal = await RemoteOperationJournal.open(join(f.root, 'claude-journal'), { initializeNewInstallation: true })
  journals.push(journal)
  vi.spyOn(native.registry, 'abandonReservedLaunch').mockResolvedValue(false)
  vi.spyOn(native.registry, 'reserveLaunch').mockImplementation(async owner => ({ ...native.registry.scope(owner), launchId: native.launch.launchId }))
  vi.spyOn(native.registry, 'closeRegistration').mockResolvedValue(undefined)
  vi.spyOn(native.registry, 'closeOwner').mockImplementation(async () => {
    native.snapshot.mockReturnValue({ revision: 'closed', launches: [{ ...native.launch, lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty' }] })
    return true
  })
  vi.spyOn(mcp, 'createUnboundWorkerMcpEndpoint').mockResolvedValue({ endpoint: 'http://127.0.0.1:41000/mcp',
    bindRelay: async () => {}, unbindRelay: async () => {}, close: async () => {}, refreshLease: async () => '2099-01-01T00:00:00.000Z' })
  let messages = 0
  sdk.client = { sdkVersion: '0.3.284', getSessionInfo: async sessionId => ({ sessionId }), getSessionMessages: async () => [],
    forkSession: async () => { throw new Error('No fork expected') }, query(input) {
      const frames = new ClaudeBoundedQueue<unknown>(64)
      let servers = input.options.mcpServers as Record<string, unknown>
      const pumping = (async () => {
        for await (const message of input.prompt) {
          messages++
          const session_id = input.options.sessionId
          await frames.offer({ type: 'system', subtype: 'init', session_id, claude_code_version: '2.1.284', cwd: input.options.cwd })
          await frames.offer({ type: 'assistant', uuid: `answer-${messages}`, session_id, user_message_uuid: message.uuid,
            parent_tool_use_id: null, message: { id: `answer-${messages}`, content: [{ type: 'text', text: 'Complete' }] } })
          await frames.offer({ type: 'result', uuid: `result-${messages}`, session_id, user_message_uuid: message.uuid,
            parent_tool_use_id: null, subtype: 'success', is_error: false, result: 'Complete' })
        }
      })()
      void pumping.catch(error => frames.close(error))
      return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), close: () => frames.close(),
        interrupt: async () => ({}), initializationResult: async () => ({ models: [], account: {} }),
        mcpServerStatus: async () => [{ name: 'graphql', status: 'connected', source: 'dynamic', config: servers.graphql }],
        setMcpServers: async value => { servers = value; return { added: ['graphql'], removed: [], errors: {} } } }
    } }
  const capture = { binding: f.context.binding, facts: { intent, placement, executionPlacement: nativePlacement, configuration },
    inspection: { currentTarget: { installation: { launcher: { resolvedLauncher: '/recorded/claude' } }, sdk: { entrypoint: '/recorded/sdk' } } },
    accepted: { currentBinding: { pin: { sdkVersion: '0.3.284', cliVersion: '2.1.284', configRevision: '1' } } },
  } as unknown as InstalledClaudeWorkflowCapture
  const file = join(f.root, 'installed.json')
  await writeFile(file, JSON.stringify({ schemaVersion: 1, appMcpLauncher: '/recorded/launcher',
    claude: { binary: '/recorded/claude', installedLockPath: '/recorded/lock' } }), { mode: 0o600 })
  const binding = f.context.binding
  const options: InstalledWorkflowHostOptions = { stateDirectory: f.root, registry: native.registry, mainNow: Date.now,
    bootId: binding.bootId, pairing: { formatVersion: 1, mainId: binding.mainId, deviceId: binding.deviceId,
      workerInstallationId: binding.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
      endpoint: 'wss://unit.invalid/device', mainPublicKeyFingerprint: 'a'.repeat(64), credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' },
    configuration: { path: file, ownerUid: process.getuid!() }, currentBinding: () => binding,
    captureRequest: () => ({ binding, request: async raw => {
      const value = raw as { action?: string; method?: string; request?: { phase: string } }
      if (value.method === 'claude-authority') return { payload: value.request?.phase === 'admission'
        ? { ownerPrincipalId: 'owner', attemptId: 'attempt', autoAllowTools: true } : { authorized: true } }
      if (value.action) return { payload: { version: 1, action: value.action, operationId: intent.operationId,
        attemptId: intent.attemptId, bindingHash: intent.bindingHash, owner: intent.owner } }
      return { payload: { version: 1, mainId: intent.mainId, audience: 'worker', principalId: 'owner',
        executionId: intent.executionId, agentId: configuration.agentId, operationId: intent.operationId,
        attemptId: intent.attemptId, bindingHash: intent.bindingHash, expiresAt: '2099-01-01T00:00:00.000Z' } }
    } }), sources: f.sources, approvedRoots: async () => f.approvedRoots, codexSuiteRevision: 'unused',
    signal: new AbortController().signal, journal: async () => journal,
    workflowClaude: { ...installedWorkflowClaudeAdapter,
      createReader: () => ({ capture: async () => capture }) } }
  const host = await createInstalledWorkflowHost(options)
  if (host.kind !== 'configured') throw new Error('Expected installed Claude host')
  const call = async (raw: unknown) => {
    const frame = RemoteExecutionRpcRequestSchema.parse(raw)
    return host.extensions[0]!.handle!({ ...frame, ...(frame.method === 'prepare' ? { executionPlacement: nativePlacement } : {}) }, f.context)
  }
  const physical = createRemoteWorkflowPhysicalVerification({ endpoint: () => ({ currentBinding: () => binding,
    captureRequest: () => ({ binding, request: call }) }) })
  let receipt: ReturnType<typeof RemoteOperationReceiptSchema.parse> | undefined
  const proxy = new RemoteNativeSessionManager({ intent, placement, harness: 'claude', configuration,
    transport: { request: async (_method, raw) => (await call(raw)).payload },
    observeReceipt: async value => { receipt = value },
    observeOriginalSource: async (value, source, signal) => { await physical.prefetch(value, placement, source, signal) },
    controlFor: async () => { throw new Error('Settlement must not Stop the execution') } })
  const correlation = `execution:${intent.executionId}`
  try {
    const session = await proxy.createSession({ request, correlationId: correlation,
      environment: { agentId: configuration.agentId, variables: { [INSTALLATION_NAMES.environment.MCP_TOKEN]: 'original-token' } } })
    let current = correlation
    for (let turn = 0; turn <= Number(corrective); turn++) {
      current = turn ? `${correlation}:result-repair:1` : correlation
      for await (const event of proxy.startTurn(session, { prompt: 'Complete the work', clientCorrelationId: current, deferSettlement: true })) {
        if (event.type === 'turn.completed') {
          // Main has published the last frame; its history refresh outlasts the stream cache.
          const later = Date.now() + 31_000
          const clock = vi.spyOn(Date, 'now').mockReturnValue(later)
          try { await proxy.history(session) } finally { clock.mockRestore() }
        }
      }
      const history = await proxy.reconcile(session, current)
      expect(history.terminalTurn?.result).toEqual({ outcome: 'succeeded', output: 'Complete' })
      expect(() => assertOriginalWorkflowTerminal({ id: intent.executionId, agentId: configuration.agentId },
        session, history, current)).not.toThrow()
      await call({ method: 'physical-ack', intent, placement, receiptSequence: receipt!.sequence,
        sourceDigest: remoteWorkflowSourceDigest({ type: 'history', history }) })
    }
    const history = await proxy.settleTurn(session, current)
    expect(receipt).toMatchObject({ phase: 'confirmed_terminal', terminal: { kind: 'completed' } })
    expect(history.terminalTurn?.correlationId).toBe(current)
    await proxy.close(session)
    const acknowledgment = { method: 'physical-ack', intent, placement, receiptSequence: receipt!.sequence, retire: true,
      sourceDigest: remoteWorkflowSourceDigest({ type: 'event', event: { ...history.events.at(-1)!, executionId: intent.executionId } }) }
    expect((await call(acknowledgment)).payload).toMatchObject({ status: 'retired' })
    // Its response was lost after the Worker removed the event alias. Main
    // must finish this same ACK before it can ACK the containing history.
    expect((await call(acknowledgment)).payload).toMatchObject({ status: 'not_retained' })
    expect((await call({ ...acknowledgment,
      sourceDigest: remoteWorkflowSourceDigest({ type: 'history', history }) })).payload).toMatchObject({ status: 'retired' })
    expect(await journal.isRetired(intent.operationId)).toBe(true)
    expect(messages).toBe(corrective ? 2 : 1)
  } finally { await host.close() }
})
