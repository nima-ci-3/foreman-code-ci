import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { CiResultKeys, type CiFileMask, type CiTestTree } from '../src/resultCache.js'
import { functionMasks } from '../src/functionProofs.js'

function tree(files: Record<string, string>): CiTestTree {
  return { blobs: new Map(Object.entries(files).map(([path, text]) => [path, `100644:${createHash('sha1').update(text).digest('hex')}`])),
    read: async path => files[path]! }
}
const base = {
  'package.json': JSON.stringify({ name: 'site', private: true }),
  'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  'apps/api/package.json': JSON.stringify({ name: 'api', devDependencies: { vitest: '4.0.0' } }),
  'apps/api/src/lib/label.ts': 'export const label = (value: string) => value\n',
  'apps/api/test/label.test.ts': "import { expect, it } from 'vitest'\nimport { label } from '../src/lib/label.js'\nit('labels', () => expect(label('a')).toBe('a'))\n",
}

it('keeps an unsplit lockfile in every project and proof key', async () => {
  const files = { ...base,
    'packages/kit/package.json': JSON.stringify({ name: 'kit' }),
    'packages/kit/src/value.test.ts': 'export const value = 1\n',
    'scripts/value.test.mjs': 'export const value = 1\n' }
  for (const lockfile of ['lockfileVersion: 9.0\n', 'lockfileVersion: 9.0\nimporters: {}\n']) {
    const before = await CiResultKeys.create(tree({ ...files, 'pnpm-lock.yaml': lockfile }), AbortSignal.timeout(10_000))
    const after = await CiResultKeys.create(tree({ ...files, 'pnpm-lock.yaml': `${lockfile}# upgraded\n` }), AbortSignal.timeout(10_000))
    for (const file of ['apps/api/test/label.test.ts', 'packages/kit/src/value.test.ts', 'scripts/value.test.mjs']) {
      for (const suite of ['unit', 'integration']) {
        const first = await before.key(file, suite, suite)
        const changed = await after.key(file, suite, suite)
        expect(first.key).toMatch(/^[a-f0-9]{64}$/)
        expect(changed.key).toMatch(/^[a-f0-9]{64}$/)
        expect(changed.key).not.toBe(first.key)
        expect(changed.runnerFreeKey).not.toBe(first.runnerFreeKey)
        const mask: CiFileMask = async () => 'same function inputs'
        const masked = await before.key(file, suite, suite, mask)
        expect(masked.key).toMatch(/^[a-f0-9]{64}$/)
        expect((await after.key(file, suite, suite, mask)).key).not.toBe(masked.key)
      }
    }
  }
})

it('keys tests although a runner script documents an import of a file that does not exist', async () => {
  const keys = await CiResultKeys.create(tree({ ...base,
    // Production had this: one doc comment made every test unkeyed, so nothing was ever cached.
    'scripts/check-boundaries.mjs': "/** Every relative module specifier: `import './x'` and `import('./x')`. */\nexport const check = true\n" }),
  AbortSignal.timeout(10_000))
  expect((await keys.key('apps/api/test/label.test.ts', 'unit', 'unit-api')).key).toMatch(/^[a-f0-9]{64}$/)
})

it('still refuses a key when the test itself imports a file that does not exist', async () => {
  const keys = await CiResultKeys.create(tree({ ...base,
    'apps/api/test/missing.test.ts': "import { gone } from '../src/lib/gone.js'\nexport { gone }\n" }), AbortSignal.timeout(10_000))
  expect(await keys.key('apps/api/test/missing.test.ts', 'unit', 'unit-api')).toMatchObject({ key: null })
})

it('keys tests that import another workspace package through its exports, following its sources', async () => {
  const files = { ...base,
    'packages/kit/package.json': JSON.stringify({ name: '@example/kit', exports: { './server': { import: './dist/server.js' } } }),
    'packages/kit/src/server.ts': 'export const serve = () => 1\n',
    'apps/api/test/serve.test.ts': "import { serve } from '@example/kit/server'\nexport const value = serve()\n" }
  const keys = await CiResultKeys.create(tree(files), AbortSignal.timeout(10_000))
  const first = (await keys.key('apps/api/test/serve.test.ts', 'unit', 'unit-api')).key
  expect(first).toMatch(/^[a-f0-9]{64}$/)
  // A change in the package's source changes the importing test's key.
  const changed = await CiResultKeys.create(tree({ ...files, 'packages/kit/src/server.ts': 'export const serve = () => 2\n' }),
    AbortSignal.timeout(10_000))
  expect((await changed.key('apps/api/test/serve.test.ts', 'unit', 'unit-api')).key).not.toBe(first)
})

