import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { SkillVersionSchema } from '@foreman-code/contracts/management'
import { resolveAssignedSkills, resolveAssignedSkillSets, resolveWorkspaceSkills, skillHash } from '../src/modules/skills/catalog.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)

it('resolves ordered references across workspaces in one query and retains head locks', async () => {
  const { pool } = database
  const versions = []
  for (const name of ['First', 'Second']) {
    const workspaceId = randomUUID()
    await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [workspaceId, JSON.stringify({ id: workspaceId, name })])
    const skill = SkillVersionSchema.parse({ workspaceId, skillId: randomUUID(), version: 'v1', name,
      instructions: `Use ${name}`, contentHash: skillHash(`Use ${name}`), createdAt: new Date().toISOString() })
    await pool.query(`insert into workspace_skill_versions(workspace_id,skill_id,version,record,sequence)
      values($1,$2,$3,$4::jsonb,1)`, [workspaceId, skill.skillId, skill.version, JSON.stringify(skill)])
    await pool.query(`insert into workspace_skills(workspace_id,skill_id,head_version,revision,version_count)
      values($1,$2,$3,1,1)`, [workspaceId, skill.skillId, skill.version])
    versions.push(skill)
  }
  const references = versions.reverse().map(({ workspaceId, skillId, version }) => ({ workspaceId, skillId, version }))
  await withTransaction(pool, async client => {
    const query = vi.spyOn(client, 'query')
    try {
      const resolved = await resolveWorkspaceSkills(client, references)
      expect(resolved.map(skill => skill.name)).toEqual(['Second', 'First'])
      expect(query).toHaveBeenCalledTimes(1)
      const other = await pool.connect()
      try {
        await expect(withTransaction({ client: other }, async sql => {
          await sql.query("set local lock_timeout='100ms'")
          await sql.query('update workspace_skills set archived_at=now() where workspace_id=$1 and skill_id=$2',
            [references[0]!.workspaceId, references[0]!.skillId])
        })).rejects.toMatchObject({ code: '55P03' })
      } finally { other.release() }
    } finally { query.mockRestore() }
  })
})

it('batches node reference sets while keeping archived retention local to each node', async () => {
  const { pool } = database
  const workspaceId = randomUUID(), skillId = randomUUID()
  await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
    [workspaceId, JSON.stringify({ id: workspaceId, name: 'Node skills' })])
  const skill = SkillVersionSchema.parse({ workspaceId, skillId, version: 'v1', name: 'Retained',
    instructions: 'Use retained instructions', contentHash: skillHash('Use retained instructions'), createdAt: new Date().toISOString() })
  await pool.query(`insert into workspace_skill_versions(workspace_id,skill_id,version,record,sequence)
    values($1,$2,'v1',$3::jsonb,1)`, [workspaceId, skillId, JSON.stringify(skill)])
  await pool.query(`insert into workspace_skills(workspace_id,skill_id,head_version,revision,version_count,archived_at)
    values($1,$2,'v1',1,1,now())`, [workspaceId, skillId])
  const reference = { skillId, version: 'v1' }
  const query = vi.spyOn(pool, 'query')
  try {
    const resolved = await resolveAssignedSkillSets(pool, workspaceId, [
      { references: [reference], retained: [reference] }, { references: [reference], retained: [reference] },
    ])
    expect(resolved.map(set => set.map(value => value.name))).toEqual([['Retained'], ['Retained']])
    expect(query).toHaveBeenCalledTimes(1)
    await expect(resolveAssignedSkillSets(pool, workspaceId, [
      { references: [reference], retained: [reference] }, { references: [reference] },
    ])).rejects.toMatchObject({ code: 'SKILL_ARCHIVED' })
    await expect(resolveAssignedSkills(pool, workspaceId, [reference, reference], [reference]))
      .rejects.toMatchObject({ code: 'SKILL_DUPLICATE' })
  } finally { query.mockRestore() }
})
