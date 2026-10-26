import { createHash, randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CiGetOutputSchema, CiRunOutputSchema, type CiHostRequest, type CiHostRun, type CiTestResults, type IntegrationCoverage } from '@foreman-code/contracts'
import { compactIntegrationCoverage } from '@foreman-code/contracts/ci-coverage'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HostCiService, type CiCommits, type HostCiComputer } from '@foreman-code/ci/service'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { mainCiContext } from '../src/modules/ci/context.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)
// The queue and gate reservations span workspaces; each case owns a fresh fleet.
beforeEach(async () => {
  await database.pool.query('truncate ci_runs, ci_file_durations, management_command_receipts, management_audit')
})

const LABEL = 'apps/api/test/label.integration.test.ts'
const PLAIN = 'apps/api/test/plain.integration.test.ts'
const DYNAMIC = 'apps/api/test/dynamic.integration.test.ts'
const ALL_TESTS = [DYNAMIC, LABEL, PLAIN]

/** The repository at the first commit: LABEL imports label.ts, which imports format.ts. */
const BASE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'site', private: true, devDependencies: { vitest: '4.0.0' } }),
  'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  'scripts/ci-suite.sh': '#!/bin/bash\nexec node scripts/ci-files.mjs\n',
  'scripts/ci-files.mjs': 'export const files = []\n',
  'apps/api/package.json': JSON.stringify({ name: 'api', devDependencies: { vitest: '4.0.0' } }),
  'apps/api/src/lib/format.ts': 'export const format = (value: string) => value.trim()\n',
  'apps/api/src/lib/label.ts': "import { format } from './format.js'\nexport const label = (value: string) => `[${format(value)}]`\n",
  'apps/api/src/unrelated.ts': 'export const unrelated = 1\n',
  [LABEL]: "import { expect, it } from 'vitest'\nimport { label } from '../src/lib/label.js'\n"
    + "it('labels', () => { expect(label(' a ')).toBe('[a]') })\n",
  [PLAIN]: "import { expect, it } from 'vitest'\nit('adds', () => { expect(1 + 1).toBe(2) })\n",
  // A module named at run time: no key can prove what it loads.
  [DYNAMIC]: "import { expect, it } from 'vitest'\nconst name = process.env.FIXTURE_MODULE ?? '../src/lib/format.js'\n"
    + "it('loads', async () => { expect(await import(name)).toBeTruthy() })\n",
}
const commit = (digit: string) => digit.repeat(40)
/** Every later commit changes one input of the first. */
const TREES: Record<string, Record<string, string>> = {
  [commit('1')]: BASE,
  [commit('2')]: { ...BASE, 'apps/api/src/unrelated.ts': 'export const unrelated = 2\n' },
  [commit('3')]: { ...BASE, 'apps/api/src/lib/format.ts': 'export const format = (value: string) => value.trim() || "-"\n' },
  [commit('4')]: { ...BASE, 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n# upgraded\n' },
  [commit('5')]: { ...BASE, 'scripts/ci-suite.sh': '#!/bin/bash\nexec node scripts/ci-files.mjs --changed\n' },
}
/** format.ts with a function LABEL never calls, then commits that change only its body, the called body, or module code. */
const FORMAT = 'apps/api/src/lib/format.ts'
const withFormat = (text: string) => ({ ...BASE, [FORMAT]: text })
TREES[commit('6')] = withFormat('export const format = (value: string) => value.trim()\nexport function pad(value: string) {\n  return value\n}\n')
TREES[commit('7')] = withFormat('export const format = (value: string) => value.trim()\nexport function pad(value: string) {\n  return ` ${value} `\n}\n')
TREES[commit('8')] = withFormat('export const format = (value: string) => value.trimEnd()\nexport function pad(value: string) {\n  return value\n}\n')
TREES[commit('9')] = withFormat('export const format = (value: string) => value.trim()\nexport function pad(value: string) {\n  return value\n}\nexport const width = 2\n')
TREES[commit('a')] = withFormat('export const format = (value: string) => value.trim()\nexport function pad(value: string) {\n  const broken = ;\n}\n')

type Outcome = 'passed' | 'failed' | 'skipped' | 'missing'

async function fixture({ mirror = false, cloudReady = true, cloudStatusError = false } = {}) {
  const pool = database.pool
  const workspaceId = randomUUID()
  await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId, JSON.stringify({
    id: workspaceId, name: 'CI result cache', repository: { provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main' },
    ...(mirror ? { ciMirror: { provider: 'github', owner: 'octo', name: 'site-ci' } } : {}),
  })])
  const access = new PostgresAccessService(pool)
  const commands = new PostgresCommandCoordinator(pool)
  const computers: HostCiComputer[] = [
    { key: 'cache-builder', hostRef: { kind: 'main', mainId: 'cache-main' }, label: 'Builder', priority: 60 },
    ...[0, 1].map(slot => ({ key: `cache-cloud-${slot}`, label: `Cloud ${slot}`, priority: 30,
      hostRef: { kind: 'cloud' as const, mainId: 'cache-main', provider: 'github' as const, slot },
      userSystemd: { supported: true, reason: null } })),
  ]
  const remote = new Map<string, CiHostRun>()
  const starts: Extract<CiHostRequest, { operation: 'start' }>[] = []
  /** Per-file outcomes the build computer reports for the next finished runs. */
  const outcomes = new Map<string, Outcome>()
  const results = (files: string[]): CiTestResults => {
    const reported = files.filter(file => outcomes.get(file) !== 'missing')
    const status = (file: string) => (outcomes.get(file) ?? 'passed') as 'passed' | 'failed' | 'skipped'
    return { truncated: false, summary: {
      passed: reported.filter(file => status(file) === 'passed').length,
      failed: reported.filter(file => status(file) === 'failed').length,
      skipped: reported.filter(file => status(file) === 'skipped').length },
    files: reported.map(file => ({ file, status: status(file) === 'skipped' ? 'passed' : status(file), durationMs: 10,
      tests: [{ name: `${file} works`, status: status(file), durationMs: 10 }] })) }
  }
  const tree = (sha: string) => {
    const files = TREES[sha]
    if (!files) throw new Error(`Unknown commit ${sha}`)
    return { blobs: new Map(Object.entries(files).map(([path, text]) =>
      [path, `100644:${createHash('sha1').update(text).digest('hex')}`])),
    read: async (path: string) => files[path]! }
  }
  /** The coverage the build computer reports for a finished run's files, when set. */
  let coverage: ((files: string[]) => IntegrationCoverage) | undefined
  const integrationFiles = [DYNAMIC, LABEL, PLAIN]
  /** What the repository selector picks at each commit; a missing commit makes it fail. */
  const selections = new Map<string, string[]>()
  /** Commits where the selector picks every file. */
  const fullSelection = new Set<string>()
  const commits: CiCommits & { testTree: (repository: string, sha: string) => Promise<ReturnType<typeof tree>> } = {
    resolve: async (_repository, _branch, sha) => sha!,
    capabilities: async () => ({ parts: true, integrationPartitions: true, affected: true }),
    integrationInventory: async () => ({ files: integrationFiles,
      durations: Object.fromEntries(integrationFiles.map(file => [file, 1000])) }),
    unitInventory: async () => ({ files: ['apps/api/src/site.test.ts'], durations: {}}),
    testTree: async (_repository, sha) => tree(sha),
    // The repository's affected selector, as Main runs it for a caller that names no files.
    affectedSelection: async (_repository, input) => {
      if (fullSelection.has(input.commit)) return { scope: 'full', files: [], reason: 'Shared CI infrastructure changed.' }
      const files = selections.get(input.commit)
      if (!files) throw new Error('The selector failed')
      return { scope: 'affected', files, reason: 'Selected by the repository selector.' }
    },
  }
  const ci = new HostCiService(mainCiContext, pool, commands, new RunCiAuthority(pool), commits, {
    computers: async () => computers,
    request: async (computer, request) => {
      if (request.operation === 'status' && computer.hostRef.kind === 'cloud' && cloudStatusError) {
        throw new Error('Cloud status unavailable')
      }
      if (request.operation === 'status') return { operation: 'status', ready: computer.hostRef.kind !== 'cloud' || cloudReady,
        reasons: computer.hostRef.kind === 'cloud' && !cloudReady ? ['Cloud CI unavailable'] : [],
        cpuCount: 16, memoryBytes: 32 * 2 ** 30, slotsTotal: 8, slotsUsed: 0, runs: [] }
      if (request.operation === 'start') {
        starts.push(request)
        const run: CiHostRun = { runId: request.runId, state: 'running', step: request.suite,
          startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, logBytes: 0, message: null }
        remote.set(request.runId, run)
        return { operation: 'start', run }
      }
      const run = remote.get(request.runId)
      if (!run) throw new Error('Unexpected CI request')
      if (request.operation === 'cancel') return { operation: 'cancel', run: { ...run, state: 'canceled' } }
      const started = starts.find(start => start.runId === request.runId)!
      const finished = !['starting', 'running'].includes(run.state)
      return { operation: 'read', run, text: '', nextOffset: 0,
        ...(request.testResults && finished ? { testResults: results(started.files ?? []) } : {}),
        ...(request.integrationCoverage && finished && coverage ? { integrationCoverage: gzipSync(JSON.stringify(
          compactIntegrationCoverage(coverage(started.files ?? [])))).toString('base64') } : {}) }
    },
  })
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, ci } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const connect = async (actions: typeof CI_GET_ACTIONS) => {
    const issued = await access.issue({ name: 'CI cache caller', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions, scope: { workspaceIds: [workspaceId] } }] })
    const client = new Client({ name: 'ci-result-cache-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${issued.token}` } } }))
    return client
  }
  const operator = await connect([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])
  const call = async (name: string, input: Record<string, unknown>) => {
    const result = await operator.callTool({ name, arguments: { workspaceId, ...input } })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return decodeMcpToolResult(result)
  }
  const request = async (sha: string, files: string[]) => CiRunOutputSchema.parse(await call('ci_run', {
    suite: 'integration', commit: commit(sha), scope: 'affected', files, commandId: randomUUID() }))
  const read = async (ticketId: string) => CiGetOutputSchema.parse(await call('ci_get', { ticketId }))
  const requestSelected = async (sha: string) => CiRunOutputSchema.parse(await call('ci_run', {
    suite: 'integration', commit: commit(sha), scope: 'affected', commandId: randomUUID() }))
  /** Starts the request on the builder, finishes it and collects its results. */
  // ci_run also starts a background dispatch; observations run in the background, so wait for them to finish.
  const settle = async () => { await ci.dispatch(); await ci.drain() }
  const complete = async (ticketId: string, state: 'passed' | 'failed' = 'passed') => {
    await settle()
    const run = remote.get(ticketId)
    if (!run) throw new Error('The CI ticket did not start')
    remote.set(ticketId, { ...run, state, exitCode: state === 'passed' ? 0 : 1, finishedAt: new Date().toISOString() })
    await settle()
    const completed = CiGetOutputSchema.parse(await call('ci_get', {
      ticketId, waitUntil: 'group-terminal', waitSeconds: 10,
    }))
    expect(completed.wait?.status).toBe('settled')
    expect(completed.run).toMatchObject({ state, collection: 'complete' })
  }
  /** The files a request actually sent to a build computer. */
  const sent = async (ticketId: string) => {
    await settle()
    return starts.find(start => start.runId === ticketId)?.files ?? null
  }
  const cachedRows = async () => (await pool.query<{ file: string; ticket_id: string }>(
    // A pass is stored under its full key and its runner-free key; each file and proving ticket counts once.
    'select distinct file,ticket_id from ci_test_result_cache where workspace_id=$1 order by file', [workspaceId])).rows
  return { workspaceId, connect, call, request, requestSelected, selections, fullSelection, read, complete, sent, starts, outcomes, cachedRows,
    reportCoverage: (report: typeof coverage) => { coverage = report }, close: async () => {
    await Promise.all(clients.map(client => client.close()))
    await ci.close()
    await app.close()
  } }
}

