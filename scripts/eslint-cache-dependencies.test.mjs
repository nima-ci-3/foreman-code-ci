import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
const id = text => createHash('sha256').update(text).digest('hex')

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'lint-dependencies-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const project = join(root, 'apps/api')
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), typeof text === 'string' ? text : JSON.stringify(text))
  }
  for (const file of ['eslint-closure-cache.mjs', 'lint-allowlist.mjs', 'eslint-plugin-foreman/index.mjs',
    'eslint-plugin-foreman/pendingSqlTextTests.mjs']) {
    mkdirSync(dirname(join(root, 'scripts', file)), { recursive: true })
    copyFileSync(join(import.meta.dirname, file), join(root, 'scripts', file))
  }
  for (const file of ['ciImportGraph.mjs', 'ciLockIdentities.mjs']) {
    mkdirSync(join(root, 'packages/contracts/src'), { recursive: true })
    copyFileSync(join(import.meta.dirname, '../packages/contracts/src', file), join(root, 'packages/contracts/src', file))
  }
  write('package.json', { private: true, type: 'module' })
  write('apps/api/package.json', { name: 'fixture', type: 'module' })
  write('apps/api/tsconfig.json', { compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' }, include: ['src'] })
  write('scripts/lint-allowlist.json', { files: {}, eslint: {}, 'test-names': [], 'import-cycles': [] })
  write('pnpm-lock.yaml', 'lockfileVersion: 9.0')
  write('apps/api/src/provider.ts', 'export const value = 1\n')
  write('apps/api/src/user.ts', "import { value } from './provider.js'\nexport const result = value\n")
  write('apps/api/src/other.ts', 'export const other = true\n')
  write('apps/api/node_modules/eslint/package.json', { type: 'commonjs' })
  // Record the public command boundary; this test never runs ESLint or a compiler.
  write('apps/api/node_modules/eslint/bin/eslint.js', `
    const { writeFileSync } = require('node:fs')
    const { resolve } = require('node:path')
    const args = process.argv.slice(2)
    const files = args.filter(arg => /\\.[cm]?[jt]sx?$/.test(arg))
    writeFileSync('invocation.json', JSON.stringify(files))
    writeFileSync(args[args.indexOf('--output-file') + 1], JSON.stringify(files.map(file => ({ filePath: resolve(file), messages: [] }))))
  `)
  for (const name of ['typescript', 'yaml']) {
    symlinkSync(dirname(require.resolve(`${name}/package.json`)), join(project, 'node_modules', name))
  }
  const run = (environment = {}) => {
    rmSync(join(project, 'invocation.json'), { force: true })
    const result = spawnSync(process.execPath, [join(root, 'scripts/eslint-closure-cache.mjs')],
      { cwd: project, encoding: 'utf8', env: { ...process.env, FOREMAN_LINT_BASELINE: '', ...environment } })
    assert.equal(result.status, 0, result.stderr)
    try { return JSON.parse(readFileSync(join(project, 'invocation.json'), 'utf8')).sort() }
    catch (error) { if (error.code !== 'ENOENT') throw error; return [] }
  }
  const prime = () => { assert.ok(run().length); assert.deepEqual(run(), []) }
  return { root, project, write, run, prime }
}

test('only the active inherited tsconfig invalidates typed targets', t => {
  const f = fixture(t)
  f.write('tsconfig.shared.json', { compilerOptions: { strict: true } })
  f.write('apps/api/tsconfig.json', { extends: '../../tsconfig.shared.json', include: ['src'] })
  f.write('apps/api/tsconfig.build.json', { extends: './tsconfig.json', exclude: ['test'] })
  f.write('apps/api/src/tool.mjs', 'export const tool = 1')
  f.prime()
  f.write('apps/api/tsconfig.build.json', { extends: './tsconfig.json', exclude: ['test', 'src/other.ts'] })
  assert.deepEqual(f.run(), [])
  f.write('tsconfig.shared.json', { compilerOptions: { strict: false } })
  assert.deepEqual(f.run(), ['src/other.ts', 'src/provider.ts', 'src/user.ts'])
})

test('external module declarations affect their importers; ambient declarations affect every typed target', t => {
  const f = fixture(t)
  f.write('apps/api/src/shape.d.ts', 'export interface Shape { a: string }')
  f.write('apps/api/src/user.ts', "import type { Shape } from './shape.js'\nexport const value: Shape = { a: '' }")
  f.write('apps/api/src/unused.d.ts', 'export interface Unused { a: string }')
  f.write('apps/api/src/global.d.ts', 'export {}\ndeclare global { interface Global { a: string } }')
  f.write('apps/api/src/tool.mjs', 'export const tool = 1')
  f.prime()
  f.write('apps/api/src/unused.d.ts', 'export interface Unused { a: number }')
  assert.deepEqual(f.run(), ['src/unused.d.ts'])
  f.write('apps/api/src/shape.d.ts', 'export interface Shape { a: number }')
  assert.deepEqual(f.run(), ['src/shape.d.ts', 'src/user.ts'])
  f.write('apps/api/src/global.d.ts', 'export {}\ndeclare global { interface Global { a: number } }')
  const typed = ['src/global.d.ts', 'src/other.ts', 'src/provider.ts', 'src/shape.d.ts', 'src/unused.d.ts', 'src/user.ts']
  assert.deepEqual(f.run(), typed)
  f.write('apps/api/src/global.d.ts', "import type { Shape } from './shape.js'\nexport {}\ndeclare global { interface Global { a: Shape } }")
  assert.deepEqual(f.run(), typed)
  f.write('apps/api/src/shape.d.ts', 'export interface Shape { a: boolean }')
  assert.deepEqual(f.run(), typed)
})

test('manifest metadata preserves passes while module resolution changes invalidate consumers', t => {
  const f = fixture(t)
  const manifest = { name: 'fixture', type: 'module', imports: { '#value': './src/provider.ts' } }
  f.write('apps/api/package.json', manifest)
  f.write('apps/api/src/user.ts', "import { value } from '#value'\nexport const result = value")
  f.prime()
  f.write('package.json', { private: true, type: 'module', foremanCi: { hostSlots: 9 }, description: 'updated', version: '2' })
  f.write('apps/api/package.json', { ...manifest, description: 'updated', license: 'MIT', files: ['dist'], scripts: { test: 'changed' } })
  assert.deepEqual(f.run(), [])
  f.write('apps/api/package.json', { ...manifest, imports: { '#value': './src/other.ts' } })
  assert.ok(f.run().includes('src/user.ts'))
})

test('conditional imports follow static, require, dynamic and explicit type resolution modes', t => {
  const f = fixture(t)
  f.write('apps/api/package.json', { name: 'fixture', type: 'module', imports: { '#value': { import: './src/esm.ts', require: './src/cjs.ts' } } })
  f.write('apps/api/src/esm.ts', 'export const value = 1')
  f.write('apps/api/src/cjs.ts', 'export const value = 1')
  f.write('apps/api/src/user.ts', "import { value } from '#value'\nexport const result = value")
  f.write('apps/api/src/required.cts', "import value = require('#value')\nexport { value }")
  f.write('apps/api/src/dynamic.cts', "export const result = import('#value')")
  f.write('apps/api/src/type.ts', "import type { value } from '#value' with { 'resolution-mode': 'require' }\nexport type Result = typeof value")
  f.prime()
  f.write('apps/api/src/cjs.ts', 'export const value = 2')
  assert.deepEqual(f.run(), ['src/cjs.ts', 'src/required.cts', 'src/type.ts'])
  f.write('apps/api/src/esm.ts', 'export const value = 2')
  assert.deepEqual(f.run(), ['src/dynamic.cts', 'src/esm.ts', 'src/user.ts'])
})

test('JavaScript targets keep passes when their imports change', t => {
  const f = fixture(t)
  f.write('apps/api/src/tool.mjs', "import { value } from './provider.js'\nexport const tool = value")
  f.prime()
  f.write('apps/api/src/provider.ts', 'export const value = 2\n')
  assert.deepEqual(f.run(), ['src/provider.ts', 'src/user.ts'])
  f.write('apps/api/src/tool.mjs', 'export const tool = 2')
  assert.deepEqual(f.run(), ['src/tool.mjs'])
})

test('exemption and pending-SQL edits invalidate only files whose effective rules change', t => {
  const f = fixture(t)
  const legacy = 'export const other = true\n'
  const otherPackage = 'export const external = true\n'
  const allowlist = { files: { [id(legacy)]: 'apps/api/src/other.ts', [id(otherPackage)]: 'apps/ci/src/other.ts' },
    eslint: { 'foreman/no-silent-catch': [id(legacy), id(otherPackage)] }, 'test-names': [], 'import-cycles': [] }
  f.write('apps/ci/src/other.ts', otherPackage)
  f.write('scripts/lint-allowlist.json', allowlist)
  f.write('apps/api/src/pending.test.ts', 'export const pending = 1')
  f.write('scripts/eslint-plugin-foreman/pendingSqlTextTests.mjs', "export const pendingSqlTextTests = new Set(['apps/api/src/pending.test.ts'])")
  f.prime()
  f.write('scripts/lint-allowlist.json', { ...allowlist, 'test-names': [id(legacy)], 'import-cycles': [[id(legacy), id(otherPackage)]] })
  assert.deepEqual(f.run(), [])
  f.write('scripts/lint-allowlist.json', { ...allowlist, eslint: { 'foreman/no-silent-catch': [id(legacy)] } })
  assert.deepEqual(f.run(), [])
  f.write('scripts/lint-allowlist.json', { ...allowlist, eslint: {} })
  assert.deepEqual(f.run(), ['src/other.ts'])
  f.write('scripts/eslint-plugin-foreman/pendingSqlTextTests.mjs', 'export const pendingSqlTextTests = new Set()')
  assert.deepEqual(f.run(), ['src/pending.test.ts'])
  // Baseline mode changes rules only for currently exempt files.
  f.write('scripts/lint-allowlist.json', allowlist)
  assert.deepEqual(f.run(), ['src/other.ts'])
  assert.deepEqual(f.run({ FOREMAN_LINT_BASELINE: '1' }), ['src/other.ts'])
})

test('pending-SQL membership changes effective rule options without changing the plugin version', async t => {
  const f = fixture(t)
  execFileSync('git', ['init', '-q'], { cwd: f.root })
  const entry = 'apps/api/src/pending.test.ts'
  f.write(entry, 'export const pending = 1')
  f.write('scripts/eslint-plugin-foreman/pendingSqlTextTests.mjs', `export const pendingSqlTextTests = new Set([${JSON.stringify(entry)}])`)
  const pluginPath = join(f.root, 'scripts/eslint-plugin-foreman/index.mjs')
  const before = await import(pathToFileURL(pluginPath))
  const effective = config => config.find(part => part.files?.includes('src/pending.test.ts'))?.rules['foreman/no-source-text-tests']
  assert.deepEqual(effective(before.foremanLint(f.project)), ['error', { pendingSqlText: true }])
  f.write('scripts/eslint-plugin-foreman/pendingSqlTextTests.mjs', 'export const pendingSqlTextTests = new Set()')
  // A fresh process reloads the changed module just as a fresh ESLint invocation does.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { plugin, foremanLint } = await import(${JSON.stringify(pathToFileURL(pluginPath).href)})
    const rules = foremanLint(${JSON.stringify(f.project)})
    console.log(JSON.stringify({ version: plugin.meta.version, pending: rules.some(part => part.files?.includes('src/pending.test.ts')) }))
  `], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const after = JSON.parse(result.stdout)
  assert.equal(after.version, before.plugin.meta.version)
  assert.equal(after.pending, false)
})

test('workspace callers use the declarations read during lint, including transitive declarations', t => {
  const f = fixture(t)
  const pkg = 'packages/contracts'
  f.write(`${pkg}/package.json`, { name: '@foreman-code/contracts', type: 'module', exports: { './value': { types: './dist/value.d.ts', import: './dist/value.js' } } })
  f.write(`${pkg}/src/value.ts`, 'export const value = 2')
  f.write(`${pkg}/dist/value.d.ts`, "export { value } from './inner.js'")
  f.write(`${pkg}/dist/inner.d.ts`, 'export declare const value: number')
  f.write(`${pkg}/dist/unused.d.ts`, 'export declare const unused: string')
  mkdirSync(join(f.project, 'node_modules/@foreman-code'), { recursive: true })
  symlinkSync(join(f.root, pkg), join(f.project, 'node_modules/@foreman-code/contracts'))
  f.write('apps/api/src/user.ts', "import { value } from '@foreman-code/contracts/value'\nexport const result = value")
  f.prime()
  f.write(`${pkg}/dist/inner.d.ts`, 'export declare const value: Promise<number>')
  assert.deepEqual(f.run(), ['src/user.ts'])
  f.write(`${pkg}/src/value.ts`, 'export const value = 3')
  f.write(`${pkg}/dist/unused.d.ts`, 'export declare const unused: number')
  assert.deepEqual(f.run(), [])
  f.write(`${pkg}/package.json`, { name: '@foreman-code/contracts', type: 'commonjs', description: 'updated',
    exports: { './value': { types: './dist/value.d.ts', import: './dist/value.js' } } })
  assert.deepEqual(f.run(), ['src/user.ts'])
  f.write(`${pkg}/dist/value.d.ts`, 'export declare const value: boolean')
  assert.deepEqual(f.run(), ['src/user.ts'])
  // Worktrees can share node_modules; the declarations actually read may live outside this checkout.
  const external = mkdtempSync(join(tmpdir(), 'lint-workspace-'))
  t.after(() => rmSync(external, { recursive: true, force: true }))
  writeFileSync(join(external, 'package.json'), JSON.stringify({ name: '@foreman-code/contracts', types: './value.d.ts' }))
  writeFileSync(join(external, 'value.d.ts'), 'export declare const value: boolean')
  rmSync(join(f.project, 'node_modules/@foreman-code/contracts'))
  symlinkSync(external, join(f.project, 'node_modules/@foreman-code/contracts'))
  f.write('apps/api/src/user.ts', "import { value } from '@foreman-code/contracts'\nexport const result = value")
  assert.deepEqual(f.run(), ['src/user.ts'])
  assert.deepEqual(f.run(), [])
  writeFileSync(join(external, 'value.d.ts'), 'export declare const value: string')
  assert.deepEqual(f.run(), ['src/user.ts'])
})
