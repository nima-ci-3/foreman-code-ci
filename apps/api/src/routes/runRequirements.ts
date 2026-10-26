import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { INSTALLATION_NAMES } from '@foreman-code/contracts/installation-names'
import { RunRequirementsInputSchema, RunRequirementsResultSchema, type RunRequirement,
  type RunRequirementsInput, type RunRequirementsResult } from '@foreman-code/contracts/computer-maintenance'
import type { ComputerAccount } from '@foreman-code/contracts/computer-accounts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { sameWorkflowValue } from '@foreman-code/contracts/current'
import { withAdvancedDefaults } from '@foreman-code/contracts'
import type { ManagementPrincipal, HarnessMcpList } from '@foreman-code/contracts/management'
import type { OperatorServices } from '../mcp/operator/types.js'
import { requirePrincipal } from '../modules/access/http.js'
import { DomainError } from '../modules/errors.js'
import type { FastifyInstance } from 'fastify'

type Harness = 'codex' | 'claude'
type McpStatus = NonNullable<HarnessMcpList['presets']>[typeof INSTALLATION_NAMES.mcp.server] | null
const item = (id: string, state: RunRequirement['state'], message: string, fixable = false): RunRequirement =>
  ({ id, state, message, fixable })
const label = (harness: Harness) => harness === 'codex' ? 'Codex' : 'Claude'

/** Facts from a host-default profile; selected managed accounts are checked separately. */
export function computerRequirements(input: { harness: Harness; online: boolean; account: ComputerAccount | null;
  mcp: McpStatus; managedAccount?: boolean; injectedMcp?: boolean }): RunRequirement[] {
  const { harness, account, mcp } = input
  if (!input.online) return [item('computer', 'unknown', 'This computer is offline or did not respond. Reconnect its Worker.')]
  const items = [item('computer', 'ready', 'Computer is connected.')]
  if (!account) {
    items.push(item('harness', 'unknown', `${label(harness)} installation could not be checked.`))
  } else if (!account.installed) {
    items.push(item('harness', 'missing', `${label(harness)} is not installed on this computer.`, true))
  } else {
    items.push(item('harness', 'ready', `${label(harness)} is installed.`))
    if (!input.managedAccount) {
      items.push(account.signedIn === true ? item('sign-in', 'ready', `${label(harness)} is signed in.`)
        : account.signedIn === false ? item('sign-in', 'missing', `Open Settings → Computers → this computer → Sign-ins, sign in to ${label(harness)}, then check again.`)
          : item('sign-in', 'unknown', `Could not verify ${label(harness)} sign-in. Open Settings → Computers → this computer → Sign-ins and check its account.`))
    }
  }
  if (input.injectedMcp) items.push(item('mcp', 'ready', 'Foreman Code MCP is supplied by the app.'))
  else if (account?.installed === false) items.push(item('mcp', 'missing', 'Foreman Code MCP needs the harness installed first.', true))
  else if (mcp === 'installed' || mcp === 'inherited') items.push(item('mcp', 'ready', 'Foreman Code MCP is configured.'))
  else if (mcp === null) items.push(item('mcp', 'unknown', 'Foreman Code MCP could not be checked on this computer.'))
  else items.push(item('mcp', 'missing', `Foreman Code MCP for ${label(harness)} is ${mcp === 'disabled' ? 'turned off' : mcp === 'missing' ? 'not set up' : 'out of date'}.`, true))
  return items
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 3500) : 'The check could not be completed.'
}

async function maintenance(services: OperatorServices, principal: ManagementPrincipal, target: DeviceProvisioningTarget,
  task: { kind: 'update-harnesses'; harnesses: Harness[] } | { kind: 'update-worker' } | { kind: 'repair-browser' }) {
  if (!services.computerMaintenance) throw new DomainError('COMPUTER_MAINTENANCE_UNAVAILABLE', 'Computer maintenance is unavailable.', 503)
  const result = await services.computerMaintenance.start(principal, 'http', { commandId: randomUUID(), targets: [target], task })
  const started = result.computers[0]
  if (!started?.task) throw new Error(started?.error ?? 'The computer did not start setup.')
  let current = started.task
  const deadline = Date.now() + 180_000
  while (current.state === 'running' && Date.now() < deadline) {
    await delay(1000)
    const state = await services.computerMaintenance.readTarget(principal, 'http', { target, refresh: true })
    const next = state.computers[0]?.status?.tasks.find(value => value.id === current.id)
    if (!next) throw new Error('The computer did not report the setup task. Check computer maintenance.')
    current = next
  }
  if (current.state !== 'succeeded') throw new Error(current.state === 'running'
    ? 'Setup is still running. Check computer maintenance and retry.' : current.summary)
}

