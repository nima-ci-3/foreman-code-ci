import { expect, it } from 'vitest'
import { partialStructuredResult, structuredResult } from './structuredResult'

it('treats a result that is still streaming as unfinished, and a finished one as a result', () => {
  const partial = '{"data": {"latestDeliverable": {"orchestrator_action_status": "completed", "worker_task": "Navigate to'
  expect(partialStructuredResult(partial)).toBe(true)
  expect(partialStructuredResult('```json\n{"routing": {"kind": "fini')).toBe(true)
  const finished = '{"data": {"latestDeliverable": {}}, "summary": "Both screenshots captured."}'
  expect(partialStructuredResult(finished)).toBe(false)
  expect(structuredResult(finished)?.summary).toBe('Both screenshots captured.')
  expect(partialStructuredResult('Here is what I found: the page loaded.')).toBe(false)
  expect(partialStructuredResult('{ not a result')).toBe(false)
})
