import { useEffect, useRef, useState } from 'react'
import type { SavedNodePlacement } from '@foreman-code/contracts/node-placement'
import { sameWorkflowValue } from '@foreman-code/contracts/current'
import type { NodePlacementChoicesResult } from '@foreman-code/contracts/placement-readback'
import { WorkspaceExecutionLocationSettings } from '../settings'
import { useSetupWorkspaceSourceRoot } from '../../shared/api/workspaceBoundLocation'
import { Button, Select } from '../../shared/ui/nocturne'
import { NodeRow } from '../graph/AgentMainFields'

/** The caller supplies authorized, revision-pinned choices; project setup uses the shared folder picker. */
export type NodePlacementOption = Readonly<{
  placement: SavedNodePlacement
  label: string
  unavailableReason?: string
  commit?: string
}>
/** A paired computer that can't run this Agent; it stays in the list so choosing it explains why. */
export type UnavailableComputer = NonNullable<NodePlacementChoicesResult['unavailableComputers']>[number]
export type NodePlacementFieldProps = {
  workspaceId?: string | undefined
  value?: SavedNodePlacement
  options: readonly NodePlacementOption[]
  unavailableComputers?: readonly UnavailableComputer[] | undefined
  onChange(value: SavedNodePlacement | undefined): void
  disabled?: boolean | undefined
  optionsState?: 'ready' | 'loading' | 'unavailable' | undefined
  /** Why choices can't be read right now. */
  note?: string | undefined
  inheritedWorktree?: string | undefined
}

export function NodePlacementField({ workspaceId, value, options, unavailableComputers = [], onChange, disabled, optionsState = 'ready', note,
  inheritedWorktree }: NodePlacementFieldProps) {
  const [blocked, setBlocked] = useState<string>()
  const [setupComputer, setSetupComputer] = useState<UnavailableComputer>()
  const setupTrigger = useRef<HTMLButtonElement>(null)
  const setup = useSetupWorkspaceSourceRoot(workspaceId ?? '')
  // A computer set up on choice is selected as soon as it appears among the working choices.
  const [setupHost, setSetupHost] = useState<UnavailableComputer['hostRef']>()
  useEffect(() => {
    if (!setupHost) return
    const ready = options.find(option => !option.unavailableReason && sameWorkflowValue(option.placement.hostRef, setupHost))
    if (!ready) return
    setSetupHost(undefined)
    setBlocked(undefined)
    onChange(structuredClone(ready.placement))
  }, [options, setupHost, onChange])
  const runSetup = (computer: UnavailableComputer) => {
    if (!workspaceId || setup.isPending) return
    setup.mutate({ workspaceId, commandId: crypto.randomUUID(), hostRef: computer.hostRef }, {
      onSuccess: result => {
        if ('kind' in result.value && result.value.kind === 'selection-required') setSetupComputer(computer)
        else setSetupHost(computer.hostRef)
      },
    })
  }
  const selected = value ? options.findIndex((option) => sameWorkflowValue(option.placement, value)) : -1
  const current = selected >= 0 ? options[selected] : undefined
  let selection = value ? selected < 0 ? 'retained' : String(selected) : 'inherited'
  if (blocked) selection = blocked
  const blockedComputer = blocked?.startsWith('computer:') ? unavailableComputers[Number(blocked.slice(9))] : undefined
  const blockedReason = blocked?.startsWith('computer:') ? blockedComputer?.reason
    : blocked ? options[Number(blocked)]?.unavailableReason : undefined
  let message: string | undefined = blockedReason
  if (!message && value && current?.unavailableReason) message = current.unavailableReason
  else if (!message && value && !current && optionsState === 'ready') message = 'The saved computer is no longer available. Choose another.'
  else if (!message && optionsState === 'loading') message = 'Checking computers…'
  else if (!message && optionsState === 'unavailable') message = note ?? 'Computers can’t be checked right now.'
  const needsSetup = blockedComputer?.reason === `This workspace’s project isn’t set up on ${blockedComputer?.name} yet.`
  return <><NodeRow label="Computer" note={message ? <>{setup.isPending && needsSetup ? `Setting up ${blockedComputer?.name}…` : message}{workspaceId && blockedComputer && needsSetup && !setup.isPending ? <>{' '}
    <Button size="sm" variant="ghost" ref={setupTrigger} disabled={disabled} onClick={() => runSetup(blockedComputer)}>Set up on {blockedComputer.name}</Button>
    {setup.error ? <span role="alert">{setup.error.message}</span> : null}
  </> : null}</> : undefined} tone={blockedReason || current?.unavailableReason ? 'warning' : undefined}>
    <Select label="Computer" aria-label="Computer" className="agent-node-inline" value={selection} disabled={disabled}
      options={[
        { value: 'inherited', label: inheritedWorktree ? 'Workflow default' : 'Main (default)' },
        ...(value && selected < 0 ? [{ value: 'retained', label: 'Saved computer', disabled: true }] : []),
        ...options.map((option, index) => ({ value: String(index),
          label: option.unavailableReason ? `${option.label} · unavailable` : option.label })),
        ...unavailableComputers.map((computer, index) => ({ value: `computer:${index}`, label: `${computer.name} · unavailable` })),
      ]} onChange={(event) => {
        const choice = event.target.value
        if (choice === 'inherited') {
          setBlocked(undefined)
          onChange(undefined)
          return
        }
        const option = choice.startsWith('computer:') ? undefined : options[Number(choice)]
        if (!option || option.unavailableReason) {
          // An unavailable computer is shown with its reason and never replaces the working choice;
          // one whose project isn't set up yet is set up right away and selected when ready.
          setBlocked(choice)
          const computer = choice.startsWith('computer:') ? unavailableComputers[Number(choice.slice(9))] : undefined
          if (computer && computer.reason === `This workspace’s project isn’t set up on ${computer.name} yet.`) runSetup(computer)
          return
        }
        setBlocked(undefined)
        onChange(structuredClone(option.placement))
      }} />
  </NodeRow>
    {workspaceId && setupComputer ? <WorkspaceExecutionLocationSettings workspaceId={workspaceId} presentation="dialog"
      open prepareSource initialHostRef={setupComputer.hostRef} triggerRef={setupTrigger}
      onOpenChange={open => { if (!open) setSetupComputer(undefined) }}
      onSaved={() => { setSetupHost(setupComputer.hostRef); setSetupComputer(undefined) }} /> : null}
  </>
}