/** Shared by Run setup and automatic computer upkeep. */
export async function repairManagedMcp(services: OperatorServices, principal: ManagementPrincipal,
  target: DeviceProvisioningTarget, harness: Harness): Promise<void> {
  if (target.hostRef.kind === 'main' && harness === 'claude') return
  const settings = services.harnessSettings?.mcp
  if (!settings) throw new Error('Harness connection settings are unavailable.')
  const found = await settings.list(principal, harness, target.hostRef)
  const status = found.presets?.[INSTALLATION_NAMES.mcp.server]
  if (status === 'installed' || status === 'inherited') return
  if (!status) throw new Error(`Could not read Foreman Code MCP for ${label(harness)}.`)
  const common = { harness, hostRef: target.hostRef, preset: INSTALLATION_NAMES.mcp.server, commandId: randomUUID() }
  const result = await settings.applyManaged(principal, status === 'disabled'
    ? { ...common, enabled: true } : { ...common, installed: true })
  if (result.status !== 'applied' && result.status !== 'reconciled') throw new Error(result.error ?? `MCP setup did not finish (${result.status}).`)
}

/** Upkeep reuses the same managed connection and browser repairs as Run setup. */
export async function repairComputerRequirements(services: OperatorServices, principal: ManagementPrincipal,
  target: DeviceProvisioningTarget): Promise<void> {
  if (!services.computerAccounts || !services.computerMaintenance) {
    throw new Error('Computer account and maintenance services must be available before upkeep can repair setup.')
  }
  let account = (await services.computerAccounts.readTarget(principal, 'http', { target, refresh: true })).computers[0]?.accounts
  if (!account) throw new Error('Computer account status is unavailable.')
  const errors: unknown[] = []
  const missing = (['codex', 'claude'] as const).filter(harness =>
    account!.accounts.find(value => value.tool === harness)?.installed === false)
  if (missing.length) {
    try {
      await maintenance(services, principal, target, { kind: 'update-harnesses', harnesses: missing })
      account = (await services.computerAccounts.readTarget(principal, 'http', { target, refresh: true })).computers[0]?.accounts ?? account
    } catch (error) { errors.push(error) }
  }
  for (const harness of ['codex', 'claude'] as const) {
    if (!account.accounts.find(value => value.tool === harness)?.installed) continue
    try { await repairManagedMcp(services, principal, target, harness) } catch (error) { errors.push(error) }
  }
  try { await repairSavedWorkflows(services, principal, target) } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Some computer setup repairs did not complete.')
}