it('skips unchanged passed files in a later affected run and reports the run that proved them', async () => {
  const f = await fixture()
  try {
    const first = await f.request('1', [LABEL, PLAIN])
    expect(await f.sent(first.ticketId)).toEqual([LABEL, PLAIN])
    await f.complete(first.ticketId)
    expect(await f.cachedRows()).toEqual([
      { file: LABEL, ticket_id: first.ticketId }, { file: PLAIN, ticket_id: first.ticketId }])

    const startsBefore = f.starts.length
    const second = await f.request('2', [LABEL, PLAIN])
    const proof = [{ file: LABEL, ticketId: first.ticketId, commit: commit('1') },
      { file: PLAIN, ticketId: first.ticketId, commit: commit('1') }]
    expect(second.cachedFiles).toEqual(proof)
    expect(await f.sent(second.ticketId)).toBeNull()
    expect(f.starts).toHaveLength(startsBefore)
    const readback = await f.read(second.ticketId)
    expect(readback.run).toMatchObject({ state: 'passed', cachedFiles: proof })
    expect(readback.logTail).toContain(LABEL)
    expect(readback.logTail).toContain(PLAIN)
    expect(readback.logTail).toContain(first.ticketId)

    const reader = await f.connect(CI_GET_ACTIONS)
    const denied = await reader.callTool({ name: 'ci_run', arguments: { workspaceId: f.workspaceId,
      suite: 'integration', commit: commit('2'), scope: 'affected', files: [LABEL], commandId: randomUUID() } })
    expect(denied.isError).toBe(true)
    expect(await f.cachedRows()).toHaveLength(2)
  } finally { await f.close() }
})

