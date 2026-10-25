import type { TelemetrySample, TelemetryStorage } from '@foreman-code/contracts/resource-telemetry'
import { metricView, sampleClock } from '../resource-telemetry'

export function storageUsedPercent(storage: TelemetryStorage | null): number | null {
  return storage?.totalBytes ? (storage.totalBytes - storage.availableBytes) / storage.totalBytes * 100 : null
}

/**
 * The one derivation of what a computer's telemetry sample shows at a given age. A metric counts as current only
 * while its own deadline holds; the raw values stay available so callers can keep them as last known.
 */
export function readComputerSample(sample: TelemetrySample | undefined, age: number) {
  const cpuView = sample && metricView('CPU', sample, age)
  const memoryView = sample && metricView('RAM', sample, age)
  const cpu = sample?.cpu.state === 'fresh' ? sample.cpu.value : null
  const memory = sample?.memory.state === 'fresh' ? sample.memory.value : null
  const cpuPercent = cpuView?.status === 'fresh' ? cpu?.hostCapacityPercent ?? null : null
  const memoryPercent = memoryView?.status === 'fresh' && memory?.totalBytes ? memory.bytes / memory.totalBytes * 100 : null
  const storage = sample?.storage && sample.presence === 'online' && sampleClock(sample, age).freshRemainingMs > 0
    ? sample.storage : null
  return { cpu, memory, cpuPercent, memoryPercent, storage,
    cpuLabel: cpuView?.statusLabel ?? 'Unavailable', memoryLabel: memoryView?.statusLabel ?? 'Unavailable' }
}
