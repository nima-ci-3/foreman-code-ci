import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/current'
import type { ClaudeSdkClient } from '../src/modules/harnesses/claudeSdk/port.js'
import { ClaudeBoundedQueue } from '../src/modules/harnesses/claudeSdk/queue.js'
import { allocateInstalledWorkflowClaude, type InstalledClaudeWorkflowCapture } from '../src/modules/harnesses/installedWorkflowClaude.js'
import { RemoteExecutionHost } from '../src/modules/runs/remote/executionHost.js'
import { RemoteOperationJournal } from '../src/modules/runs/remote/operationJournal.js'
import { RemoteNativeSessionManager } from '../src/modules/runs/remote/nativeManagerProxy.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import { freezePlacement, deriveDispatch } from '../src/modules/placement/binding.js'
import { repeatDigest } from '../src/modules/runs/repeatResolution.js'
import { RemoteExecutionRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { INSTALLATION_NAMES } from '@foreman-code/contracts/installation-names'
import { checkpointRuntimeFixture } from './helpers/checkpointRuntime.js'
import { deferred } from './helpers/deferred.js'
import { graphParity } from './helpers/graphParity.js'

const sdk = vi.hoisted(() => ({ client: undefined as ClaudeSdkClient | undefined }))
vi.mock('../src/modules/harnesses/claudeSdk/official.js', () => ({ loadOfficialClaudeSdk: async () => sdk.client }))
vi.mock('../src/modules/harnesses/claudeSdk/configuration.js', () => ({
  compileClaudeConfiguration: (configuration: { mcpServers: unknown }, cwd: string) => ({ configuration, cwd,
    mcpServers: configuration.mcpServers, env: {}, qualification: { basicTurns: true, resume: true,
      fork: true, history: true, policy: { alwaysAppliedToolHook: true } } }),
}))
vi.mock('../src/modules/harnesses/claudeSdk/mcpPolicy.js', () => ({ acceptedClaudeAppTools: async () => [] }))

// SDK replay and synthetic host admission/physical ports; the Worker adapter,
// journal, RPC proxy, Main writer lanes, publication and graph readers are real.
it.each(['succeeded', 'failed'] as const)('shows remote Claude corrective work running until its own %s result', async outcome => {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
  fixture.version.approval = { handler: 'native' }
  fixture.version.definition.approval = fixture.version.approval
  fixture.version.definition.handoffs = { contractVersion: 1 }
  fixture.configurations[0]!.harness = { harness: 'claude', model: 'claude-haiku-4-5', authMode: 'subscription',
    configDirectory: '/recorded/profile', permissionMode: 'default', sandbox: 'danger-full-access', tools: [],
    mcpServers: { graphql: { type: 'http', url: 'http://127.0.0.1:3041/mcp' } }, permissionRules: [], instructions: '' }
  const first = deferred(), releaseFirst = deferred(), correctionOffered = deferred(), acknowledgeCorrection = deferred()
  const correction = deferred(), releaseCorrection = deferred(), correctionCompleted = deferred(), finishExecution = deferred()
  const data = { latestDeliverable: { summary: 'Corrected result' }, remainingFindings: [] }
  let messages = 0
  sdk.client = {
    sdkVersion: '0.3.284', getSessionInfo: async sessionId => ({ sessionId }),
    getSessionMessages: async () => [], forkSession: async () => { throw new Error('No fork expected') },
    query(input) {
      const frames = new ClaudeBoundedQueue<unknown>(64)
      let servers = input.options.mcpServers as Record<string, unknown>
      const pumping = (async () => {
        for await (const message of input.prompt) {
          const index = ++messages
          const sessionId = input.options.sessionId
          if (index > 1) { correctionOffered.resolve(); await acknowledgeCorrection.promise }
          await frames.offer({ type: 'system', subtype: 'init', session_id: sessionId,
            claude_code_version: '2.1.284', cwd: input.options.cwd })
          await frames.offer({ type: 'assistant', uuid: `reply-${index}`, session_id: sessionId,
            user_message_uuid: message.uuid, parent_tool_use_id: null,
            message: { id: `answer-${index}`, content: [{ type: 'tool_use', id: `browser-${index}`,
              name: 'mcp__browser__navigate', input: { url: 'https://example.test' } }] } })
          if (index === 1) { first.resolve(); await releaseFirst.promise }
          else { correction.resolve(); await releaseCorrection.promise }
          await frames.offer({ type: 'user', uuid: `tool-result-${index}`, session_id: sessionId,
            parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result',
              tool_use_id: `browser-${index}`, content: 'Page loaded' }] } })
          await frames.offer({ type: 'result', uuid: `result-${index}`, session_id: sessionId,
            user_message_uuid: message.uuid, parent_tool_use_id: null,
            subtype: index > 1 && outcome === 'failed' ? 'error_during_execution' : 'success',
            is_error: index > 1 && outcome === 'failed', errors: outcome === 'failed' ? ['Recorded failure'] : [],
            result: JSON.stringify({ routing: index === 1 ? { kind: 'finish', outcome: 'invalid-extra-field' }
              : { kind: 'finish' }, data }) })
        }
      })()
      void pumping.catch(error => frames.close(error))
      return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), close: () => frames.close(),
        initializationResult: async () => ({ models: [], account: {} }), interrupt: async () => ({}),
        mcpServerStatus: async () => [{ name: 'graphql', status: 'connected', source: 'dynamic', config: servers.graphql }],
        setMcpServers: async value => { servers = value; return { added: ['graphql'], removed: [], errors: {} } } }
    },
  }
  const journalPath = join(process.env.TMPDIR!, `claude-activity-${randomUUID()}`)
  const journal = await RemoteOperationJournal.open(journalPath,
    { initializeNewInstallation: true })
  let host: RemoteExecutionHost | undefined
  const f = await checkpointRuntimeFixture(1, 1, { fixture, approvalNodeIds: [], managerFactory: context => {
    const digest = 'a'.repeat(64), mainId = randomUUID(), deviceId = randomUUID(), workerInstallationId = randomUUID()
    const workerRequest = () => ({ ...context.workflowRequest!, workingDirectory: '/recorded/project',
      runtimeDirectory: `/recorded/runtime/${context.executionId}` })
    let credential: string | undefined
    const placement = freezePlacement({ schemaVersion: 1, mainId, runId: context.runId!, nodeId: fixture.version.entryNodeId,
      hostRef: { kind: 'device', mainId, deviceId }, registration: { workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
      mainInstallationId: 'main-installation', destination: { canonicalProjectRoot: '/recorded/project',
        canonicalCwd: '/recorded/project', managedRuntimeRoot: '/recorded/runtime',
        directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1',
        attestationId: 'attestation', attestationHash: digest },
      source: { revisionId: 'source', manifestDigest: digest, materializationId: 'materialization', materializationDigest: digest },
      payload: { kind: 'agent', agentId: context.agentId, agentConfigurationVersionId: context.configuration.id,
        driverId: 'claude', driverRevision: '1', instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'harness',
        installationFingerprint: digest, runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] } })
    const intent = deriveDispatch(placement, { executionId: context.executionId, occurrenceId: null, occurrenceIndex: 0,
      technicalAttempt: 1, attemptId: randomUUID(), operationId: randomUUID(), inputDigest: repeatDigest(context.workflowRequest!.input),
      owner: { grantId: 'owner', epoch: '1' } })
    const capture = { facts: { configuration: context.configuration, intent },
      inspection: { currentTarget: { installation: { launcher: { resolvedLauncher: '/recorded/claude' } }, sdk: { entrypoint: '/recorded/sdk' } } },
      accepted: { currentBinding: { pin: { sdkVersion: '0.3.284', cliVersion: '2.1.284', configRevision: '1' } } },
    } as unknown as InstalledClaudeWorkflowCapture
    const worker = allocateInstalledWorkflowClaude({ capture, workingDirectory: '/recorded/project',
      recovery: { owner: `execution:${context.executionId}` } as never, environment: {}, before: async () => {},
      mcpEndpoint: 'http://127.0.0.1:41000/mcp', credential: () => credential,
      inspectionStart: () => context.workflowRequest ? { request: workerRequest(), correlationId: `execution:${context.executionId}` } : undefined,
      authority: async request => request.phase === 'admission'
        ? { ownerPrincipalId: 'owner', attemptId: '1', autoAllowTools: true } : { authorized: true },
      callbackJournal: { read: async () => undefined, write: async () => {}, forTool: async () => undefined,
        acknowledged: async () => [] }, deviceId })
    host = new RemoteExecutionHost({ journal, connection: { mainId, deviceId, workerInstallationId, bootId: randomUUID(),
      keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }, incarnationId: randomUUID(),
      managers: new ExecutionScopedNativeSessionManagerResolver(() => worker.manager), authorize: async () => {},
      attestRuntimeLeaf: async (_intent, _placement, request) => ({ executionId: intent.executionId, attemptId: intent.attemptId,
        operationId: intent.operationId, bindingHash: intent.bindingHash, canonicalRuntimeDirectory: request.runtimeDirectory,
        directoryIdentityHash: digest, materializationId: 'materialization', materializationDigest: digest }),
      preflight: async (request, access) => {
        credential = access?.token
        return access ? { agentId: request.configuration.agentId,
          variables: { [INSTALLATION_NAMES.environment.MCP_TOKEN]: access.token } } : undefined
      },
      nativeEvidence: async () => ({ sessionId: worker.session.nativeSessionId, processIdentityDigest: digest }),
      settle: async (_intent, history) => history.terminalTurn ? { kind: history.terminalTurn.result.outcome === 'failed' ? 'failed' : 'completed', result: history.terminalTurn.result,
        closureEvidenceDigest: digest } : null })
    const proxy = new RemoteNativeSessionManager({ intent, placement, harness: 'claude', configuration: context.configuration,
      transport: { request: (_method, raw) => {
        const frame = RemoteExecutionRpcRequestSchema.parse(raw)
        return host!.handle(frame.method === 'prepare' ? { ...frame, request: workerRequest() } : frame)
      } }, observeReceipt: async () => {},
      controlFor: async () => { throw new Error('No controls expected') } })
    const start = proxy.startTurn.bind(proxy)
    proxy.startTurn = async function* (session, input, signal) {
      for await (const event of start(session, input, signal)) {
        yield event
        if (event.type === 'turn.completed' || event.type === 'turn.failed') {
          // A slow terminal publication requires another authenticated history observation.
          const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000)
          try { await proxy.history(session, signal) } finally { clock.mockRestore() }
        }
        if (input.clientCorrelationId?.endsWith(':result-repair:1')
          && (event.type === 'turn.completed' || event.type === 'turn.failed')) {
          correctionCompleted.resolve()
          await finishExecution.promise
        }
      }
    }
    return proxy
  } })
  const task = f.engine.start(f.f.run.id)
  const stopped = task.then(() => { throw new Error('Execution stopped before the expected Claude message') })
  try {
    await Promise.race([first.promise, stopped])
    const parity = await graphParity(f.db.pool, f.f.scope)
    const running = async () => (await parity.compare()).state.nodes[0]
    await expect.poll(running).toMatchObject({ state: { lifecycle: 'running' }, activity: { status: 'active',
      acknowledgementId: expect.any(String), correlationId: expect.any(String), action: 'working' } })
    const original = await running()
    releaseFirst.resolve()
    await Promise.race([correctionOffered.promise, stopped])
    expect(await running()).toMatchObject({ state: { lifecycle: 'starting' }, activity: { status: 'none' } })
    acknowledgeCorrection.resolve()
    await Promise.race([correction.promise, stopped])
    await expect.poll(running).toMatchObject({ state: { lifecycle: 'running' }, activity: { status: 'active',
      acknowledgementId: expect.any(String), correlationId: expect.any(String), action: 'working' } })
    expect((await running())?.activity.correlationId).not.toBe(original?.activity.correlationId)
    releaseCorrection.resolve()
    await Promise.race([correctionCompleted.promise, stopped])
    expect(await running()).toMatchObject({ state: { lifecycle: 'starting' }, activity: { status: 'none' } })
    expect((await f.runs.getDetails(f.f.scope.workspaceId, f.f.run.id))?.executions[0]?.state).toBe('running')
    finishExecution.resolve()
    if (outcome === 'failed') await expect(task).rejects.toMatchObject({ code: 'WORK_SELECTED_EXECUTION_FAILED' })
    else await task
    expect((await parity.compare()).state.nodes[0]).toMatchObject({ state: { lifecycle: outcome }, activity: { status: 'none' } })
    expect(messages).toBe(2)
    expect((await f.runs.getDetails(f.f.scope.workspaceId, f.f.run.id))?.executions).toHaveLength(1)
  } finally {
    releaseFirst.resolve(); acknowledgeCorrection.resolve(); releaseCorrection.resolve(); finishExecution.resolve()
    await stopped.catch(() => { /* ignore: the engine outcome is asserted through task and graph reads. */ })
    await task.catch(() => { /* ignore: cleanup waits for the engine; assertions above report its outcome. */ })
    await host?.shutdown()
    await journal.close()
    await rm(journalPath, { force: true })
    await f.close()
    vi.restoreAllMocks()
  }
}, 60_000)
