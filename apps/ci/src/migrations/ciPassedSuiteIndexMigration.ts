/** Affected runs diff against the newest ancestor where their suite passed; this finds a suite's passed parts without
 * reading every CI record. */
export const ciPassedSuiteIndexMigration = { version: 2026102502, sql: `
  create index if not exists ci_runs_passed_suite_idx on ci_runs ((record->>'repository'), (record->>'suite'), created_at desc)
    include (group_id, workspace_id) where state='passed';
` } as const
