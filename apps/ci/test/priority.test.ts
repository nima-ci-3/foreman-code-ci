import { CiRunRecordSchema } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { compareCiQueue, onlyCiInfrastructure } from '../src/priority.js'

it.each([
  ['apps/ci/src/service.ts'],
  ['apps/api/test/ci-host/service.test.ts'],
  ['apps/ci/test/runner.test.ts', 'apps/ci/test/helpers/ciContext.ts'],
  ['apps/api/src/modules/jobs/ciAuthority.ts', 'apps/api/src/modules/jobs/dispatch.ts'],
  ['scripts/ci-affected.mjs', 'scripts/test-db.mjs', 'scripts/test-integration.mjs'],
  ['.github/workflows/ci.yml', '.circleci/config.yml'],
].map(files => ({ files })))('recognizes CI-only changes: $files', ({ files }) => {
  expect(onlyCiInfrastructure(files)).toBe(true)
})

it.each([
  [],
  ['apps/ci/src/service.ts', 'apps/web/src/App.tsx'],
  ['apps/api/src/modules/jobs/service.ts'],
  ['scripts/ci-directory/product.mjs'],
  ['.github/workflows/release.yml'],
].map(files => ({ files })))('keeps empty, mixed and unrelated changes normal: $files', ({ files }) => {
  expect(onlyCiInfrastructure(files)).toBe(false)
})

it('orders queued gate checks like dispatch SQL: integration after every gate check queued at the same moment', () => {
  // The JS comparator held integration back only within one gate group while the SQL order did it across groups,
  // so the displayed queue and dispatch disagreed for gates queued together.
  const run = (id: string, groupId: string, suite: 'integration' | 'typecheck') => CiRunRecordSchema.parse({
    id, groupId, workspaceId: 'workspace', suite, part: null, scope: 'full', files: [], partition: null,
    repository: 'fixture/project', commit: 'a'.repeat(40), state: 'queued', computer: null, step: null, exitCode: null,
    message: null, gate: true, queuedAt: '2026-10-25T00:00:00.000Z', startedAt: null, finishedAt: null,
    initiator: { principalId: 'operator', executionId: null } })
  const integration = run('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'integration')
  const typecheck = run('33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', 'typecheck')
  expect([integration, typecheck].sort(compareCiQueue).map(value => value.suite)).toEqual(['typecheck', 'integration'])
})
