import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { CiRunRecordSchema } from '@foreman-code/contracts'
import { supersedeCiRuns, validateCiSupersession } from '@foreman-code/ci/supersession'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)

it('updates all locked superseded tickets and their ordered audits in one statement', async () => {
  const { pool } = database
  const workspaceId = randomUUID()
  await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
    [workspaceId, JSON.stringify({ id: workspaceId, name: 'Supersession fixture' })])
  const { principal } = await new PostgresAccessService(pool).issue({ name: 'CI requester', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [] })
  const ticket = (commit: string) => CiRunRecordSchema.parse({ id: randomUUID(), workspaceId, groupId: randomUUID(),
    suite: 'lint', part: null, scope: 'full', files: [], partition: null, repository: 'fixture/project', commit,
    state: 'queued', computer: null, step: null, exitCode: null, message: null,
    queuedAt: '2026-01-01T00:00:00Z', startedAt: null, finishedAt: null,
    initiator: { principalId: principal.id, executionId: null } })
  const originals = ['a', 'b', 'c'].map(value => ticket(value.repeat(40)))
  for (const run of originals) await pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record)
    values($1,$2,$3,$4,$5::jsonb)`, [run.id, workspaceId, run.groupId, run.state, JSON.stringify(run)])
  const replacement = ticket('d'.repeat(40))
  let auditOrder: string[] = []
  await withTransaction(pool, async client => {
    const locked = await validateCiSupersession(client, replacement, new Map(originals.map(run => [run.id, true])))
    expect(locked).toHaveLength(3)
    auditOrder = locked!.map(run => run.id)
    const query = vi.spyOn(client, 'query')
    try {
      await supersedeCiRuns(client, replacement, locked!, { source: 'http', commandId: 'replace-all' })
      expect(query).toHaveBeenCalledTimes(1)
    } finally { query.mockRestore() }
  })
  const records = (await pool.query('select record from ci_runs where workspace_id=$1 order by id', [workspaceId])).rows
  expect(records.map(row => row.record)).toEqual(originals.slice().sort((a, b) => a.id.localeCompare(b.id)).map(run =>
    ({ ...run, supersededBy: replacement.id, message: `superseded by ${replacement.id}` })))
  const audits = (await pool.query(`select details from management_audit where principal_id=$1 order by sequence`, [principal.id])).rows
  expect(audits.map(row => row.details)).toEqual(auditOrder.map(ticketId =>
    ({ commandId: 'replace-all', ticketId, supersededBy: replacement.id })))
})