it('keys files with a fresh deadline after the deadline that built the graph has passed', async () => {
  // Production: one commit's graph is shared by its parts; its 30 s build deadline expired and every later key failed.
  const built = new AbortController()
  const keys = await CiResultKeys.create(tree(base), built.signal)
  built.abort(new Error('build deadline passed'))
  expect((await keys.bounded(AbortSignal.timeout(10_000)).key('apps/api/test/label.test.ts', 'unit', 'unit-api')).key)
    .toMatch(/^[a-f0-9]{64}$/)
})

it('follows child URLs through generic process wrappers', async () => {
  // Production: formats/supervisor.ts forks "./worker.ts" through a computed URL; editing only the worker kept the key.
  const files = { ...base,
    'apps/api/src/process.ts': "import { fork } from 'node:child_process'\nexport const forkProcess = (path: string) => fork(path)\n",
    'apps/api/src/supervisor.ts': "import { fileURLToPath } from 'node:url'\nimport { forkProcess } from './process.js'\n"
      + 'export const run = () => forkProcess(fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url)))\n',
    'apps/api/src/worker.ts': 'process.send?.(1)\n',
    'apps/api/test/supervisor.test.ts': "import { run } from '../src/supervisor.js'\nexport const value = run\n" }
  const first = (await (await CiResultKeys.create(tree(files), AbortSignal.timeout(10_000))).key('apps/api/test/supervisor.test.ts', 'unit', 'unit-api')).key
  expect(first).toMatch(/^[a-f0-9]{64}$/)
  const changed = await CiResultKeys.create(tree({ ...files, 'apps/api/src/worker.ts': 'process.send?.(2)\n' }), AbortSignal.timeout(10_000))
  expect((await changed.key('apps/api/test/supervisor.test.ts', 'unit', 'unit-api')).key).not.toBe(first)
})

it('keys tests whose code loads modules by computed paths that name their files, and follows those files', async () => {
  // Production: a method named require, `import(join(release, 'apps/x.mjs'))`, a built `dist` path, an installed bundle
  // named by its ci-key and a call inside generated code made 1,344 of 2,248 unit tests unkeyed.
  const files = { ...base,
    'apps/api/src/runtime.ts': "import { join } from 'node:path'\nimport { pathToFileURL } from 'node:url'\n"
      + 'export class Jobs { require(id: string): void { void id } }\n'
      + "export const tool = (release: string) => import(pathToFileURL(join(release, 'apps/api/src/tool.mjs')).href)\n"
      + "export const built = (release: string) => import(pathToFileURL(join(release, 'apps/api/dist/built.js')).href)\n"
      + 'export const host = (path: string) => import(/* ci-key: apps/api/src/host.ts */ pathToFileURL(path).href)\n'
      + "export const script = `const x = await import(pathToFileURL(selector).href)`\n",
    'apps/api/src/tool.mjs': 'export const tool = 1\n',
    'apps/api/src/built.ts': 'export const built = 1\n',
    'apps/api/src/host.ts': 'export const host = 1\n',
    'apps/api/test/runtime.test.ts': "import { tool } from '../src/runtime.js'\nexport const value = tool\n" }
  const keyOf = async (changed: Record<string, string>) => (await (await CiResultKeys.create(tree({ ...files, ...changed }),
    AbortSignal.timeout(10_000))).key('apps/api/test/runtime.test.ts', 'unit', 'unit-api')).key
  const first = await keyOf({})
  expect(first).toMatch(/^[a-f0-9]{64}$/)
  for (const path of ['apps/api/src/tool.mjs', 'apps/api/src/built.ts', 'apps/api/src/host.ts']) {
    expect(await keyOf({ [path]: 'export const changed = 2\n' })).not.toBe(first)
  }
})

