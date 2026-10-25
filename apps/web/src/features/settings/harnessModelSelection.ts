import { ClaudeEffortSchema, type HarnessConfiguration, type AgentEffort } from '@foreman-code/contracts'
import type { HarnessOptions } from '@foreman-code/contracts/management'

type CatalogModel = HarnessOptions['models'][number]
/** What a model picker needs from a native catalog entry; the effort and tier lists may be absent from a partial one. */
type PickedModel = Pick<CatalogModel, 'id'> & Partial<Pick<CatalogModel, 'reasoningEfforts' | 'serviceTiers'>>

const knownEfforts = new Set<string>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
type EffortList = { reasoningEfforts?: readonly string[] | undefined }
export function supportedEfforts(model: EffortList | undefined): AgentEffort[] {
  return (model?.reasoningEfforts ?? []).filter((effort): effort is AgentEffort => knownEfforts.has(effort))
}
/** The efforts a Claude model offers; unknown models offer none, so no effort is ever invented. */
export function claudeEfforts(model: EffortList | undefined) {
  return (model?.reasoningEfforts ?? []).flatMap(effort => {
    const parsed = ClaudeEffortSchema.safeParse(effort)
    return parsed.success ? [parsed.data] : []
  })
}
/** Efforts and Fast mode for the harness's selected model; an unknown model offers neither. */
export function modelCapabilities(harness: 'codex' | 'claude', model: PickedModel | undefined) {
  const efforts: readonly string[] = harness === 'codex' ? supportedEfforts(model) : claudeEfforts(model)
  return { efforts, fastSupported: harness === 'codex' && model?.serviceTiers?.includes('priority') === true }
}
/** Keep the Claude effort when the new model offers it, else medium, else the first effort it does offer. */
export function claudeEffortForModel(model: PickedModel, current: string | undefined) {
  const efforts = claudeEfforts(model)
  return efforts.find(effort => effort === current) ?? efforts.find(effort => effort === 'medium') ?? efforts[0]
}
/** Keep the Codex effort and tier when the new model offers them; otherwise medium (or its first effort) and standard. */
export function codexSelectionForModel<Effort extends AgentEffort, Tier extends string>(model: PickedModel, current: { reasoningEffort: Effort; serviceTier: Tier }) {
  const efforts = supportedEfforts(model)
  // No guess when a catalog has an unknown effort: validation will report the preserved selection.
  return {
    reasoningEffort: efforts.includes(current.reasoningEffort) ? current.reasoningEffort
      : efforts.includes('medium') ? 'medium' as const : efforts[0] ?? current.reasoningEffort,
    serviceTier: model.serviceTiers?.includes(current.serviceTier) ? current.serviceTier : 'standard' as const,
  }
}
export function selectNativeModel(configuration: HarnessConfiguration, model: PickedModel): HarnessConfiguration {
  if (configuration.harness === 'claude') return { ...configuration, model: model.id, effort: claudeEffortForModel(model, configuration.effort) }
  return { ...configuration, model: model.id, ...codexSelectionForModel(model, configuration) }
}
export function nativeOptionsWithSaved(values: readonly string[], saved: string, emptyLabel = 'Native default') {
  const choices = [...new Set(values)].map((value) => ({ value, label: value || emptyLabel, disabled: false }))
  if (!choices.some((item) => item.value === saved)) choices.unshift({ value: saved, label: `${saved || emptyLabel} · saved, unavailable`, disabled: true })
  return choices
}
