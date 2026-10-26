import { gzipSync } from 'node:zlib'
import type pg from 'pg'
import { expect, it } from 'vitest'
import { functionProven } from '../src/functionProofs.js'

it('marks a pass reused through function proofs so an import audit can tell it from an exact proof', async () => {
  const commit = 'b'.repeat(40)
  const pool = { query: async () => ({ rows: [
    { file: 'apps/api/test/kept.test.ts', cache_key: 'kept-key', executed: gzipSync(JSON.stringify({ 'apps/api/src/a.ts': ['run'] })),
      ticket_id: '00000000-0000-4000-8000-000000000001', commit },
    { file: 'apps/api/test/changed.test.ts', cache_key: 'old-key', executed: gzipSync(JSON.stringify({})),
      ticket_id: '00000000-0000-4000-8000-000000000002', commit },
  ] }) } as unknown as pg.Pool
  const proven = await functionProven(pool, { workspaceId: 'workspace', repository: 'example/project', suite: 'unit',
    files: ['apps/api/test/kept.test.ts', 'apps/api/test/changed.test.ts'] },
  async () => ({ 'apps/api/test/kept.test.ts': 'kept-key', 'apps/api/test/changed.test.ts': 'new-key' }))
  expect(proven).toEqual([{ file: 'apps/api/test/kept.test.ts', ticketId: '00000000-0000-4000-8000-000000000001', commit, functions: true }])
})
