import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { CiRunRecordSchema, type CiRunRecord } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { weighCiPartitions } from '../src/partitionPlanning.js'
import type { HostCiComputer, HostCiEndpoint } from '../src/serviceTypes.js'
import { testCiContext } from './helpers/ciContext.js'

it('places ordinary integration partitions on GitHub before higher-priority CircleCI slots', async () => {
  const computers: HostCiComputer[] = ['circleci', 'github'].map(provider => ({ key: provider, label: provider,
    priority: provider === 'circleci' ? 60 : 40,
    hostRef: { kind: 'cloud', mainId: 'fixture', provider: provider as 'circleci' | 'github', slot: 0 },
    userSystemd: { supported: true, reason: null } }))
  const groupId = randomUUID()
  const runs = [0, 1].map(index => CiRunRecordSchema.parse({ id: randomUUID(), groupId, workspaceId: 'fixture',
    repository: 'octo/site', commit: 'a'.repeat(40), suite: 'integration', scope: 'affected',
    files: ['apps/api/test/ordinary.integration.test.ts'], partition: { index, count: 2 },
    state: 'queued', computer: null, step: null, exitCode: null, message: null,
    queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
    initiator: { principalId: 'operator', executionId: null } }))
  const saved = new Map(runs.map(run => [run.id, run]))
  let reads = 0
  const pool = { query: async (_query: string, values?: unknown[]) => {
    if (++reads === 1) return { rows: runs.map(record => ({ record })) }
    if (reads === 2) return { rows: [] }
    const plans = JSON.parse(String(values?.[0])) as { id: string; patch: Partial<CiRunRecord> }[]
    return { rows: plans.map(plan => {
      const record = CiRunRecordSchema.parse({ ...saved.get(plan.id), ...plan.patch })
      saved.set(record.id, record)
      return { record }
    }) }
  } } as unknown as pg.Pool
  const endpoint: HostCiEndpoint = { computers: async () => computers,
    request: async () => ({ operation: 'status', ready: true, reasons: [], runs: [], cpuCount: 4,
      memoryBytes: 16 * 2 ** 30, slotsUsed: 0, slotsTotal: 1 }) }
  const result = await weighCiPartitions(testCiContext, pool, endpoint, runs, computers,
    async id => saved.get(id)!)
  expect(result.map(run => run.plannedHostKey)).toEqual(['github', 'circleci'])
})
