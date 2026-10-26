import { expect, it } from 'vitest'
import { makeCurrentWorkflowFixture, type GraphActivity } from '@foreman-code/contracts/current'
import { publicNodeState } from '../src/modules/run-graph/publicLifecycle.js'

const execution = makeCurrentWorkflowFixture('public-lifecycle', 'single').identities[0]!
const activity = (status: GraphActivity['status']): GraphActivity => ({
  workflowNodeId: execution.workflowNodeId, execution, status,
})
const active: GraphActivity = { ...activity('active'), action: 'working', acknowledgementId: 'ack', correlationId: 'turn' }

it.each(['starting', 'running'])('shows %s work with no active native turn as starting', state => {
  const current = { execution, state }
  expect(publicNodeState(execution.workflowNodeId, current, undefined).lifecycle).toBe('starting')
  expect(publicNodeState(execution.workflowNodeId, current, undefined, [{
    key: { execution, workKind: 'workflow', workId: execution.executionId },
    activity: activity('none'), lastNativeSequence: '2',
  }]).lifecycle).toBe('starting')
})

it.each<{ native: GraphActivity; lifecycle: string; state?: string; outcome?: string; closed?: boolean; blocked?: boolean }>([
  { native: active, lifecycle: 'running' },
  { native: activity('unknown'), lifecycle: 'unknown' },
  { native: { ...active, status: 'stale' as const }, lifecycle: 'unknown' },
  { native: activity('active'), lifecycle: 'unknown' },
  { native: { ...active, action: 'reviewing' as const }, lifecycle: 'unknown' },
  { native: { ...active, action: 'waiting_approval' as const }, lifecycle: 'unknown' },
  { native: activity('none'), closed: true, lifecycle: 'unknown' },
  { native: activity('none'), blocked: true, lifecycle: 'unknown' },
  ...(['succeeded', 'failed', 'canceled'] as const).map(outcome => ({
    native: activity('none'), state: 'completed', outcome, lifecycle: outcome,
  })),
])('preserves public lifecycle $lifecycle for $native.status with $state work', value => {
  expect(publicNodeState(execution.workflowNodeId,
    { execution, state: value.state ?? 'running', outcome: value.outcome }, undefined, [{
      key: { execution, workKind: 'workflow', workId: execution.executionId },
      activity: value.native, lastNativeSequence: '2',
    }], value.closed, value.blocked).lifecycle).toBe(value.lifecycle)
})
