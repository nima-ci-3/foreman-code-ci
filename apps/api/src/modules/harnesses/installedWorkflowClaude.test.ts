import { expect, it, vi } from 'vitest'
import { INSTALLATION_NAMES } from '@foreman-code/contracts/installation-names'
import type { ClaudeSdkClient, ClaudeSdkUserMessage } from './claudeSdk/port.js'
import { ClaudeBoundedQueue } from './claudeSdk/queue.js'
import { workflowRequest } from './claudeSdk/__tests__/sessionManager.js'
import { allocateInstalledWorkflowClaude, type InstalledClaudeWorkflowCapture } from './installedWorkflowClaude.js'

const provider = vi.hoisted(() => ({ client: undefined as ClaudeSdkClient | undefined }))
vi.mock('./claudeSdk/configuration.js', () => ({
  compileClaudeConfiguration: (configuration: { mcpServers: unknown }) => ({
    configuration, mcpServers: configuration.mcpServers, env: {},
    qualification: { basicTurns: true, resume: true, fork: true, history: true, policy: { alwaysAppliedToolHook: true } },
  }),
}))
vi.mock('./claudeSdk/official.js', () => ({ loadOfficialClaudeSdk: async () => provider.client }))
const tools = vi.hoisted(() => ({ discovered: [] as { servers: unknown; token: unknown }[] }))
vi.mock('./claudeSdk/mcpPolicy.js', () => ({ acceptedClaudeAppTools: async (input: { servers: unknown; token: unknown }) => {
  tools.discovered.push({ servers: input.servers, token: input.token })
  return [{ serverName: 'graphql', source: { kind: 'http', url: 'http://127.0.0.1:41000/mcp' }, tools: ['interaction_get'] }]
} }))

function sdk() {
  const frames = new ClaudeBoundedQueue<unknown>(32)
  const closed = { count: 0 }
  const queries: Record<string, unknown>[] = []
  let servers: Readonly<Record<string, unknown>> = {}
  let messages: AsyncIterator<ClaudeSdkUserMessage> | undefined
  const client: ClaudeSdkClient = {
    sdkVersion: '0.3.284', query: input => {
      queries.push(input.options)
      servers = input.options.mcpServers as typeof servers
      messages = input.prompt[Symbol.asyncIterator]()
      return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), interrupt: async () => ({}),
        initializationResult: async () => ({ models: [], account: {} }),
        mcpServerStatus: async () => [{ name: 'graphql', status: 'connected', source: 'dynamic', config: servers.graphql }],
        setMcpServers: async value => { servers = value; return { added: ['graphql'], removed: [], errors: {} } },
        close: () => { closed.count++; frames.close() } }
    }, getSessionInfo: async sessionId => ({ sessionId }), getSessionMessages: async () => [],
    forkSession: async () => { throw new Error('No fork expected') },
  }
  return { client, frames, queries, closed, servers: () => servers, nextMessage: async () => (await messages!.next()).value! }
}

function allocate(options: { prepared?: boolean } = {}) {
  const request = workflowRequest()
  const configuration = { ...request.configuration, harness: { ...request.configuration.harness,
    mcpServers: { graphql: { type: 'http' as const, url: 'http://127.0.0.1:3041/mcp' } } } }
  const capture = { facts: { configuration, intent: { runId: 'run' } },
    inspection: { currentTarget: { installation: { launcher: { resolvedLauncher: '/usr/bin/claude' } }, sdk: { entrypoint: '/sdk' } } },
    accepted: { currentBinding: { pin: { sdkVersion: '0.3.284', cliVersion: '2.1.284', configRevision: 'revision' } } },
  } as unknown as InstalledClaudeWorkflowCapture
  const authority = vi.fn(async (input: { phase: string }) => input.phase === 'admission'
    ? { ownerPrincipalId: 'principal', attemptId: '1', autoAllowTools: true } : { authorized: true })
  const claude = allocateInstalledWorkflowClaude({ capture, workingDirectory: '/work', recovery: { owner: 'execution:execution' } as never,
    environment: {}, before: async () => undefined, mcpEndpoint: 'http://127.0.0.1:41000/mcp', credential: () => 'scoped-token',
    inspectionStart: () => options.prepared === false ? undefined
      : { request: { ...request, configuration }, correlationId: 'execution:execution' },
    authority, callbackJournal: { read: async () => undefined, write: async () => undefined,
      forTool: async () => undefined, acknowledged: async () => [] }, deviceId: 'device' })
  return { claude, authority, start: { request: { ...request, configuration }, correlationId: 'execution:execution',
    environment: { agentId: 'agent', variables: { [INSTALLATION_NAMES.environment.MCP_TOKEN]: 'scoped-token' } } } }
}

it('reports the chosen session at preparation and delivers the scoped credential through the Worker MCP endpoint', async () => {
  const fake = sdk()
  provider.client = fake.client
  const { claude, start } = allocate()
  const session = await claude.manager.createSession(start)
  expect(session).toEqual(claude.session)
  expect(fake.queries).toHaveLength(1)
  expect(fake.queries[0]!.sessionId).toBe(session.nativeSessionId)
  expect(fake.servers().graphql).toMatchObject({ url: 'http://127.0.0.1:41000/mcp',
    headers: { Authorization: 'Bearer scoped-token' } })
  expect(claude.ownsSession(session)).toBe(true)
  await claude.manager.dispose?.()
})

