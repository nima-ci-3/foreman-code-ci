import { DurableInteractionSchema, ReviewJobSchema } from '@foreman-code/contracts'
import { RUN_GRAPH_LIMITS, type RunGraphScope } from '@foreman-code/contracts/current'

import type { SqlTransaction } from '../../../infrastructure/transaction.js'
import { batchedReads } from '../../../infrastructure/batchedReads.js'
import type { CurrentExchanges } from '../../run-graph/compactSnapshot.js'
import { RunGraphError } from '../../run-graph/errors.js'
import { readContext, type ApprovalContext, type ApprovalContextRows } from './context.js'
import { RUN_CLEANUP_BOUNDARY_SQL } from './cleanupAuthority.js'
import { hasRunGraphPublication, type ReviewNativeProofRecord } from '../reviewNativeProof.js'
import { acknowledgementId, reviewEvidence } from './nativeEvidence.js'
import { CANCELED_INTERACTION_RETIRED_SQL, interactionFact, reviewFact } from './publication.js'

export interface InteractionRow {
  record: unknown
}

/** Current bounded approval exchanges for the compact graph snapshot.
 * Uses the caller's read transaction and the same immutable authority mapper as
 * the writers; completed/retired history remains on detail paths. */
export type CurrentInteractionRow = InteractionRow
export const CURRENT_INTERACTIONS_SQL = `select i.record
     from durable_interactions i
     left join interaction_graph_resumes g on g.interaction_id=i.id
     where i.run_id=$1 and (
       i.status not in ('delivered','canceled')
       or (i.status='delivered' and i.record->>'kind' is distinct from 'work_direction'
         and g.approval_native_ack_id is null)
       or (i.status='canceled' and not (${CANCELED_INTERACTION_RETIRED_SQL}))
     ) order by i.id limit $2`

export type CurrentReviewRow = { record: unknown; revision: string; interaction_record: unknown;
  approval_native_evidence: unknown; approval_original_proof_id: string | null }
export const CURRENT_REVIEWS_SQL = `select j.record,j.revision::text,i.record as interaction_record,
       j.approval_native_evidence,j.approval_original_proof_id
     from review_jobs j join durable_interactions i on i.id=j.interaction_id
     where i.run_id=$1 and (
       j.state not in ('completed','failed')
       or (j.state='failed' and j.record->'cleanup' is not null
         and j.record->'cleanup'->>'completedAt' is null)
     ) order by j.id limit $2`

