import { expect, it } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/current'
import { stagedProfileSelection } from './stagedProfileSelection.js'

const mainId = '10000000-0000-4000-8000-000000000001'
const device = { kind: 'device' as const, mainId, deviceId: '20000000-0000-4000-8000-000000000001' }
const mainPin = { instanceId: '40000000-0000-4000-8000-000000000001', instanceRevision: '6',
  target: { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
    harnessInstallationId: 'installed-main', installationFingerprint: 'b'.repeat(64) } }
const deviceTarget = { hostRef: device, applicationInstallationId: '30000000-0000-4000-8000-000000000001',
  harnessInstallationId: 'installed-device', installationFingerprint: 'c'.repeat(64) }

function graphWithWorkerNode() {
  const fixture = makeCurrentWorkflowFixture('staged-profile', 'single')
  const graph = structuredClone(fixture.version.definition)
  const node = graph.nodes[0]!
  node.placement = { schemaVersion: 1, hostRef: device, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1',
    projectRoot: '/worker/project', cwdPolicy: 'project-root', relativeCwd: '', instanceId: 'f88a8311-df92-5666-afe9-493c7231bc4f',
    instanceRevision: '1', harnessInstallationId: 'installed-device' }
  return { graph, agentId: node.agentId }
}

it('moves a Main profile pin to the profile of the paired computer the node is placed on', async () => {
  const { graph, agentId } = graphWithWorkerNode()
  expect(await stagedProfileSelection(graph, agentId, mainPin, async () => deviceTarget)).toEqual({
    instanceId: 'f88a8311-df92-5666-afe9-493c7231bc4f', instanceRevision: '1', target: deviceTarget })
  expect(await stagedProfileSelection(graph, agentId, undefined, async () => deviceTarget))
    .toMatchObject({ target: deviceTarget })
})

it('keeps the pin when the node has no paired-computer placement or the profile is unknown', async () => {
  const { graph, agentId } = graphWithWorkerNode()
  expect(await stagedProfileSelection(graph, agentId, mainPin, async () => undefined)).toEqual(mainPin)
  expect(await stagedProfileSelection(graph, 'another-agent', mainPin, async () => deviceTarget)).toEqual(mainPin)
})