it('runs a file again when a transitive import or an unparsed lockfile changes, and a canary when the runner scripts change', async () => {
  const f = await fixture()
  try {
    const first = await f.request('1', [LABEL, PLAIN])
    await f.complete(first.ticketId)

    const imported = await f.request('3', [LABEL, PLAIN])
    expect(imported.cachedFiles).toEqual([{ file: PLAIN, ticketId: first.ticketId, commit: commit('1') }])
    expect(await f.sent(imported.ticketId)).toEqual([LABEL])
    const notice = f.starts.find(start => start.runId === imported.ticketId)!.notice
    expect(notice).toContain(PLAIN)
    expect(notice).toContain(first.ticketId)

    // A lockfile with no importers cannot be split per package, so it still covers every test.
    const locked = await f.request('4', [LABEL, PLAIN])
    expect(locked.cachedFiles).toBeUndefined()
    expect(await f.sent(locked.ticketId)).toEqual([LABEL, PLAIN])

    // Only the runner changed: one file of the part reruns to prove it, the other stays proven.
    const runner = await f.request('5', [LABEL, PLAIN])
    expect(runner.cachedFiles).toHaveLength(1)
    const canaries = await f.sent(runner.ticketId)
    expect(canaries).toHaveLength(1)
    expect([...canaries!, runner.cachedFiles![0]!.file].sort()).toEqual([LABEL, PLAIN].sort())
  } finally { await f.close() }
})

