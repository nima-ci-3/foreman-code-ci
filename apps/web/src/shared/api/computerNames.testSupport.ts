import type { QueryClient } from '@tanstack/react-query'
import type { ComputerActivityList } from '@foreman-code/contracts/computer-activity'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { sessionGeneration } from './sessionBoundary'

/** Puts named computers in the cached computer list that useComputerName reads. */
export function seedComputerNames(client: QueryClient, mainId: string,
  computers: { hostRef: DeviceProvisioningTarget['hostRef']; name: string }[]): void {
  const list: ComputerActivityList = { mainId, cloud: [], truncated: false, activityComplete: true,
    computers: computers.map(({ hostRef, name }) => ({ target: { hostRef, applicationInstallationId: '00000000-0000-4000-8000-000000000000',
      keyRevision: null, authorizationRevision: null }, online: true, name, jobs: [], agents: [] })) }
  client.setQueryData(['computer-activity', sessionGeneration()], list)
}
