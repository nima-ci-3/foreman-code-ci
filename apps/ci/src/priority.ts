import type { CiRunRecord } from '@foreman-code/contracts'

const infrastructureFiles = new Set([
  'apps/api/src/modules/jobs/dispatch.ts',
  'apps/api/src/modules/jobs/dispatch.test.ts',
  'scripts/test-db.mjs',
  'scripts/test-integration.mjs',
  '.github/workflows/ci.yml',
  '.github/workflows/ci.yaml',
  '.circleci/config.yml',
  '.circleci/config.yaml',
])

export function onlyCiInfrastructure(files: string[]): boolean {
  return files.length > 0 && files.every(file =>
    file.startsWith('apps/ci/src/')
    || file.startsWith('apps/ci/test/')
    || file.startsWith('apps/api/test/ci-host/')
    || /^apps\/api\/src\/modules\/jobs\/ci[^/]*\.(?:ts|mjs|mts)$/.test(file)
    || /^scripts\/ci-[^/]+\.mjs$/.test(file)
    || infrastructureFiles.has(file))
}

/** The CI queue order, defined once: each key is the SQL expression dispatch sorts by and the same value in
 * JavaScript, ascending unless `descending`. Ties end on the ticket id. */
const QUEUE_KEYS: { sql: string; value: (run: CiRunRecord) => number | string; descending?: true }[] = [
  { sql: "case when record->>'gate'='true' then 0 else 1 end", value: run => run.gate ? 0 : 1 },
  { sql: "case when record->>'priority'='high' then 0 else 1 end", value: run => run.priority === 'high' ? 0 : 1 },
  { sql: "case when record#>>'{partition,tier}'='slow' then 1 else 0 end", value: run => run.partition?.tier === 'slow' ? 1 : 0 },
  { sql: "case when record#>>'{partition,tier}'='slow' then coalesce((record->>'expectedDurationMs')::double precision,0) else 0 end",
    value: run => run.partition?.tier === 'slow' ? run.expectedDurationMs ?? 0 : 0, descending: true },
  { sql: "record->>'queuedAt'", value: run => run.queuedAt },
  // A gate's integration parts start after its other checks queued at the same moment.
  { sql: "case when record->>'gate'='true' and record->>'suite'='integration' then 1 else 0 end",
    value: run => run.gate && run.suite === 'integration' ? 1 : 0 },
  { sql: 'id', value: run => run.id },
]

export function compareCiQueue(left: CiRunRecord, right: CiRunRecord): number {
  for (const key of QUEUE_KEYS) {
    const [a, b] = [key.value(left), key.value(right)]
    if (a !== b) return (a < b ? -1 : 1) * (key.descending ? -1 : 1)
  }
  return 0
}

export function ciQueueReason(run: CiRunRecord): string {
  return run.message ?? 'Waiting for an eligible CI slot; high priority tickets run before normal, oldest first.'
}

export const CI_QUEUE_ORDER = QUEUE_KEYS.map(key => `${key.sql}${key.descending ? ' desc' : ''}`).join(', ')
