import { ZodError } from 'zod'
import { HarnessExecutionSchema, NativeSessionReferenceSchema } from '@foreman-code/contracts'
import { RepeatOccurrenceV1Schema, type WorkflowVersionCurrent } from '@foreman-code/contracts/current'
import { DomainError } from '../errors.js'
import { readSavePlacementEvidence, saveNativePlacement } from '../placement/index.js'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import { readWorkflowClosureEvidence, workflowClosureFromEvidence } from '../interactions/index.js'
import { assertRepeatNativeClosure } from '../interactions/index.js'
import { assertWorkflowNativeEntryRow, notSubmittedReceipt, workflowNativeReservation, type NativeEntryRow } from '../runs/workflowNativeEntry.js'
import { assertRepeatCanonicalReceiptRows, type RepeatCanonicalReceiptRow } from '../run-graph/index.js'
import { assertRepeatExecution, assertRepeatScope, repeatDigest, type RepeatNodeRef, type RepeatScope } from '../runs/repeatResolution.js'

const PAGE_SIZE = 128

interface ExecutionRow {
  id: string; run_id: string; workflow_node_id: string; agent_id: string; attempt: number
  record: unknown; repeat_occurrence_id: string | null; occurrence_record: unknown | null
  native_reference: unknown | null
  entry: NativeEntryRow | null; entry_receipts: RepeatCanonicalReceiptRow[]
}

/** Read-only native proof facet of Save/Stop-and-save. The caller holds every
 * affected parent Run row until its transaction ends, and separately checks
 * terminal state, finalization, credentials, approvals and review obligations.
 * This performs no recovery, disposal, seal, acknowledgement or native I/O.
 * A launch reservation alone, terminal enum, or absent registry is never proof.
 */
export async function readSaveNativeSettlements(sql: SqlQuery,
  runs: readonly { scope: RepeatScope; version: WorkflowVersionCurrent }[]): Promise<Map<string, boolean>> {
  const byRun = new Map(runs.map(run => [run.scope.runId, run]))
  const settled = new Map(runs.map(run => [run.scope.runId, true]))
  if (!runs.length) return settled
  let after = ''
  for (;;) {
    // Page across ALL affected Runs, including every attempt/occurrence, rather
    // than paying for an empty page and proof reads for each historical Run.
    const rows = (await sql.query<ExecutionRow>(`select e.id,e.run_id,e.workflow_node_id,e.agent_id,e.attempt,e.record,
        e.repeat_occurrence_id,o.record as occurrence_record,s.reference as native_reference,
        (select row_to_json(n) from (
          select phase,reservation,reservation_digest,transition,source_id,source_digest
          from workflow_native_entries where execution_id=e.id and run_id=e.run_id
        ) n) as entry,
        coalesce((select json_agg(receipt) from (
          select r.workspace_id,r.workflow_id,r.workflow_version_id,v.execution_semantics_version,
            h.protocol_version,h.head_sequence::text,g.source_digest,g.semantic_digest as source_semantic_digest,
            g.first_sequence::text as source_sequence,null::text as effect_digest,
            null::text as effect_semantic_digest,null::text as effect_sequence
          from workflow_native_entries n join runs r on r.id=n.run_id
          join workflow_versions v on v.id=r.workflow_version_id
          join run_graph_heads h on h.run_id=r.id
          join run_graph_sources g on g.run_id=r.id and g.source_kind='execution'
            and g.source_id=n.source_id and g.source_revision=1
          where n.execution_id=e.id and n.run_id=e.run_id
        ) receipt),'[]'::json) as entry_receipts
      from harness_executions e
      left join run_repeat_occurrences o on o.occurrence_id=e.repeat_occurrence_id and o.run_id=e.run_id
      left join execution_native_sessions s on s.execution_id=e.id
      where e.run_id=any($1::text[]) and e.id>$2 order by e.id limit ${PAGE_SIZE}`,
    [[...byRun.keys()], after])).rows
    if (!rows.length) return settled
    const ids = rows.map(row => row.id)
    const placements = await readSavePlacementEvidence(sql, ids)
    const closures = await readWorkflowClosureEvidence(sql, ids)
    for (const row of rows) {
      const { scope, version } = byRun.get(row.run_id)!
      if (!settled.get(row.run_id)) continue
      try {
        assertRepeatScope(version, scope)
        const execution = HarnessExecutionSchema.parse(row.record)
        if (row.id !== execution.id || row.run_id !== scope.runId || execution.runId !== scope.runId
          || row.workflow_node_id !== execution.workflowNodeId || row.agent_id !== execution.agentId || row.attempt !== execution.attempt
          || execution.state !== 'completed' || !execution.result || !execution.finishedAt) {
          settled.set(row.run_id, false)
          continue
        }
        const occurrence = row.repeat_occurrence_id === null ? null : RepeatOccurrenceV1Schema.parse(row.occurrence_record).identity
        if ((occurrence?.occurrenceId ?? null) !== row.repeat_occurrence_id) {
          settled.set(row.run_id, false)
          continue
        }
        const ref: RepeatNodeRef = { nodeId: execution.workflowNodeId, occurrence }
        assertRepeatExecution(version, scope, ref, execution)
        if (execution.nativeSessionId) {
          const placement = saveNativePlacement(placements.get(row.id)!, execution.id)
          if (placement && execution.workingDirectory !== placement.workingTree.canonicalCwd) {
            settled.set(row.run_id, false)
            continue
          }
          const session = NativeSessionReferenceSchema.parse(row.native_reference)
          const closure = workflowClosureFromEvidence(closures.get(row.id)!, execution)
          assertRepeatNativeClosure(execution, session, closure && 'session' in closure ? closure : undefined)
        } else {
          if (row.native_reference !== null || execution.result.outcome === 'succeeded') {
            settled.set(row.run_id, false)
            continue
          }
          const reservation = workflowNativeReservation(scope, ref, execution, repeatDigest(execution.input, 4 * 1024 * 1024))
          const entry = assertWorkflowNativeEntryRow(row.entry, reservation)
          if (entry.phase === 'not_submitted') {
            assertRepeatCanonicalReceiptRows(row.entry_receipts, notSubmittedReceipt(entry, reservation))
          } else if (entry.phase !== 'entered' || !workflowClosureFromEvidence(closures.get(row.id)!, execution)) {
            settled.set(row.run_id, false)
          }
        }
      } catch (error) {
        // Missing/corrupt proof is an obligation. Operational failures propagate.
        if (!(error instanceof DomainError || error instanceof ZodError)) throw error
        settled.set(row.run_id, false)
      }
    }
    if (rows.length < PAGE_SIZE) return settled
    after = rows[rows.length - 1]!.id
  }
}