export async function readCurrentGraphExchanges(
  sql: SqlTransaction,
  scope: RunGraphScope,
  prefetched?: { interactions: CurrentInteractionRow[]; reviews: CurrentReviewRow[] },
): Promise<CurrentExchanges> {
  const interactionRows = prefetched ? { rows: prefetched.interactions } : await sql.query<CurrentInteractionRow>(
    CURRENT_INTERACTIONS_SQL,
    [scope.runId, RUN_GRAPH_LIMITS.exchanges + 1],
  )
  if (interactionRows.rows.length > RUN_GRAPH_LIMITS.exchanges) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')

  const reviewRows = prefetched ? { rows: prefetched.reviews } : await sql.query<CurrentReviewRow>(
    CURRENT_REVIEWS_SQL, [scope.runId, RUN_GRAPH_LIMITS.exchanges + 1])
  if (reviewRows.rows.length > RUN_GRAPH_LIMITS.exchanges) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  const requested = [...interactionRows.rows.map(row => DurableInteractionSchema.parse(row.record)),
    ...reviewRows.rows.map(row => DurableInteractionSchema.parse(row.interaction_record))]
  const batch = requested.length ? (await sql.query<{
    run: ApprovalContextRows['run']; requesters: { id: string; record: unknown; closed: boolean }[];
    bindings: { id: string; approval_relationship_id: string | null; approval_reviewer_execution_id: string | null }[];
    direction_wait: boolean
  }>(`select (select json_build_object('run',r.record,'version',v.record,'stopped',
        ${RUN_CLEANUP_BOUNDARY_SQL} or r.worker_credentials_closed_at is not null)
      from runs r join workflow_versions v on v.id=r.workflow_version_id
      where r.id=$1 and v.execution_semantics_version=3) as run,
    coalesce((select json_agg(e) from (select id,record,worker_credentials_closed_at is not null as closed
      from harness_executions where run_id=$1 and id=any($2::text[])) e),'[]'::json) as requesters,
    coalesce((select json_agg(i) from (select id,approval_relationship_id,approval_reviewer_execution_id
      from durable_interactions where id=any($3::text[])) i),'[]'::json) as bindings,
    exists(select 1 from run_work_direction_waits where run_id=$1) as direction_wait`,
  [scope.runId, requested.map(item => item.executionId), requested.map(item => item.id)])).rows[0] : undefined
  const prefetchedContext: ApprovalContextRows | undefined = batch ? { run: batch.run,
    requesters: new Map(batch.requesters.map(row => [row.id, row])),
    bindings: new Map(batch.bindings.map(row => [row.id, row])), directionWait: batch.direction_wait,
    reviewerSql: batchedReads(sql) } : undefined
  const proofIds = reviewRows.rows.flatMap(row => row.approval_native_evidence && row.approval_original_proof_id
    ? [row.approval_original_proof_id] : [])
  const proofs = proofIds.length ? (await sql.query<{ proof_id: string; job_id: string; record: ReviewNativeProofRecord; source_digest: string }>(
    `select proof_id,job_id,record,source_digest from review_native_proofs where proof_id=any($1::text[])${hasRunGraphPublication(sql, scope) ? ' for share' : ''}`,
    [proofIds])).rows : []
  const proofByJob = new Map(proofs.map(row => [`${row.job_id}\u0000${row.proof_id}`, row]))

  const contexts = new Map<string, Promise<ApprovalContext>>()
  const contextFor = async (interaction: ReturnType<typeof DurableInteractionSchema.parse>) => {
    const saved = contexts.get(interaction.id)
    if (saved) return saved
    const pending = readContext(sql, interaction, false, false, prefetchedContext).then(context => {
      if (context.scope.runId !== scope.runId || context.scope.workflowVersionId !== scope.workflowVersionId) {
        throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
      }
      return context
    })
    contexts.set(interaction.id, pending)
    return pending
  }
  const contextResults = await Promise.allSettled(requested.map(contextFor))
  const failedContext = contextResults.find(result => result.status === 'rejected')
  if (failedContext?.status === 'rejected') throw failedContext.reason

  const interactions: CurrentExchanges['interactions'] = []
  for (const row of interactionRows.rows) {
    const interaction = DurableInteractionSchema.parse(row.record)
    // Delivery establishes a pending continuation obligation, not evidence of
    // checkpoint consumption or native work. Lease/blocked states stay private.
    // Canceled uncertainty uses the same mapper as its delta producer. Only a
    // committed retirement receipt removes it, never a later cleanup flag alone.
    const fact = interactionFact(await contextFor(interaction), interaction)
    if (fact.type !== 'interaction.state') throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    interactions.push(fact.interaction)
  }

  const reviews: CurrentExchanges['reviews'] = []
  for (const row of reviewRows.rows) {
    const interaction = DurableInteractionSchema.parse(row.interaction_record)
    const job = ReviewJobSchema.parse(row.record)
    const fact = reviewFact(await contextFor(interaction), job, row.revision,
      acknowledgementId(await reviewEvidence(sql, job.id, row,
        proofByJob.get(`${job.id}\u0000${row.approval_original_proof_id}`) ?? null)))
    if (fact.type !== 'review.state') throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    reviews.push(fact.review)
  }
  if (interactions.length + reviews.length > RUN_GRAPH_LIMITS.exchanges) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  return { interactions, reviews }
}