it('caches a file that passed in a failed ticket, but never failed, skipped, unreported or uncertain results', async () => {
  const f = await fixture()
  try {
    // Only each file's own result matters: LABEL passed although PLAIN failed the ticket.
    f.outcomes.set(PLAIN, 'failed')
    const failed = await f.request('1', [LABEL, PLAIN])
    await f.complete(failed.ticketId, 'failed')
    expect(await f.cachedRows()).toEqual([{ file: LABEL, ticket_id: failed.ticketId }])
    const retry = await f.request('2', [LABEL, PLAIN])
    expect(retry.cachedFiles?.map(item => item.file)).toEqual([LABEL])
    expect(await f.sent(retry.ticketId)).toEqual([PLAIN])

    // Commit 4 changes the lockfile, so no earlier proof applies.
    f.outcomes.set(PLAIN, 'skipped')
    f.outcomes.set(LABEL, 'missing')
    const partial = await f.request('4', [LABEL, PLAIN, DYNAMIC])
    expect(partial.cachedFiles).toBeUndefined()
    await f.complete(partial.ticketId)
    // Only the dynamic file passed, and its import cannot be resolved statically, so it has no usable key.
    expect((await f.cachedRows()).filter(row => row.ticket_id === partial.ticketId)).toEqual([])

    const again = await f.request('4', [LABEL, PLAIN, DYNAMIC])
    expect(again.cachedFiles).toBeUndefined()
    expect(await f.sent(again.ticketId)).toEqual([DYNAMIC, LABEL, PLAIN])
  } finally { await f.close() }
})

