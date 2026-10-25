import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

const script = resolve(import.meta.dirname, 'eslint-closure-cache.mjs')

/** A package whose "ESLint" records the files it is asked to lint and fails when a file says so. */
function project(realLint = false) {
  const root = mkdtempSync(join(tmpdir(), 'eslint-closure-'))
  const directory = join(root, 'apps/api')
  mkdirSync(join(root, 'packages'))
  mkdirSync(join(root, 'scripts/eslint-plugin-foreman'), { recursive: true })
  copyFileSync(script, join(root, 'scripts/eslint-closure-cache.mjs'))
  writeFileSync(join(root, 'scripts/eslint-plugin-foreman/index.mjs'), 'export const rules = {}')
  writeFileSync(join(root, 'scripts/lint-allowlist.json'), '{}')
  writeFileSync(join(root, 'scripts/lint-allowlist.mjs'), 'export const allowlist = {}')
  writeFileSync(join(root, 'package.json'), '{"private":true}')
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0')
  mkdirSync(join(directory, 'node_modules/eslint/bin'), { recursive: true })
  writeFileSync(join(directory, 'node_modules/eslint/package.json'), '{"type":"commonjs"}')
  const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
  symlinkSync(dirname(require.resolve('typescript/package.json')), join(directory, 'node_modules/typescript'))
  mkdirSync(join(directory, 'src'))
  writeFileSync(join(directory, 'node_modules/eslint/bin/eslint.js'), `
    const { appendFileSync, readFileSync } = require('node:fs')
    const files = process.argv.slice(2).filter(argument => argument.endsWith('.ts'))
    appendFileSync(${JSON.stringify(join(directory, 'linted.log'))}, JSON.stringify(files.map(file => file.replace(/^src\\//, '')).sort()) + '\\n')
    process.exit(files.some(file => readFileSync(file, 'utf8').includes('LINT_ERROR')) ? 1 : 0)`)
  if (realLint) writeFileSync(join(directory, 'node_modules/eslint/bin/eslint.js'), `
    const { ESLint } = require(${JSON.stringify(require.resolve('eslint'))})
    const tseslint = require(${JSON.stringify(require.resolve('typescript-eslint'))})
    const { appendFileSync } = require('node:fs')
    const files = process.argv.slice(2).filter(argument => argument.endsWith('.ts'))
    appendFileSync(${JSON.stringify(join(directory, 'linted.log'))}, JSON.stringify(files.map(file => file.replace(/^src\\//, '')).sort()) + '\\n')
    const lint = new ESLint({ cwd: ${JSON.stringify(directory)}, overrideConfigFile: true,
      overrideConfig: tseslint.config(...tseslint.configs.recommended, { files: ['**/*.ts'],
        languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: ${JSON.stringify(directory)} } },
        rules: { '@typescript-eslint/no-floating-promises': 'error' } }) })
    lint.lintFiles(files).then(results => {
      for (const result of results) for (const message of result.messages) console.error(message.ruleId, message.message)
      process.exit(results.some(result => result.errorCount || result.warningCount) ? 1 : 0)
    }).catch(error => { console.error(error); process.exit(1) })`)
  writeFileSync(join(directory, 'package.json'), '{"name":"closure-fixture"}')
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', baseUrl: '.', paths: { '#local/*': ['./src/*'] },
  }, include: ['src'] }))
  writeFileSync(join(directory, 'src/types.ts'), 'export type Shape = { a: string }\n')
  writeFileSync(join(directory, 'src/user.ts'), "import type { Shape } from './types.js'\nexport const value: Shape = { a: '' }\n")
  writeFileSync(join(directory, 'src/alone.ts'), 'export const alone = 1\n')
  const lint = (environment = {}) => {
    const result = spawnSync(process.execPath, [join(root, 'scripts/eslint-closure-cache.mjs'), '--max-warnings', '0'],
      { cwd: directory, encoding: 'utf8', env: { ...process.env, ...environment } })
    const log = (() => { try { return readFileSync(join(directory, 'linted.log'), 'utf8') } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return ''
    } })()
    rmSync(join(directory, 'linted.log'), { force: true })
    return { status: result.status, linted: log.trim().split('\n').filter(Boolean).flatMap(line => JSON.parse(line)).sort() }
  }
  return { root, directory, lint, write: (file, value) => writeFileSync(join(directory, 'src', file), value),
    close: () => rmSync(root, { recursive: true, force: true }) }
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

test('path aliases invalidate callers when the resolved imported type changes', () => {
  const fixture = project()
  try {
    fixture.write('user.ts', "import type { Shape } from '#local/types'\nexport const value: Shape = { a: '' }")
    assert.equal(fixture.lint().status, 0)
    assert.deepEqual(fixture.lint().linted, [])
    fixture.write('types.ts', 'export type Shape = { a: number }')
    assert.deepEqual(fixture.lint().linted, ['types.ts', 'user.ts'])
  } finally { fixture.close() }
})

