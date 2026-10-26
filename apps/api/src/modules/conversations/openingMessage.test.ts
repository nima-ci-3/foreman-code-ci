import { describe, expect, it } from 'vitest'
import { openingMessage } from './executionActivity.js'

const task = 'Review the changes. TRUSTED WORKFLOW EXECUTION CONTEXT is a heading in the document.'
const result = (latestDeliverable: unknown) => ({ routing: { kind: 'finish' }, summary: 'Internal summary',
  board: { kind: 'none', reason: 'no_changes' }, data: { latestDeliverable, remainingFindings: [] } })
const handoff = (output: unknown, handoffTask: unknown = null) => ({ initial_prompt: 'Node prompt',
  handoff_kind: 'work_request', handoff_task: handoffTask, handoff_output: output })

describe('openingMessage', () => {
  it('shows the node prompt when the execution was not handed over', () => {
    expect(openingMessage({ initial_prompt: 'Node prompt', handoff_kind: null, handoff_task: null, handoff_output: null }))
      .toBe('Node prompt')
    expect(openingMessage({ initial_prompt: null, handoff_kind: null, handoff_task: null, handoff_output: null })).toBe('')
  })

  it('shows the task text another Agent handed over, in every result shape', () => {
    expect(openingMessage(handoff(result(task)))).toBe(task)
    expect(openingMessage(handoff(result({ task, internal: 'private metadata' })))).toBe(task)
    expect(openingMessage(handoff({ text: JSON.stringify(result(task)) }))).toBe(task)
    expect(openingMessage(handoff(JSON.stringify(result(task))))).toBe(task)
  })

  it('prefers a delegated task over the parent result', () => {
    expect(openingMessage(handoff(result('Parent report'), { data: { task } }))).toBe(task)
    expect(openingMessage(handoff(result('Parent report'), { data: task }))).toBe(task)
  })

  it('shows nothing for a hand-off without task text', () => {
    expect(openingMessage(handoff(result({ private: 'no task text' })))).toBe('')
    expect(openingMessage(handoff(result('Parent report'), { data: null }))).toBe('')
    expect(openingMessage(handoff({ text: 'not json' }))).toBe('')
  })
})