it('still refuses a key when tested code loads a module whose path names nothing it can follow', async () => {
  const keys = await CiResultKeys.create(tree({ ...base,
    'apps/api/src/loader.ts': "import { pathToFileURL } from 'node:url'\nexport const load = (path: string) => import(pathToFileURL(path).href)\n",
    'apps/api/test/loader.test.ts': "import { load } from '../src/loader.js'\nexport const value = load\n" }), AbortSignal.timeout(10_000))
  expect(await keys.key('apps/api/test/loader.test.ts', 'unit', 'unit-api')).toMatchObject({ key: null })
})

it('keys tests whose helpers read sibling files and run system tools, and follows the files they read', async () => {
  // Production: any import.meta.url or child_process in a test helper left every test using it unkeyed (434 files).
  const files = { ...base,
    'apps/api/test/fixtures/server.cjs': 'module.exports = 1\n',
    'apps/api/test/fixtures/helpers.ts': "import { execFileSync } from 'node:child_process'\nimport { readFileSync } from 'node:fs'\n"
      + "export const source = () => readFileSync(new URL('./server.cjs', import.meta.url), 'utf8')\n"
      + "export const head = (cwd: string) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })\n",
    'apps/api/test/helpers.test.ts': "import { source } from './fixtures/helpers.js'\nexport const value = source\n" }
  const keyOf = async (changed: Record<string, string>) => (await (await CiResultKeys.create(tree({ ...files, ...changed }),
    AbortSignal.timeout(10_000))).key('apps/api/test/helpers.test.ts', 'unit', 'unit-api')).key
  const first = await keyOf({})
  expect(first).toMatch(/^[a-f0-9]{64}$/)
  expect(await keyOf({ 'apps/api/test/fixtures/server.cjs': 'module.exports = 2\n' })).not.toBe(first)
})

it('still refuses a key when a test helper starts an executable supplied by the host environment', async () => {
  const keys = await CiResultKeys.create(tree({ ...base,
    'apps/api/test/fixtures/run.ts': "import { spawn } from 'node:child_process'\nexport const run = spawn(process.env.BINARY!, [])\n",
    'apps/api/test/run.test.ts': "import { run } from './fixtures/run.js'\nexport const value = run\n" }), AbortSignal.timeout(10_000))
  expect(await keys.key('apps/api/test/run.test.ts', 'unit', 'unit-api')).toMatchObject({ key: null })
})

it('keys the last kinds of unkeyed tests and follows what each one reads', async () => {
  // Production: the remaining 202 unkeyed unit tests named large directories, ran Node scripts held in variables,
  // wrote imports inside fixture strings, imported workspace builds by relative dist paths or used CSS @import.
  const files = { ...base,
    'apps/api/src/deep.ts': 'export const deep = 1\n',
    'apps/api/src/lib/runner.mjs': "import { deep } from '../deep.js'\nexport const run = deep\n",
    'packages/kit/package.json': JSON.stringify({ name: '@example/kit' }),
    'packages/kit/src/value.ts': 'export const value = 1\n',
    'apps/web/src/theme.css': '.a { color: red }\n',
    'apps/web/src/app.css': "@import './theme.css';\n",
    'apps/api/test/fixtures/repo.ts': "import { spawnSync } from 'node:child_process'\nimport { join } from 'node:path'\n"
      + "export const source = 'apps/api/src/lib'\nconst script = join(source, 'runner.mjs')\n"
      + 'export const run = () => spawnSync(process.execPath, [script])\n'
      + "export const fixture = \"import { gone } from './gone.js'\"\n"
      + "export const kit = () => import('../../../../packages/kit/dist/value.js')\n",
    'apps/api/test/repo.test.ts': "import { run } from './fixtures/repo.js'\nimport '../../web/src/app.css'\nexport const value = run\n" }
  const keyOf = async (changed: Record<string, string>) => (await (await CiResultKeys.create(tree({ ...files, ...changed }),
    AbortSignal.timeout(10_000))).key('apps/api/test/repo.test.ts', 'unit', 'unit-api')).key
  const first = await keyOf({})
  expect(first).toMatch(/^[a-f0-9]{64}$/)
  // A script inside the named directory, what that script imports, the workspace build's source and the CSS import.
  for (const path of ['apps/api/src/lib/runner.mjs', 'apps/api/src/deep.ts', 'packages/kit/src/value.ts', 'apps/web/src/theme.css']) {
    expect(await keyOf({ [path]: 'export const changed = 2\n' })).not.toBe(first)
  }
})

