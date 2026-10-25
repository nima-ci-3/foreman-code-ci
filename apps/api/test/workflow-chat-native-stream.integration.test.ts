import { afterEach, expect, it } from 'vitest'
import { ChatDeliveryReceiptSchema, EngineChatReadbackSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { ControlledWorkflowProvider } from './helpers/controlledWorkflowProvider.js'
import { hierarchyRuntimeFixture, coordinationOutput } from './helpers/hierarchyRuntimeFixture.js'
import { workflowChatTarget } from './helpers/workflowChatRequests.js'
import { closeActivityReplay, eventStream } from './helpers/activityReplayFixture.js'
import { createWorkflowExecutionChatService } from '../src/modules/collaboration/workflowChatProduction.js'
import { workflowChatCall } from './helpers/workflowChatRequests.js'

afterEach(closeActivityReplay)

it('publishes an idle execution chat capability change when the remaining Run work completes', async () => {
  const provider = new ControlledWorkflowProvider(['builder'], (node, request) => coordinationOutput(node, request,
    node === 'master' ? { select: ['build'] } : {}))
  const f = await currentOperatorIntegration({ executionChat: true, fixture: hierarchyRuntimeFixture(),
    approvalNodeIds: [], collaborationPorts: {}, managerFactory: context => provider.connection(context) })
  const drive = f.engine.start(f.f.run.id).catch(error => error)
  let stream: Awaited<ReturnType<typeof eventStream>> | undefined
  try {
    await provider.entered('builder')
    const master = (await f.runs.listRepeatExecutions(f.f.run.id)).find(row => row.execution.workflowNodeId === 'master')!.execution
    const target = await workflowChatTarget(f, 'master', master.id)
    expect(target.kind).toBe('workflow_execution')
    const read = () => workflowChatCall(f, 'agent_chat_read', { target }).then(value => EngineChatReadbackSchema.parse(value))
    expect(await read()).toMatchObject({ state: 'idle', capabilities: { queue: true } })
    const service = createWorkflowExecutionChatService(f.db.pool, f.native)
    const before = await service.changes(f.writer.principal, target)
    const base = `/api/workspaces/${target.agent.workspaceId}/workflows/${target.agent.workflowId}/execution-chat`
    stream = await eventStream(`${f.address}${base}/events?${new URLSearchParams({ target: JSON.stringify(target) })}`, f.writer.token)
    const first = await stream.next(() => true)
    provider.release('builder')
    expect(await drive).not.toBeInstanceOf(Error)
    await stream.next(event => event.cursor !== first.cursor)
    expect((await service.changes(f.writer.principal, target)).stateCursor).not.toBe(before.stateCursor)
    expect(await read()).toMatchObject({ state: 'idle', capabilities: { queue: false } })
  } finally { await stream?.close(); provider.releaseAll(); await f.stop(); await drive; await f.close() }
}, 60_000)

it.each(['execution', 'consultation'] as const)('observes committed %s text while hierarchy work stays active', async kind => {
  const provider = new ControlledWorkflowProvider(['builder'], (node, request) => coordinationOutput(node, request,
    node === 'master' ? { select: ['build'] } : {}))
  const f = await currentOperatorIntegration({ executionChat: true, fixture: hierarchyRuntimeFixture(),
    approvalNodeIds: [], collaborationPorts: {}, managerFactory: context => provider.connection(context) })
  const drive = f.engine.start(f.f.run.id).catch(error => error)
  let stream: Awaited<ReturnType<typeof eventStream>> | undefined
  try {
    await provider.entered('builder')
    const target = await workflowChatTarget(f, kind === 'execution' ? 'builder' : 'master')
    let sourceId: string
    let sessionId: string
    if (target.kind === 'workflow_execution') {
      const execution = (await f.runs.getExecution(target.execution.executionId))!
      sourceId = execution.id
      sessionId = execution.nativeSessionId!
    } else {
      const send = await f.client.callTool({ name: 'agent_chat_send', arguments: {
        target, intent: 'next_turn', content: 'Report progress', commandId: 'consultation-input',
      } })
      expect(send.isError, JSON.stringify(send)).not.toBe(true)
      const receipt = ChatDeliveryReceiptSchema.parse(decodeMcpToolResult(send))
      sourceId = receipt.consultationId!
      await expect.poll(async () => (await f.db.pool.query<{ state: string }>(
        'select state from run_coordinator_consultations where id=$1', [sourceId])).rows[0]?.state,
      { timeout: 15_000 }).toBe('completed')
      sessionId = (await f.db.pool.query<{ binding: { nativeSessionId: string } }>(
        'select binding from run_coordinator_consultations where id=$1', [sourceId])).rows[0]!.binding.nativeSessionId
    }
    const base = `/api/workspaces/${target.agent.workspaceId}/workflows/${target.agent.workflowId}/execution-chat`
    stream = await eventStream(`${f.address}${base}/events?${new URLSearchParams({ target: JSON.stringify(target) })}`, f.writer.token)
    const first = await stream.next(() => true)
    const record = { sequence: 1000, occurredAt: new Date().toISOString(), type: 'assistant.delta',
      payload: { threadId: sessionId, turnId: 'streamed-turn', itemId: 'streamed-item', delta: 'Text without a lifecycle change' } }
    const committedAt = performance.now()
    if (target.kind === 'workflow_execution') {
      await f.db.pool.query('insert into harness_native_events(execution_id,sequence,record) values($1,1000,$2::jsonb)',
        [sourceId, JSON.stringify(record)])
    } else {
      await f.db.pool.query(`insert into run_coordinator_native_events(run_id,consultation_id,source_id,record,created_at)
        values($1,$2,$3,$4::jsonb,$5)`, [f.f.run.id, sourceId, 'streamed-delta', JSON.stringify(record), record.occurredAt])
    }
    const changed = await stream.next(event => event.cursor !== first.cursor)
    expect(performance.now() - committedAt).toBeLessThanOrEqual(250)
    expect(changed).toMatchObject({ target, message: {
      content: 'Text without a lifecycle change', nativeMessageId: 'streamed-item',
      revision: expect.any(String), nativeMessageComplete: false,
    } })
    expect(changed.snapshotRequired).not.toBe(true)
    const read = await f.client.callTool({ name: 'agent_chat_read', arguments: { target } })
    expect(read.isError, JSON.stringify(read)).not.toBe(true)
    expect(EngineChatReadbackSchema.parse(decodeMcpToolResult(read)).messages).toContainEqual(
      expect.objectContaining({ content: 'Text without a lifecycle change' }))
    expect(provider.active).toBeGreaterThan(0)
  } finally { await stream?.close(); provider.releaseAll(); await f.stop(); await drive; await f.close() }
}, 60_000)
