import { expect, it } from 'vitest'
import { fakeComputer, fakeFleet } from '../../../test/helpers/fleetSync.js'

it('repairs requirements on Main and paired computers and retries a failed computer', async () => {
  let now = 1_000_000
  const { fleet, sources, registrations } = fakeFleet(fakeComputer(), () => now)
  const repaired = new Set<string>()
  let workerOffline = true
  Object.assign(sources, { runRequirementsRepair: async (target: { hostRef: { kind: string }; applicationInstallationId: string }) => {
    if (target.hostRef.kind === 'device' && workerOffline) throw new Error('Worker offline')
    repaired.add(target.applicationInstallationId)
  } })

  await expect(fleet.syncChangedSources()).rejects.toThrow('Some computer requirements could not be repaired.')
  expect(repaired.has(registrations[0]!.mainId)).toBe(true)
  expect(repaired.has(registrations[0]!.workerInstallationId)).toBe(false)

  workerOffline = false
  now += 5 * 60_000
  await fleet.syncChangedSources()
  expect(repaired.has(registrations[0]!.workerInstallationId)).toBe(true)
})
