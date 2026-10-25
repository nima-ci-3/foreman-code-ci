import type { OperatorActivity } from '@foreman-code/contracts'

/** One wording for an activity's status in every chat (Agent, run and Operator transcripts). */
export const activityStatusLabels: Record<OperatorActivity['status'], string> = {
  pending: 'Waiting', running: 'Running', completed: '', failed: 'Failed', canceled: 'Stopped', unknown: 'Unconfirmed',
}
