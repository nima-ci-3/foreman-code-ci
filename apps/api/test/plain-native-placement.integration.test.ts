import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/current'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { insertRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { freezePlacement, deriveDispatch } from '../src/modules/placement/binding.js'
import { nativePlacementDigest } from '../src/modules/placement/executionBinding.js'
import { insertAcceptedPlacements, insertDispatchIntent, insertNativePlacement, readNativePlacement } from '../src/modules/placement/persistence.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { insertCurrentRunFixture } from './helpers/currentRunFixture.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { postgresEnabled } from './helpers/database.js'

it.skipIf(!postgresEnabled)('persists the native placement of an execution in a plain workspace folder', async () => {
  let placement: ReturnType<typeof freezePlacement> | undefined
  const base = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'),
    admitPlacementExecutionLocked: async (sql, owner, _run, execution, ref, inputDigest) => {
      if (!placement) throw new Error('Placement fixture is not initialized')
      const intent = deriveDispatch(placement, { executionId: execution.id, attemptId: randomUUID(),
        operationId: randomUUID(), technicalAttempt: execution.attempt,
        occurrenceId: ref.occurrence?.occurrenceId ?? null, occurrenceIndex: ref.occurrence?.occurrenceIndex ?? 0,
        inputDigest, owner: { grantId: randomUUID(), epoch: '1' } })
      await insertDispatchIntent(sql, owner, intent, { assertCurrent: async () => {} })
    } })
  let owner: RunOwnership | undefined
  try {
    const saveInput = await base.create()
    const saved = (await base.services.workflows.current.save(base.writer.principal, 'http', saveInput)).value
    const draft = await insertCurrentRunFixture(base.db.pool, { ...base.f, run: { ...base.f.run, id: randomUUID() } },
      saved, base.writer.principal.id, { insert: false })
    const node = agentWorkflowNode(draft.version.definition.nodes[0])
    const mainId = (await base.db.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const hash = 'c'.repeat(64)
    const filesystem = { device: '1', inode: '2', mountId: '3' }
    const policy = { schemaVersion: 1 as const, rootPolicyId: randomUUID(), rootPolicyRevision: '1',
      workspaceId: draft.run.workspaceId, hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
      registration: null, locationRevision: '1', ownerPrincipalId: base.writer.principal.id, allowedBaseId: randomUUID(),
      configurationRevision: '1', relativePath: '', accessMode: 'read-write' as const, canonicalProjectRoot: '/project',
      filesystem, directoryIdentityHash: hash, managedRuntimeRoot: '/native/runtime', runtimeFilesystem: filesystem,
      attestationId: randomUUID(), attestationDigest: hash }
    placement = freezePlacement({ schemaVersion: 1, mainId, mainInstallationId: mainId,
      runId: draft.run.id, nodeId: node.id, hostRef: policy.hostRef, registration: null,
      destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/native/runtime',
        directoryIdentityHash: hash, rootPolicyId: policy.rootPolicyId, rootPolicyRevision: '1', locationRevision: '1',
        attestationId: policy.attestationId, attestationHash: hash },
      source: { kind: 'plain', filesystem, accessMode: 'read-write' },
      payload: { kind: 'agent', agentId: node.agentId, agentConfigurationVersionId: draft.run.agentConfigurationVersionIds[node.agentId]!,
        driverId: 'codex', driverRevision: '1', instanceId: 'instance', instanceRevision: '1',
        harnessInstallationId: 'installation', installationFingerprint: hash, runtimeContractVersion: 1,
        protocolRevision: '1', credentialScopeRefs: [] } })
    await withExclusiveGraphConnection(base.db.pool, connection => connection.transaction(async sql => {
      await insertRepeatRun(sql, draft.accepted, repeatStartPublication)
      await insertAcceptedPlacements(sql, draft.run.id, [node], draft.run.agentConfigurationVersionIds,
        [placement!], { assertCurrent: async () => {} })
    }))
    owner = await RunOwnership.acquire(base.db.pool, draft.run.id, () => {})
    if (!owner) throw new Error('Expected Run owner')
    const store = await base.runs.repeat(owner)
    const admitted = await store.admit({ nodeId: node.id, occurrence: null }, () => HarnessExecutionSchema.parse({
      id: randomUUID(), runId: draft.run.id, workflowNodeId: node.id, agentId: node.agentId,
      agentConfigurationVersionId: draft.run.agentConfigurationVersionIds[node.agentId],
      attempt: 1, state: 'queued', input: {}, createdAt: base.f.createdAt,
    }))
    if (admitted.kind !== 'admitted') throw new Error('Expected execution admission')
    const dispatch = (await base.db.pool.query<{ record: ReturnType<typeof deriveDispatch> }>(
      'select record from execution_dispatch_intents where execution_id=$1', [admitted.execution.id])).rows[0]!.record
    const fields = { version: 1 as const, kind: 'plain' as const, acceptedBindingHash: placement.bindingHash,
      runId: draft.run.id, nodeId: node.id, executionId: dispatch.executionId, attemptId: dispatch.attemptId,
      operationId: dispatch.operationId, policy, workingTree: { canonicalProjectRoot: '/project', canonicalCwd: '/project',
        directoryIdentityHash: hash, filesystem, accessMode: 'exclusive-write' as const, privateGit: null } }
    const native = { ...fields, bindingHash: nativePlacementDigest(fields) }
    await owner.oneShotConnection().transaction(sql => insertNativePlacement(sql, owner!, native))
    expect(await owner.oneShotConnection().transaction(sql => readNativePlacement(sql, dispatch.executionId)))
      .toEqual(native)
  } finally {
    await owner?.release()
    await base.close()
  }
}, 60_000)
