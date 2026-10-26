import { CI_UNIT_SHARD_LIMIT, integrationPartition, requiresUserSystemd, type CiDurations, type CiPart, type CiPartition,
  type CiRunInput } from '@foreman-code/contracts'

export interface CiUnitInventory {
  files: string[]
  durations: CiDurations
}
interface PlannedPart {
  part: CiPart | null
  partition: CiPartition | null
  files: string[]
  expectedDurationMs?: number
  selectionDurationMs?: number
}

const UNIT_SETUP_MS = 90_000
const UNIT_TEST_TARGET_MS = 150_000

function unitFileDurations(files: string[], durations: CiDurations): CiDurations | undefined {
  const measured = files.map(file => durations[file])
    .filter((value): value is number => value !== undefined && Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right)
  if (!measured.length) return undefined
  const median = measured[Math.floor(measured.length / 2)]!
  return Object.fromEntries(files.map(file => {
    const value = durations[file]
    return [file, value !== undefined && Number.isFinite(value) && value > 0 ? value : median]
  }))
}

/** Aim for 150 seconds of measured test time per unit shard; unknown repositories use the default counts. */
function unitShardCount(files: string[], durations: CiDurations, slots: number) {
  const measured = unitFileDurations(files, durations)
  const fallback = 5
  if (!measured) return Math.min(fallback, files.length || fallback, Math.max(1, slots))
  const total = Object.values(measured).reduce((sum, duration) => sum + duration, 0)
  const limit = Math.min(CI_UNIT_SHARD_LIMIT, files.length, Math.max(1, slots))
  let count = Math.min(limit, Math.max(1, Math.ceil(total / UNIT_TEST_TARGET_MS)))
  while (count < limit) {
    const loads = Array.from({ length: count }, (_, index) =>
      integrationPartition(files, measured, { index, count })
        .reduce((sum, file) => sum + measured[file]!, 0))
    if (Math.max(...loads) <= UNIT_TEST_TARGET_MS) break
    count++
  }
  return count
}

export function planCiParts(input: CiRunInput, durations: CiDurations, inventory?: CiUnitInventory, slots = CI_UNIT_SHARD_LIMIT): PlannedPart[] {
  const unitDurations = { ...inventory?.durations, ...durations }
  const affected = (input.scope ?? 'affected') === 'affected' && input.files !== undefined
  const selected = affected ? [...new Set(input.files)].sort() : []
  if (affected && !selected.length) return [{ part: null, partition: null, files: [] }]
  const selectionDurations = input.suite === 'unit' && affected ? unitFileDurations(selected, unitDurations) : undefined
  const selectionDurationMs = selectionDurations
    ? Object.values(selectionDurations).reduce((sum, duration) => sum + duration, 0) : undefined
  if (input.suite === 'install' || input.suite === 'integration') {
    const mixed = input.suite === 'integration' && selected.some(requiresUserSystemd)
      && selected.some(file => !requiresUserSystemd(file))
    const requested = Math.max(input.partitions ?? 1, mixed ? 2 : 1)
    const count = affected ? Math.min(requested, selected.length) : requested
    return Array.from({ length: Math.max(1, count) }, (_, index) => ({ part: null,
      partition: count > 1 ? { index, count } : null, files: selected }))
  }
  const names: CiPart[] = input.suite === 'unit'
    ? ['unit-api', 'unit-other']
    : [`${input.suite}-api`, `${input.suite}-other`]
  const belongs = (file: string, part: CiPart) => part.endsWith('-api') === file.startsWith('apps/api/')
  return names.flatMap(part => {
    const files = selected.filter(file => belongs(file, part))
    if (affected && !files.length) return []
    const candidates = affected ? files : inventory?.files.filter(file => belongs(file, part)) ?? []
    const sharded = part === 'unit-api'
    if (!affected && inventory && sharded && !candidates.length) return []
    const count = sharded ? unitShardCount(candidates, unitDurations, slots) : 1
    const measured = input.suite === 'unit' ? unitFileDurations(candidates, unitDurations) : undefined
    return Array.from({ length: count }, (_, index) => {
      const partition = count > 1 ? { index, count } : null
      const slice = partition ? integrationPartition(candidates, measured ?? unitDurations, partition) : candidates
      const expectedDurationMs = measured
        ? UNIT_SETUP_MS + slice.reduce((sum, file) => sum + measured[file]!, 0) : undefined
      return { part, partition, files: affected ? slice : files,
        ...(selectionDurationMs !== undefined ? { selectionDurationMs } : {}),
        ...(expectedDurationMs !== undefined ? { expectedDurationMs } : {}) }
    })
  })
}

/** The unit part a test file runs in, as planCiParts splits it. */
export function unitPartOf(file: string): CiPart {
  return file.startsWith('apps/api/') ? 'unit-api' : 'unit-other'
}

/** CircleCI takes every suite except the Worker unit tests, which need podman. */
export function runsOnCircleCi(run: { part?: string | null | undefined }): boolean {
  return run.part !== 'unit-other'
}

export function ciGroupState(runs: readonly { state: string }[]) {
  for (const state of ['failed', 'lost', 'canceled', 'running', 'starting', 'queued', 'passed'] as const) {
    if (runs.some(run => run.state === state)) return state
  }
  return 'passed' as const
}
