import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { batchedReads } from '../src/infrastructure/batchedReads.js'
import { currentDatabase, postgresEnabled } from './helpers/database.js'

describe.skipIf(!postgresEnabled)('batched database reads', () => {
  let database: Awaited<ReturnType<typeof currentDatabase>>
  beforeAll(async () => { database = await currentDatabase() }, 60_000)
  afterAll(async () => { await database?.close() })

  it('preserves each result and timestamps while combining independent reads, then reads fresh on the next turn', async () => {
    const query = vi.spyOn(database.pool, 'query')
    try {
      const sql = batchedReads(database.pool)
      const statement = "select $1::text as name, $2::timestamptz as expires_at where $1 <> 'absent'"
      const date = '2030-01-01T00:00:00.000Z'
      const [first, second, duplicate, absent, locked] = await Promise.all([
        sql.query<{ name: string; expires_at: Date }>(statement, ['first', date]),
        sql.query<{ name: string; expires_at: Date }>(statement, ['second', date]),
        sql.query<{ name: string; expires_at: Date }>(statement, ['first', date]),
        sql.query(statement, ['absent', date]),
        sql.query<{ id: string }>('select id from application_installation where singleton=true for share'),
      ])
      expect(first.rows).toEqual([{ name: 'first', expires_at: new Date(date) }])
      expect(second.rows).toEqual([{ name: 'second', expires_at: new Date(date) }])
      expect(duplicate.rows).toEqual(first.rows)
      expect(absent.rows).toEqual([])
      expect(locked.rows).toHaveLength(1)
      expect(query).toHaveBeenCalledTimes(1)

      expect((await sql.query<{ name: string }>('select $1::text as name', ['fresh'])).rows).toEqual([{ name: 'fresh' }])
      expect(query).toHaveBeenCalledTimes(2)
    } finally { query.mockRestore() }
  })
})
