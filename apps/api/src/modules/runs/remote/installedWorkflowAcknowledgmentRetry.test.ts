import { expect, it } from 'vitest'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import type { NativeHistory } from '../../harnesses/port.js'
import { remoteWorkflowSourceDigest } from './workflowPhysicalReadout.js'
import { restartedInstalledFixture, runningInstalledFixture } from './__tests__/installedWorkflowHost.js'

it('replays a terminal event acknowledgment after its first response is lost, then retires the history', async () => {
  const f = await runningInstalledFixture()
  try {
    f.finish('succeeded', { text: 'Complete' })
    await f.settled
    const response = await f.call('history')
    const value = response.payload as { history: NativeHistory; status: { receipt: unknown } }
    const receipt = RemoteOperationReceiptSchema.parse(value.status.receipt)
    const selector = { receiptSequence: receipt.sequence, retire: true }
    const source = { type: 'event' as const, event: { ...value.history.events[0]!, executionId: f.intent.executionId } }
    const event = { ...selector, sourceDigest: remoteWorkflowSourceDigest(source) }
    expect((await f.call('physical-ack', event)).payload).toMatchObject({ status: 'retired' })
    await expect(f.call('physical-readout', { receiptSequence: event.receiptSequence, sourceDigest: event.sourceDigest }))
      .rejects.toMatchObject({ details: { reason: 'not_retained' } })
    // Main did not receive that response and retries the exact admitted ACK.
    expect((await f.call('physical-ack', event)).payload).toMatchObject({ status: 'not_retained' })
    const history = { ...selector, sourceDigest: remoteWorkflowSourceDigest({ type: 'history', history: value.history }) }
    expect((await f.call('physical-ack', history)).payload).toMatchObject({ status: 'retired' })
    expect((await f.call('status')).payload).toMatchObject({ status: 'known', receipt })
  } finally { f.finish('canceled'); await f.host.close() }
})

it('does not retire a terminal reply whose original process identity changed', async () => {
  const f = await runningInstalledFixture()
  try {
    f.finish('succeeded', { text: 'Complete' })
    await f.settled
    const response = await f.call('history')
    const value = response.payload as { history: NativeHistory; status: { receipt: unknown } }
    const receipt = RemoteOperationReceiptSchema.parse(value.status.receipt)
    f.changeProcess()
    await expect(f.call('physical-ack', { receiptSequence: receipt.sequence, retire: true,
      sourceDigest: remoteWorkflowSourceDigest({ type: 'history', history: value.history }) }))
      .rejects.toMatchObject({ code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE' })
    expect(await f.journal.isRetired(f.intent.operationId)).toBe(false)
  } finally { f.finish('canceled'); await f.host.close() }
})

it('replays a recovered session acknowledgment before retiring its terminal history', async () => {
  const f = await restartedInstalledFixture()
  await f.journal.close()
  const host = await f.startHost()
  const call = (method: string, fields: Record<string, unknown> = {}) => host.extensions[0]!.handle!({
    method, intent: f.intent, placement: f.placement, ...fields,
  }, f.context)
  try {
    const reply = await call('reattach', { session: f.session, request: f.request })
    const receipt = RemoteOperationReceiptSchema.parse((reply.payload as { status: { receipt: unknown } }).status.receipt)
    const session = { receiptSequence: receipt.sequence, retire: true,
      sourceDigest: remoteWorkflowSourceDigest({ type: 'session_created', session: f.session }) }
    expect((await call('physical-ack', session)).payload).toMatchObject({ status: 'retired' })
    expect((await call('physical-ack', session)).payload).toMatchObject({ status: 'not_retained' })
    const response = await call('history')
    const history = (response.payload as { history: NativeHistory }).history
    expect((await call('physical-ack', { receiptSequence: receipt.sequence, retire: true,
      sourceDigest: remoteWorkflowSourceDigest({ type: 'history', history }) })).payload).toMatchObject({ status: 'retired' })
  } finally { await host.close() }
})