it('keys tests that fork a repository file by URL or declare the inputs of artifacts they build and run', async () => {
  // Production: the last 41 unit and 13 integration tests forked children by `new URL(...)` or loaded a Worker bundle
  // they built into a temp directory.
  const files = { ...base,
    'apps/api/test/helpers/child.ts': 'process.send?.(1)\n',
    'apps/api/test/fork.test.ts': "import { fork } from 'node:child_process'\nimport { fileURLToPath } from 'node:url'\n"
      + "export const start = () => fork(fileURLToPath(new URL('./helpers/child.ts', import.meta.url)), [])\n",
    'apps/worker/src/workerFactory.mjs': 'export const worker = 1\n',
    'apps/api/test/artifact.test.ts': '// ci-key-inputs: apps/worker\n'
      + "import { join } from 'node:path'\nimport { pathToFileURL } from 'node:url'\n"
      + "export const load = (artifact: string) => import(pathToFileURL(join(artifact, 'src/worker.mjs')).href)\n" }
  const keyOf = async (test: string, changed: Record<string, string>) => (await (await CiResultKeys.create(
    tree({ ...files, ...changed }), AbortSignal.timeout(10_000))).key(test, 'unit', 'unit-api')).key
  for (const [test, input] of [['apps/api/test/fork.test.ts', 'apps/api/test/helpers/child.ts'],
    ['apps/api/test/artifact.test.ts', 'apps/worker/src/workerFactory.mjs']]) {
    const first = await keyOf(test!, {})
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(await keyOf(test!, { [input!]: 'export const changed = 2\n' })).not.toBe(first)
  }
})

it('keeps test keys when only CI code that cannot change a test outcome, a type-only import or the root version changes', async () => {
  // Production: every commit touching any CI file reran all tests; nothing was ever served from the cache.
  const files = { ...base,
    'scripts/check-import-cycles.mjs': 'export const check = 1\n',
    'scripts/ci-suite.sh': 'pnpm vitest run\n',
    'apps/api/src/lib/shape.ts': 'export type Shape = { a: string }\nexport const shape = 1\n',
    'apps/api/test/typed.test.ts': "import type { Shape } from '../src/lib/shape.js'\nexport const value: Shape = { a: 'a' }\n" }
  const keyOf = async (changes: Record<string, string>, path = 'apps/api/test/label.test.ts') =>
    (await (await CiResultKeys.create(tree({ ...files, ...changes }), AbortSignal.timeout(10_000))).key(path, 'unit', 'unit-api')).key
  const first = await keyOf({})
  expect(first).toMatch(/^[a-f0-9]{64}$/)
  expect(await keyOf({ 'scripts/check-import-cycles.mjs': 'export const check = 2\n' })).toBe(first)
  expect(await keyOf({ 'package.json': JSON.stringify({ name: 'site', private: true, version: '0.0.2' }) })).toBe(first)
  const typed = await keyOf({}, 'apps/api/test/typed.test.ts')
  expect(await keyOf({ 'apps/api/src/lib/shape.ts': 'export type Shape = { a: string }\nexport const shape = 2\n' },
    'apps/api/test/typed.test.ts')).toBe(typed)
  // The script that runs the tests still changes every key.
  expect(await keyOf({ 'scripts/ci-suite.sh': 'pnpm vitest run --pool=forks\n' })).not.toBe(first)
})

it('gives each test its own key although two tests import each other', async () => {
  // Production: tests whose closures reached each other shared one key, and recording their proofs failed
  // ("ON CONFLICT DO UPDATE command cannot affect row a second time"), so no proof was ever stored.
  const keys = await CiResultKeys.create(tree({ ...base,
    'apps/api/test/one.test.ts': "import './two.test.js'\nexport const one = 1\n",
    'apps/api/test/two.test.ts': "import './one.test.js'\nexport const two = 2\n" }), AbortSignal.timeout(10_000))
  const one = (await keys.key('apps/api/test/one.test.ts', 'unit', 'unit-api')).key
  expect(one).toMatch(/^[a-f0-9]{64}$/)
  expect((await keys.key('apps/api/test/two.test.ts', 'unit', 'unit-api')).key).not.toBe(one)
})

