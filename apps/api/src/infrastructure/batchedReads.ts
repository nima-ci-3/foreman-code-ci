import type pg from 'pg'
import type { SqlQuery } from './transaction.js'

/** Coalesce independent SELECTs issued in the same turn of one read operation. */
export function batchedReads(sql: SqlQuery): SqlQuery {
  type Pending = { statement: string; values: unknown[]; resolve: (result: pg.QueryResult) => void; reject: (error: unknown) => void }
  let pending: Pending[] = []
  let scheduled = false
  const flush = async () => {
    scheduled = false
    const batch = pending
    pending = []
    const unique = new Map<string, { statement: string; values: unknown[]; waiters: Pending[] }>()
    for (const entry of batch) {
      const key = JSON.stringify([entry.statement, entry.values])
      const existing = unique.get(key)
      if (existing) existing.waiters.push(entry)
      else unique.set(key, { statement: entry.statement, values: entry.values, waiters: [entry] })
    }
    const entries = [...unique.values()]
    // Keep parameter and statement size bounded even for a large page.
    for (let offset = 0; offset < entries.length; offset += 100) {
      const group = entries.slice(offset, offset + 100)
      try {
        const values: unknown[] = []
        const queries = group.map((entry, index) => {
          const start = values.length
          values.push(...entry.values)
          const statement = entry.statement.trim().replace(/;\s*$/, '')
            .replace(/\$(\d+)\b/g, (_match, number: string) => `$${start + Number(number)}`)
          return `select ${index} as ordinal,coalesce(json_agg(row),'[]'::json) as rows from (${statement}) row`
        })
        const result = await sql.query<{ ordinal: number; rows: pg.QueryResultRow[] }>(queries.join(' union all '), values)
        for (const row of result.rows) {
          for (const value of row.rows) {
            for (const key of ['expires_at', 'revoked_at', 'archived_at']) {
              if (typeof value[key] === 'string') value[key] = new Date(value[key])
            }
          }
          for (const waiter of group[row.ordinal]!.waiters) waiter.resolve({ rows: row.rows,
            rowCount: row.rows.length, command: 'SELECT', oid: 0, fields: [] })
        }
      } catch (error) {
        for (const entry of group) for (const waiter of entry.waiters) waiter.reject(error)
      }
    }
  }
  return {
    query<R extends pg.QueryResultRow = pg.QueryResultRow>(statement: string, values: unknown[] = []): Promise<pg.QueryResult<R>> {
      return new Promise((resolve, reject) => {
        pending.push({ statement, values, resolve: result => resolve(result as pg.QueryResult<R>), reject })
        if (!scheduled) { scheduled = true; queueMicrotask(() => { void flush() }) }
      })
    },
  }
}
