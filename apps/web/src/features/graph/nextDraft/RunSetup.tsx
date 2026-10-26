import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { INSTALLATION_NAMES } from '@foreman-code/contracts/installation-names'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { sameWorkflowValue } from '@foreman-code/contracts/current'
import { applyManagedMcp, harnessSettingsKeys, readMcpList } from '../../../shared/api/harnessSettings'
import { useComputerName } from '../../../shared/api/computerActivity'
import { Button, Dialog } from '../../../shared/ui/nocturne'
import { agentNodeFacts, type NextDraftEdit } from '../../board-core'

type HostRef = DeviceProvisioningTarget['hostRef']
type Need = { harness: 'codex' | 'claude'; hostRef?: HostRef; enable: boolean; label: string }
type Graph = NextDraftEdit['context']['draft']['graph']
type Agents = readonly (Parameters<typeof agentNodeFacts>[0] & { id: string })[]

/** Before Run: find computers whose harness lacks Foreman Code MCP and offer to set them all up at once. */
export function useRunSetup() {
  const client = useQueryClient()
  const computerName = useComputerName()
  const [needs, setNeeds] = useState<Need[]>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const pending = useRef<() => Promise<unknown>>(undefined)

  const guard = async (graph: Graph, agents: Agents, run: () => Promise<unknown>) => {
    const targets: Omit<Need, 'enable' | 'label'>[] = []
    for (const node of graph.nodes) {
      if (node.kind === 'job') continue
      const agent = agents.find(candidate => candidate.id === node.agentId)
      const harness = agent ? agentNodeFacts(agent).harness : undefined
      if (harness !== 'codex' && harness !== 'claude') continue
      const placed = node.placement?.hostRef
      const hostRef = placed?.kind === 'device' ? placed : undefined
      // Main's Claude receives Foreman Code MCP from the app itself.
      if (!hostRef && harness === 'claude') continue
      if (!targets.some(target => target.harness === harness && sameWorkflowValue(target.hostRef, hostRef))) {
        targets.push({ harness, ...(hostRef ? { hostRef } : {}) })
      }
    }
    const found: Need[] = []
    for (const target of targets) {
      // An unreadable computer is left to Start, which reports it.
      const status = (await readMcpList(target.harness, target.hostRef))?.presets?.[INSTALLATION_NAMES.mcp.server]
      if (!status || status === 'installed' || status === 'inherited') continue
      const computer = target.hostRef ? computerName({ hostRef: target.hostRef }) ?? 'a paired computer' : 'this computer'
      found.push({ ...target, enable: status === 'disabled',
        label: `Foreman Code MCP ${status === 'disabled' ? 'is turned off' : status === 'missing' ? 'isn’t set up' : 'is out of date'} for ${target.harness === 'codex' ? 'Codex' : 'Claude'} on ${computer}.` })
    }
    if (!found.length) return run()
    pending.current = run
    setError(undefined)
    setNeeds(found)
  }

  const setUp = async () => {
    if (!needs) return
    setBusy(true)
    setError(undefined)
    try {
      for (const need of needs) {
        const base = { harness: need.harness, preset: INSTALLATION_NAMES.mcp.server, commandId: crypto.randomUUID(),
          ...(need.hostRef ? { hostRef: need.hostRef } : {}) }
        const plan = await applyManagedMcp(need.enable ? { ...base, enabled: true } : { ...base, installed: true })
        if (plan.status !== 'applied' && plan.status !== 'reconciled') throw new Error(plan.error ?? `Setup didn’t finish (${plan.status}).`)
      }
      await client.invalidateQueries({ queryKey: harnessSettingsKeys.root })
      setNeeds(undefined)
      await pending.current?.()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const dialog = <Dialog open={!!needs} onOpenChange={open => { if (!open && !busy) setNeeds(undefined) }} busy={busy} size="sm"
    title="Set up before running?"
    footer={<div className="n-actions"><Button disabled={busy} onClick={() => setNeeds(undefined)}>Decline</Button>
      <Button variant="primary" loading={busy} onClick={() => void setUp()}>Set up and run</Button></div>}>
    <ul>{needs?.map(need => <li key={need.label}>{need.label}</li>)}</ul>
    {error ? <p className="n-field-error" role="alert">{error}</p> : null}
  </Dialog>
  return { guard, dialog }
}
