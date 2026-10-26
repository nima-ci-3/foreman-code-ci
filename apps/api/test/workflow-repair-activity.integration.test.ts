import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/current'
import { checkpointRuntimeFixture } from './helpers/checkpointRuntime.js'
import { correctiveNativeManager } from './helpers/correctiveNativeManager.js'
import { deferred } from './helpers/deferred.js'
import { graphParity } from './helpers/graphParity.js'

it('shows acknowledged corrective work as running until its own native terminal', async () => {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
  fixture.version.definition.handoffs = { contractVersion: 1 }
  const data = { latestDeliverable: { summary: 'Corrected result' }, remainingFindings: [] }
  const entered = deferred(), release = deferred()
  const f = await checkpointRuntimeFixture(1, 1, { fixture, approvalNodeIds: [],
    outputFor: () => ({ routing: { kind: 'finish', outcome: 'invalid-extra-field' }, data }),
    managerFactory: () => {
      const manager = correctiveNativeManager(f.provider.connection(), [],
        () => ({ outcome: 'succeeded', output: { routing: { kind: 'finish' }, data } }))
      const start = manager.startTurn.bind(manager)
      manager.startTurn = async function* (session, input, signal) {
        for await (const event of start(session, input, signal)) {
          yield event
          if (input.clientCorrelationId.endsWith(':result-repair:1') && event.type === 'turn.started') {
            entered.resolve()
            await release.promise
          }
        }
      }
      return manager
    } })
  const task = f.engine.start(f.f.run.id)
  try {
    await entered.promise
    const parity = await graphParity(f.db.pool, f.f.scope)
    const active = await parity.compare()
    expect(active.state.nodes[0]).toMatchObject({ state: { lifecycle: 'running' },
      activity: { status: 'active', action: 'working', acknowledgementId: expect.any(String), correlationId: expect.any(String) } })
    release.resolve()
    await task
    expect((await parity.compare()).state.nodes[0]).toMatchObject({ state: { lifecycle: 'succeeded' }, activity: { status: 'none' } })
    expect((await f.runs.getDetails(f.f.scope.workspaceId, f.f.run.id))?.executions).toHaveLength(1)
  } finally {
    release.resolve()
    await task.catch(() => { /* ignore: cleanup waits for the engine; assertions above report its outcome. */ })
    await f.close()
    vi.restoreAllMocks()
  }
}, 60_000)