it('changes only the keys of tests that import a package whose locked tree changed', async () => {
  // Production: any lockfile change reran every test.
  const lock = (pgVersion: string, vitest = '4.0.0') => ['lockfileVersion: \'9.0\'', 'importers:', '  .: {}', '  apps/api:',
    '    dependencies:', `      pg: { specifier: ^8.0.0, version: ${pgVersion} }`, '      zod: { specifier: ^4.0.0, version: 4.1.0 }',
    '    devDependencies:', `      vitest: { specifier: ^4.0.0, version: ${vitest} }`,
    'packages:', `  pg@${pgVersion}: { resolution: { integrity: sha512-${pgVersion} } }`, '  zod@4.1.0: { resolution: { integrity: sha512-z } }',
    `  vitest@${vitest}: { resolution: { integrity: sha512-${vitest} } }`,
    'snapshots:', `  pg@${pgVersion}: {}`, '  zod@4.1.0: {}', `  vitest@${vitest}: {}`, ''].join('\n')
  const files = { ...base,
    'apps/api/package.json': JSON.stringify({ name: 'api', dependencies: { pg: '^8.0.0', zod: '^4.0.0' }, devDependencies: { vitest: '^4.0.0' } }),
    'apps/api/test/db.test.ts': "import pg from 'pg'\nexport const value = pg\n",
    'apps/api/test/schema.test.ts': "import { z } from 'zod'\nexport const value = z\n" }
  const keysOf = async (lockfile: string) => {
    const keys = await CiResultKeys.create(tree({ ...files, 'pnpm-lock.yaml': lockfile }), AbortSignal.timeout(10_000))
    return Promise.all(['apps/api/test/db.test.ts', 'apps/api/test/schema.test.ts'].map(async file => (await keys.key(file, 'unit', 'unit-api')).key))
  }
  const [db, schema] = await keysOf(lock('8.1.0'))
  const [dbAfter, schemaAfter] = await keysOf(lock('8.2.0'))
  expect(dbAfter).not.toBe(db)
  expect(schemaAfter).toBe(schema)
  // The project's test runner reaches every test of the project.
  const [, schemaNewRunner] = await keysOf(lock('8.1.0', '4.1.0'))
  expect(schemaNewRunner).not.toBe(schema)
})

it('treats the repository root a test setup resolves as a base, not as files the test reads', async () => {
  // Production: setupCoverage.ts's `resolve('../..')` put all 5,422 repository files in 178 tests' keys, so editing
  // any other test file reran them.
  const files = { ...base,
    'apps/api/test/setupCoverage.ts': "import { resolve } from 'node:path'\nexport const root = resolve('../..')\n",
    'apps/api/test/covered.test.ts': "import { root } from './setupCoverage.js'\nexport const value = root\n",
    'apps/api/test/other.test.ts': 'export const other = 1\n' }
  const keyOf = async (changes: Record<string, string>) => (await (await CiResultKeys.create(tree({ ...files, ...changes }),
    AbortSignal.timeout(10_000))).key('apps/api/test/covered.test.ts', 'unit', 'unit-api')).key
  const first = await keyOf({})
  expect(first).toMatch(/^[a-f0-9]{64}$/)
  expect(await keyOf({ 'apps/api/test/other.test.ts': 'export const other = 2\n' })).toBe(first)
})

it('keys an enumerated test directory on names, and explicitly read assets on contents', async () => {
  // Reading a directory observes test names; reading an asset observes its contents.
  const files = { ...base,
    'apps/api/test/ci-host/support.ts': "import { readdirSync, readFileSync } from 'node:fs'\n"
      + "export const repository = { names: readdirSync(new URL('../', import.meta.url)), data: readFileSync(new URL('../data.json', import.meta.url)) }\n",
    'apps/api/test/ci-host/one.test.ts': "import { repository } from './support.js'\nexport const value = repository\n",
    'apps/api/test/two.test.ts': 'export const two = 1\n',
    'apps/api/test/data.json': '{"a":1}\n' }
  const keyOf = async (changes: Record<string, string>) => (await (await CiResultKeys.create(tree({ ...files, ...changes }),
    AbortSignal.timeout(10_000))).key('apps/api/test/ci-host/one.test.ts', 'unit', 'unit-api')).key
  const first = await keyOf({})
  expect(first).toMatch(/^[a-f0-9]{64}$/)
  expect(await keyOf({ 'apps/api/test/two.test.ts': 'export const two = 2\n' })).toBe(first)
  expect(await keyOf({ 'apps/api/test/three.test.ts': 'export const three = 3\n' })).not.toBe(first)
  expect(await keyOf({ 'apps/api/test/data.json': '{"a":2}\n' })).not.toBe(first)
})