it('sends the first input on the prepared process and acknowledges it by its message ID', async () => {
  const fake = sdk()
  provider.client = fake.client
  const { claude, authority, start } = allocate()
  const session = await claude.manager.createSession(start)
  const submitted = vi.fn(async () => undefined)
  const events = (async () => { for await (const event of claude.manager.startTurn(session,
    { prompt: 'do the work', clientCorrelationId: 'execution:execution', onSubmitted: submitted })) void event })()
  const message = await fake.nextMessage()
  // Main reads the context while Claude has the first input but has not initialized the session.
  expect(claude.manager.contextSnapshot?.(session)).toBeNull()
  await fake.frames.offer({ type: 'system', subtype: 'init', session_id: session.nativeSessionId,
    claude_code_version: '2.1.284', cwd: '/work' })
  await fake.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'reply', user_message_uuid: message.uuid })
  await fake.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'result',
    user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'done' })
  await events
  expect(fake.queries).toHaveLength(1)
  expect(message.message.content).toBe('do the work')
  expect(submitted).toHaveBeenCalledWith(message.uuid)
  expect(authority).toHaveBeenCalledWith({ phase: 'admission' }, expect.anything())
  expect(claude.manager.hasResidentSession(session)).toBe(true)
  await claude.manager.dispose?.()
})

async function completeFirstTurn(fake: ReturnType<typeof sdk>, claude: ReturnType<typeof allocate>['claude'],
  session: Awaited<ReturnType<typeof claude.manager.createSession>>) {
  const events = (async () => { for await (const event of claude.manager.startTurn(session,
    { prompt: 'do the work', clientCorrelationId: 'execution:execution' })) void event })()
  const message = await fake.nextMessage()
  await fake.frames.offer({ type: 'system', subtype: 'init', session_id: session.nativeSessionId,
    claude_code_version: '2.1.284', cwd: '/work' })
  await fake.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'reply', user_message_uuid: message.uuid })
  await fake.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'result',
    user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'done' })
  await events
  return message
}

it('answers Main route discovery before preparation without opening Claude', async () => {
  const fake = sdk()
  provider.client = fake.client
  const { claude } = allocate({ prepared: false })
  expect(await claude.manager.inspectMcp()).toMatchObject({ harness: 'claude', serverName: 'graphql', endpointMatches: true })
  expect(fake.queries).toHaveLength(0)
})

it('binds the application tools the scoped credential lists through the Worker endpoint', async () => {
  const fake = sdk()
  provider.client = fake.client
  tools.discovered.length = 0
  const { claude, start } = allocate()
  await claude.manager.createSession(start)
  expect(tools.discovered).toEqual([{ token: 'scoped-token', servers: { graphql: expect.objectContaining({
    url: 'http://127.0.0.1:41000/mcp', headers: { Authorization: 'Bearer scoped-token' } }) } }])
  await claude.manager.dispose?.()
})

it('reads, stops and closes the reported session before its first input', async () => {
  const fake = sdk()
  provider.client = fake.client
  const { claude, start } = allocate()
  const session = await claude.manager.createSession(start)
  expect(await claude.manager.history(session)).toMatchObject({ events: [], pendingInteractions: [] })
  expect(await claude.manager.reconcile(session, 'execution:execution')).toMatchObject({ events: [] })
  expect(claude.manager.contextSnapshot?.(session)).toBeNull()
  expect(await claude.manager.cancel(session)).toBe(false)
  await claude.manager.close(session)
  expect(fake.closed.count).toBe(1)
})

it('names the completed turn by the acknowledged input message', async () => {
  const fake = sdk()
  provider.client = fake.client
  const { claude, start } = allocate()
  const session = await claude.manager.createSession(start)
  const message = await completeFirstTurn(fake, claude, session)
  const history = await claude.manager.reconcile(session, 'execution:execution')
  expect(history.terminalTurn?.providerId).toBe(message.uuid)
  expect(history.nativeTurnId).toBe(message.uuid)
  await claude.manager.dispose?.()
})

it('reports the final answer in the workflow result shape Main reads', async () => {
  const fake = sdk()
  provider.client = fake.client
  const { claude, start } = allocate()
  const session = await claude.manager.createSession(start)
  await completeFirstTurn(fake, claude, session)
  const history = await claude.manager.reconcile(session, 'execution:execution')
  expect(history.terminalTurn?.result).toEqual({ outcome: 'succeeded', output: { text: 'done' } })
  expect(history.terminalResult).toEqual({ outcome: 'succeeded', output: { text: 'done' } })
  await claude.manager.dispose?.()
})

it('reconciles the whole session as one contiguous event sequence', async () => {
  const fake = sdk()
  provider.client = fake.client
  const { claude, start } = allocate()
  const session = await claude.manager.createSession(start)
  await completeFirstTurn(fake, claude, session)
  // Main streams an execution's events by sequence; the session's own events sit between its turns.
  const history = await claude.manager.reconcile(session, 'execution:execution')
  expect(history.events.map(event => event.sequence)).toEqual(Array.from(
    { length: history.nextSequence! - history.firstRetainedSequence! }, (_, index) => history.firstRetainedSequence! + index))
  expect(history.events.some(event => event.type === 'session.idle')).toBe(true)
  await claude.manager.dispose?.()
})

it('owns a continued session it attached instead of the one it would have chosen', async () => {
  const fake = sdk()
  provider.client = fake.client
  const { claude, start } = allocate()
  const continued = { harness: 'claude' as const, providerVersion: '2.1.284', nativeSessionId: 'continued-session' }
  await claude.manager.attachSession(continued, start)
  expect(claude.session).toEqual(continued)
  expect(claude.ownsSession(continued)).toBe(true)
  await claude.manager.dispose?.()
})
