import type { CiRunRecord } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { smallCiRun } from '../src/computerCapabilities.js'

const run = (fields: Partial<CiRunRecord>) => ({ suite: 'integration', scope: 'affected', files: ['a.integration.test.ts'],
  expectedDurationMs: 120_000, ...fields }) as CiRunRecord

it('sends selections with at most one cloud setup of tests to a build computer and everything larger to the cloud', () => {
  expect(smallCiRun(run({}))).toBe(true)
  expect(smallCiRun(run({ suite: 'unit' }))).toBe(true)
  expect(smallCiRun(run({ expectedDurationMs: 181_000 }))).toBe(false)
  expect(smallCiRun(run({ expectedDurationMs: undefined }))).toBe(false)
  expect(smallCiRun(run({ gate: true }))).toBe(false)
  expect(smallCiRun(run({ scope: 'full' }))).toBe(false)
  expect(smallCiRun(run({ deriveFiles: true }))).toBe(false)
  expect(smallCiRun(run({ suite: 'typecheck' }))).toBe(false)
})