test('conditional package imports invalidate the consumer of the ESM target', () => {
  const fixture = project()
  try {
    writeFileSync(join(fixture.directory, 'package.json'), JSON.stringify({ name: 'closure-fixture', type: 'module',
      imports: { '#action': { import: './src/esm.ts', require: './src/cjs.ts' } } }))
    fixture.write('esm.ts', 'export function action(): void {}')
    fixture.write('cjs.ts', 'export function action(): void {}')
    fixture.write('user.ts', "import { action } from '#action'; action()")
    assert.equal(fixture.lint().status, 0)
    assert.deepEqual(fixture.lint().linted, [])
    fixture.write('esm.ts', 'export async function action(): Promise<void> {}')
    assert.deepEqual(fixture.lint().linted, ['esm.ts', 'user.ts'])
  } finally { fixture.close() }
})

test('ambient module declarations invalidate unchanged consumers', () => {
  const fixture = project()
  try {
    fixture.write('ambient.d.mts', 'declare global { interface Shared { value: string } }\nexport {}')
    assert.equal(fixture.lint().status, 0)
    assert.deepEqual(fixture.lint().linted, [])
    fixture.write('ambient.d.mts', 'declare global { interface Shared { value: number } }\nexport {}')
    assert.ok(fixture.lint().linted.includes('user.ts'))
  } finally { fixture.close() }
})

test('global scripts invalidate unchanged consumers', () => {
  const fixture = project()
  try {
    fixture.write('ambient.ts', 'declare function action(): void')
    assert.equal(fixture.lint().status, 0)
    assert.deepEqual(fixture.lint().linted, [])
    fixture.write('ambient.ts', 'declare function action(): Promise<void>')
    assert.ok(fixture.lint().linted.includes('user.ts'))
  } finally { fixture.close() }
})

test('lint exemptions and inherited compiler options invalidate earlier passes', () => {
  for (const input of ['scripts/lint-allowlist.json', 'scripts/lint-allowlist.mjs', 'tsconfig.shared.json']) {
    const fixture = project()
    try {
      writeFileSync(join(fixture.root, 'tsconfig.shared.json'), '{"compilerOptions":{"strict":true}}')
      writeFileSync(join(fixture.directory, 'tsconfig.json'), '{"extends":"../../tsconfig.shared.json","include":["src"]}')
      assert.equal(fixture.lint().status, 0)
      assert.deepEqual(fixture.lint().linted, [])
      writeFileSync(join(fixture.root, input), input.endsWith('.mjs') ? 'export const allowlist = { changed: true }'
        : '{"compilerOptions":{"strict":false}}')
      assert.ok(fixture.lint().linted.includes('user.ts'), input)
    } finally { fixture.close() }
  }
})

test('workspace packages invalidate consumers of their own workspace dependencies', () => {
  const fixture = project()
  try {
    for (const name of ['top', 'base']) {
      mkdirSync(join(fixture.root, 'packages', name, 'src'), { recursive: true })
      writeFileSync(join(fixture.root, 'packages', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}` }))
    }
    const base = join(fixture.root, 'packages/base/src/index.ts')
    writeFileSync(base, 'export type Shape = { a: string }')
    writeFileSync(join(fixture.root, 'packages/top/src/index.ts'), "export type { Shape } from '@fixture/base'")
    fixture.write('user.ts', "import type { Shape } from '@fixture/top'\nexport const value: Shape = { a: '' }")
    assert.equal(fixture.lint().status, 0)
    assert.deepEqual(fixture.lint().linted, [])
    writeFileSync(base, 'export type Shape = { a: number }')
    assert.ok(fixture.lint().linted.includes('user.ts'))
  } finally { fixture.close() }
})

test('declaration files themselves are linted rather than silently recorded as passed', () => {
  const fixture = project()
  try {
    fixture.write('invalid.d.ts', 'declare const value: any // LINT_ERROR')
    assert.equal(fixture.lint().status, 1)
  } finally { fixture.close() }
})

test('real typed lint catches a newly floating promise through a path alias in an unchanged cached caller', () => {
  const fixture = project(true)
  try {
    fixture.write('types.ts', 'export function action(): void {}')
    fixture.write('user.ts', "import { action } from '#local/types'\naction()")
    assert.equal(fixture.lint().status, 0)
    assert.deepEqual(fixture.lint().linted, [])
    fixture.write('types.ts', 'export async function action(): Promise<void> {}')
    const result = fixture.lint()
    assert.equal(result.status, 1)
    assert.ok(result.linted.includes('user.ts'))
    assert.equal(fixture.lint().status, 1)
  } finally { fixture.close() }
})

test('lint baseline mode cannot reuse results produced with exemptions enabled', () => {
  const fixture = project()
  try {
    assert.equal(fixture.lint({ FOREMAN_LINT_BASELINE: '' }).status, 0)
    assert.deepEqual(fixture.lint({ FOREMAN_LINT_BASELINE: '' }).linted, [])
    assert.deepEqual(fixture.lint({ FOREMAN_LINT_BASELINE: '1' }).linted, ['alone.ts', 'types.ts', 'user.ts'])
  } finally { fixture.close() }
})