/** Saved workflows supply the workspace-specific setup that a bare computer cannot identify. */
async function repairSavedWorkflows(services: OperatorServices, principal: ManagementPrincipal,
  target: DeviceProvisioningTarget): Promise<void> {
  const failures: unknown[] = []
  const checked = new Set<string>()
  let workspaceCursor: string | undefined
  do {
    const page = await services.workspaces.list(principal, { limit: 100, includeArchived: false, cursor: workspaceCursor })
    for (const entry of page.items) {
      const workspaceId = entry.workspace.id
      let workflowCursor: string | undefined
      do {
        const workflows = await services.workflows.list(principal, { workspaceId, limit: 100,
          includeArchived: false, cursor: workflowCursor })
        for (const saved of workflows.items) {
          if (!saved.currentVersionId) continue
          const graph = saved.workflow
          let defaultHost = { kind: 'main' as const, mainId: target.hostRef.mainId } as DeviceProvisioningTarget['hostRef']
          if (graph.defaultWorktree?.rootBinding) {
            if (!services.sources) continue
            const roots = await services.sources.rootList(principal, 'http', { workspaceId })
            const root = roots.items.find(value => value.binding.rootId === graph.defaultWorktree!.rootBinding.rootId)
            if (!root) continue
            defaultHost = root.selection.hostRef
          }
          const requests: RunRequirementsInput[] = []
          for (const node of graph.nodes) {
            if (node.kind === 'job') {
              if (target.hostRef.kind !== 'main') continue
              let request = requests.find(value => value.harness === 'job' && value.jobDefinitions.length < 100)
              if (!request) {
                request = { workspaceId, harness: 'job', agentIds: [], browserProfiles: [], jobDefinitions: [], action: 'fix' }
                requests.push(request)
              }
              request.jobDefinitions.push({ id: node.jobDefinitionId, revision: node.jobDefinitionRevision })
              continue
            }
            const hostRef = node.placement?.hostRef ?? defaultHost
            if (!sameWorkflowValue(hostRef, target.hostRef)) continue
            try {
              const agent = (await services.agents.get(principal, workspaceId, node.agentId)).agent
              const harness = agent.harnessConfiguration?.harness
              if (harness !== 'codex' && harness !== 'claude') continue
              const rootBinding = node.placement?.rootBinding ?? (!node.placement ? graph.defaultWorktree?.rootBinding : undefined)
              const rootPolicyId = node.placement?.rootPolicyId
              let request = requests.find(value => value.harness === harness && value.rootPolicyId === rootPolicyId
                && sameWorkflowValue(value.rootBinding, rootBinding) && value.agentIds.length < 100
                && value.browserProfiles.length < 100 && !value.agentConfigurations?.some(snapshot => snapshot.agentId === node.agentId
                  && (snapshot.placementInstanceId !== node.placement?.instanceId
                    || snapshot.placementInstanceRevision !== node.placement?.instanceRevision)))
              if (!request) {
                request = { workspaceId, harness, hostRef, ...(rootBinding ? { rootBinding } : {}),
                  ...(rootPolicyId ? { rootPolicyId } : {}), agentIds: [], browserProfiles: [], jobDefinitions: [], action: 'fix' }
                requests.push(request)
              }
              if (!request.agentIds.includes(node.agentId)) request.agentIds.push(node.agentId)
              if (agent.harnessConfiguration && !request.agentConfigurations?.some(value => value.agentId === node.agentId)) {
                request.agentConfigurations ??= []
                request.agentConfigurations.push({ agentId: node.agentId, configuration: agent.harnessConfiguration,
                  ...(agent.harnessProfileSelection ? { selection: agent.harnessProfileSelection } : {}),
                  ...(node.placement ? { placementInstanceId: node.placement.instanceId,
                    placementInstanceRevision: node.placement.instanceRevision } : {}) })
              }
              if (node.browser?.enabled && !request.browserProfiles.includes(node.browser.profileId ?? null)) {
                request.browserProfiles.push(node.browser.profileId ?? null)
              }
            } catch (error) { failures.push(error) }
          }
          for (const request of requests) {
            try {
              const key = JSON.stringify({ ...request, agentIds: [...request.agentIds].sort(),
                browserProfiles: [...request.browserProfiles].sort(), jobDefinitions: [...request.jobDefinitions].sort((a, b) => a.id.localeCompare(b.id)) })
              if (checked.has(key)) continue
              checked.add(key)
              const result = await runRequirements(services, principal, request, false)
              const failed = result.items.filter(value => value.state !== 'ready' && value.fixable)
              if (failed.length) failures.push(new Error(failed.map(value => value.message).join('; ')))
            } catch (error) { failures.push(error) }
          }
        }
        workflowCursor = workflows.pageInfo.nextCursor ?? undefined
      } while (workflowCursor)
    }
    workspaceCursor = page.pageInfo.nextCursor ?? undefined
  } while (workspaceCursor)
  if (failures.length) throw new AggregateError(failures, 'Saved workflow computer setup did not finish.')
}

