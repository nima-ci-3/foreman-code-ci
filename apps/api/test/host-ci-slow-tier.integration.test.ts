import { CiGetOutputSchema, CiRunOutputSchema, integrationPartition } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { CI_GET_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

it.each([
  ['full', 60_000], ['affected', 60_000], ['affected', 90_000],
] as const)(
  'persists mixed-tier failures through authenticated MCP with scope=%s and slow duration=%i', async (scope, slowDuration) => {
    const fast = 'apps/api/test/quick.integration.test.ts'
    const slow = 'apps/api/test/lengthy.integration.test.ts'
    const files = [fast, slow].sort()
    const durations = { [fast]: 1_000, [slow]: slowDuration }
    const f = await fixture({ integrationInventory: { files, durations } })
    try {
      const input = { suite: 'integration', scope, commit: 'a'.repeat(40), commandId: 'slow-tier-failure',
        ...(scope === 'affected' ? { files } : {}) }
      const reader = await f.connect(CI_GET_ACTIONS)
      expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
      expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
      const admitted = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
      expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(admitted)
      // Small affected selections stay together on a build computer even when they contain a slow file.
      if (scope === 'affected' && slowDuration === 60_000) {
        expect(admitted.partitions).toBeUndefined()
        const initial = await f.waitFor(reader, admitted.ticketId, output => output.run.state === 'running')
        expect(initial.partitions).toBeUndefined()
        expect(initial.run).toMatchObject({ files, partition: null, computer: { hostRef: { kind: 'device' } } })
        expect(f.started).toHaveLength(1)
        expect(f.started[0]!.request).toMatchObject({ operation: 'start', files })
        f.finish(initial.run.id, 1, 'Fast and slow files failed.\n')
        const finished = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', {
          ticketId: admitted.ticketId, waitUntil: 'group-terminal', waitSeconds: 5,
        }))
        expect(finished.wait?.status).toBe('settled')
        expect(finished.group?.state).toBe('failed')
        expect(finished.run).toMatchObject({ state: 'failed', exitCode: 1, files })
        const stored = (await f.pool.query('select record from ci_runs where id=$1', [finished.run.id])).rows[0].record
        expect(stored).toEqual(finished.run)
        return
      }
      expect(admitted.partitions).toHaveLength(2)
      const initial = await f.waitFor(reader, admitted.ticketId, output =>
        output.partitions!.every(run => run.state === 'running'))
      const fastRun = initial.partitions!.find(run => run.partition?.tier === 'fast')!
      const slowRun = initial.partitions!.find(run => run.partition?.tier === 'slow')!
      expect(fastRun.state).toBe('running')
      expect(slowRun.state).toBe('running')
      expect(slowRun).not.toHaveProperty('deferred')
      f.finish(fastRun.id, 1, 'Fast file failed.\n')
      const afterFast = await f.waitFor(reader, fastRun.id, output => output.run.state === 'failed')
      expect(afterFast.partitions!.find(run => run.id === fastRun.id)).toMatchObject({ state: 'failed', exitCode: 1 })
      expect(afterFast.partitions!.find(run => run.id === slowRun.id)?.state).toBe('running')
      const launched = f.started.flatMap(({ request }) => request.operation === 'start'
        ? integrationPartition(files, request.durations ?? durations, request.partition!) : [])
      expect(launched.sort()).toEqual(files.slice().sort())
      f.finish(slowRun.id, 1, 'Slow file also failed.\n')
      const finished = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', {
        ticketId: admitted.ticketId, waitUntil: 'group-terminal', waitSeconds: 5,
      }))
      expect(finished.wait?.status).toBe('settled')
      expect(finished.group?.state).toBe('failed')
      expect(finished.partitions!.find(run => run.id === fastRun.id)).toMatchObject({ state: 'failed', exitCode: 1 })
      expect(finished.partitions!.find(run => run.id === slowRun.id)).toMatchObject({ state: 'failed', exitCode: 1 })
      expect(finished.partitions!.every(run => run.exitCode === 1)).toBe(true)
      for (const run of finished.partitions!) {
        const stored = (await f.pool.query('select record from ci_runs where id=$1', [run.id])).rows[0].record
        expect(stored).toEqual(run)
      }
    } finally { await f.close() }
  },
)