it('never skips cached files in full-scope runs or gates', async () => {
  const f = await fixture()
  try {
    const first = await f.request('1', [LABEL, PLAIN])
    await f.complete(first.ticketId)

    const full = CiRunOutputSchema.parse(await f.call('ci_run', { suite: 'integration', commit: commit('1'),
      scope: 'full', commandId: randomUUID() }))
    expect(full.cachedFiles).toBeUndefined()
    // A full-scope start sends no file list, so the builder runs every file.
    await f.sent(full.ticketId)
    const start = f.starts.find(sent => sent.runId === full.ticketId)
    expect(start).toMatchObject({ scope: 'full' })
    expect(start?.files).toBeUndefined()
    expect((await f.read(full.ticketId)).run).toMatchObject({ scope: 'full', files: [], state: 'running',
      computer: { hostRef: { kind: 'main', mainId: 'cache-main' } } })

    const reader = await f.connect(CI_GET_ACTIONS)
    const denied = await reader.callTool({ name: 'ci_run', arguments: { workspaceId: f.workspaceId,
      suite: 'integration', commit: commit('1'), scope: 'full', gate: true } })
    expect(denied.isError).toBe(true)

    const gate = CiRunOutputSchema.parse(await f.call('ci_run', { suite: 'integration', commit: commit('1'),
      scope: 'full', gate: true, commandId: randomUUID() }))
    expect(gate.cachedFiles).toBeUndefined()
    const parts = (await f.read(gate.ticketId)).partitions ?? []
    expect(parts.every(part => part.cachedFiles === undefined)).toBe(true)
    expect(parts.filter(part => part.suite === 'integration').every(part => part.plannedHostKey === 'cache-builder'))
      .toBe(true)
    expect(parts.filter(part => part.suite === 'integration').flatMap(part => part.files).sort())
      .toEqual([DYNAMIC, LABEL, PLAIN])
  } finally { await f.close() }
})

it.each([
  { reason: 'no CI mirror', mirror: false, cloudReady: true, cloudStatusError: false },
  { reason: 'cloud not ready', mirror: true, cloudReady: false, cloudStatusError: false },
  { reason: 'cloud status unavailable', mirror: true, cloudReady: true, cloudStatusError: true },
])('plans and starts a gate on the builder when cloud cannot run it: $reason', async ({ mirror, cloudReady, cloudStatusError }) => {
  const f = await fixture({ mirror, cloudReady, cloudStatusError })
  try {
    const gate = CiRunOutputSchema.parse(await f.call('ci_run', { suite: 'integration', commit: commit('1'),
      scope: 'full', gate: true, commandId: randomUUID() }))
    await f.sent(gate.ticketId)
    const parts = (await f.read(gate.ticketId)).partitions ?? []
    expect(parts.length).toBeGreaterThan(0)
    expect(parts.every(part => part.plannedHostKey === 'cache-builder')).toBe(true)
    expect(parts.filter(part => part.suite === 'integration').flatMap(part => part.files).sort())
      .toEqual([DYNAMIC, LABEL, PLAIN])
    const running = parts.filter(part => part.state === 'running')
    expect(running).toHaveLength(1)
    expect(running[0]?.computer?.hostRef).toEqual({ kind: 'main', mainId: 'cache-main' })
  } finally { await f.close() }
})

