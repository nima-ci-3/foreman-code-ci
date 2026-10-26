import { expect, it } from 'vitest'
import { planCiGate } from '../src/gate.js'
import type { HostCiComputer, HostCiEndpoint } from '../src/serviceTypes.js'
import { testCiContext } from './helpers/ciContext.js'

function fleet(builder = true): HostCiEndpoint {
  const computers: HostCiComputer[] = [
    ...(builder ? [{ key: 'builder', label: 'Build computer', priority: 10, hostRef: { kind: 'main' as const, mainId: 'fixture' } }] : []),
    ...Array.from({ length: 14 }, (_, slot) => ({ key: `github:${slot}`, label: `GitHub ${slot}`, priority: 30,
      hostRef: { kind: 'cloud' as const, mainId: 'fixture', provider: 'github' as const, slot },
      userSystemd: { supported: true, reason: null } })),
  ]
  return { computers: async () => computers,
    request: async computer => ({ operation: 'status', ready: true, reasons: [], runs: [],
      cpuCount: computer.hostRef.kind === 'cloud' ? 4 : 5, memoryBytes: 16 * 2 ** 30,
      slotsUsed: 0, slotsTotal: 1 }),
  }
}

// Enough measured unit work to give every cloud slot a check before integration starts.
const unitFiles = Array.from({ length: 32 }, (_, file) => `apps/api/src/feature-${file}.test.ts`)
const unit = { files: unitFiles, durations: Object.fromEntries(unitFiles.map(file => [file, 50_000]))}

