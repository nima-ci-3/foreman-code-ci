import { expect, it } from 'vitest'
import { resolveWorkflowChatTarget } from '../src/modules/collaboration/workflowChatResolver.js'
import { readChatPrincipal } from '../src/modules/access/conversationCredentials.js'
import { allExecutions, historicalFixture, runA } from './helpers/historicalRuns.js'
import { postgresEnabled } from './helpers/database.js'

it.skipIf(!postgresEnabled)('lists a finished Run node\'s executions newest first', async () => {
  const f = await historicalFixture('repeat')
  try {
    await runA(f)
    const node = f.f.version.definition.nodes[1]!
    // Execution IDs are random: make the newest execution the one with the smallest ID.
    const ids = (await allExecutions(f)).filter(execution => execution.workflowNodeId === node.id).map(execution => execution.id).sort()
    expect(ids).toHaveLength(3)
    for (const [index, id] of [...ids].reverse().entries()) {
      await f.db.pool.query(`update harness_executions set created_at=now()+make_interval(secs => $2) where id=$1`, [id, index])
    }
    const resolved = await resolveWorkflowChatTarget(f.db.pool, await readChatPrincipal(f.db.pool, f.writer.principal.id), {
      workspaceId: f.f.run.workspaceId, workflowId: f.f.run.workflowId, workflowNodeId: node.id, runId: f.f.run.id })
    if (resolved.kind !== 'selection_required') throw new Error(`Expected a choice, got ${resolved.kind}`)
    expect(resolved.items.map(item => item.target.kind === 'workflow_execution' ? item.target.execution.executionId : null))
      .toEqual(ids)
  } finally { await f.close() }
}, 120_000)
