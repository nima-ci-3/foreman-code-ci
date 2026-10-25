import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const script = resolve(import.meta.dirname, 'eslint-closure-cache.mjs')

/** A package whose "ESLint" records the files it is asked to lint and fails when a file says so. */
function project() {
  const directory = mkdtempSync(join(tmpdir(), 'eslint-closure-'))
  mkdirSync(join(directory, 'node_modules/eslint/bin'), { recursive: true })
  mkdirSync(join(directory, 'src'))
  writeFileSync(join(directory, 'node_modules/eslint/bin/eslint.js'), `
    const { appendFileSync, readFileSync } = require('node:fs')
    const files = process.argv.slice(2).filter(argument => argument.endsWith('.ts'))
    appendFileSync(${JSON.stringify(join(directory, 'linted.log'))}, JSON.stringify(files.map(file => file.replace(/^src\\//, '')).sort()) + '\\n')
    process.exit(files.some(file => readFileSync(file, 'utf8').includes('LINT_ERROR')) ? 1 : 0)`)
  writeFileSync(join(directory, 'package.json'), '{"name":"closure-fixture"}')
  writeFileSync(join(directory, 'src/types.ts'), 'export type Shape = { a: string }\n')
  writeFileSync(join(directory, 'src/user.ts'), "import type { Shape } from './types.js'\nexport const value: Shape = { a: '' }\n")
  writeFileSync(join(directory, 'src/alone.ts'), 'export const alone = 1\n')
  const lint = () => {
    const result = spawnSync(process.execPath, [script, '--max-warnings', '0'], { cwd: directory, encoding: 'utf8' })
    const log = (() => { try { return readFileSync(join(directory, 'linted.log'), 'utf8') } catch { return '' } })()
    rmSync(join(directory, 'linted.log'), { force: true })
    return { status: result.status, linted: log.trim().split('\n').filter(Boolean).flatMap(line => JSON.parse(line)).sort() }
  }
  return { directory, lint, write: (file, value) => writeFileSync(join(directory, 'src', file), value),
    close: () => rmSync(directory, { recursive: true, force: true }) }
}

test('lints every file once, then only files whose own text or imported files changed', () => {
  const fixture = project()
  try {
    assert.deepEqual(fixture.lint(), { status: 0, linted: ['alone.ts', 'types.ts', 'user.ts'] })
    assert.deepEqual(fixture.lint(), { status: 0, linted: [] })
    // A type the user file imports changed: a typed rule may now judge the user file differently.
    fixture.write('types.ts', 'export type Shape = { a: number }\n')
    assert.deepEqual(fixture.lint(), { status: 0, linted: ['types.ts', 'user.ts'] })
  } finally { fixture.close() }
})

test('a failed lint records no pass, so the failing file is linted again', () => {
  const fixture = project()
  try {
    fixture.write('alone.ts', 'export const alone = 1 // LINT_ERROR\n')
    assert.equal(fixture.lint().status, 1)
    assert.deepEqual(fixture.lint(), { status: 1, linted: ['alone.ts', 'types.ts', 'user.ts'] })
  } finally { fixture.close() }
})
