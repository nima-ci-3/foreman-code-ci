import { requiresUserSystemd, type CiRunRecord } from '@foreman-code/contracts'
import type { HostCiComputer } from './service.js'

export function isGitHubComputer(computer: HostCiComputer): boolean {
  return computer.hostRef.kind === 'cloud' && computer.hostRef.provider === 'github'
}

/** Free builders first, then GitHub Actions before paid cloud capacity. */
export function ciComputerPreference(computer: HostCiComputer): number {
  return computer.hostRef.kind !== 'cloud' ? 3 : isGitHubComputer(computer) ? 2 : 1
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
