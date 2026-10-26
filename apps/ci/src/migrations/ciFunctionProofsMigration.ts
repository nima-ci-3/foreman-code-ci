/** A test file's latest pass with the functions it ran (gzip JSON per source file) and its key under them: a later
 * commit that changed only bodies of functions it never ran still has that key, so the file is proven. */
export const ciFunctionProofsMigration = { version: 2026102601, sql: `
  create table if not exists ci_test_function_proofs (
    workspace_id text not null references workspaces(id),
    repository text not null,
    suite text not null,
    file text not null,
    cache_key text not null,
    executed bytea not null,
    ticket_id uuid not null,
    commit text not null,
    passed_at timestamptz not null default now(),
    primary key (workspace_id, repository, suite, file)
  );
` } as const
