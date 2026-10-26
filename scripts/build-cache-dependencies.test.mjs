import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { verificationRuntimeFiles } from '../packages/verification-runner/runtime-files.mjs'

const require = createRequire(new URL('../apps/ci/package.json', import.meta.url))
const typescript = resolve(require.resolve('typescript/package.json'), '..')
const projects = { contracts: 'packages/contracts', 'contracts-node': 'packages/contracts-node', ci: 'apps/ci', api: 'apps/api', web: 'apps/web' }

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'build-dependencies-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  let root = join(home, 'checkout')
  const put = (path, value) => {
    mkdirSync(resolve(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), value)
  }
  for (const name of ['heavy-job.mjs', 'heavy-job-slots.mjs', 'sleep.mjs', 'ci-contracts.mjs', 'build-cache-inputs.mjs', 'copy-api-runtime.mjs']) {
    if (existsSync(new URL(name, import.meta.url))) {
      mkdirSync(join(root, 'scripts'), { recursive: true })
      copyFileSync(new URL(name, import.meta.url), join(root, 'scripts', name))
    }
  }
  mkdirSync(join(root, 'packages/verification-runner'), { recursive: true })
  copyFileSync(new URL('../packages/verification-runner/runtime-files.mjs', import.meta.url), join(root, 'packages/verification-runner/runtime-files.mjs'))
  for (const name of ['installationNames.mjs', 'productEnvironment.mjs', 'runtimeBuildIdentityNode.mjs']) {
    mkdirSync(join(root, 'packages/contracts/src'), { recursive: true })
    copyFileSync(new URL(`../packages/contracts/src/${name}`, import.meta.url), join(root, 'packages/contracts/src', name))
  }
  for (const [kind, project] of Object.entries(projects)) {
    put(`${project}/package.json`, JSON.stringify({ name: `@example/${kind}`, type: 'module', devDependencies: { typescript: '5.9.3' } }))
    put(`${project}/src/index.ts`, 'export const value = 1')
    put(`${project}/tsconfig.json`, JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', types: [], noEmit: true }, include: ['src', 'tests'] }))
    put(`${project}/tsconfig.build.json`, JSON.stringify({ extends: './tsconfig.json', compilerOptions: { noEmit: false, outDir: 'dist', rootDir: 'src', declaration: true }, include: ['src'], exclude: ['src/**/*.test.ts'] }))
    mkdirSync(join(root, project, 'node_modules/.bin'), { recursive: true })
    symlinkSync(typescript, join(root, project, 'node_modules/typescript'), 'dir')
  }
  for (const tool of ['vite', '@vitejs/plugin-react']) {
    put(`apps/web/node_modules/${tool}/package.json`, JSON.stringify({ name: tool, version: '1.0.0', main: 'index.cjs' }))
    put(`apps/web/node_modules/${tool}/index.cjs`, tool === 'vite' ? 'exports.defineConfig = value => value; exports.load = () => import(moduleName)' : 'module.exports = {}')
  }
  put('package.json', '{"type":"module"}')
  put('.gitignore', 'node_modules/\ndist/\n.logs/\n.env*\n')
  put('apps/api/src/server.ts', 'export const server = 1')
  put('apps/web/public/favicon.svg', '<svg/>')
  put('apps/web/index.html', '<html/>')
  put('apps/web/vite.config.ts', 'import { defineConfig } from "vite"; export default defineConfig({ define: { setting: process.env.VITE_SETTING } })')
  const emitter = `#!/usr/bin/env node
const fs = require('node:fs');
const web = process.cwd().endsWith('/web');
fs.mkdirSync('dist', {recursive:true});
fs.writeFileSync('dist/' + (web ? 'index.html' : process.cwd().endsWith('/api') ? 'server.js' : process.cwd().endsWith('/ci') ? 'environment.js' : process.cwd().endsWith('/contracts-node') ? 'serverKit.js' : 'index.js'), fs.readFileSync('src/index.ts'));
fs.writeFileSync('dist/index.d.ts', fs.readFileSync('src/index.ts'));
fs.appendFileSync('../../.logs/emissions', 'emitted\\n');
if (process.cwd().endsWith('/api')) {
  fs.mkdirSync('dist/cli', {recursive:true});
  fs.writeFileSync('dist/cli/harnessCompatibility.js', 'import fs from "node:fs"; fs.appendFileSync("../../.logs/probes", process.env.PROBE_SETTING + "\\\\n")');
}
`
  for (const project of Object.values(projects)) {
    put(`${project}/node_modules/.bin/tsc`, emitter)
    chmodSync(join(root, project, 'node_modules/.bin/tsc'), 0o755)
  }
  put('apps/web/node_modules/.bin/vite', '#!/usr/bin/env node\n')
  chmodSync(join(root, 'apps/web/node_modules/.bin/vite'), 0o755)
  for (const path of [...verificationRuntimeFiles, 'apps/worker/artifacts/node-24.22.1-linux-x64.json',
    ...['Containerfile', 'corepack', 'context.mjs', 'seed-policy.mjs', 'verification-policy.mjs', 'verification-observation.mjs'].map(name => `apps/worker/artifacts/ci-runtime/${name}`)]) {
    if (!existsSync(join(root, path))) put(path, 'runtime asset')
  }
  put('apps/api/src/modules/browser-runtime/skill/browser-use.md', 'browser skill')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !/^(?:GRAPHQL|FOREMAN_CODE)_HEAVY_/.test(key)))
  Object.assign(env, { FOREMAN_CODE_HEAVY_BASE_TMPDIR: home, FOREMAN_CODE_VERIFICATION_ROOT: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
  delete env.CI_HOST_RUNNER
  delete env.FOREMAN_CODE_CI_CONTRACTS_CACHE
  delete env.NODE_OPTIONS
  const run = (args, cwd = root, extraEnv = {}) => spawnSync(process.execPath, args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15000 })
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')
  mkdirSync(join(root, '.logs'))
  const build = (kind = 'contracts', { extraEnv = {}, flags = [], compilerPath } = {}) => {
    const project = join(root, projects[kind])
    const command = kind === 'web' && flags.includes('--mode') ? ['sh', '-c', `tsc -b && vite build ${flags.join(' ')}`] : kind === 'api' ? ['sh', '-c', 'tsc -p tsconfig.build.json && node ../../scripts/copy-api-runtime.mjs && node dist/cli/harnessCompatibility.js'] : [...(compilerPath ? [process.execPath, compilerPath] : ['tsc']), '-p', 'tsconfig.build.json', ...flags]
    const result = run(['../../scripts/heavy-job.mjs', '--build', kind, '--', ...command], project,
      { ...extraEnv, PATH: `${project}/node_modules/.bin:${env.PATH}` })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return result.stdout + result.stderr
  }
  const contracts = (action, extraEnv = {}, flags = []) => {
    const project = join(root, projects.contracts)
    const args = ['../../scripts/ci-contracts.mjs', action, root]
    if (action === 'build') args.push(join(home, 'cache'), '--', 'tsc', '-p', 'tsconfig.build.json', ...flags)
    return run(args, project, { ...extraEnv, PATH: `${project}/node_modules/.bin:${env.PATH}` })
  }
  const key = () => {
    const result = contracts('key')
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  const count = () => existsSync(join(root, '.logs/emissions')) ? readFileSync(join(root, '.logs/emissions'), 'utf8').trim().split('\n').length : 0
  return { get root() { return root }, home, put, build, contracts, key, count, git,
    move() { const destination = join(home, 'relocated'); renameSync(root, destination); root = destination } }
}

for (const kind of Object.keys(projects)) {
  test(`${kind}: unrelated repo files preserve hits; selected and newly added compiler inputs miss`, t => {
    const f = fixture(t)
    f.build(kind)
    f.put('docs/release.md', 'unrelated documentation')
    f.put('apps/worker/test/unrelated.test.mjs', 'unrelated worker test')
    f.put(`${projects[kind]}/src/unused.test.ts`, 'excluded test')
    assert.match(f.build(kind), /build is current/)
    f.put(`${projects[kind]}/src/index.ts`, 'export const value = 2')
    assert.doesNotMatch(f.build(kind), /build is current/)
    f.put(`${projects[kind]}/src/added.ts`, 'export const added = true')
    assert.doesNotMatch(f.build(kind), /build is current/)
    rmSync(join(f.root, projects[kind], 'src/added.ts'))
    assert.doesNotMatch(f.build(kind), /build is current/)
  })
}

test('identical inputs and installed tools survive checkout and tool-store relocation', t => {
  const f = fixture(t)
  f.build()
  const tool = join(f.home, 'tool-store/typescript')
  cpSync(typescript, tool, { recursive: true })
  rmSync(join(f.root, 'packages/contracts/node_modules/typescript'))
  symlinkSync(tool, join(f.root, 'packages/contracts/node_modules/typescript'), 'dir')
  assert.match(f.build(), /build is current/)
  f.move()
  assert.match(f.build(), /build is current/)
  assert.equal(f.count(), 1)
  const launcher = join(tool, 'bin/tsc')
  writeFileSync(launcher, readFileSync(join(f.root, 'packages/contracts/node_modules/.bin/tsc')))
  f.build('contracts', { compilerPath: launcher })
  const moved = join(f.home, 'another-tool-store')
  renameSync(tool, moved)
  rmSync(join(f.root, 'packages/contracts/node_modules/typescript'))
  symlinkSync(moved, join(f.root, 'packages/contracts/node_modules/typescript'), 'dir')
  assert.match(f.build('contracts', { compilerPath: join(moved, 'bin/tsc') }), /build is current/)
})

test('installed compiler payload changes miss even if its entry point and version stay unchanged', t => {
  const f = fixture(t)
  const tool = join(f.home, 'compiler')
  cpSync(typescript, tool, { recursive: true })
  rmSync(join(f.root, 'packages/contracts/node_modules/typescript'))
  symlinkSync(tool, join(f.root, 'packages/contracts/node_modules/typescript'), 'dir')
  const manifest = JSON.parse(readFileSync(join(tool, 'package.json'), 'utf8'))
  manifest.optionalDependencies = { 'compiler-payload': '1.0.0' }
  mkdirSync(join(tool, 'node_modules/compiler-payload'), { recursive: true })
  writeFileSync(join(tool, 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(tool, 'node_modules/compiler-payload/package.json'), '{"name":"compiler-payload","version":"1.0.0","main":"index.js"}')
  writeFileSync(join(tool, 'node_modules/compiler-payload/index.js'), 'module.exports = 1')
  f.build()
  writeFileSync(join(tool, 'node_modules/compiler-payload/index.js'), 'module.exports = 2')
  assert.doesNotMatch(f.build(), /build is current/)
  writeFileSync(join(tool, 'lib/_tsc.js'), readFileSync(join(tool, 'lib/_tsc.js'), 'utf8') + '\n// changed compiler payload\n')
  assert.doesNotMatch(f.build(), /build is current/)
})

test('web build configuration includes NODE_ENV, VITE values, ignored env files, and command flags', t => {
  const f = fixture(t)
  f.build('web', { extraEnv: { NODE_ENV: 'production', VITE_SETTING: 'one' } })
  assert.doesNotMatch(f.build('web', { extraEnv: { NODE_ENV: 'development', VITE_SETTING: 'one' } }), /build is current/)
  assert.doesNotMatch(f.build('web', { extraEnv: { NODE_ENV: 'development', VITE_SETTING: 'two' } }), /build is current/)
  f.put('apps/web/.env.production.local', 'VITE_SETTING=from-file')
  assert.doesNotMatch(f.build('web', { extraEnv: { NODE_ENV: 'development', VITE_SETTING: 'two' } }), /build is current/)
  assert.doesNotMatch(f.build('web', { flags: ['--sourceMap'] }), /build is current/)
})

test('both contracts caches ignore README, tests, lint/Vitest config, unrelated manifests and lock trees', t => {
  const f = fixture(t)
  f.put('pnpm-lock.yaml', `lockfileVersion: '9.0'\nimporters:\n  packages/contracts:\n    devDependencies:\n      typescript:\n        specifier: 5.9.3\n        version: 5.9.3\n  apps/api:\n    dependencies:\n      unrelated:\n        specifier: 1.0.0\n        version: 1.0.0\npackages:\n  typescript@5.9.3:\n    resolution: {integrity: compiler-one}\n  unrelated@1.0.0:\n    resolution: {integrity: unrelated-one}\nsnapshots:\n  typescript@5.9.3: {}\n  unrelated@1.0.0: {}\n`)
  const key = f.key()
  f.build()
  f.put('packages/contracts/README.md', 'documentation')
  f.put('packages/contracts/tests/new.test.ts', 'test')
  f.put('packages/contracts/eslint.config.js', 'lint')
  f.put('packages/contracts/vitest.config.ts', 'test config')
  f.put('packages/contracts/package.json', '{"name":"@example/contracts","type":"module","version":"99.0.0","scripts":{"test":"changed"},"devDependencies":{"typescript":"5.9.3"}}')
  f.put('pnpm-lock.yaml', readFileSync(join(f.root, 'pnpm-lock.yaml'), 'utf8').replaceAll('unrelated-one', 'unrelated-two'))
  assert.equal(f.key(), key)
  assert.match(f.build(), /build is current/)
  f.put('pnpm-lock.yaml', readFileSync(join(f.root, 'pnpm-lock.yaml'), 'utf8').replaceAll('compiler-one', 'compiler-two'))
  assert.notEqual(f.key(), key)
})

test('contracts archive key includes the compiler transitive lock tree but ignores unrelated overrides', t => {
  const f = fixture(t)
  f.put('pnpm-lock.yaml', `lockfileVersion: '9.0'\noverrides:\n  unrelated: 1.0.0\nimporters:\n  packages/contracts:\n    devDependencies:\n      typescript:\n        version: 5.9.3\npackages:\n  typescript@5.9.3:\n    resolution: {integrity: compiler}\n  compiler-core@1.0.0:\n    resolution: {integrity: core-one}\nsnapshots:\n  typescript@5.9.3:\n    dependencies:\n      compiler-core: 1.0.0\n  compiler-core@1.0.0: {}\n`)
  const key = f.key()
  f.put('pnpm-lock.yaml', readFileSync(join(f.root, 'pnpm-lock.yaml'), 'utf8').replace('unrelated: 1.0.0', 'unrelated: 2.0.0'))
  assert.equal(f.key(), key)
  f.put('pnpm-lock.yaml', readFileSync(join(f.root, 'pnpm-lock.yaml'), 'utf8').replace('core-one', 'core-two'))
  assert.notEqual(f.key(), key)
})

test('inner contracts cache observes environment and flags when the outer cache misses', t => {
  const f = fixture(t)
  assert.equal(f.contracts('build').status, 0)
  assert.equal(f.contracts('build').status, 0)
  assert.equal(f.count(), 1)
  assert.equal(f.contracts('build', { NODE_OPTIONS: '--stack-trace-limit=20' }).status, 0)
  assert.equal(f.count(), 2)
  assert.equal(f.contracts('ready', { NODE_OPTIONS: '--stack-trace-limit=30' }).status, 1)
  assert.equal(f.contracts('build', {}, ['--sourceMap']).status, 0)
  assert.equal(f.count(), 3)
})

test('contracts keys track uncommitted source and inherited build config, and never trust damaged local/restored outputs', t => {
  const f = fixture(t)
  const key = f.key()
  assert.equal(f.contracts('build').status, 0)
  f.put('packages/contracts/src/index.ts', 'export const value = 2')
  assert.notEqual(f.key(), key)
  assert.equal(f.contracts('ready').status, 1)
  assert.equal(f.contracts('build').status, 0)
  f.put('packages/contracts/dist/index.d.ts', 'damaged local output')
  assert.equal(f.contracts('ready').status, 1)
  assert.equal(f.contracts('build').status, 0)
  assert.equal(readFileSync(join(f.root, 'packages/contracts/dist/index.d.ts'), 'utf8'), 'export const value = 2')
  for (const entry of readdirSync(join(f.home, 'cache'), { withFileTypes: true })) {
    if (entry.isDirectory()) rmSync(join(f.home, 'cache', entry.name, 'index.d.ts'))
  }
  rmSync(join(f.root, 'packages/contracts/dist'), { recursive: true })
  assert.equal(f.contracts('build').status, 0)
  assert.equal(readFileSync(join(f.root, 'packages/contracts/dist/index.d.ts'), 'utf8'), 'export const value = 2')
  const changed = f.key()
  f.put('packages/contracts/tsconfig.json', '{/* build config */"compilerOptions":{"target":"ES2023","types":[],},"include":["src"],}')
  assert.notEqual(f.key(), changed)
  assert.equal(f.contracts('ready').status, 1)
})

test('web assets and embedded runtime identity remain real dependencies', t => {
  const f = fixture(t)
  const asset = join(f.home, 'linked-asset.txt')
  writeFileSync(asset, 'one')
  symlinkSync(asset, join(f.root, 'apps/web/public/linked-asset.txt'))
  f.build('web')
  writeFileSync(asset, 'two')
  assert.doesNotMatch(f.build('web'), /build is current/)
  for (const [path, content] of [['apps/web/public/favicon.svg', '<svg>changed</svg>'], ['apps/api/src/server.ts', 'export const server = 2'], ['packages/contracts/src/new-runtime.mjs', 'export const runtime = 2']]) {
    f.put(path, content)
    assert.doesNotMatch(f.build('web'), /build is current/, path)
  }
})


test('compiler flag overrides change the dependency graph, including ambient declarations', t => {
  const f = fixture(t)
  f.put('packages/contracts/node_modules/@types/extra/package.json', '{"name":"@types/extra","version":"1.0.0","types":"index.d.ts"}')
  f.put('packages/contracts/node_modules/@types/extra/index.d.ts', 'declare const extra: string')
  f.build('contracts', { flags: ['--types', 'extra'] })
  f.put('packages/contracts/node_modules/@types/extra/index.d.ts', 'declare const extra: number')
  assert.doesNotMatch(f.build('contracts', { flags: ['--types', 'extra'] }), /build is current/)
})

test('Vite runtime imports include import-condition JavaScript independently of declarations', t => {
  const f = fixture(t)
  f.put('apps/web/index.html', '<script type="module" src="/src/index.ts"></script>')
  f.put('apps/web/src/index.ts', 'import { value } from "@fixture/runtime"; console.log(value)')
  f.put('apps/web/node_modules/@fixture/runtime/package.json', '{"name":"@fixture/runtime","type":"module","exports":{"types":"./index.d.ts","import":"./esm.js","require":"./cjs.cjs"}}')
  f.put('apps/web/node_modules/@fixture/runtime/index.d.ts', 'export declare const value: string')
  f.put('apps/web/node_modules/@fixture/runtime/esm.js', 'export const value = "one"')
  f.put('apps/web/node_modules/@fixture/runtime/cjs.cjs', 'exports.value = "one"')
  f.build('web')
  f.put('apps/web/node_modules/@fixture/runtime/cjs.cjs', 'exports.value = "unused"')
  assert.match(f.build('web'), /build is current/)
  f.put('apps/web/node_modules/@fixture/runtime/esm.js', 'export const value = "two"')
  assert.doesNotMatch(f.build('web'), /build is current/)
})

test('API compilation stays cached while every invocation runs the harness compatibility probe', t => {
  const f = fixture(t)
  f.build('api', { extraEnv: { PROBE_SETTING: 'one' } })
  assert.match(f.build('api', { extraEnv: { PROBE_SETTING: 'two' } }), /build is current/)
  assert.equal(f.count(), 1)
  assert.equal(readFileSync(join(f.root, '.logs/probes'), 'utf8'), 'one\ntwo\n')
  f.put('apps/worker/src/diagnostics.mjs', 'changed copied runtime asset')
  assert.doesNotMatch(f.build('api'), /build is current/)
  assert.equal(f.count(), 2)
})


test('CI keys only the declarations it consumes, not every contracts artifact', t => {
  const f = fixture(t)
  f.put('packages/contracts/dist/index.js', 'export const value = 1')
  f.put('packages/contracts/dist/index.d.ts', 'export declare const value: number')
  f.put('apps/ci/src/index.ts', 'import type { value } from "../../../packages/contracts/dist/index.js"; export type Value = typeof value')
  f.build('ci')
  f.put('packages/contracts/dist/unused.d.ts', 'export declare const unused: string')
  assert.match(f.build('ci'), /build is current/)
  f.put('packages/contracts/dist/index.d.ts', 'export declare const value: string')
  assert.doesNotMatch(f.build('ci'), /build is current/)
})

test('web mode flags select the env files that participate in freshness', t => {
  const f = fixture(t)
  f.build('web')
  f.put('apps/web/.env.staging', 'VITE_SETTING=staging-one')
  assert.match(f.build('web'), /build is current/)
  assert.doesNotMatch(f.build('web', { flags: ['--mode', 'staging'] }), /build is current/)
  f.put('apps/web/.env.staging', 'VITE_SETTING=staging-two')
  assert.doesNotMatch(f.build('web', { flags: ['--mode', 'staging'] }), /build is current/)
})


test('compiler lock keys ignore optional payloads for other platforms', t => {
  const f = fixture(t)
  f.put('pnpm-lock.yaml', `lockfileVersion: '9.0'
importers:
  packages/contracts:
    devDependencies:
      typescript:
        version: 5.9.3
packages:
  typescript@5.9.3:
    resolution: {integrity: compiler}
  current-payload@1.0.0:
    resolution: {integrity: current-one}
    os: [${process.platform}]
    cpu: [${process.arch}]
  other-payload@1.0.0:
    resolution: {integrity: other-one}
    os: [${process.platform === 'darwin' ? 'linux' : 'darwin'}]
snapshots:
  typescript@5.9.3:
    optionalDependencies:
      current-payload: 1.0.0
      other-payload: 1.0.0
  current-payload@1.0.0: {}
  other-payload@1.0.0: {}
`)
  const key = f.key()
  f.put('pnpm-lock.yaml', readFileSync(join(f.root, 'pnpm-lock.yaml'), 'utf8').replaceAll('other-one', 'other-two'))
  assert.equal(f.key(), key)
  f.put('pnpm-lock.yaml', readFileSync(join(f.root, 'pnpm-lock.yaml'), 'utf8').replaceAll('current-one', 'current-two'))
  assert.notEqual(f.key(), key)
})