it('keys runner regression files only when the test imports them', async () => {
  const regressions = ['scripts/test-integration.test.mjs', 'scripts/integration-process.test.mjs',
    'scripts/integration-capacity.test.mjs', 'scripts/integration-phase.test.mjs']
  const files = { ...base, ...Object.fromEntries(regressions.map(path => [path, 'export const fixture = 1\n'])),
    'scripts/integration-process.mjs': 'export const run = 1\n',
    'apps/api/test/runner.test.ts': "import { fixture } from '../../../scripts/integration-process.test.mjs'\nexport const value = fixture\n" }
  const keyOf = async (changes: Record<string, string>, file = 'apps/api/test/label.test.ts') =>
    (await (await CiResultKeys.create(tree({ ...files, ...changes }), AbortSignal.timeout(10_000))).key(file, 'integration', 'integration')).key
  const first = await keyOf({})
  expect(first).toMatch(/^[a-f0-9]{64}$/)
  for (const path of regressions) expect(await keyOf({ [path]: 'export const fixture = 2\n' })).toBe(first)
  const imported = await keyOf({}, 'apps/api/test/runner.test.ts')
  expect(imported).toMatch(/^[a-f0-9]{64}$/)
  expect(await keyOf({ 'scripts/integration-process.test.mjs': 'export const fixture = 2\n' }, 'apps/api/test/runner.test.ts')).not.toBe(imported)
  expect(await keyOf({ 'scripts/integration-process.mjs': 'export const run = 2\n' })).not.toBe(first)
})

it('keeps protocol declarations out of runtime keys unless a test reads them', async () => {
  const declaration = 'packages/ci-protocol/src/testResults.d.mts'
  const files = { ...base,
    [declaration]: 'export interface Result { passed: number }\n',
    'packages/ci-protocol/src/testResults.mjs': 'export const passed = 1\n',
    'apps/api/test/declarations.test.ts': "import { readFileSync } from 'node:fs'\n"
      + "export const declarations = readFileSync(new URL('../../../packages/ci-protocol/src/testResults.d.mts', import.meta.url), 'utf8')\n" }
  const keyOf = async (changes: Record<string, string>, file = 'apps/api/test/label.test.ts') =>
    (await (await CiResultKeys.create(tree({ ...files, ...changes }), AbortSignal.timeout(10_000))).key(file, 'integration', 'integration')).key
  const first = await keyOf({})
  expect(first).toMatch(/^[a-f0-9]{64}$/)
  const edit = { [declaration]: 'export interface Result { passed: number; failed: number }\n' }
  expect(await keyOf(edit)).toBe(first)
  const reader = await keyOf({}, 'apps/api/test/declarations.test.ts')
  expect(reader).toMatch(/^[a-f0-9]{64}$/)
  expect(await keyOf(edit, 'apps/api/test/declarations.test.ts')).not.toBe(reader)
  expect(await keyOf({ 'packages/ci-protocol/src/testResults.mjs': 'export const passed = 2\n' })).not.toBe(first)
})

