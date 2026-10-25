import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { ComputerActivityService } from '../src/modules/computers/activity.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { createTestPool } from './helpers/testPool.mjs'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { postgresEnabled } from './helpers/database.js'

it.runIf(postgresEnabled)('counts a coordinator consultation after its source execution finishes and retires it after settlement', async () => {
  const database = await migratedDatabase()
  const schema = `computer_activity_${randomUUID().replaceAll('-', '')}`
  const mainId = randomUUID()
  // Isolated committed read facts; authority and all other computer reads use the fully migrated database.
  await createFixtureSchema(database.pool, schema)
  const pool = createTestPool({ connectionString: database.databaseUrl,
    options: `-c search_path=${schema},public`, max: 2 })
  try {
    for (const table of [
      'runs(id text,workspace_id text,workflow_id text,workflow_version_id text)',
      'workflow_versions(id text,record jsonb)',
      'agents(id text,record jsonb)',
      'run_node_placements(run_id text,node_id text,record jsonb)',
      'harness_executions(id text,run_id text,workflow_node_id text,agent_id text,record jsonb,created_at timestamptz)',
      'run_coordinator_mailboxes(run_id text,workflow_node_id text,agent jsonb,active_consultation_id text)',
      'run_coordinator_consultations(id text,run_id text,state text,created_at timestamptz)',
    ]) await pool.query(`create table ${schema}.${table}`)
    await pool.query("insert into runs values('run','workspace','workflow','version')")
    await pool.query("insert into workflow_versions values('version',$1)", [{ definition: { name: 'Website' } }])
    await pool.query("insert into agents values('master-agent',$1)", [{ name: 'Master' }])
    await pool.query("insert into run_node_placements values('run','master',$1)", [{
      hostRef: { kind: 'main', mainId }, mainInstallationId: mainId,
    }])
    await pool.query("insert into harness_executions values('source','run','master','master-agent',$1,now())", [{ state: 'completed' }])
    await pool.query("insert into run_coordinator_mailboxes values('run','master',$1,'consultation')", [{ agentId: 'master-agent' }])
    await pool.query("insert into run_coordinator_consultations values('consultation','run','active',now())")
    const access = new PostgresAccessService(database.pool)
    const caller = await access.issue({ name: 'Computer activity reader', audience: 'operator',
      grants: [{ actions: ['settings:read', 'runs:read', 'jobs:read'], scope: {} }] })
    const service = new ComputerActivityService(pool, mainId, () => null, new PostgresCommandCoordinator(pool))
    expect((await service.list(caller.principal)).computers[0]!.agents).toEqual([{
      id: 'consultation', workspaceId: 'workspace', workflowId: 'workflow', workflowName: 'Website',
      runId: 'run', nodeId: 'master', agentName: 'Master', state: 'running',
    }])
    await pool.query("update run_coordinator_consultations set state='completed' where id='consultation'")
    expect((await service.list(caller.principal)).computers[0]!.agents).toEqual([])
  } finally {
    await pool.end()
    try { await dropFixtureSchema(database.pool, schema) } finally { await database.close() }
  }
}, 60_000)
