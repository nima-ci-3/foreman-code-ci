import { expect, it } from 'vitest'
import { modelLabel } from './modelLabel'

it('names dated and undated Claude model ids', () => {
  expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(modelLabel('claude-opus-4-1')).toBe('Opus 4.1')
  expect(modelLabel('claude-sonnet-4-20250514')).toBe('Sonnet 4')
})

it('keeps other model ids as they are', () => {
  expect(modelLabel('gpt-6.1-sol')).toBe('gpt-6.1-sol')
  expect(modelLabel('haiku')).toBe('haiku')
})
