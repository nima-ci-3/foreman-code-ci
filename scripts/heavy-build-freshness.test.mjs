import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const compilerApi = createRequire(new URL('../apps/ci/package.json', import.meta.url)).resolve('typescript')
const projects = { contracts: ['packages/contracts', 'index'], 'contracts-node': ['packages/contracts-node', 'serverKit'], ci: ['apps/ci', 'environment'] }

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'heavy-freshness-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const root = join(home, 'source')
  mkdirSync(join(root, 'scripts'), { recursive: true })
  for (const name of ['heavy-job.mjs', 'heavy-job-slots.mjs', 'sleep.mjs', 'ci-contracts.mjs', 'build-cache-inputs.mjs']) {
    copyFileSync(new URL(name, import.meta.url), join(root, 'scripts', name))
  }
  for (const [project, entry] of Object.values(projects)) {
    mkdirSync(join(root, project, 'src'), { recursive: true })
    mkdirSync(join(root, project, 'node_modules/typescript'), { recursive: true })
    writeFileSync(join(root, project, 'node_modules/typescript/index.js'), `module.exports = require(${JSON.stringify(compilerApi)})`)
    writeFileSync(join(root, project, 'node_modules/typescript/package.json'), '{"name":"typescript","version":"5.9.3","main":"index.js"}')
    writeFileSync(join(root, project, 'package.json'), '{"type":"module"}')
    writeFileSync(join(root, project, 'tsconfig.build.json'), '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","target":"ES2022","allowJs":true,"types":[]},"include":["src"],"exclude":["src/**/*.test.ts"]}')
    writeFileSync(join(root, project, 'src', `${entry}.ts`), 'export const value = 1')
    writeFileSync(join(root, project, 'src/deviceIdentityNode.ts'), 'export const removed = true')
  }
  for (const name of ['installationNames.mjs', 'productEnvironment.mjs', 'runtimeBuildIdentityNode.mjs']) {
    copyFileSync(new URL(`../packages/contracts/src/${name}`, import.meta.url), join(root, 'packages/contracts/src', name))
  }
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(root, '.gitignore'), 'node_modules/\ndist/\n.logs/\n')
  // Model the incremental emitter's relevant public behavior without running TypeScript:
  // unchanged inputs are not emitted again, and removed sources leave outputs behind.
  writeFileSync(join(root, 'scripts/tsc.cjs'), `
const fs = require('node:fs'), path = require('node:path');
const project = path.dirname(process.argv[process.argv.indexOf('-p') + 1]);
const variant = process.argv[process.argv.indexOf('--sourceRoot') + 1];
const output = path.join(project, 'dist');
const info = path.join(output, '.tsbuildinfo');
const previous = fs.existsSync(info) ? JSON.parse(fs.readFileSync(info)) : {};
const current = {};
fs.mkdirSync(output, {recursive:true});
for (const file of fs.readdirSync(path.join(project, 'src')).filter(file => file.endsWith('.ts'))) {
  const source = fs.readFileSync(path.join(project, 'src', file), 'utf8');
  current[file] = source;
  if (previous[file] === source) continue;
  for (const suffix of ['.js', '.d.ts', '.js.map']) {
    fs.writeFileSync(path.join(output, file.slice(0, -3) + suffix), variant + '\\n' + source);
  }
}
fs.writeFileSync(info, JSON.stringify(current));
fs.appendFileSync('.logs/emissions', project + '\\n');
if (variant === 'failed') process.exit(7);
`)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('GIT_') && !/^(?:GRAPHQL|FOREMAN_CODE)_HEAVY_/.test(key)))
  Object.assign(env, { FOREMAN_CODE_HEAVY_BASE_TMPDIR: home, FOREMAN_CODE_VERIFICATION_ROOT: '',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
  delete env.CI_HOST_RUNNER
  delete env.FOREMAN_CODE_CI_CONTRACTS_CACHE
  const run = (command, args, environment = env) => spawnSync(command, args,
    { cwd: root, env: environment, encoding: 'utf8', timeout: 15000 })
  const git = (...args) => {
    const result = run('git', args)
    assert.equal(result.status, 0, result.stderr)
  }
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')
  mkdirSync(join(root, '.logs'))
  const compiler = (kind, variant = 'ordinary') => [process.execPath, 'scripts/tsc.cjs', '-p', `${projects[kind][0]}/tsconfig.build.json`, '--sourceRoot', variant]
  const build = (kind, { variant, nested = false, cached = false } = {}) => {
    const args = ['scripts/heavy-job.mjs', '--build', kind, '--', ...compiler(kind, variant)]
    const result = run(process.execPath, nested ? ['scripts/heavy-job.mjs', '--', process.execPath, ...args] : args,
      { ...env, ...(cached ? { FOREMAN_CODE_CI_CONTRACTS_CACHE: join(home, 'cache') } : {}) })
    if (variant !== 'failed') assert.equal(result.status, 0, result.stdout + result.stderr)
    return result
  }
  const output = (kind, file = `${projects[kind][1]}.d.ts`) => join(root, projects[kind][0], 'dist', file)
  return { home, root, env, run, git, build, compiler, output }
}

for (const kind of Object.keys(projects)) {
  test(`${kind}: a cache miss replaces stale incremental output, including deleted sources`, t => {
    const f = fixture(t)
    const seed = f.compiler(kind)
    assert.equal(f.run(seed[0], seed.slice(1)).status, 0)
    writeFileSync(f.output(kind), 'stale declaration')
    rmSync(join(f.root, projects[kind][0], 'src/deviceIdentityNode.ts'))
    f.git('add', '-A')
    f.build(kind, { nested: kind === 'ci' })
    assert.equal(readFileSync(f.output(kind), 'utf8'), 'ordinary\nexport const value = 1')
    for (const suffix of ['.js', '.d.ts', '.js.map']) assert.equal(existsSync(f.output(kind, `deviceIdentityNode${suffix}`)), false)
    assert.match(f.build(kind).stdout, /build is current/)
  })
}

test('changed or missing declarations are repaired instead of stamping an incremental no-op', t => {
  const f = fixture(t)
  f.build('contracts')
  writeFileSync(f.output('contracts'), 'written by another emitter')
  f.build('contracts')
  assert.equal(readFileSync(f.output('contracts'), 'utf8'), 'ordinary\nexport const value = 1')
  rmSync(f.output('contracts'))
  f.build('contracts')
  assert.equal(readFileSync(f.output('contracts'), 'utf8'), 'ordinary\nexport const value = 1')
  assert.match(f.build('contracts').stdout, /build is current/)
})

test('changing the build command cannot reuse another command\'s stamp', t => {
  const f = fixture(t)
  f.build('contracts')
  f.build('contracts', { variant: 'different-emitter' })
  assert.equal(readFileSync(f.output('contracts'), 'utf8'), 'different-emitter\nexport const value = 1')
})

test('the installed native compiler participates in freshness even when the JS compiler is unchanged', t => {
  const f = fixture(t)
  const native = join(f.root, 'packages/contracts/node_modules/@typescript/native')
  mkdirSync(native, { recursive: true })
  writeFileSync(join(native, 'index.js'), 'module.exports = "native-one"')
  writeFileSync(join(native, 'package.json'), '{"name":"@typescript/native","version":"7.0.1","main":"index.js"}')
  f.build('contracts')
  writeFileSync(join(native, 'index.js'), 'module.exports = "native-two"')
  assert.doesNotMatch(f.build('contracts').stdout, /build is current/)
  writeFileSync(join(native, 'package.json'), '{"name":"@typescript/native","version":"7.0.2","main":"index.js"}')
  assert.doesNotMatch(f.build('contracts').stdout, /build is current/)
  f.build('contracts', { cached: true })
  writeFileSync(join(native, 'package.json'), '{"name":"@typescript/native","version":"7.0.3","main":"index.js"}')
  assert.equal(f.run(process.execPath, ['scripts/ci-contracts.mjs', 'ready', f.root]).status, 1)
})

test('CI freshness includes the declarations it consumes from contracts', t => {
  const f = fixture(t)
  f.build('contracts')
  writeFileSync(join(f.root, 'apps/ci/src/contractTypes.ts'), '/// <reference path="../../../packages/contracts/dist/index.d.ts" />\nexport {}')
  f.build('ci')
  writeFileSync(f.output('contracts'), 'changed dependency declaration')
  assert.doesNotMatch(f.build('ci').stdout, /build is current/)
})

test('failed emission cannot leave a usable build stamp or poison the next successful build', t => {
  const f = fixture(t)
  f.build('contracts')
  assert.equal(f.build('contracts', { variant: 'failed' }).status, 7)
  assert.equal(existsSync(join(f.root, '.logs/heavy-build-contracts.json')), false)
  f.build('contracts')
  assert.equal(readFileSync(f.output('contracts'), 'utf8'), 'ordinary\nexport const value = 1')
  assert.match(f.build('contracts').stdout, /build is current/)
})

test('the shared contracts cache rejects modified output and keys uncommitted source contents', t => {
  const f = fixture(t)
  f.build('contracts', { cached: true })
  writeFileSync(f.output('contracts'), 'corrupted restored declaration')
  f.build('contracts', { cached: true })
  assert.equal(readFileSync(f.output('contracts'), 'utf8'), 'ordinary\nexport const value = 1')
  f.build('contracts', { cached: true, variant: 'different-emitter' })
  assert.equal(readFileSync(f.output('contracts'), 'utf8'), 'different-emitter\nexport const value = 1')
  writeFileSync(join(f.root, 'packages/contracts/src/index.ts'), 'export const value = 2')
  f.build('contracts', { cached: true })
  assert.equal(readFileSync(f.output('contracts'), 'utf8'), 'ordinary\nexport const value = 2')
  const ready = () => f.run(process.execPath, ['scripts/ci-contracts.mjs', 'ready', f.root])
  assert.equal(ready().status, 0)
  writeFileSync(f.output('contracts'), 'watcher replaced a declaration')
  assert.equal(ready().status, 1)
})

test('the shared contracts cache rebuilds a damaged cached artifact instead of restoring it', t => {
  const f = fixture(t)
  f.build('contracts', { cached: true })
  const cache = join(f.home, 'cache')
  const cached = readdirSync(cache, { withFileTypes: true }).find(entry => entry.isDirectory()).name
  rmSync(join(cache, cached, 'index.d.ts'))
  rmSync(join(f.root, 'packages/contracts/dist'), { recursive: true })
  f.build('contracts', { cached: true })
  assert.equal(readFileSync(f.output('contracts'), 'utf8'), 'ordinary\nexport const value = 1')
})

test('the shared contracts cache supports worktrees with symlinked node_modules', t => {
  const f = fixture(t)
  const modules = join(f.root, 'packages/contracts/node_modules')
  const shared = join(f.home, 'shared-modules')
  renameSync(modules, shared)
  symlinkSync(shared, modules, 'dir')
  f.build('contracts', { cached: true })
  assert.equal(readFileSync(f.output('contracts'), 'utf8'), 'ordinary\nexport const value = 1')
  assert.match(f.build('contracts', { cached: true }).stdout, /build is current/)
})
