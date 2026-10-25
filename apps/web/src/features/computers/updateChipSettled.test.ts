import { expect, it } from 'vitest'
import type { MaintenanceStatus } from '@foreman-code/contracts/computer-maintenance'
import { deriveStatusChips } from './statusChips'

const failedUpdate = { id: 'task-2', kind: 'update-worker', state: 'failed', startedAt: '2026-10-25T10:00:00.000Z',
  finishedAt: '2026-10-25T10:01:00.000Z', summary: 'worker_update_restart_pending', outputTail: '' }
const status = (worker: Record<string, unknown>) => ({ worker, harnesses: [], tasks: [failedUpdate],
  system: { packageUpdates: 0 } }) as unknown as MaintenanceStatus
const update = (value: MaintenanceStatus) =>
  deriveStatusChips({ accounts: null, connections: undefined, status: value, readiness: undefined, starting: false }).at(-1)!

it('does not keep a failed Worker update once the Worker runs its target version', () => {
  expect(update(status({ state: 'current', currentVersion: '0.0.119', targetVersion: '0.0.119', lastError: null })).state).not.toBe('failed')
})

it('still shows the failed Worker update while the Worker is behind', () => {
  expect(update(status({ state: 'current', currentVersion: '0.0.118', targetVersion: '0.0.119', lastError: null })).state).toBe('failed')
})
