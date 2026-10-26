import pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import type { FileWithRevision } from '@foreman-code/contracts/files'
import { PostgresJobPublicationLedger } from '../src/modules/files/jobs/ledger.js'
import type { JobPublicationLink } from '../src/modules/files/jobs/port.js'
import { PostgresFileRepository } from '../src/modules/files/postgres.js'
import type { StoredFile } from '../src/modules/files/repository.js'
import type { JobSql } from '../src/modules/jobs/repository.js'

afterEach(() => vi.restoreAllMocks())
it('bulk reads exact artifact revisions and maps them back to publication order', async () => {
  const pool = new pg.Pool()
  const links = ['a', 'b', 'c'].map((path, index) => ({ path,
    ref: { fileId: index < 2 ? 'shared-file' : 'other-file', revisionId: `revision-${index}` },
  } as JobPublicationLink))
  const snapshots = links.map(link => ({ value: {
    file: { fileId: link.ref.fileId, scope: { kind: 'job_execution', workspaceId: 'workspace', jobExecutionId: 'execution' } },
    revision: { revisionId: link.ref.revisionId },
  } as FileWithRevision, storageKey: 'opaque', ownerPrincipalId: 'owner' } satisfies StoredFile))
  const query = vi.fn(async () => ({ rows: links.map(record => ({ record })) }))
  const sql = { query } as unknown as JobSql
  const read = vi.spyOn(PostgresFileRepository.prototype, 'read').mockImplementation(async (fileId, revisionId) =>
    snapshots.find(stored => stored.value.file.fileId === fileId && stored.value.revision.revisionId === revisionId))
  const readMany = vi.spyOn(PostgresFileRepository.prototype, 'readMany').mockResolvedValue([...snapshots].reverse())
  try {
    const ledger = new PostgresJobPublicationLedger(pool)
    expect(await ledger.list(sql, 'workspace', 'execution')).toEqual(links.map((link, index) =>
      ({ link, value: snapshots[index]!.value })))
    expect(readMany).toHaveBeenCalledExactlyOnceWith(links.map(link => link.ref), sql)
    expect(read).not.toHaveBeenCalled()
    readMany.mockResolvedValueOnce(snapshots.slice(1))
    await expect(ledger.list(sql, 'workspace', 'execution')).rejects.toMatchObject({ code: 'JOB_ARTIFACT_NOT_FOUND' })
    readMany.mockResolvedValueOnce([{ ...snapshots[0]!, value: { ...snapshots[0]!.value,
      file: { ...snapshots[0]!.value.file, scope: { kind: 'job_execution', workspaceId: 'other', jobExecutionId: 'execution' },
        retentionDurationSeconds: 3600, expiresAt: '2026-01-01T01:00:00.000Z' } } },
    ...snapshots.slice(1)])
    await expect(ledger.list(sql, 'workspace', 'execution')).rejects.toMatchObject({ code: 'JOB_ARTIFACT_SCOPE_CONFLICT' })
  } finally { await pool.end() }
})
