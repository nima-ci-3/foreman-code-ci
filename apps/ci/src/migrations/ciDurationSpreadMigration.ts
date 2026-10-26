/** Keep a bounded successful-sample window for watchdogs and freeze its peaks with each queued run. */
export const ciDurationSpreadMigration = { version: 2026102602, sql: `
  alter table ci_file_durations add column recent_durations_ms integer[] not null default '{}';
  update ci_file_durations set recent_durations_ms=array[duration_ms];
  alter table ci_runs add column duration_peaks jsonb;
` } as const
