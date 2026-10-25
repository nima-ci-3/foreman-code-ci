import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { withAdvancedDefaults, type NativeSessionReference } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { DeviceSessionBindingSchema, type DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DispatchIntent, AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import { ExecutionFactsResultSchema } from '@foreman-code/contracts/execution-authority'
import { WorkerClaudeAuthorizationSchema, WorkerClaudeCallbackIdentitySchema, WorkerClaudeCallbackRecordSchema,
  type WorkerClaudeAuthorityRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { DomainError } from '../errors.js'
import { sameDeviceInstallation } from '../devices/deviceReconnect.js'
import { inspectInstalledClaude, type InstalledClaudeTarget } from './installedClaudeInspection.js'
import { installedClaudeProfilePin } from './claudeSdk/installedProfilePin.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from './instanceRegistry.js'
import { HarnessInstallationRegistry } from './installationRegistry.js'
import { compileClaudeConfiguration } from './claudeSdk/configuration.js'
import { createClaudeSdkRunner } from './claudeSdk/runner.js'
import { loadOfficialClaudeSdk } from './claudeSdk/official.js'
import { allocateClaudeNativeHarness } from './claudeSdk/composition.js'
import { createClaudeSdkCallbacks } from './claudeSdk/sdkCallbacks.js'
import { ClaudeInteractionBridge, type ClaudeCallbackIdentity } from './claudeSdk/interactions.js'
import type { ClaudeCallbackJournal, ClaudeCallbackRecord } from './claudeSdk/callbackJournal.js'
import type { ClaudeNativeSessionManager } from './claudeSdk/sessionManager.js'
import { appMcpServerName } from './appMcpLauncher.js'
import type { NativeProcessRecovery } from './recovery/processRegistry.js'
import type { NativeHistory, NativeSessionStart, NativeTurnInput } from './port.js'
import { acceptedClaudeAppTools } from './claudeSdk/mcpPolicy.js'
import { readBoundedTextIfPresent, writeDurableFile } from '../../shared/durableFile.js'

const unavailable = (): never => { throw new DomainError('HARNESS_PROFILE_UNAVAILABLE',
  'The installed Worker Claude profile changed or is unavailable.', 409) }
const same = (left: unknown, right: unknown) => commandInputHash(left) === commandInputHash(right)

/** Reads Main's execution facts beside the installed Claude SDK identity, like the Codex reader does for Codex.
 * Claude has no binary suite: its exact-target profile check is the native qualification. */
export function createInstalledClaudeWorkflowReader(input: {
  intent: DispatchIntent
  placement: AcceptedNodePlacement
  trustedCurrentBinding(): Readonly<DeviceSessionBinding> | null
  trustedCurrentIntent?(): DispatchIntent
  inspect(binding: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<{ currentTarget: InstalledClaudeTarget | null }>
  readFacts(signal: AbortSignal): Promise<unknown>
  signal: AbortSignal
}) {
  const initial = input.trustedCurrentBinding()
  const original = initial ? DeviceSessionBindingSchema.parse(initial) : null
  const originalIntent = structuredClone(input.intent), originalPlacement = structuredClone(input.placement)
  const capture = async (effectSignal?: AbortSignal) => {
    const signal = effectSignal ? AbortSignal.any([input.signal, effectSignal]) : input.signal
    signal.throwIfAborted()
    const expectedIntent = structuredClone(input.trustedCurrentIntent?.() ?? originalIntent)
    if (!same({ ...expectedIntent, owner: originalIntent.owner }, originalIntent)) return unavailable()
    const live = input.trustedCurrentBinding()
    if (!live || !original || !sameDeviceInstallation(live, original)) return unavailable()
    const binding = DeviceSessionBindingSchema.parse(live)
    const before = (await input.inspect(binding, signal)).currentTarget
    const facts = ExecutionFactsResultSchema.parse(await input.readFacts(signal))
    const after = (await input.inspect(binding, signal)).currentTarget
    signal.throwIfAborted()
    const { installation, override, profileProof } = facts.harness
    const placement = facts.placement
    if (!before || !after || !same(input.trustedCurrentBinding(), binding)
      || !same(before.binding, binding) || !same(after.binding, binding) || !same(before.target, after.target)
      || !isDeepStrictEqual(before.installation.claudeSdk, after.installation.claudeSdk)
      || !isDeepStrictEqual(before.installation.launcher.payloadFingerprints, after.installation.launcher.payloadFingerprints)
      || !same(facts.intent, expectedIntent) || !same(facts.placement, originalPlacement)
      || placement.hostRef.kind !== 'device' || !placement.registration || placement.payload.kind !== 'agent'
      || binding.mainId !== placement.mainId || binding.deviceId !== placement.hostRef.deviceId
      || binding.workerInstallationId !== placement.registration.workerInstallationId
      || binding.keyRevision !== placement.registration.keyRevision
      || binding.authorizationRevision !== placement.registration.authorizationRevision
      || !same(override.target, after.target) || override.instanceId !== placement.payload.instanceId
      || override.instanceRevision !== placement.payload.instanceRevision
      || placement.payload.driverId !== 'claude' || installation.driverId !== 'claude'
      || placement.payload.harnessInstallationId !== after.target.harnessInstallationId
      || placement.payload.installationFingerprint !== after.target.installationFingerprint
      || !isDeepStrictEqual(installation.claudeSdk, after.installation.claudeSdk)
      || !isDeepStrictEqual(installation.launcher.payloadFingerprints, after.installation.launcher.payloadFingerprints)
      || facts.configuration.harness.harness !== 'claude'
      || !same(withAdvancedDefaults(facts.configuration.harness), withAdvancedDefaults(override.configuration))
      || facts.intent.bindingHash !== placement.bindingHash || facts.executionPlacement.acceptedBindingHash !== placement.bindingHash
      || facts.executionPlacement.executionId !== facts.intent.executionId
      || facts.executionPlacement.attemptId !== facts.intent.attemptId
      || facts.executionPlacement.operationId !== facts.intent.operationId
      || facts.configuration.id !== placement.payload.agentConfigurationVersionId
      || facts.configuration.agentId !== placement.payload.agentId) return unavailable()
    for (const field of ['driverRevision', 'protocolRevision', 'environmentGeneration', 'connectionGeneration'] as const) {
      if (installation[field] !== after.installation[field]) unavailable()
    }
    const instances = new HarnessInstanceRegistry(localHarnessDrivers)
    instances.reload([{ instanceId: override.instanceId, instanceRevision: override.instanceRevision,
      driverId: 'claude', enabled: override.enabled, configuration: override.configuration }])
    const installations = new HarnessInstallationRegistry(instances)
    installations.refresh([after.installation])
    const selected = installations.pin({ instanceId: override.instanceId, hostRef: after.target.hostRef,
      harnessInstallationId: after.target.harnessInstallationId,
      environmentGeneration: after.installation.environmentGeneration,
      connectionGeneration: after.installation.connectionGeneration })
    const pin = installedClaudeProfilePin(override, selected, profileProof)
    return Object.freeze({ binding: Object.freeze(binding), inspection: Object.freeze({ currentTarget: after }), facts,
      accepted: { override, persistedProof: profileProof,
        currentBinding: { ...profileProof, instanceId: override.instanceId, pin } } })
  }
  return Object.freeze({ capture })
}
export type InstalledClaudeWorkflowCapture = Awaited<ReturnType<ReturnType<typeof createInstalledClaudeWorkflowReader>['capture']>>

const CallbackFileSchema = z.object({ records: z.record(z.string(), WorkerClaudeCallbackRecordSchema) }).strict()

/** SDK callback receipts of one workflow execution, kept beside its operation journal so a Worker restart keeps them. */
export function installedWorkflowClaudeCallbackJournal(path: string): ClaudeCallbackJournal {
  const limit = { maxBytes: 4 * 1024 * 1024, message: 'The Claude callback journal is too large.' }
  const read = async () => CallbackFileSchema.parse(JSON.parse(await readBoundedTextIfPresent(path, limit)
    ?? '{"records":{}}')).records as Record<string, ClaudeCallbackRecord>
  let writes: Promise<void> = Promise.resolve()
  return {
    read: async key => (await read())[key],
    write(key, record) {
      const write = writes.then(async () => {
        const parsed = WorkerClaudeCallbackRecordSchema.parse(record)
        if (key !== commandInputHash(parsed.identity)) throw new DomainError('CLAUDE_CALLBACK_SCOPE_DENIED',
          'The callback journal key differs from its native identity.', 409)
        const records = await read()
        const previous = records[key]
        records[key] = { ...record, acknowledged: previous?.acknowledged === true || record.acknowledged,
          ...(previous?.retired || record.retired ? { retired: true } : {}) }
        await writeDurableFile(path, JSON.stringify({ records }), { createParent: true })
      })
      writes = write.catch(() => {
        // ignore: the caller awaits `write` and sees its failure; this chain only serializes later writes.
      })
      return write
    },
    async forTool(identity) {
      const matching = Object.values(await read()).filter(record => record.identity.nativeSessionId === identity.nativeSessionId
        && record.identity.nativeMessageId === identity.nativeMessageId && record.identity.generation === identity.generation
        && record.identity.toolUseId === identity.toolUseId)
      return matching.length === 1 ? matching[0] : undefined
    },
    acknowledged: async sessionId => Object.values(await read())
      .filter(record => record.identity.nativeSessionId === sessionId && record.acknowledged && !record.retired),
  }
}

const AdmissionSchema = z.object({ ownerPrincipalId: z.string().min(1), attemptId: z.string().min(1),
  autoAllowTools: z.boolean() }).strict()

export interface InstalledWorkflowClaude {
  manager: ClaudeNativeSessionManager
  /** The session this execution owns: chosen before the first input, or the continued one. */
  readonly session: NativeSessionReference
  /** True while this manager still owns that session, before and after its first input. */
  ownsSession(session: NativeSessionReference): boolean
}

/** Allocates the Claude adapter for one workflow execution on a paired Worker. The remote protocol records a session
 * before the first message, so the adapter chooses the session ID up front and opens the Claude process with it. */
export function allocateInstalledWorkflowClaude(input: {
  capture: InstalledClaudeWorkflowCapture
  workingDirectory: string
  recovery: NativeProcessRecovery
  environment: NodeJS.ProcessEnv
  apiKey?: string
  /** Revalidates Main authority and reserves the execution's native launch before any SDK process. */
  before(signal?: AbortSignal): Promise<void>
  /** The Worker's local MCP endpoint relaying to Main. */
  mcpEndpoint: string
  /** The execution's current scoped Main credential. */
  credential(): string | undefined
  /** The accepted start once Main prepared the execution; absent during earlier discovery. */
  inspectionStart(): NativeSessionStart | undefined
  authority(request: WorkerClaudeAuthorityRequest, signal: AbortSignal): Promise<unknown>
  callbackJournal: ClaudeCallbackJournal
  deviceId: string
}): InstalledWorkflowClaude {
  const { capture } = input
  const configuration = capture.facts.configuration.harness
  const target = capture.inspection.currentTarget
  const binary = target.installation.launcher.resolvedLauncher
  if (configuration.harness !== 'claude' || !binary) return unavailable()
  const pin = capture.accepted.currentBinding.pin
  const compiled = compileClaudeConfiguration(configuration, input.workingDirectory, capture.accepted,
    input.environment, input.apiKey)
  const serverName = appMcpServerName(compiled.mcpServers)
  const configured = compiled.mcpServers[serverName]
  if (configured?.type !== 'http') throw new DomainError('APP_MCP_PREFLIGHT_FAILED',
    'The accepted Claude settings cannot receive a scoped HTTP credential on this Worker.', 409)
  const localServer = { ...configured, url: input.mcpEndpoint }
  // Callbacks and tool discovery see the application server at the Worker endpoint that relays to Main.
  const callbackConfiguration = { ...compiled.configuration, mcpServers: { ...compiled.configuration.mcpServers,
    [serverName]: localServer } } as typeof compiled.configuration
  // Main returns the workflow's approval handler with each admission; the bridge reads it per callback.
  const policy = { autoAllowTools: false }
  const authorize = async (request: WorkerClaudeAuthorityRequest, signal: AbortSignal) =>
    WorkerClaudeAuthorizationSchema.parse(await input.authority(request, signal))
  const identityOf = (identity: ClaudeCallbackIdentity) => WorkerClaudeCallbackIdentitySchema.parse(identity)
  const signalNever = new AbortController().signal
  const bridge: ClaudeInteractionBridge = new ClaudeInteractionBridge(callbackConfiguration, {
    callbackJournal: input.callbackJournal,
    async validate(identity) { await authorize({ phase: 'validate', identity: identityOf(identity) }, signalNever) },
    async request(identity, toolName, _value, signal) {
      if (toolName === 'AskUserQuestion') return { outcome: 'deny',
        reason: 'Structured native question answers are not supported by the persisted response contract.' }
      await authorize({ phase: 'validate', identity: identityOf(identity) }, signal)
      // Main publishes the pending request from this execution's native history, as for a local workflow.
      return bridge.waitForResponse(identity)
    },
    async validateResponse(identity, answer) {
      if (answer.outcome === 'answered') throw new DomainError('CLAUDE_RESPONSE_CONTRACT_UNSUPPORTED',
        'Structured native question answers are not supported by the persisted response contract.', 409)
      await authorize({ phase: 'response', identity: identityOf(identity),
        answer: { outcome: answer.outcome, ...(answer.reason !== undefined ? { reason: answer.reason } : {}) } }, signalNever)
    },
  }, policy)
  const runner = createClaudeSdkRunner({ loadClient: async () => {
    await input.before()
    return loadOfficialClaudeSdk(compiled.configuration.configDirectory, input.recovery, binary, target.sdk.entrypoint)
  } })
  const sdkOptions: Record<string, unknown> = { ...compiled, mcpServers: { ...compiled.mcpServers, [serverName]: localServer },
    includePartialMessages: true, forwardSubagentText: true,
    ...createClaudeSdkCallbacks({ manager: () => manager, bridge }) }
  delete sdkOptions.configuration
  delete sdkOptions.qualification
  let session: NativeSessionReference = { harness: 'claude', providerVersion: pin.cliVersion, nativeSessionId: randomUUID() }
  let admission: z.infer<typeof AdmissionSchema> | undefined
  const manager = allocateClaudeNativeHarness({ harness: 'claude', role: 'workflow', workingDirectory: input.workingDirectory,
    ownerAgentId: capture.facts.configuration.agentId, processRecovery: input.recovery, appMcpAccess: 'scoped',
    scope: { deviceId: input.deviceId, profilePath: compiled.configuration.configDirectory,
      configRevision: pin.configRevision, cwd: input.workingDirectory },
    runner, sdkOptions, newSessionId: session.nativeSessionId,
    qualification: { sdkVersion: pin.sdkVersion, cliVersion: pin.cliVersion, basicTurns: compiled.qualification.basicTurns,
      resume: compiled.qualification.resume, fork: compiled.qualification.fork, history: compiled.qualification.history,
      interactions: compiled.qualification.policy.alwaysAppliedToolHook },
    inspectionStart: () => input.inspectionStart() ?? (() => { throw new DomainError('CLAUDE_INSPECTION_CONTEXT_REQUIRED',
      'Claude inspection needs the prepared workflow start.', 409) })(),
    expectedMcp: { serverName, url: input.mcpEndpoint },
    interactionPort: {
      async pending(native, signal) { signal?.throwIfAborted(); return bridge.pendingInteractions(native)[0] },
      respond: bridge.respond.bind(bridge),
      async reconcileResponse(native, response, signal) {
        const observation = await bridge.observeResponse(native, response.nativeRequestId, response.option, signal)
        return { events: [], pendingInteractions: bridge.pendingInteractions(native), interactionDeliveries: [observation],
          responseDeliveries: await bridge.deliveryEvidence(native) }
      },
      stopAutomaticResponses: () => bridge.close(),
    },
    liveCallbacks: bridge, cancelPendingRequests: () => bridge.cancelPendingRequests(),
    pendingInteractions: native => bridge.pendingInteractions(native),
    responseDeliveries: native => bridge.deliveryEvidence(native),
    ownerForStart: start => ({ ownerId: capture.facts.intent.runId,
      attemptId: admission?.attemptId ?? start.correlationId ?? 'session-control',
      generation: input.recovery.launchId ?? admission?.attemptId ?? 'session-control' }),
  }).manager
  bridge.subscribePending(notification => manager.notifyPendingChanged(notification))

  let start: NativeSessionStart | undefined
  let opened = false
  // The first input is in flight and Claude has not reported the chosen session yet.
  let initializing = false
  /** The reported session exists only as an ID until Claude initializes it with the first input. */
  const beforeInit = (native: NativeSessionReference) => same(native, session) && (!opened || initializing)
    && !manager.hasResidentSession(native)
  // The remote protocol names a turn by the ID its submission was acknowledged with; for Claude that is the input message.
  const remoteHistory = async (native: NativeSessionReference, read: () => Promise<NativeHistory>): Promise<NativeHistory> => {
    if (beforeInit(native)) return { events: [], pendingInteractions: [], firstRetainedSequence: 0, nextSequence: 0 }
    const history = await read()
    const turnId = history.nativeTurnId ?? history.terminalTurn?.providerId ?? history.nativeSubmission?.nativeMessageId
    return { ...history, ...(turnId ? { nativeTurnId: turnId } : {}), responseDeliveries: await bridge.deliveryEvidence(native) }
  }
  const readHistory = manager.history.bind(manager)
  manager.history = (native, signal) => remoteHistory(native, () => readHistory(native, signal))
  const reconcile = manager.reconcile.bind(manager)
  manager.reconcile = (native, correlationId, signal) => remoteHistory(native, () => reconcile(native, correlationId, signal))
  const reconcileResponse = manager.reconcileResponse!.bind(manager)
  manager.reconcileResponse = (native, response, signal) => remoteHistory(native, () => reconcileResponse(native, response, signal))
  const cancel = manager.cancel.bind(manager)
  manager.cancel = async (native, signal, nativeMessageId) => !opened && same(native, session)
    ? false : cancel(native, signal, nativeMessageId)
  const close = manager.close.bind(manager)
  // Before its first input the session is only the inspected process; closing it ends that process.
  manager.close = async native => { if (!opened && same(native, session)) await manager.dispose?.(); else await close(native) }
  const inspectMcp = manager.inspectMcp.bind(manager)
  // Main checks the route before it prepares the execution; the Worker serves that route itself and proves it with the
  // credential and tool discovery when it opens the session.
  manager.inspectMcp = async signal => input.inspectionStart() ? inspectMcp(signal) : { harness: 'claude', serverName,
    state: 'status_unavailable', endpointMatches: true, credentialEnvironmentVariable: null,
    checkedAt: new Date().toISOString(), detail: 'The Worker checks this route when it opens the Claude session.' }
  const admit = async (message: NativeTurnInput, signal?: AbortSignal) => {
    const { onSubmitted, ...rest } = message
    admission = AdmissionSchema.parse(await input.authority({ phase: 'admission' }, signal ?? signalNever))
    policy.autoAllowTools = admission.autoAllowTools
    return { ...rest, callbackAuthority: { ownerPrincipalId: admission.ownerPrincipalId, attemptId: admission.attemptId },
      // Claude acknowledges each input by its message ID, which the Worker journal records as the turn.
      onMessageSubmitted: async (submission: { nativeMessageId: string }) => { await onSubmitted?.(submission.nativeMessageId) } }
  }
  const createSession = manager.createSession.bind(manager)
  manager.createSession = async (sessionStart, signal) => {
    if ('sessionContinuation' in sessionStart && sessionStart.sessionContinuation) {
      const continued = await createSession(sessionStart, signal)
      session = structuredClone(continued)
      start = structuredClone(sessionStart)
      opened = true
      return continued
    }
    if (start) throw new DomainError('CLAUDE_CREATION_IDENTITY_CONFLICT', 'This execution already chose its Claude session.', 409)
    const token = input.credential()
    if (!token) throw new DomainError('HARNESS_ROLE_AUTHORITY_INVALID', 'The Worker has no scoped Main credential for this execution.', 403)
    await input.before(signal)
    await inspectMcp(signal)
    const scopedServer = { ...localServer, headers: { Authorization: `Bearer ${token}` } }
    const snapshot = await manager.refreshInspectionCredentials(sessionStart,
      { ...sdkOptions.mcpServers as Record<string, unknown>, [serverName]: scopedServer }, signal)
    if (snapshot.httpCredentialAcknowledgement?.endpoint !== input.mcpEndpoint) throw new DomainError(
      'CLAUDE_MCP_CREDENTIAL_DELIVERY_UNCONFIRMED', 'The SDK has not acknowledged the scoped Worker credential.', 409)
    // The bridge allows only the application tools this credential can list through the Worker endpoint.
    bridge.bindMcpTools(await acceptedClaudeAppTools({ configuration: callbackConfiguration,
      servers: { [serverName]: scopedServer }, token, ...(signal ? { signal } : {}) }))
    start = structuredClone(sessionStart)
    return structuredClone(session)
  }
  const startInitialTurn = manager.startInitialTurn.bind(manager)
  const startTurn = manager.startTurn.bind(manager)
  const attachSession = manager.attachSession.bind(manager)
  manager.attachSession = async (native, sessionStart, signal) => {
    const attached = await attachSession(native, sessionStart, signal)
    start ??= structuredClone(sessionStart)
    session = structuredClone(attached)
    opened = true
    return attached
  }
  manager.startTurn = async function* (native, message, signal) {
    if (!start) throw new DomainError('CLAUDE_SESSION_CONTEXT_REQUIRED', 'The message requires its admitted session context.', 409)
    const admitted = await admit(message, signal)
    if (!opened && native.nativeSessionId === session.nativeSessionId) {
      opened = true
      initializing = true
      try {
        yield* startInitialTurn(start, { ...admitted, onSessionObserved: async observed => {
          if (!same(observed, session)) throw new DomainError('CLAUDE_SESSION_MISMATCH',
            'Claude started another session than the one this execution reported.', 409)
          initializing = false
        } }, signal)
      } finally { initializing = false }
      return
    }
    const attached = await attachSession(native, start, signal)
    yield* startTurn(attached, admitted, signal)
  }
  return { manager, get session() { return structuredClone(session) },
    ownsSession: native => same(native, session) && (manager.hasResidentSession(native) || !!start && !opened) }
}

/** What the Worker workflow host needs to run Claude; the Worker composition passes this module's functions. */
export interface InstalledWorkflowClaudeAdapter {
  createReader: typeof createInstalledClaudeWorkflowReader
  inspect: typeof inspectInstalledClaude
  allocate: typeof allocateInstalledWorkflowClaude
  callbackJournal: typeof installedWorkflowClaudeCallbackJournal
}

export const installedWorkflowClaudeAdapter: InstalledWorkflowClaudeAdapter = {
  createReader: createInstalledClaudeWorkflowReader, inspect: inspectInstalledClaude,
  allocate: allocateInstalledWorkflowClaude, callbackJournal: installedWorkflowClaudeCallbackJournal,
}
