import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'

const repository = resolve(import.meta.dirname, '..')
const require = createRequire(join(repository, 'apps/api/package.json'))
const { parse } = require('yaml')
const ts = require('typescript')
const config = name => parse(readFileSync(join(repository, name), 'utf8'))
const workflow = config('.github/workflows/ci.yml').jobs.ci.steps
const warmer = config('.github/workflows/ci-cache.yml').jobs['warm-caches'].steps
const circle = config('.circleci/config.yml').jobs.ci.steps

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ci-cloud-cache-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value))
  }
  put('package.json', { name: 'fixture', version: '1', type: 'module', packageManager: 'pnpm@11.27.0', scripts: {} })
  put('pnpm-lock.yaml', 'lockfileVersion: 9.0\n')
  put('pnpm-workspace.yaml', 'packages: [apps/*, packages/*]\n')
  put('.npmrc', 'auto-install-peers=false\n')
  for (const project of ['apps/api', 'apps/ci', 'apps/web', 'packages/contracts', 'packages/contracts-node']) {
    put(`${project}/package.json`, { name: project.replace('/', '-'), version: '1', type: 'module', scripts: {} })
    put(`${project}/tsconfig.json`, { compilerOptions: { noLib: true, noEmit: true, incremental: true,
      module: 'NodeNext', moduleResolution: 'NodeNext', tsBuildInfoFile: 'node_modules/.cache/tsc/state.tsbuildinfo' }, include: ['src'] })
    put(`${project}/tsconfig.build.json`, { extends: './tsconfig.json', compilerOptions: { noEmit: false }, exclude: ['src/**/*.test.ts'] })
    put(`${project}/src/value.ts`, 'export const value = 1\n')
    mkdirSync(join(root, project, 'node_modules'), { recursive: true })
    symlinkSync(dirname(require.resolve('typescript/package.json')), join(root, project, 'node_modules/typescript'))
  }
  put('apps/web/tsconfig.json', { files: [], references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }] })
  put('apps/web/tsconfig.app.json', { compilerOptions: { noLib: true, noEmit: true, incremental: true, module: 'ESNext', moduleResolution: 'Bundler' }, include: ['src'] })
  put('apps/web/tsconfig.node.json', { compilerOptions: { noLib: true, noEmit: true, incremental: true }, files: ['vite.config.ts', 'playwright.config.ts'] })
  put('apps/web/vite.config.ts', 'export default {}\n')
  put('apps/web/playwright.config.ts', 'export default {}\n')
  put('apps/web/public/icon.svg', '<svg/>')
  put('apps/web/index.html', '<html/>')
  put('scripts/copy-api-runtime.mjs', 'export const copy = 1\n')
  put('packages/contracts/src/runtimeBuildIdentityNode.mjs', 'export const identity = 1\n')
  put('packages/verification-runner/runtime-files.mjs', 'export const files = []\n')
  put('apps/api/src/modules/browser-runtime/skill/browser-use.md', 'browser skill')
  const run = (command, env = {}, cwd = root) => spawnSync('bash', ['-ec', command], {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20_000,
  })
  const patchManifest = (path, fields) => put(path, { ...JSON.parse(readFileSync(join(root, path), 'utf8')), ...fields })
  return { root, put, run, patchManifest }
}

function key(f, kind) {
  const step = workflow.find(step => step.id === 'compiler-inputs')
  let outputs = {}
  if (step) {
    const output = join(f.root, 'output')
    const result = f.run(step.run.replaceAll('node scripts/', `node ${repository}/scripts/`), { GITHUB_OUTPUT: output, SUITE: kind === 'api' ? 'build-api' : 'build-web' })
    assert.equal(result.status, 0, result.stderr)
    outputs = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('=')))
  }
  return workflow.find(step => step.id === (kind === 'api' ? 'api-build' : 'web-typecheck')).with.key.replace(/\$\{\{ (.*?) \}\}/g, (_, expression) => {
    if (expression === 'runner.os') return 'Linux'
    if (expression.startsWith('steps.compiler-inputs.outputs.')) return outputs[expression.split('.').at(-1)]
    if (expression.startsWith('hashFiles(')) {
      const patterns = [...expression.matchAll(/'([^']+)'/g)].map(match => match[1])
      const files = ts.sys.readDirectory(f.root, undefined, patterns.filter(p => p.startsWith('!')).map(p => p.slice(1)), patterns.filter(p => !p.startsWith('!'))).sort()
      const hash = createHash('sha256')
      for (const file of files) hash.update(readFileSync(file))
      return hash.digest('hex')
    }
    throw new Error(`Unsupported workflow expression: ${expression}`)
  })
}

