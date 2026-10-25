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