it('does not load a Vitest alias replacement until a test imports the target', async () => {
  const files = { ...base,
    'apps/api/package.json': JSON.stringify({ name: '@example/kit', exports: { './tool': './dist/tool.js' }, devDependencies: { vitest: '4.0.0' } }),
    'apps/api/vitest.config.mjs': "import { fileURLToPath, URL } from 'node:url'\nexport default {\n"
      + " resolve: { alias: [{ find: '@example/kit/tool', replacement: fileURLToPath(new URL('./src/tool.ts', import.meta.url)) }] },\n"
      + " test: { setupFiles: ['./test/setup.ts'] }\n}\n",
    'apps/api/test/setup.ts': 'export const setup = 1\n',
    'apps/api/src/tool.ts': "import { helper } from './helper.js'\nexport const tool = () => helper()\n",
    'apps/api/src/helper.ts': 'export const helper = () => 1\n',
    'apps/api/test/tool.test.ts': "import { tool } from '@example/kit/tool'\nexport const value = tool()\n",
  }
  const keyOf = async (changes: Record<string, string>, file = 'apps/api/test/label.test.ts', mask?: CiFileMask) =>
    (await (await CiResultKeys.create(tree({ ...files, ...changes }), AbortSignal.timeout(10_000))).key(file, 'integration', 'integration', mask)).key
  const first = await keyOf({})
  expect(first).toMatch(/^[a-f0-9]{64}$/)
  expect(await keyOf({ 'apps/api/src/helper.ts': 'export const helper = () => 2\n' })).toBe(first)
  const imported = await keyOf({}, 'apps/api/test/tool.test.ts')
  expect(imported).toMatch(/^[a-f0-9]{64}$/)
  expect(await keyOf({ 'apps/api/src/helper.ts': 'export const helper = () => 2\n' }, 'apps/api/test/tool.test.ts')).not.toBe(imported)
  expect(await keyOf({ 'apps/api/test/setup.ts': 'export const setup = 2\n' })).not.toBe(first)
  expect(await keyOf({ 'apps/api/vitest.config.mjs': files['apps/api/vitest.config.mjs'].replace("'@example/kit/tool'", "'other'") })).not.toBe(first)
  // defineConfig's literal form is the API's real configuration shape.
  const configured = "import { defineConfig } from 'vitest/config'\n"
    + files['apps/api/vitest.config.mjs'].replace('export default {', 'export default defineConfig({').replace(/}\n$/, '})\n')
  const configuredKey = await keyOf({ 'apps/api/vitest.config.mjs': configured })
  expect(configuredKey).toMatch(/^[a-f0-9]{64}$/)
  expect(await keyOf({ 'apps/api/vitest.config.mjs': configured, 'apps/api/src/helper.ts': 'export const helper = () => 2\n' })).toBe(configuredKey)
  // The same URL outside the alias is still an input, as is an alias that overrides ordinary package resolution.
  for (const config of [files['apps/api/vitest.config.mjs'].replace("'./test/setup.ts'", "'./src/tool.ts'"),
    files['apps/api/vitest.config.mjs'].replace("'@example/kit/tool'", "'custom-alias'"),
    files['apps/api/vitest.config.mjs'].replace(' test: {', ' plugins: [], test: {'),
    "import { readFileSync } from 'node:fs'\n" + files['apps/api/vitest.config.mjs'].replace("new URL('./src/tool.ts', import.meta.url)", "new URL('./src/tool.ts', import.meta.url), 'utf8'")
      .replace('replacement: fileURLToPath(', 'replacement: readFileSync('),
    "import './src/tool.ts'\n" + files['apps/api/vitest.config.mjs']]) {
    const key = await keyOf({ 'apps/api/vitest.config.mjs': config })
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    expect(await keyOf({ 'apps/api/vitest.config.mjs': config, 'apps/api/src/helper.ts': 'export const helper = () => 2\n' })).not.toBe(key)
  }
  const override = { 'apps/api/package.json': JSON.stringify({ name: '@example/kit', exports: { './tool': './dist/helper.js' },
    devDependencies: { vitest: '4.0.0' } }) }
  const overridden = await keyOf(override)
  expect(overridden).toMatch(/^[a-f0-9]{64}$/)
  expect(await keyOf({ ...override, 'apps/api/src/helper.ts': 'export const helper = () => 2\n' })).not.toBe(overridden)
  // Once the alias stops making this a harness file, existing function proofs can distinguish its callers.
  const test = 'apps/api/test/tool.test.ts'
  const helper = 'apps/api/src/helper.ts'
  const mask = functionMasks({ sets: [['/helper#0']], tests: { [test]: { [helper]: 0 } } })(test)
  const withUnused = 'export const helper = () => 1\nexport const unused = () => 2\n'
  const masked = await keyOf({ [helper]: withUnused }, test, mask)
  expect(masked).toMatch(/^[a-f0-9]{64}$/)
  expect(await keyOf({ [helper]: withUnused.replace('=> 2', '=> 3') }, test, mask)).toBe(masked)
  expect(await keyOf({ [helper]: withUnused.replace('=> 1', '=> 3') }, test, mask)).not.toBe(masked)
})
