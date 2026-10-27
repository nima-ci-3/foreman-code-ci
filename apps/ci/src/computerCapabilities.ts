import { requiresUserSystemd, type CiRunRecord } from '@foreman-code/contracts'
import type { HostCiComputer } from './service.js'

export function isGitHubComputer(computer: HostCiComputer): boolean {
  return computer.hostRef.kind === 'cloud' && computer.hostRef.provider === 'github'
}

/** GitHub Actions slots are used before CircleCI and build computers. */
export function ciComputerPreference(computer: HostCiComputer): number {
  return isGitHubComputer(computer) ? 3 : computer.hostRef.kind === 'cloud' ? 2 : 1
}

export function supportsUserSystemd(computer: HostCiComputer): boolean {
  return computer.hostRef.kind !== 'cloud' || computer.userSystemd?.supported === true
}

export function needsSystemdExecutor(run: CiRunRecord): boolean {
  if (run.requiresBuildComputer !== undefined) return run.requiresBuildComputer
  return run.suite === 'integration' && (run.partition
    ? run.partition.hostIndexes?.includes(run.partition.index) === true
    : run.scope === 'full' || Boolean(run.deriveFiles) || run.files.some(requiresUserSystemd))
}

/** The setup a cloud part pays before its tests (checkout, install, build); planned part durations include it. */
const CLOUD_SETUP_MS = 90_000

/** A selection whose measured test time is at most one cloud setup finishes sooner on a build computer, whose checkout
 * and install are warm; larger work goes to the cloud. */
export function smallCiRun(run: CiRunRecord): boolean {
  const testDurationMs = run.selectionDurationMs
    ?? (run.partition ? Infinity : (run.expectedDurationMs ?? Infinity) - CLOUD_SETUP_MS)
  return !run.gate && run.scope === 'affected' && !run.deriveFiles && (run.suite === 'unit' || run.suite === 'integration')
    && testDurationMs <= CLOUD_SETUP_MS
}

/** Plain words for where a ticket went and why, kept on the ticket so a surprising placement can be explained. */
export function ciPlacementReason(run: CiRunRecord, computer: HostCiComputer): string {
  if (run.gate) return `Gate part planned for ${computer.label}.`
  const time = run.selectionDurationMs !== undefined
    ? `${(run.selectionDurationMs / 1000).toFixed(1)} s of measured tests`
    : run.expectedDurationMs !== undefined
      ? `no measured durations; estimated ${Math.round(Math.max(0, run.expectedDurationMs - CLOUD_SETUP_MS) / 1000)} s`
      : 'no duration estimate'
  const small = smallCiRun(run)
  if (computer.hostRef.kind !== 'cloud') return small ? `Small ${run.suite} run (${time}): build computers take it first.`
    : `Not a small ${run.suite} run (${time}), but no cloud executor could take it.`
  return small ? `Small ${run.suite} run (${time}), but no build computer was free.`
    : `Not a small ${run.suite} run (${time}); larger work goes to the cloud.`
}