export async function runRequirements(services: OperatorServices, principal: ManagementPrincipal,
  raw: RunRequirementsInput, checkClaude = true): Promise<RunRequirementsResult> {
  const input = RunRequirementsInputSchema.parse(raw)
  const items: RunRequirement[] = []
  const workspace = await services.workspaces.get(principal, input.workspaceId)
  if (input.harness === 'job') {
    let enrollment: Awaited<ReturnType<NonNullable<OperatorServices['ciEnrollment']>['read']>> | undefined
    try { enrollment = await services.ciEnrollment?.read(principal, { workspaceId: input.workspaceId }) }
    catch (error) { items.push(item('job-computers', 'unknown', `Could not read build computer setup: ${errorText(error)}`)) }
    const repairable = enrollment?.computers.filter(computer => computer.state === 'setup-required'
      || computer.state === 'failed' || computer.state === 'root-required' || computer.state === 'runtime-required') ?? []
    for (const job of input.jobDefinitions) {
      try {
        if (!services.jobs) throw new Error('Job readiness is unavailable.')
        const result = await services.jobs.validateLaunch(principal, input.workspaceId, { definitionId: job.id, expectedRevision: job.revision })
        items.push(result.valid ? item(`job:${job.id}`, 'ready', 'A build computer is ready for this Job.')
          : item(`job:${job.id}`, 'missing', `No ready build computer for this Job: ${result.reasons.join(', ') || 'setup required'}.`,
            repairable.length > 0))
      } catch (error) { items.push(item(`job:${job.id}`, 'unknown', `Could not check Job setup: ${errorText(error)}`)) }
    }
    if (input.action === 'fix' && items.some(value => value.fixable) && services.ciEnrollment) {
      const failures: RunRequirement[] = []
      for (const computer of repairable) {
        try {
          await services.ciEnrollment.update(principal, 'http', { workspaceId: input.workspaceId, target: computer.target,
            expectedRevision: computer.revision, enabled: true, commandId: randomUUID() })
        } catch (error) { failures.push(item(`job-setup:${computer.target.applicationInstallationId}`,
          'missing', `Could not prepare the build computer: ${errorText(error)}`, true)) }
      }
      const deadline = Date.now() + 180_000
      let checked = await runRequirements(services, principal, { ...input, action: 'check' }, checkClaude)
      while (checked.items.some(value => value.id.startsWith('job:') && value.state !== 'ready') && Date.now() < deadline) {
        const current = await services.ciEnrollment.read(principal, { workspaceId: input.workspaceId })
        if (!current.computers.some(computer => computer.state === 'pending' || computer.state === 'preparing')) break
        await delay(1000)
        checked = await runRequirements(services, principal, { ...input, action: 'check' }, checkClaude)
      }
      checked.items.push(...failures)
      return RunRequirementsResultSchema.parse(checked)
    }
    return RunRequirementsResultSchema.parse({ target: null, items })
  }

  let hostRef = input.hostRef
  let selectedRoot: Awaited<ReturnType<NonNullable<OperatorServices['sources']>['rootList']>>['items'][number] | undefined
  if (input.rootBinding) {
    if (!services.sources) return RunRequirementsResultSchema.parse({ target: null,
      items: [item('project', 'unknown', 'Workspace project roots are unavailable.')] })
    const roots = await services.sources.rootList(principal, 'http', { workspaceId: input.workspaceId })
    selectedRoot = roots.items.find(value => value.binding.rootId === input.rootBinding!.rootId)
    if (!selectedRoot) return RunRequirementsResultSchema.parse({ target: null,
      items: [item('project', 'missing', 'The workflow default project location no longer exists. Choose a project location.')] })
    if (hostRef && !sameWorkflowValue(hostRef, selectedRoot.selection.hostRef)) return RunRequirementsResultSchema.parse({ target: null,
      items: [item('project', 'missing', 'The project root belongs to a different computer. Select the correct location.')] })
    hostRef = selectedRoot.selection.hostRef
  }
  if (!services.computerAccounts || !services.computerMaintenance) throw new DomainError('COMPUTER_MAINTENANCE_UNAVAILABLE', 'Computer setup is unavailable.', 503)
  const listed = await services.computerAccounts.list(principal, 'http', false)
  const target = listed.computers.find(value => hostRef ? sameWorkflowValue(value.target.hostRef, hostRef)
    : value.target.hostRef.kind === 'main')?.target
  if (!target) return RunRequirementsResultSchema.parse({ target: null,
    items: [item('computer', 'unknown', 'The selected computer is not paired or could not be found.')] })
  const computerId = target.hostRef.kind === 'device' ? target.hostRef.deviceId : target.hostRef.mainId
  const accountFacts = (await services.computerAccounts.readTarget(principal, 'http', { target, refresh: true })).computers[0]?.accounts ?? null
  let selectedSource: Awaited<ReturnType<NonNullable<OperatorServices['sources']>['get']>> | undefined
  if (selectedRoot && services.sources) {
    try { selectedSource = await services.sources.get(principal, 'http', { workspaceId: input.workspaceId, ...selectedRoot.source }) }
    catch (error) { items.push(item('source', 'unknown', `Could not check the workspace source: ${errorText(error)}`)) }
  }
  const repository = workspace.workspace.repository
  const repositoryProbe = repository ? { repository: `${repository.owner}/${repository.name}`,
    ...(selectedSource?.manifest.git?.commit ? { commit: selectedSource.manifest.git.commit } : {}) } : undefined
  let status = (await services.computerMaintenance.readTarget(principal, 'http', { target, refresh: true })).computers[0]
  // Older Workers reject probe fields in their strict protocol. Read bundle
  // readiness first so they can be updated before attempting the new probes.
  if ((target.hostRef.kind === 'main' || status?.workerReadiness?.ready)
    && (input.browserProfiles.length || repositoryProbe)) {
    status = (await services.computerMaintenance.readTarget(principal, 'http', {
      target, refresh: true, ...(input.browserProfiles.length ? { browserProbe: true } : {}),
      ...(repositoryProbe ? { repositoryProbe } : {}),
    })).computers[0]
  }
  const account = accountFacts?.accounts.find(value => value.tool === input.harness) ?? null
  const selected = await Promise.all(input.agentIds.map(async id => {
    const edited = input.agentConfigurations?.find(value => value.agentId === id)
    if (edited) return { id, harnessConfiguration: edited.configuration, selection: edited.selection,
      placementInstanceId: edited.placementInstanceId, placementInstanceRevision: edited.placementInstanceRevision }
    const agent = (await services.agents.get(principal, input.workspaceId, id)).agent
    return { id, harnessConfiguration: agent.harnessConfiguration, selection: agent.harnessProfileSelection,
      placementInstanceId: undefined, placementInstanceRevision: undefined }
  }))
  const managed = selected.filter(agent => agent.harnessConfiguration?.harness === input.harness && agent.harnessConfiguration.accountId)
  const needsDefault = selected.length === 0 || managed.length !== selected.length
  let mcp: McpStatus = null
  let connections: HarnessMcpList | undefined
  if (account?.installed && !(target.hostRef.kind === 'main' && input.harness === 'claude')) {
    try {
      connections = await services.harnessSettings?.mcp.list(principal, input.harness, target.hostRef)
      mcp = connections?.presets?.[INSTALLATION_NAMES.mcp.server] ?? null
    }
    catch (error) { items.push(item('mcp-read', 'unknown', `Could not read Foreman Code MCP: ${errorText(error)}`)) }
  }
  items.push(...computerRequirements({ harness: input.harness, online: status?.observation?.status === 'available' && !!status.status && !!accountFacts,
    account, mcp, managedAccount: input.harness === 'claude' || !needsDefault,
    injectedMcp: target.hostRef.kind === 'main' && input.harness === 'claude' }))
  if (target.hostRef.kind === 'device' && status?.workerReadiness && !status.workerReadiness.ready) {
    items.push(item('worker', 'missing', `Worker needs an update (${status.workerReadiness.code ?? 'not ready'}).`, true))
  }
  const accountBindings = new Map<string, NonNullable<Awaited<ReturnType<NonNullable<OperatorServices['providerAccounts']>['get']>>['binding']>>()
  for (const agent of managed) {
    const configuration = agent.harnessConfiguration
    if (!configuration || configuration.harness !== input.harness || !configuration.accountId) continue
    try {
      if (!services.providerAccounts) throw new Error('Provider accounts are unavailable.')
      const found = await services.providerAccounts.get(principal, { accountId: configuration.accountId, target })
      if (found.binding) accountBindings.set(configuration.accountId, found.binding)
      items.push(found.status === 'signed-in' && !found.removedAt
        ? item(`account:${configuration.accountId}`, 'ready', `${label(input.harness)} account ${found.name} is signed in.`)
        : item(`account:${configuration.accountId}`, 'missing', `Open Settings → Computers → this computer → Sign-ins, sign in to ${label(input.harness)} account ${found.name}, then check again.`))
    } catch (error) { items.push(item(`account:${configuration.accountId}`, 'unknown', `Could not check the selected account: ${errorText(error)}`)) }
  }
  let profiles: Awaited<ReturnType<NonNullable<OperatorServices['harnessInstances']>['list']>>['overrides'] | undefined
  if (selected.length && account?.installed) {
    try {
      if (!services.harnessInstances) throw new Error('Harness profiles are unavailable.')
      profiles = (await services.harnessInstances.list(principal, { hostRef: target.hostRef,
        applicationInstallationId: target.applicationInstallationId })).overrides
    } catch (error) { items.push(item('profiles', 'unknown', `Could not read harness profiles: ${errorText(error)}`)) }
  }
  for (const agent of selected) {
    const configuration = agent.harnessConfiguration
    if (!configuration || configuration.harness !== input.harness) {
      items.push(item(`configuration:${agent.id}`, 'unknown', 'This Agent has no readable harness configuration.'))
      continue
    }
    const profile = profiles?.find(value => value.enabled && value.driverId === input.harness
        && (agent.placementInstanceId ? value.instanceId === agent.placementInstanceId
          && value.instanceRevision === agent.placementInstanceRevision
          : agent.selection ? value.instanceId === agent.selection.instanceId
            && value.instanceRevision === agent.selection.instanceRevision && sameWorkflowValue(value.target, agent.selection.target)
            : true)
        && sameWorkflowValue(withAdvancedDefaults(value.configuration), withAdvancedDefaults(configuration)))
    if (profiles) {
      items.push(profile?.qualification === 'qualified'
        ? item(`profile:${agent.id}`, 'ready', `${label(input.harness)} profile for this Agent is ready.`)
        : item(`profile:${agent.id}`, 'missing', profile?.qualificationFailure?.message
          ?? (profile ? `The ${label(input.harness)} profile needs to be checked on this computer.`
            : agent.placementInstanceId || agent.selection
              ? `The Agent's selected ${label(input.harness)} profile is unavailable or changed on this computer. Select its current profile and save the workflow.`
              : `This computer needs a ${label(input.harness)} profile matching this Agent.`),
        !!profile || !agent.placementInstanceId && !agent.selection))
    }
    // Without a managed account, Claude's configDirectory is the account
    // profile. The computer-wide account probe and default options can name a
    // different profile, so qualify this exact host/profile instead.
    if (configuration.harness === 'claude' && !configuration.accountId && account?.installed && checkClaude) {
      try {
        if (!profile || !services.harnessInstances) throw new Error('Select and prepare the Agent’s Claude profile first.')
        const checked = await services.harnessInstances.check(principal, 'http', { commandId: randomUUID(),
          instanceId: profile.instanceId, expectedRevision: profile.revision, target: profile.target })
        const profileItem = items.find(value => value.id === `profile:${agent.id}`)
        if (checked.proof.qualified && checked.proof.authenticated === true) {
          if (profileItem) Object.assign(profileItem, item(profileItem.id, 'ready', 'The selected Claude profile is ready.'))
          items.push(item(`sign-in:${agent.id}`, 'ready', 'The selected Claude profile is signed in.'))
          items.push(item(`model:${agent.id}`, 'ready', 'The selected Claude model and settings passed the profile check.'))
        } else {
          const reason = checked.proof.failure?.message ?? 'The selected Claude profile did not pass its native check.'
          if (profileItem) Object.assign(profileItem, item(profileItem.id, 'missing', reason, true))
          items.push(item(`sign-in:${agent.id}`, checked.proof.authenticated === false ? 'missing' : 'unknown',
            `${reason} Open Settings → Computers → this computer → Sign-ins and check the selected Claude profile.`))
        }
      } catch (error) {
        items.push(item(`sign-in:${agent.id}`, 'unknown', `Could not check the selected Claude profile: ${errorText(error)}`))
      }
    } else if (!(configuration.harness === 'claude' && !configuration.accountId) && account?.installed && services.extensions?.native) {
      try {
        const binding = configuration.accountId ? accountBindings.get(configuration.accountId) : undefined
        if (configuration.accountId && !binding) throw new Error('The selected provider account binding is unavailable.')
        const options = await services.extensions.native.options(input.harness, binding, target.hostRef)
        if (!configuration.accountId && options.authenticated) {
          const auth = items.find(value => value.id === 'sign-in')
          if (auth?.state === 'unknown') Object.assign(auth, item('sign-in', 'ready', `${label(input.harness)} is signed in.`))
        }
        const model = options.models.find(value => value.id === configuration.model
          || configuration.harness === 'claude' && configuration.model === 'default' && value.defaultPriority === -1)
        const supported = !!model && (configuration.harness !== 'codex'
          || model.reasoningEfforts.includes(configuration.reasoningEffort)
            && (configuration.serviceTier !== 'priority' || model.serviceTiers.includes('priority')))
        items.push(supported ? item(`model:${agent.id}`, 'ready', 'The selected model and settings are available.')
          : item(`model:${agent.id}`, 'missing', `Choose an available ${label(input.harness)} model and settings for this Agent.`))
      } catch (error) { items.push(item(`model:${agent.id}`, 'unknown', `Could not check the selected model and account: ${errorText(error)}`)) }
    }
    if (configuration.harness === 'codex') {
      for (const [name, expected] of Object.entries(configuration.advanced?.mcpServers ?? {})) {
        if (name === INSTALLATION_NAMES.mcp.server) continue
        const found = connections?.servers.find(server => server.name === name)
        if (!connections) items.push(item(`connection:${agent.id}:${name}`, 'unknown', `Could not check MCP connection ${name}.`))
        else if (!found || found.enabled !== expected.enabled) items.push(item(`connection:${agent.id}:${name}`, 'missing',
          `Set up MCP connection ${name} with the saved settings on this computer.`))
        else if (profile?.qualification === 'qualified') items.push(item(`connection:${agent.id}:${name}`, 'ready',
          `MCP connection ${name} is present and its saved policy passed the profile check.`))
        else items.push(item(`connection:${agent.id}:${name}`, 'unknown',
          `Check the Agent's harness profile to verify MCP connection ${name} and its saved tool settings.`))
      }
    }
  }
  if (!input.rootBinding && !input.rootPolicyId && target.hostRef.kind === 'main' && workspace.locationValidation?.status !== 'ready') {
    items.push(item('project', 'missing', workspace.locationValidation?.status === 'unavailable'
      ? workspace.locationValidation.error.message : 'Choose a workspace folder before running.'))
  }
  if (target.hostRef.kind === 'device' || input.rootBinding || input.rootPolicyId) {
    try {
      if (!services.workspaceRoots) throw new Error('Workspace locations are unavailable.')
      const policies = await services.workspaceRoots.choices(principal, { workspaceId: input.workspaceId })
      const policy = policies.policies.find(value => sameWorkflowValue(value.hostRef, target.hostRef)
        && (!selectedRoot || value.rootPolicyId === selectedRoot.selection.rootPolicyId)
        && (!input.rootPolicyId || value.rootPolicyId === input.rootPolicyId))
      if (!policy) {
        const canPrepare = !input.rootPolicyId && !input.rootBinding && !!services.sources
          && await services.sources.isPlainWorkspace(principal, input.workspaceId)
        items.push(item('project', 'missing', canPrepare
          ? 'This workspace project needs setup on this computer.'
          : 'This workspace project is not set up on this computer. Choose its workspace folder.', canPrepare))
      }
      else {
        const validation = await services.workspaceRoots.validate(principal, 'http', {
          workspaceId: input.workspaceId, hostRef: policy.hostRef, allowedBaseId: policy.allowedBaseId,
          configurationRevision: policy.configurationRevision, relativePath: policy.relativePath,
          accessMode: policy.accessMode, expectedLocationRevision: Number(policy.locationRevision),
          expectedRootPolicyRevision: Number(policy.rootPolicyRevision),
        })
        items.push(sameWorkflowValue(validation.attestation.filesystem, policy.filesystem)
          ? item('project', 'ready', 'Workspace project folder is available on this computer.')
          : item('project', 'missing', 'The workspace folder changed on this computer. Select and save it again.'))
      }
    } catch (error) { items.push(item('project', 'unknown', `Could not validate the workspace folder: ${errorText(error)}`)) }
  }
  if (selectedRoot && selectedSource && target.hostRef.kind === 'main') {
    try {
      const { sourceMaterializationBytes } = await import('../modules/sources/footprint.js')
      const { readSourceStorageCapacity } = await import('../modules/sources/storageCapacity.js')
      const disk = await readSourceStorageCapacity(selectedRoot.binding.canonicalPath, selectedRoot.binding.filesystem)
      const required = sourceMaterializationBytes(selectedSource.manifest)
      items.push(disk.availableBytes >= required ? item('disk', 'ready', 'Workspace storage has enough free space.')
        : item('disk', 'missing', `Free at least ${required} bytes on the workspace filesystem, then retry.`))
    } catch (error) { items.push(item('disk', 'unknown', `Could not check workspace storage: ${errorText(error)}`)) }
  }
  if (repositoryProbe) {
    const probe = status?.status?.repositoryProbe
    items.push(probe?.ready ? item('repository', 'ready', `Repository ${repositoryProbe.repository} is accessible on this computer.`)
      : item('repository', probe ? 'missing' : 'unknown', probe?.reason
        ? `${probe.reason} For a private repository, open Settings → Computers → this computer → Sign-ins and sign in to GitHub.`
        : `Could not check repository ${repositoryProbe.repository} on this computer.`))
  }
  if (input.browserProfiles.length) {
    const browser = status?.status?.browserRuntime
    if (!browser?.ready) items.push(item('browser', browser ? 'missing' : 'unknown',
      browser?.reason ?? 'The browser runtime could not be checked on this computer.',
      !!browser && !/Browser sandbox needs the Foreman AppArmor user-namespace profile\./.test(browser.reason ?? '')))
    else if (status?.status?.browserProbe?.ready) items.push(item('browser', 'ready', 'Browser runtime and sandbox are ready.'))
    else {
      const reason = status?.status?.browserProbe?.reason ?? 'Could not verify the browser sandbox and virtual display.'
      items.push(item('browser', status?.status?.browserProbe ? 'missing' : 'unknown', reason,
        !!status?.status?.browserProbe && !/apparmor|user.namespace profile|sudo .*apparmor/i.test(reason)))
    }
    for (const profileId of [...new Set(input.browserProfiles)]) {
      if (!profileId) { items.push(item('browser-profile', 'missing', 'Choose a browser profile for this Agent.')); continue }
      try {
        if (!services.browser) throw new Error('Browser profiles are unavailable.')
        const profile = await services.browser.profiles.service.get(principal, profileId)
        const catalog = await services.browser.profiles.service.catalog(principal, { computerId, limit: 100 })
        const present = catalog.presentReplicas.some(value => value.profileId === profileId)
        const localOnly = profile.profile.distribution === 'local_only' && profile.profile.sourceComputerId !== computerId
        items.push(present ? item(`browser-profile:${profileId}`, 'ready', `Browser profile ${profile.profile.name} is available.`)
          : item(`browser-profile:${profileId}`, 'missing', localOnly
            ? `Browser profile ${profile.profile.name} is local to another computer. Select another profile or change its distribution.`
            : `Browser profile ${profile.profile.name} needs setup on this computer.`, !localOnly))
      } catch (error) { items.push(item(`browser-profile:${profileId}`, 'unknown', `Could not check browser profile: ${errorText(error)}`)) }
    }
  }
  if (input.action === 'fix') {
    const failures: RunRequirement[] = []
    for (const need of items.filter(value => value.state === 'missing' && value.fixable)) {
      try {
        if (need.id === 'worker') await maintenance(services, principal, target, { kind: 'update-worker' })
        else if (need.id === 'harness') await maintenance(services, principal, target, { kind: 'update-harnesses', harnesses: [input.harness] })
        else if (need.id === 'mcp') await repairManagedMcp(services, principal, target, input.harness)
        else if (need.id === 'browser') await maintenance(services, principal, target, { kind: 'repair-browser' })
        else if (need.id === 'project') {
          if (!services.sources) throw new Error('Workspace folder setup is unavailable.')
          const result = await services.sources.setupRoot(principal, 'http', {
            workspaceId: input.workspaceId, hostRef: target.hostRef, commandId: randomUUID(),
          })
          if (result.value.kind !== 'plain') throw new Error('Choose the project location on this computer.')
        }
        else if (need.id.startsWith('profile:')) {
          if (!services.harnessInstances || !services.harnessRegistry) throw new Error('Harness profile setup is unavailable.')
          const agent = selected.find(value => value.id === need.id.slice('profile:'.length))
          const configuration = agent?.harnessConfiguration
          if (!configuration || configuration.harness !== input.harness) throw new Error('Agent configuration is unavailable.')
          const profile = profiles?.find(value => value.enabled && value.driverId === input.harness
            && (agent?.placementInstanceId ? value.instanceId === agent.placementInstanceId
              && value.instanceRevision === agent.placementInstanceRevision
              : agent?.selection ? value.instanceId === agent.selection.instanceId
                && value.instanceRevision === agent.selection.instanceRevision && sameWorkflowValue(value.target, agent.selection.target)
                : true)
            && sameWorkflowValue(withAdvancedDefaults(value.configuration), withAdvancedDefaults(configuration)))
          if (profile) {
            await services.harnessInstances.check(principal, 'http', { commandId: randomUUID(), instanceId: profile.instanceId,
              expectedRevision: profile.revision, target: profile.target })
          } else {
            const registry = await services.harnessRegistry.get(principal, target.hostRef)
            const installation = registry.installations.find(value => value.driverId === input.harness && value.installed && value.installationFingerprint)
            if (!installation?.installationFingerprint) throw new Error('The installed harness is not yet available in computer inventory. Refresh and retry.')
            const hostTarget = { hostRef: target.hostRef, applicationInstallationId: target.applicationInstallationId,
              harnessInstallationId: installation.harnessInstallationId, installationFingerprint: installation.installationFingerprint }
            if (target.hostRef.kind === 'device') {
              await services.harnessInstances.prepareWorkerConfiguration(principal, 'http', configuration, hostTarget)
            } else {
              await services.harnessInstances.save(principal, 'http', { commandId: randomUUID(), instanceId: randomUUID(),
                expectedRevision: 0, target: hostTarget, presetId: `run-setup:${input.harness}`, enabled: true, configuration })
            }
          }
        }
        else if (need.id.startsWith('browser-profile:') && services.browser) {
          const profileId = need.id.slice('browser-profile:'.length)
          const profile = await services.browser.profiles.service.get(principal, profileId)
          await services.browser.profiles.service.addExisting(principal, { profileId, computerId,
            commandId: randomUUID(), expectedRevision: profile.profile.revision })
          await services.browser.profiles.service.prepareReplica(profileId, computerId)
        }
      } catch (error) { failures.push(item(need.id, 'missing', `${need.message} ${errorText(error)}`, true)) }
    }
    const checked = await runRequirements(services, principal, { ...input, action: 'check' }, checkClaude)
    for (const failure of failures) {
      const index = checked.items.findIndex(value => value.id === failure.id)
      if (index >= 0 && checked.items[index]?.state !== 'ready') checked.items[index] = failure
      else if (index < 0) checked.items.push(failure)
    }
    return RunRequirementsResultSchema.parse(checked)
  }
  return RunRequirementsResultSchema.parse({ target, items })
}

export function registerRunRequirementsRoutes(app: FastifyInstance, services: OperatorServices): void {
  app.post('/api/management/computers/run-requirements', request =>
    runRequirements(services, requirePrincipal(request), RunRequirementsInputSchema.parse(request.body)))
}
