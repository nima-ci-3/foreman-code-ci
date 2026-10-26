import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { auditCachedFiles } from './ci-cache-audit.mjs'

const esbuild = createRequire(new URL('../apps/worker/package.json', import.meta.url))('esbuild')

test('flags a cached file whose real imports changed since its proof, and only that file', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ci-cache-audit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
  git('init', '-q'); git('config', 'user.email', 'audit@example.com'); git('config', 'user.name', 'audit')
  write('src/helper.mjs', 'export const helper = 1')
  write('src/other.mjs', 'export const other = 1')
  // A computed-looking but literal dynamic import is still an import the bundle follows.
  write('test/uses-helper.test.mjs', "import { helper } from '../src/helper.mjs'\nexport const value = helper")
  write('test/lazy.test.mjs', "export const load = () => import('../src/helper.mjs')")
  write('test/unrelated.test.mjs', "import { other } from '../src/other.mjs'\nimport 'node:fs'\nimport 'zod'\nexport const value = other")
  git('add', '-A'); git('commit', '-qm', 'proof')
  const proof = git('rev-parse', 'HEAD')
  write('src/helper.mjs', 'export const helper = 2')
  git('commit', '-qam', 'edit helper')
  const commit = git('rev-parse', 'HEAD')
  const result = await auditCachedFiles({ root, commit, esbuild, cached: ['test/uses-helper.test.mjs', 'test/lazy.test.mjs',
    'test/unrelated.test.mjs'].map(file => ({ file, commit: proof })) })
  assert.deepEqual(result.unbundled, [])
  assert.equal(result.checked, 3)
  assert.deepEqual(result.stale.map(({ file, changed }) => ({ file, changed })).sort((a, b) => a.file.localeCompare(b.file)), [
    { file: 'test/lazy.test.mjs', changed: ['src/helper.mjs'] },
    { file: 'test/uses-helper.test.mjs', changed: ['src/helper.mjs'] },
  ])
})