for (const manifest of ['package.json', 'apps/api/package.json', 'apps/ci/package.json', 'apps/web/package.json']) {
  test(`installation key survives release and non-install script changes in ${manifest}`, t => {
    const f = fixture(t)
    const command = `node ${repository}/scripts/ci-packages.mjs key "$PWD"`
    const before = f.run(command)
    assert.equal(before.status, 0, before.stderr)
    f.patchManifest(manifest, { version: '2', scripts: { test: 'new tests', build: 'new build' } })
    const after = f.run(command)
    assert.equal(after.status, 0, after.stderr)
    assert.equal(after.stdout, before.stdout)
    f.patchManifest(manifest, { scripts: { postinstall: 'node install.mjs' } })
    assert.notEqual(f.run(command).stdout, before.stdout)
    f.patchManifest(manifest, { dependencies: { dependency: '2' } })
    assert.notEqual(f.run(command).stdout, before.stdout)
  })
}

test('GitHub and CircleCI share compiler state across installation changes', () => {
  const values = [
    ...workflow.filter(step => step.with?.key?.startsWith('suite-state-')).flatMap(step => [step.with.key, step.with['restore-keys']]),
    ...warmer.filter(step => step.with?.key?.startsWith('suite-state-')).flatMap(step => [step.with.key, step.with['restore-keys']]),
    ...workflow.filter(step => step.env?.ASSET).map(step => step.env.ASSET),
  ]
  for (const value of values) {
    const render = packages => value.replaceAll('${{ steps.cache-inputs.outputs.packages }}', packages)
    assert.equal(render('old-install'), render('new-install'))
  }
  // Execute CircleCI's real download commands and compare requested URLs across package sets.
  for (const packages of ['old-install', 'new-install']) {
    const root = mkdtempSync(join(tmpdir(), 'ci-state-urls-'))
    try {
      mkdirSync(join(root, '.logs'))
      mkdirSync(join(root, 'bin'))
      writeFileSync(join(root, '.logs/ci-packages-key'), packages)
      writeFileSync(join(root, 'bin/curl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/urls"\nexit 22\n', { mode: 0o755 })
      const step = circle.flatMap(step => step.when?.steps ?? []).find(step => step.run?.name === 'Typecheck and lint state from main')
      const result = spawnSync('bash', ['-ec', step.run.command], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: root, PATH: `${root}/bin:${process.env.PATH}`, SUITE: 'typecheck-other', CIRCLE_PROJECT_USERNAME: 'owner', CIRCLE_PROJECT_REPONAME: 'repo' } })
      assert.equal(result.status, 0, result.stderr)
      const urls = readFileSync(join(root, 'urls'), 'utf8').replaceAll(root, '<home>')
      if (packages === 'old-install') values.push(urls)
      else assert.equal(urls, values.at(-1))
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('main publication retains release assets used by other package sets', t => {
  const f = fixture(t)
  f.put('apps/web/node_modules/.cache/tsc/app.tsbuildinfo', 'state')
  f.put('assets.json', ['suite-state-active-branch.tar.gz', 'run-state-typecheck-other-active-branch.tar.gz'])
  f.put('bin/package.json', { type: 'commonjs' })
  f.put('bin/gh', `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2); const path = process.env.ASSETS;
let assets = JSON.parse(fs.readFileSync(path));
if (args.includes('--json')) console.log(assets.join('\\n'));
if (args[1] === 'upload') { assets.push(require('node:path').basename(args[3])); }
if (args[1] === 'delete-asset') assets = assets.filter(name => name !== args.at(-1));
fs.writeFileSync(path, JSON.stringify(assets));
`)
  const gh = join(f.root, 'bin/gh')
  // Execute the workflow's publication block against a local fake release service.
  const chmod = spawnSync('chmod', ['+x', gh]); assert.equal(chmod.status, 0)
  const step = warmer.find(step => step.name === 'Publish typecheck and lint state for CircleCI')
  const result = f.run(step.run, { PATH: `${f.root}/bin:${process.env.PATH}`, ASSETS: join(f.root, 'assets.json'), PACKAGES_KEY: 'main', RUNNER_TEMP: f.root })
  assert.equal(result.status, 0, result.stderr)
  const assets = JSON.parse(readFileSync(join(f.root, 'assets.json'), 'utf8'))
  assert.ok(assets.includes('suite-state-active-branch.tar.gz'))
  assert.ok(assets.includes('run-state-typecheck-other-active-branch.tar.gz'))
  assert.equal(assets.length, 3)
})

for (const [kind, changes] of [
  ['api', ['apps/ci/package.json', 'apps/ci/tsconfig.unused.json', 'apps/ci/src/unimported.ts', 'apps/api/src/unused.test.ts']],
  ['web', ['apps/web/src/theme.css', 'apps/web/src/icon.svg', 'apps/web/unused-script.ts', 'packages/contracts/tsconfig.build.json', 'apps/web/package.json']],
]) {
  test(`${kind} archive ignores inputs outside its compiler/output dependency graph`, t => {
    const f = fixture(t)
    const before = key(f, kind)
    for (const path of changes) {
      if (path.endsWith('package.json')) f.patchManifest(path, { version: '2', scripts: { test: 'irrelevant' } })
      else f.put(path, path.endsWith('.json') ? { compilerOptions: { strict: true } } : 'irrelevant')
      assert.equal(key(f, kind), before, path)
    }
    f.put(`apps/${kind === 'api' ? 'api' : 'web'}/src/value.ts`, 'export const value = "changed"\n')
    assert.notEqual(key(f, kind), before)
  })
}

test('web archive follows imported declarations and effective no-emit config', t => {
  const f = fixture(t)
  f.put('packages/contracts/src/imported.d.ts', 'export declare const value: number\n')
  f.put('apps/web/src/value.ts', 'export { value } from "../../../packages/contracts/src/imported.js"\n')
  const before = key(f, 'web')
  f.put('packages/contracts/src/unimported.ts', 'export const unused = 1\n')
  assert.equal(key(f, 'web'), before)
  f.put('packages/contracts/src/imported.d.ts', 'export declare const value: string\n')
  const changed = key(f, 'web')
  assert.notEqual(changed, before)
  f.put('apps/web/tsconfig.app.json', { compilerOptions: { noLib: true, noEmit: true, strict: true }, include: ['src'] })
  assert.notEqual(key(f, 'web'), changed)
})

for (const kind of ['api', 'web']) {
  test(`${kind} archive resolves workspace exports before declarations are built`, t => {
    const f = fixture(t)
    f.patchManifest('apps/ci/package.json', { name: '@fixture/ci', exports: { '.': { types: './dist/value.d.ts' } } })
    const project = kind === 'api' ? 'apps/api' : 'apps/web'
    f.put(`${project}/src/value.ts`, 'export { value } from "@fixture/ci"\n')
    f.put(`${project}/node_modules/@fixture/placeholder`, '')
    symlinkSync(join(f.root, 'apps/ci'), join(f.root, project, 'node_modules/@fixture/ci'))
    const before = key(f, kind)
    f.put('apps/ci/src/value.ts', 'export const value = "changed"\n')
    const changed = key(f, kind)
    assert.notEqual(changed, before)
    f.put('apps/ci/dist/value.d.ts', 'export declare const value: boolean\n')
    assert.equal(key(f, kind), changed, 'stale generated declarations cannot hide source changes')
    f.put('apps/ci/src/other.ts', 'export const other = 2\n')
    assert.equal(key(f, kind), changed)
    f.patchManifest('apps/ci/package.json', { exports: { '.': { types: './dist/other.d.ts' } } })
    assert.notEqual(key(f, kind), changed)
    f.put('apps/ci/src/js-value.mjs', 'export const value = 1\n')
    f.patchManifest('apps/ci/package.json', { exports: { '.': { types: './dist/js-value.d.mts' } } })
    const javascript = key(f, kind)
    f.put('apps/ci/src/js-value.mjs', 'export const value = "changed"\n')
    assert.notEqual(key(f, kind), javascript)
  })
}

test('web archive notices installed declaration changes without unrelated package metadata', t => {
  const f = fixture(t)
  f.put('apps/web/node_modules/dep/package.json', { name: 'dep', version: '1', types: './index.d.ts' })
  f.put('apps/web/node_modules/dep/index.d.ts', 'export declare const value: number\n')
  f.put('apps/web/src/value.ts', 'export { value } from "dep"\n')
  const before = key(f, 'web')
  f.put('apps/web/node_modules/dep/package.json', { name: 'dep', version: '2', description: 'unused', types: './index.d.ts' })
  assert.equal(key(f, 'web'), before)
  f.put('apps/web/node_modules/dep/index.d.ts', 'export declare const value: string\n')
  assert.notEqual(key(f, 'web'), before)
})

test('API archive includes copied runtime assets and embedded web identity', t => {
  const f = fixture(t)
  const before = key(f, 'api')
  f.put('apps/worker/artifacts/ci-runtime/verification-policy.mjs', 'export const policy = 2\n')
  const changed = key(f, 'api')
  assert.notEqual(changed, before)
  f.put('apps/web/public/icon.svg', '<svg>changed</svg>')
  assert.notEqual(key(f, 'api'), changed)
})

test('web restore cannot overwrite newer run state', t => {
  const f = fixture(t)
  const state = 'apps/web/node_modules/.cache/tsc/app.tsbuildinfo'
  const old = new Date('2020-01-01'), fresh = new Date('2025-01-01')
  f.put('new-state/' + state, 'new run')
  utimesSync(join(f.root, 'new-state', state), fresh, fresh)
  f.put('scripts/ci-suite-state.mjs', `export { recordSuiteState } from '${repository}/scripts/ci-suite-state.mjs'`)
  f.put('bin/gh', '#!/bin/sh\ncp "$STATE_ARCHIVE" "$RUNNER_TEMP/$ASSET"\n')
  assert.equal(spawnSync('chmod', ['+x', join(f.root, 'bin/gh')]).status, 0)
  const archive = join(f.root, 'new-run.tar.gz')
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', join(f.root, 'new-state'), state]).status, 0)
  const inputs = { suite: 'typecheck-other' }
  for (const step of workflow) {
    if (step.id === 'web-typecheck') {
      const enabled = Function('inputs', 'startsWith', `return ${step.if}`)(inputs, (value, prefix) => value.startsWith(prefix))
      if (enabled) {
        f.put(state, 'old archive')
        utimesSync(join(f.root, state), old, old)
      }
    } else if (step.name === 'Typecheck and lint state from the newest run') {
      const result = f.run(step.run, { PATH: `${f.root}/bin:${process.env.PATH}`, STATE_ARCHIVE: archive,
        ASSET: 'run-state.tar.gz', RUNNER_TEMP: f.root, GITHUB_REPOSITORY: 'owner/repo' })
      assert.equal(result.status, 0, result.stderr)
    }
  }
  assert.equal(readFileSync(join(f.root, state), 'utf8'), 'new run')
})

for (const command of ['typecheck', 'build']) {
  test(`web ${command} sends both no-emit projects to content-validating project checks`, t => {
    const f = fixture(t)
    const scripts = JSON.parse(readFileSync(join(repository, 'apps/web/package.json'), 'utf8')).scripts
    // Execute package orchestration with command spies, never a real compiler or build.
    f.put('scripts/ci-remote.mjs', 'const i = process.argv.indexOf("--"); const r = (await import("node:child_process")).spawnSync(process.argv[i+1], process.argv.slice(i+2), {stdio:"inherit"}); process.exit(r.status ?? 1)')
    cpSync(join(f.root, 'scripts/ci-remote.mjs'), join(f.root, 'scripts/heavy-job.mjs'))
    f.put('bin/package.json', { type: 'commonjs' })
    f.put('bin/tsc', `#!${process.execPath}
require('node:fs').appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
`)
    f.put('bin/vite', '#!/bin/sh\nexit 0\n')
    for (const tool of ['tsc', 'vite']) assert.equal(spawnSync('chmod', ['+x', join(f.root, 'bin', tool)]).status, 0)
    const result = f.run(scripts[command], { PATH: `${f.root}/bin:${process.env.PATH}`, CALLS: join(f.root, 'calls') }, join(f.root, 'apps/web'))
    assert.equal(result.status, 0, result.stderr)
    const calls = readFileSync(join(f.root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(calls, [['-p', 'tsconfig.app.json'], ['-p', 'tsconfig.node.json']])
  })
}

test('restored no-emit build info retains timestamps rather than becoming newer than changed roots', t => {
  const f = fixture(t)
  f.put('cache/apps/web/app.tsbuildinfo', 'previous compiler state')
  const old = new Date('2020-01-01'), changed = new Date('2025-01-01')
  utimesSync(join(f.root, 'cache/apps/web/app.tsbuildinfo'), old, old)
  utimesSync(join(f.root, 'apps/web/src/value.ts'), changed, changed)
  const result = f.run(`node ${repository}/scripts/ci-typecheck-cache.mjs -- node -e ''`, { FOREMAN_CODE_CI_TYPECHECK_CACHE: join(f.root, 'cache') })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(statSync(join(f.root, 'apps/web/node_modules/.cache/tsc/app.tsbuildinfo')).mtimeMs, old.getTime())
  assert.equal(statSync(join(f.root, 'cache/apps/web/app.tsbuildinfo')).mtimeMs, old.getTime())
})
