import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { obsoleteSuiteStateCaches, pruneSuiteState, recordSuiteState, suiteStateChanged } from './ci-suite-state.mjs'

const ref = 'refs/heads/main'
const state = id => ({ id, ref, key: `suite-state-v2-linux-packages-${id}`,
  created_at: new Date(id * 1000).toISOString() })

test('suite cache retention keeps the newest three across dependency versions and preserves unrelated caches', () => {
  const caches = [state(2), state(5), state(1), state(4), state(3),
    { ...state(7), key: 'packages-v2-linux-dependencies' },
    { ...state(8), ref: 'refs/heads/feature' }]
  assert.deepEqual(obsoleteSuiteStateCaches(caches, ref).map(cache => cache.id), [2, 1])
  assert.deepEqual(obsoleteSuiteStateCaches([state(1)], ref), [])
})

test('suite cache cleanup consumes every API page and deletes only obsolete suite entries', () => {
  const deleted = []
  const gh = args => {
    if (args.includes('DELETE')) {
      deleted.push(Number(args.at(-1).split('/').at(-1)))
      return ''
    }
    const url = new URL(args.at(-1), 'https://api.github.com/')
    assert.equal(url.searchParams.get('ref'), ref)
    assert.equal(url.searchParams.get('key'), 'suite-state-')
    return JSON.stringify([{ actions_caches: [state(5), state(4)] },
      { actions_caches: [state(3), state(2), state(1), { ...state(9), key: 'pnpm-store-v2-linux' }] }])
  }
  assert.equal(pruneSuiteState('fixture/ci', ref, gh), 2)
  assert.deepEqual(deleted, [2, 1])
})

test('suite caches upload only when compiler or linter state changes', t => {
  const root = mkdtempSync(join(tmpdir(), 'suite-state-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cache = join(root, 'apps/api/node_modules/.cache')
  mkdirSync(join(cache, 'tsc'), { recursive: true })
  mkdirSync(join(cache, 'eslint'), { recursive: true })
  mkdirSync(join(root, 'packages'))
  writeFileSync(join(cache, 'tsc/check.tsbuildinfo'), 'compiler state')
  recordSuiteState(root)
  assert.equal(suiteStateChanged(root), false)
  writeFileSync(join(cache, 'tsc/check.tsbuildinfo'), 'compiler state')
  writeFileSync(join(root, 'README.md'), 'Documentation does not change the checks.')
  assert.equal(suiteStateChanged(root), false)
  writeFileSync(join(cache, 'eslint/passes.json'), '{"checked":true}')
  assert.equal(suiteStateChanged(root), true)
  recordSuiteState(root)
  assert.equal(suiteStateChanged(root), false)
  writeFileSync(join(cache, 'tsc/check.tsbuildinfo'), 'new compiler state')
  assert.equal(suiteStateChanged(root), true)
})