it('skips files that already passed in a run whose files the selector chose, and records the files it proves', async () => {
  const f = await fixture()
  try {
    f.selections.set(commit('1'), [LABEL, PLAIN])
    const first = await f.requestSelected('1')
    expect((await f.read(first.ticketId)).run).toMatchObject({ selectedOnMain: true, files: [LABEL, PLAIN] })
    expect(await f.sent(first.ticketId), JSON.stringify(await f.read(first.ticketId))).toEqual([LABEL, PLAIN])
    await f.complete(first.ticketId)
    expect(await f.cachedRows()).toEqual([
      { file: LABEL, ticket_id: first.ticketId }, { file: PLAIN, ticket_id: first.ticketId }])

    // An unrelated change: the selector still picks both files, and both are proven with identical inputs.
    f.selections.set(commit('2'), [LABEL, PLAIN])
    const startsBefore = f.starts.length
    const second = await f.requestSelected('2')
    expect(second.cachedFiles?.map(item => item.file)).toEqual([LABEL, PLAIN])
    expect(await f.sent(second.ticketId)).toBeNull()
    expect(f.starts).toHaveLength(startsBefore)

    // A changed import: only the file that depends on it runs again.
    f.selections.set(commit('3'), [LABEL, PLAIN])
    const third = await f.requestSelected('3')
    expect(third.cachedFiles?.map(item => item.file)).toEqual([PLAIN])
    expect(await f.sent(third.ticketId)).toEqual([LABEL])
  } finally { await f.close() }
})

it('leaves the selection to the runner when the selector cannot run on Main', async () => {
  const f = await fixture()
  try {
    const started = await f.requestSelected('4')
    expect((await f.read(started.ticketId)).run).toMatchObject({ deriveFiles: true })
    expect((await f.read(started.ticketId)).run).not.toHaveProperty('selectedOnMain')
  } finally { await f.close() }
})

it('starts no job for a check whose selector finds nothing affected', async () => {
  const f = await fixture()
  try {
    f.selections.set(commit('2'), [])
    const startsBefore = f.starts.length
    // Measured against a commit this check passed on; without one every package is checked (next case).
    const started = CiRunOutputSchema.parse(await f.call('ci_run', { suite: 'typecheck', commit: commit('2'), scope: 'affected',
      baseCommit: commit('1'), commandId: randomUUID() }))
    expect((await f.read(started.ticketId)).run).toMatchObject({ state: 'passed', selectedOnMain: true, files: [] })
    expect(await f.sent(started.ticketId)).toBeNull()
    expect(f.starts).toHaveLength(startsBefore)
  } finally { await f.close() }
})

it('checks every package when typecheck has no commit it passed on, since a diff proves nothing about the rest', async () => {
  // A docs-only change on a branch whose default-branch base failed typecheck passed at once without checking anything.
  const f = await fixture()
  try {
    f.selections.set(commit('2'), [])
    const started = CiRunOutputSchema.parse(await f.call('ci_run', { suite: 'typecheck', commit: commit('2'), scope: 'affected',
      commandId: randomUUID() }))
    // Background dispatch may already have started it on the builder; what matters is that it checks everything.
    const run = (await f.read(started.ticketId)).run
    expect(run).toMatchObject({ scope: 'full' })
    expect(['queued', 'starting', 'running']).toContain(run.state)
  } finally { await f.close() }
})

