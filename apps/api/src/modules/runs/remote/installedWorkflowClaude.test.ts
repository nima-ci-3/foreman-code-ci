import { expect, it, vi } from 'vitest'
import type { ClaudeSdkClient, ClaudeSdkUserMessage } from '../../harnesses/claudeSdk/port.js'
import { ClaudeBoundedQueue } from '../../harnesses/claudeSdk/queue.js'
import { workflowRequest } from '../../harnesses/claudeSdk/__tests__/sessionManager.js'
import { allocateInstalledWorkflowClaude, type InstalledClaudeWorkflowCapture } from './installedWorkflowClaude.js'

const provider = vi.hoisted(() => ({ client: undefined as ClaudeSdkClient | undefined }))
vi.mock('../../harnesses/claudeSdk/configuration.js', () => ({
  compileClaudeConfiguration: (configuration: { mcpServers: unknown }) => ({
    configuration, mcpServers: configuration.mcpServers, env: {},
    qualification: { basicTurns: true, resume: true, fork: true, history: true, policy: { alwaysAppliedToolHook: true } },
  }),
}))
vi.mock('../../harnesses/claudeSdk/official.js', () => ({ loadOfficialClaudeSdk: async () => provider.client }))

function sdk() {
  const frames = new ClaudeBoundedQueue<unknown>(32)
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
        close: () => frames.close() }
    }, getSessionInfo: async sessionId => ({ sessionId }), getSessionMessages: async () => [],
    forkSession: async () => { throw new Error('No fork expected') },
  }
  return { client, frames, queries, servers: () => servers, nextMessage: async () => (await messages!.next()).value! }
}

function allocate() {
  const request = workflowRequest()
  const configuration = { ...request.configuration, harness: { ...request.configuration.harness,
    mcpServers: { graphql: { type: 'http', url: 'http://127.0.0.1:3041/mcp' } } } }
  const capture = { facts: { configuration, intent: { runId: 'run' } },
    inspection: { currentTarget: { installation: { launcher: { resolvedLauncher: '/usr/bin/claude' } }, sdk: { entrypoint: '/sdk' } } },
    accepted: { currentBinding: { pin: { sdkVersion: '0.3.284', cliVersion: '2.1.284', configRevision: 'revision' } } },
  } as unknown as InstalledClaudeWorkflowCapture
  const authority = vi.fn(async (input: { phase: string }) => input.phase === 'admission'
    ? { ownerPrincipalId: 'principal', attemptId: '1', autoAllowTools: true } : { authorized: true })
  const claude = allocateInstalledWorkflowClaude({ capture, workingDirectory: '/work', recovery: { owner: 'execution:execution' } as never,
    environment: {}, before: async () => undefined, mcpEndpoint: 'http://127.0.0.1:41000/mcp', credential: () => 'scoped-token',
    inspectionStart: () => ({ request: { ...request, configuration }, correlationId: 'execution:execution' }),
    authority, callbackJournal: { read: async () => undefined, write: async () => undefined,
      forTool: async () => undefined, acknowledged: async () => [] }, deviceId: 'device' })
  return { claude, authority, start: { request: { ...request, configuration }, correlationId: 'execution:execution',
    environment: { agentId: 'agent', variables: {} } } }
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
  await fake.frames.offer({ type: 'system', subtype: 'init', session_id: session.nativeSessionId,
    claude_code_version: '2.1.284', cwd: '/work' })
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