it.each([0, 2])('balances a second integration wave after checks with %i reserved slots', async reserved => {
  const files = Array.from({ length: 901 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const parts = await planCiGate(testCiContext, { suite: 'integration', scope: 'full', gate: true },
    { files, durations: Object.fromEntries(files.map(file => [file, 30_000])) }, unit, {}, fleet(), new Map(), reserved)
  const integration = parts.filter(part => part.suite === 'integration')
  const checks = parts.filter(part => part.suite !== 'integration')
  const clouds = integration.filter(part => part.plannedHostKey.startsWith('github:'))
  expect(clouds.map(part => part.plannedHostKey).sort()).toEqual(
    Array.from({ length: 14 - reserved }, (_, slot) => `github:${slot}`).sort())
  expect(parts.every(part => part.plannedHostKey.startsWith('github:'))).toBe(true)
  expect(integration.flatMap(part => part.files).sort()).toEqual([...files].sort())
  const ends = integration.map(part => {
    const backlog = checks.filter(check => check.plannedHostKey === part.plannedHostKey)
      .reduce((sum, check) => sum + check.expectedDurationMs, 0)
    if (part.plannedHostKey.startsWith('github:')) expect(backlog).toBeGreaterThan(0)
    // Each integration ticket pays for its own boot; check time belongs only to the earlier tickets.
    expect(part.expectedDurationMs).toBe(90_000 + Math.ceil(part.files.length / part.integrationShards!) * 30_000)
    return backlog + part.expectedDurationMs
  })
  expect(Math.max(...ends) - Math.min(...ends)).toBeLessThanOrEqual(30_000)
  expect(Math.max(...ends)).toBeLessThan((90_000 + Math.ceil(files.length / 5) * 30_000) / 2)
})

it('keeps a gate on cloud even when its remaining integration work is small', async () => {
  const files = ['apps/api/test/first.integration.test.ts', 'apps/api/test/second.integration.test.ts']
  const parts = await planCiGate(testCiContext, { suite: 'integration', scope: 'full', gate: true },
    { files, durations: Object.fromEntries(files.map(file => [file, 10_000])) }, unit, {}, fleet())
  const integration = parts.filter(part => part.suite === 'integration')
  expect(integration).toHaveLength(1)
  expect(parts.every(part => part.plannedHostKey.startsWith('github:'))).toBe(true)
  expect(integration[0]).toMatchObject({ expectedDurationMs: 100_000 })
  expect(parts.filter(part => part.suite !== 'integration'
    && part.plannedHostKey === integration[0]!.plannedHostKey).length).toBeGreaterThan(0)
  expect(integration[0]!.files.sort()).toEqual([...files].sort())
})

it('prefers cloud behind checks even when a builder would shorten the gate from 420 to 270 seconds', async () => {
  // The builder and one cloud slot per check (typecheck, lint and unit for the API and the rest).
  const computers = (await fleet().computers()).slice(0, 7)
  const endpoint: HostCiEndpoint = { computers: async () => computers,
    request: async () => ({ operation: 'status', ready: true, reasons: [], runs: [],
      cpuCount: 4, memoryBytes: 16 * 2 ** 30, slotsUsed: 0, slotsTotal: 1 }),
  }
  const files = ['apps/api/test/first.integration.test.ts', 'apps/api/test/second.integration.test.ts']
  const parts = await planCiGate(testCiContext, { suite: 'integration', scope: 'full', gate: true },
    { files, durations: Object.fromEntries(files.map(file => [file, 180_000])) },
    { files: ['apps/api/src/feature.test.ts', 'apps/web/src/feature.test.ts'], durations: {}}, {}, endpoint)
  const checks = parts.filter(part => part.suite !== 'integration')
  expect(checks).toHaveLength(6)
  expect(new Set(checks.map(part => part.plannedHostKey)).size).toBe(6)
  const ends = computers.map(computer => parts.filter(part => part.plannedHostKey === computer.key)
    .reduce((sum, part) => sum + part.expectedDurationMs, 0))
  expect(Math.max(...ends)).toBe(420_000)
  const integration = parts.filter(part => part.suite === 'integration')
  expect(integration).toHaveLength(1)
  expect(parts.every(part => part.plannedHostKey.startsWith('github:'))).toBe(true)
  expect(integration[0]).toMatchObject({ expectedDurationMs: 270_000, integrationShards: 4 })
  expect(checks.filter(part => part.plannedHostKey === integration[0]!.plannedHostKey)
    .reduce((sum, part) => sum + part.expectedDurationMs, 0)).toBe(150_000)
  expect(integration[0]!.files.sort()).toEqual([...files].sort())
})

it('keeps gate work on cloud despite optimistic builder throughput and recent builder slowdowns', async () => {
  const computers: HostCiComputer[] = [
    { key: 'builder-first', label: 'First builder', priority: 10,
      hostRef: { kind: 'main', mainId: 'fixture' } },
    { key: 'builder-second', label: 'Second builder', priority: 10,
      hostRef: { kind: 'device', mainId: 'fixture', deviceId: 'paired-fixture' } },
    // One cloud slot per check, so integration must wait for cloud checks to finish.
    ...(await fleet().computers()).slice(1, 7),
  ]
  const endpoint: HostCiEndpoint = { computers: async () => computers,
    request: async computer => ({ operation: 'status', ready: true, reasons: [], runs: [],
      cpuCount: computer.hostRef.kind === 'cloud' ? 4 : 8, memoryBytes: 16 * 2 ** 30,
      slotsUsed: 0, slotsTotal: 1 }),
  }
  const files = Array.from({ length: 8 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  // Both builders could take four files in a typical 150s, but recently took 600s and 660s.
  const speeds = new Map([
    ['builder-first', { factor: 1, throughput: 2, conservativeThroughput: 0.4 }],
    ['builder-second', { factor: 1, throughput: 2, conservativeThroughput: 4 / 11 }],
  ])
  const parts = await planCiGate(testCiContext, { suite: 'integration', scope: 'full', gate: true },
    { files, durations: Object.fromEntries(files.map(file => [file, 60_000])) },
    { files: ['apps/api/src/feature.test.ts', 'apps/web/src/feature.test.ts'], durations: {}},
    {}, endpoint, speeds)
  const ends = computers.map(computer => parts.filter(part => part.plannedHostKey === computer.key)
    .reduce((sum, part) => sum + part.expectedDurationMs, 0))
  expect(Math.max(...ends)).toBe(300_000)
  const integration = parts.filter(part => part.suite === 'integration')
  expect(integration.flatMap(part => part.files).sort()).toEqual([...files].sort())
  expect(parts.every(part => part.plannedHostKey.startsWith('github:'))).toBe(true)
  expect(integration).toHaveLength(4)
  expect(new Set(integration.map(part => part.plannedHostKey)).size).toBe(4)
  for (const part of integration) {
    expect(part.files).toHaveLength(2)
    expect(part).toMatchObject({ expectedDurationMs: 150_000, integrationShards: 4 })
    expect(parts.filter(check => check.suite !== 'integration' && check.plannedHostKey === part.plannedHostKey)
      .reduce((sum, check) => sum + check.expectedDurationMs, 0)).toBe(150_000)
  }
})

it('plans every check and integration file on cloud executors when no build computer takes CI', async () => {
  const files = Array.from({ length: 120 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const parts = await planCiGate(testCiContext, { suite: 'integration', scope: 'full', gate: true },
    { files, durations: Object.fromEntries(files.map(file => [file, 30_000])) }, unit, {}, fleet(false))
  expect(parts.every(part => part.plannedHostKey.startsWith('github:'))).toBe(true)
  expect(parts.filter(part => part.suite === 'integration').flatMap(part => part.files).sort()).toEqual([...files].sort())
  expect(new Set(parts.map(part => part.suite))).toEqual(new Set(['typecheck', 'lint', 'unit', 'integration']))
})
