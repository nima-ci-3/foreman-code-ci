import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import { HarnessExecutionSchema, type HarnessExecution } from '@foreman-code/contracts'
import { CurrentEditReadResultSchema, CurrentWorkflowSaveResultSchema } from '@foreman-code/contracts/current'
import { PostgresWorkflowClosureStore } from '../src/modules/interactions/workflowClosure.js'
import { graphHeaders } from './graph-composition-fixture.js'
import { writerFixture } from './writer-fixtures.js'
import { currentDatabase, postgresEnabled } from './helpers/database.js'
import { insertCurrentRunFixture } from './helpers/currentRunFixture.js'

async function measure<T>(work: () => Promise<T>) {
  const query = vi.spyOn(pg.Client.prototype, 'query')
  try { return { value: await work(), statements: query.mock.calls.length } }
  finally { query.mockRestore() }
}

describe.skipIf(!postgresEnabled)('public edit read query budget', () => {
  let database: Awaited<ReturnType<typeof currentDatabase>>
  beforeAll(async () => { database = await currentDatabase() }, 60_000)
  afterAll(async () => { await database?.close() })

  it('batches historical Runs and native attempts while retaining exact settlement and changed-set results', async () => {
    const f = await writerFixture(database, 'single')
    try {
      const response = await f.app.inject({ method: 'PUT', url: f.url,
        headers: graphHeaders(f.writer.token), payload: f.input })
      expect(response.statusCode, response.body).toBe(200)
      const saved = CurrentWorkflowSaveResultSchema.parse(response.json()).value
      const closures = new PostgresWorkflowClosureStore(database.pool)
      const runIds: string[] = []
      const executions: HarnessExecution[] = []
      async function history(attempts: number) {
        const fixture = { ...f.f, run: { ...f.f.run, id: randomUUID(), executionLocation: {
          runnerId: 'runner-local', rootPath: database.directory, locationRevision: 1,
          identityHash: `sha256:${'1'.repeat(64)}`,
        } } }
        const { run } = await insertCurrentRunFixture(database.pool, fixture, saved, f.writer.principal.id)
        runIds.push(run.id)
        await database.pool.query('update runs set execution_state=$2,record=$3::jsonb where id=$1',
          [run.id, 'running', JSON.stringify({ ...run, executionState: 'running', startedAt: f.f.createdAt })])
        const terminal = { ...run, executionState: 'completed', outcome: 'succeeded',
          result: { outcome: 'succeeded', output: {} }, finishedAt: f.f.createdAt }
        const node = saved.version.definition.nodes[0]!
        if (node.kind === 'job') throw new Error('Expected an Agent fixture')
        for (let attempt = 1; attempt <= attempts; attempt++) {
          const execution = HarnessExecutionSchema.parse({ id: randomUUID(), runId: run.id,
            workflowNodeId: node.id, agentId: node.agentId,
            agentConfigurationVersionId: saved.version.agentConfigurationVersionIds[node.agentId],
            attempt, input: {}, state: 'completed', createdAt: f.f.createdAt, finishedAt: f.f.createdAt,
            workingDirectory: database.directory, nativeSessionId: randomUUID(),
            result: { outcome: 'succeeded', output: {} } })
          await database.pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
            values($1,$2,$3,$4,$5,$6::jsonb)`,
          [execution.id, run.id, node.id, node.agentId, attempt, JSON.stringify(execution)])
          const session = { harness: 'codex' as const, providerVersion: 'fixture-provider', nativeSessionId: execution.nativeSessionId! }
          await database.pool.query(`insert into execution_native_sessions(execution_id,reference,workflow_finalized_at)
            values($1,$2::jsonb,now())`, [execution.id, JSON.stringify(session)])
          const generation = await closures.begin(execution)
          await closures.record(execution, session, generation, () => {})
          executions.push(execution)
        }
        await database.pool.query('update runs set execution_state=$2,record=$3::jsonb where id=$1',
          [run.id, terminal.executionState, JSON.stringify(terminal)])
      }
      await history(1)
      const draftId = randomUUID()
      const staged = await f.app.inject({ method: 'POST', url: `${f.url}/edits`,
        headers: graphHeaders(f.writer.token), payload: { ...f.input, action: 'stage_edits',
          commandId: randomUUID(), draftId, expectedRevision: saved.revision,
          expectedWorkflowVersionId: saved.currentVersionId,
          graph: { ...saved.version.definition, nodes: saved.version.definition.nodes.map(node => ({ ...node, initialPrompt: 'Changed work' })) } } })
      expect(staged.statusCode, staged.body).toBe(200)
      const intent = CurrentEditReadResultSchema.parse(staged.json()).intent!
      const read = async (explicit = true) => {
        const query = new URLSearchParams({ draftId, ...(explicit ? { intentId: intent.id } : {}) })
        const reply = await f.app.inject({ method: 'GET', url: `${f.url}/edits?${query}`,
          headers: graphHeaders(f.writer.token) })
        expect(reply.statusCode, reply.body).toBe(200)
        return CurrentEditReadResultSchema.parse(reply.json())
      }
      const small = await measure(() => read())
      expect(small.value).toMatchObject({ intent, canStop: true, affectedSetChanged: false,
        current: [expect.objectContaining({ settled: true, nativePending: false })] })
      // More than one native-evidence page, plus Runs with no execution at all.
      await history(129)
      for (let index = 0; index < 38; index++) await history(0)
      const large = await measure(() => read())
      expect(large.value.intent).toEqual(intent)
      expect(large.value).toMatchObject({ canStop: true, affectedSetChanged: true })
      expect(large.value.current.map(item => item.pin.runId)).toEqual([...runIds].sort())
      for (const item of large.value.current) expect(item).toEqual({
        pin: { workspaceId: f.input.workspaceId, workflowId: f.input.workflowId, runId: item.pin.runId,
          workflowVersionId: saved.currentVersionId, executionSemanticsVersion: 3,
          agentConfigurationVersionIds: saved.version.agentConfigurationVersionIds },
        terminal: true, outcome: 'succeeded', settled: true, cleanupPending: false,
        nativePending: false, interactionPending: false, reviewPending: false,
      })
      expect(small.statements).toBeGreaterThan(0)
      expect(large.statements).toBeLessThanOrEqual(16)
      expect(large.statements).toBeLessThanOrEqual(small.statements + 3)
      expect(await read(false)).toEqual(large.value)
      // A new unclosed generation invalidates only its owning Run's proof.
      const changed = executions[executions.length - 1]!
      await database.pool.query(`insert into execution_native_closures(execution_id,execution_identity,expected_reference)
        select execution_id,execution_identity,expected_reference from execution_native_closures
        where execution_id=$1 order by generation desc limit 1`, [changed.id])
      const pending = await read()
      expect(pending.intent).toEqual(intent)
      expect(pending.current.filter(item => !item.settled)).toEqual([
        expect.objectContaining({ pin: expect.objectContaining({ runId: changed.runId }), nativePending: true }),
      ])
    } finally { await f.app.close() }
  }, 120_000)
})
