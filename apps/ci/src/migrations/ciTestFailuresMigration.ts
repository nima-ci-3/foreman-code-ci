/** The latest failure of each test file per suite: an unchanged test that failed reruns until it passes, even when no
 * change selects it. A later pass of the file removes its row. */
export const ciTestFailuresMigration = { version: 2026102503, sql: `
  create table if not exists ci_test_failures (
    workspace_id text not null references workspaces(id),
    repository text not null,
    suite text not null,
    file text not null,
    ticket_id uuid not null,
    commit text not null,
    failed_at timestamptz not null default now(),
    primary key (workspace_id, repository, suite, file)
  );
` } as const