it('skips proven files even when the selector picks every file', async () => {
  const f = await fixture()
  try {
    // A CI or lockfile change makes the selector choose the whole suite; files already proven still are not rerun.
    const first = await f.request('1', [LABEL, PLAIN])
    await f.complete(first.ticketId)
    f.fullSelection.add(commit('2'))
    const started = await f.requestSelected('2')
    expect(started.cachedFiles?.map(item => item.file)).toEqual([LABEL, PLAIN])
    expect(await f.sent(started.ticketId)).toEqual([DYNAMIC])
  } finally { await f.close() }
})

it('proves a file again when only bodies of functions it never ran changed, and runs it when it could behave differently', async () => {
  const f = await fixture()
  try {
    // LABEL ran label() and format(), never pad().
    f.reportCoverage(files => ({ version: 1, commit: commit('6'), testFiles: ALL_TESTS, coverage: {}, staticTests: [],
      functionSets: [['apps/api/src/lib/label.ts', ['/label#0']], [FORMAT, ['/format#0']]],
      functions: Object.fromEntries(files.filter(file => file === LABEL).map(file => [file, [0, 1]])) }))
    const first = await f.request('6', [LABEL, PLAIN])
    await f.complete(first.ticketId)

    const unrun = await f.request('7', [LABEL])
    expect(unrun.cachedFiles).toEqual([{ file: LABEL, ticketId: first.ticketId, commit: commit('6'), functions: true }])
    expect(await f.sent(unrun.ticketId)).toBeNull()

    for (const sha of ['8', '9']) {
      const changed = await f.request(sha, [LABEL])
      expect(changed.cachedFiles, `commit ${sha}`).toBeUndefined()
      expect(await f.sent(changed.ticketId)).toEqual([LABEL])
    }
  } finally { await f.close() }
})

it('keeps a smoke pass scoped to its computer instead of proving an ordinary integration run', async () => {
  const f = await fixture()
  try {
    f.reportCoverage(files => ({ version: 1, commit: commit('6'), testFiles: ALL_TESTS, coverage: {}, staticTests: [],
      functionSets: [[FORMAT, ['/format#0']]],
      functions: Object.fromEntries(files.filter(file => file === LABEL).map(file => [file, [0]])) }))
    const smokeInput = { suite: 'integration', commit: commit('6'), scope: 'affected', files: [LABEL],
      smokeComputer: { kind: 'main', mainId: 'cache-main' } }
    const smoke = CiRunOutputSchema.parse(await f.call('ci_run', { ...smokeInput, commandId: randomUUID() }))
    await f.complete(smoke.ticketId)

    const repeated = CiRunOutputSchema.parse(await f.call('ci_run', { ...smokeInput, commandId: randomUUID() }))
    expect(repeated.cachedFiles).toEqual([{ file: LABEL, ticketId: smoke.ticketId, commit: commit('6') }])
    expect(await f.sent(repeated.ticketId)).toBeNull()

    const ordinary = await f.request('7', [LABEL])
    expect(ordinary.cachedFiles).toBeUndefined()
    expect(await f.sent(ordinary.ticketId)).toEqual([LABEL])
  } finally { await f.close() }
})

it('runs a proven file again when an unused function body develops a syntax error', async () => {
  const f = await fixture()
  try {
    f.reportCoverage(files => ({ version: 1, commit: commit('6'), testFiles: ALL_TESTS, coverage: {}, staticTests: [],
      functionSets: [[FORMAT, ['/format#0']]],
      functions: Object.fromEntries(files.filter(file => file === LABEL).map(file => [file, [0]])) }))
    const first = await f.request('6', [LABEL])
    await f.complete(first.ticketId)

    const invalid = await f.request('a', [LABEL])
    expect(invalid.cachedFiles).toBeUndefined()
    expect(await f.sent(invalid.ticketId)).toEqual([LABEL])
  } finally { await f.close() }
})
