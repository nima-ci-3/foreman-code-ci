import { describe, expect, it } from 'vitest'
import { CiRunRecordSchema } from '@foreman-code/contracts'
import { ciPlacementReason } from '../src/computerCapabilities.js'
import type { HostCiComputer } from '../src/service.js'

const run = (changes: Record<string, unknown>) => CiRunRecordSchema.parse({ id: '11111111-1111-4111-8111-111111111111',
  groupId: '22222222-2222-4222-8222-222222222222', workspaceId: 'workspace', suite: 'unit', part: 'unit-api', scope: 'affected',
  files: ['apps/api/test/a.test.ts'], partition: null, repository: 'octo/site', commit: 'a'.repeat(40), state: 'queued',
  computer: null, step: null, exitCode: null, message: null, queuedAt: '2026-10-27T00:00:00.000Z', startedAt: null,
  finishedAt: null, initiator: { principalId: 'operator', executionId: null }, ...changes })
const main = { key: 'main', label: 'Main computer', priority: 10, hostRef: { kind: 'main', mainId: 'host' } } as HostCiComputer
const cloud = { key: 'gh', label: 'GitHub Actions 1', priority: 30,
  hostRef: { kind: 'cloud', mainId: 'host', provider: 'github', slot: 0 } } as HostCiComputer

describe('ciPlacementReason', () => {
  it('says why a small measured run went to a build computer or the cloud', () => {
    expect(ciPlacementReason(run({ selectionDurationMs: 1200 }), main)).toBe('Small unit run (1.2 s of measured tests): build computers take it first.')
    expect(ciPlacementReason(run({ selectionDurationMs: 1200 }), cloud)).toBe('Small unit run (1.2 s of measured tests), but no build computer was free.')
  })

  it('names a missing duration as the reason a run went to the cloud', () => {
    expect(ciPlacementReason(run({ expectedDurationMs: 210_000 }), cloud))
      .toBe('Not a small unit run (no measured durations; estimated 120 s); larger work goes to the cloud.')
  })
})
