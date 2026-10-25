import { useRef } from 'react'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { TelemetryStorage } from '@foreman-code/contracts/resource-telemetry'
import { useComputerUtilization } from '../../shared/api/computerActivity'
import { useMonotonicElapsed } from '../resource-telemetry'
import { readComputerSample, storageUsedPercent } from './computerSampleReadings'

/** How long the last current reading may stand in, dimmed, for a late refresh. */
const LAST_KNOWN_MS = 60_000

type Held<T> = { value: T; at: number } | null

export interface ComputerReadings {
  /** Current values, or the last current ones while a refresh is late; null when unknown. */
  cpu: number | null
  memory: number | null
  storage: TelemetryStorage | null
  storageUsedPercent: number | null
  /** True when the value shown is the held last-known reading, not a current one. */
  stale: { cpu: boolean; memory: boolean; storage: boolean }
  reasons: { cpu: string; memory: string }
  pending: boolean
}

/** CPU, memory and disk of one computer from its live telemetry. */
export function useComputerReadings(target: DeviceProvisioningTarget, online: boolean): ComputerReadings {
  const query = useComputerUtilization(target, online)
  // A slow or failed refresh keeps the previous reading; its own deadline decides what is current.
  const received = online ? query.data : null
  const elapsed = useMonotonicElapsed(received?.receivedMonoMs)
  const result = received?.result
  const sample = result?.kind === 'sample' ? result.sample : undefined
  const age = elapsed + (received?.requestDurationMs ?? 0)
  const { cpuPercent, memoryPercent, storage, cpuLabel, memoryLabel } = readComputerSample(sample, age)
  // Between readings each metric holds its own last current value, marked stale, rather than flickering to empty.
  const now = Date.now(), last = useRef<{ cpu: Held<number>; memory: Held<number>; storage: Held<TelemetryStorage> }>({ cpu: null, memory: null, storage: null })
  if (cpuPercent !== null) last.current.cpu = { value: cpuPercent, at: now }
  if (memoryPercent !== null) last.current.memory = { value: memoryPercent, at: now }
  if (storage) last.current.storage = { value: storage, at: now }
  const hold = <T,>(item: Held<T>) => online && item && now - item.at < LAST_KNOWN_MS ? item.value : null
  const shownStorage = storage ?? hold(last.current.storage)
  return {
    cpu: cpuPercent ?? hold(last.current.cpu),
    memory: memoryPercent ?? hold(last.current.memory),
    storage: shownStorage,
    storageUsedPercent: storageUsedPercent(shownStorage),
    stale: { cpu: cpuPercent === null, memory: memoryPercent === null, storage: !storage },
    reasons: { cpu: cpuLabel, memory: memoryLabel },
    pending: online && query.isPending,
  }
}
