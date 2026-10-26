import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { RunRequirementsInputSchema, RunRequirementsResultSchema,
  type RunRequirementsInput, type RunRequirementsResult } from '@foreman-code/contracts/computer-maintenance'
import { sameWorkflowValue } from '@foreman-code/contracts/current'
import { apiClient } from '../../../shared/api/client'
import { useComputerName } from '../../../shared/api/computerActivity'
import { harnessSettingsKeys } from '../../../shared/api/harnessSettings'
import { Button, Dialog } from '../../../shared/ui/nocturne'
import { agentNodeFacts, type NextDraftEdit } from '../../board-core'

type Graph = NextDraftEdit['context']['draft']['graph']
type Agents = readonly (Parameters<typeof agentNodeFacts>[0] & { id: string })[]
type Requirement = { input: RunRequirementsInput; result: RunRequirementsResult }

function requirementsFor(graph: Graph, agents: Agents): RunRequirementsInput[] {
  const targets: RunRequirementsInput[] = []
  for (const node of graph.nodes) {
    if (node.kind === 'job') {
      let jobs = targets.find(target => target.harness === 'job')
      if (!jobs) {
        jobs = { workspaceId: graph.workspaceId, harness: 'job', agentIds: [], browserProfiles: [], jobDefinitions: [], action: 'check' }
        targets.push(jobs)
      }
      if (!jobs.jobDefinitions.some(job => job.id === node.jobDefinitionId && job.revision === node.jobDefinitionRevision)) {
        jobs.jobDefinitions.push({ id: node.jobDefinitionId, revision: node.jobDefinitionRevision })
      }
      continue
    }
    const agent = agents.find(candidate => candidate.id === node.agentId)
    const harness = agent && agentNodeFacts(agent).harness
    if (harness !== 'codex' && harness !== 'claude') throw new Error(`Choose a Codex or Claude harness for ${node.name ?? node.label ?? 'this Agent'} before running.`)
    const hostRef = node.placement?.hostRef
    const rootBinding = node.placement?.rootBinding ?? (!hostRef ? graph.defaultWorktree?.rootBinding : undefined)
    const rootPolicyId = node.placement?.rootPolicyId
    let target = targets.find(value => value.harness === harness
      && sameWorkflowValue(value.hostRef, hostRef) && sameWorkflowValue(value.rootBinding, rootBinding) && value.rootPolicyId === rootPolicyId)
    if (!target) {
      target = { workspaceId: graph.workspaceId, harness, ...(hostRef ? { hostRef } : {}),
        ...(rootBinding ? { rootBinding } : {}), ...(rootPolicyId ? { rootPolicyId } : {}), agentIds: [], browserProfiles: [], jobDefinitions: [], action: 'check' }
      targets.push(target)
    }
    if (!target.agentIds.includes(node.agentId)) target.agentIds.push(node.agentId)
    if (agent?.harnessConfiguration && !target.agentConfigurations?.some(value => value.agentId === node.agentId)) {
      target.agentConfigurations ??= []
      target.agentConfigurations.push({ agentId: node.agentId, configuration: agent.harnessConfiguration })
    }
    if (node.browser?.enabled) {
      const profile = node.browser.profileId ?? null
      if (!target.browserProfiles.includes(profile)) target.browserProfiles.push(profile)
    }
  }
  return targets
}

async function readRequirements(input: RunRequirementsInput): Promise<Requirement> {
  try {
    const result = await apiClient.request('/api/management/computers/run-requirements', RunRequirementsResultSchema,
      { method: 'POST', body: RunRequirementsInputSchema.parse(input) })
    return { input, result }
  } catch (error) {
    return { input, result: { target: null, items: [{ id: 'check-failed', state: 'unknown', fixable: false,
      message: error instanceof Error ? error.message : 'The computer could not be checked.' }] } }
  }
}

async function setUpRequirements(requirement: Requirement): Promise<Requirement> {
  let current = requirement
  const attempted = new Set<string>()
  for (;;) {
    const fixable = current.result.items.filter(item => item.state !== 'ready' && item.fixable).map(item => item.id).sort().join('\0')
    if (!fixable) return readRequirements({ ...current.input, action: 'check' })
    if (attempted.has(fixable)) return current
    attempted.add(fixable)
    current = await readRequirements({ ...current.input, action: 'fix' })
  }
}

export function useRunSetup() {
  const client = useQueryClient()
  const computerName = useComputerName()
  const [requirements, setRequirements] = useState<Requirement[]>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const pending = useRef<() => Promise<unknown>>(undefined)

  const guard = async (graph: Graph, agents: Agents, run: () => Promise<unknown>) => {
    const inputs = requirementsFor(graph, agents)
    const checked = await Promise.all(inputs.map(readRequirements))
    if (checked.every(({ result }) => result.items.every(item => item.state === 'ready'))) return run()
    pending.current = run
    setError(undefined)
    setRequirements(checked)
  }

  const setUp = async () => {
    if (!requirements) return
    setBusy(true)
    setError(undefined)
    try {
      const checked = await Promise.all(requirements.map(setUpRequirements))
      setRequirements(checked)
      await client.invalidateQueries({ queryKey: harnessSettingsKeys.root })
      if (checked.every(({ result }) => result.items.every(item => item.state === 'ready'))) {
        setRequirements(undefined)
        await pending.current?.()
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const groups = new Map<string, { title: string; items: { id: string; message: string }[] }>()
  for (const { input, result } of requirements ?? []) {
    const missing = result.items.filter(item => item.state !== 'ready')
    if (!missing.length) continue
    const host = result.target?.hostRef ?? input.hostRef
    const key = input.harness === 'job' ? 'jobs' : host ? JSON.stringify(host) : input.rootBinding ? JSON.stringify(input.rootBinding) : 'main'
    const title = input.harness === 'job' ? 'Build computers' : host ? computerName({ hostRef: host }) ?? 'Selected computer' : input.rootBinding ? 'Selected computer' : 'This computer'
    const group = groups.get(key) ?? { title, items: [] }
    for (const item of missing) {
      const message = input.harness === 'job' ? item.message : `${input.harness === 'codex' ? 'Codex' : 'Claude'}: ${item.message}`
      if (!group.items.some(existing => existing.message === message)) group.items.push({ id: `${input.harness}:${item.id}`, message })
    }
    groups.set(key, group)
  }
  const dialog = <Dialog open={!!requirements} onOpenChange={open => { if (!open && !busy) setRequirements(undefined) }} busy={busy} size="sm"
    title="Set up before running?"
    footer={<div className="n-actions"><Button disabled={busy} onClick={() => setRequirements(undefined)}>Decline</Button>
      <Button variant="primary" loading={busy} onClick={() => void setUp()}>Set up and run</Button></div>}>
    {[...groups].map(([key, group]) => <div key={key}><strong>{group.title}</strong>
      <ul>{group.items.map(item => <li key={`${item.id}:${item.message}`} style={{ whiteSpace: 'pre-wrap' }}>{item.message}</li>)}</ul></div>)}
    {error ? <p className="n-field-error" role="alert">{error}</p> : null}
  </Dialog>
  return { guard, dialog }
}
