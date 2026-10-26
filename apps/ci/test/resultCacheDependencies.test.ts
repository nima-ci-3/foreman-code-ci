import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { expect, it } from 'vitest'
import { CiResultKeys, type CiTestTree } from '../src/resultCache.js'

type Files = Record<string, string>
const test = 'apps/api/test/value.test.ts'
const base: Files = {
  'package.json': JSON.stringify({ name: 'root', type: 'module', scripts: { test: 'vitest run', 'test:integration': 'node scripts/test-integration.mjs' } }),
  'apps/api/package.json': JSON.stringify({ name: 'api', type: 'module', dependencies: { zod: '1' }, devDependencies: { vitest: '1', eslint: '1' } }),
  [test]: "import { value } from '../src/value.js'; export { value }",
  'apps/api/src/value.ts': 'export const value = 1',
}
function tree(files: Files): CiTestTree {
  return { blobs: new Map(Object.entries(files).map(([path, text]) => [path, `100644:${createHash('sha1').update(text).digest('hex')}`])),
    read: async path => { if (!(path in files)) throw new Error(`Missing ${path}`); return files[path]! } }
}
async function key(files: Files, file = test, suite = 'unit') {
  return (await CiResultKeys.create(tree(files), AbortSignal.timeout(10_000))).key(file, suite, suite === 'unit' ? 'unit-api' : 'integration')
}
async function unchanged(files: Files, changes: Files, file = test) {
  const first = await key(files, file)
  expect(first.key).toMatch(/^[a-f0-9]{64}$/)
  expect(await key({ ...files, ...changes }, file)).toEqual(first)
}
async function changed(files: Files, changes: Files, file = test, suite = 'unit') {
  const first = await key(files, file, suite)
  expect(first.key).toMatch(/^[a-f0-9]{64}$/)
  expect((await key({ ...files, ...changes }, file, suite)).key).not.toBe(first.key)
}

it('keeps unrelated root files and project assets out, but follows actual reads', async () => {
  const files: Files = { ...base, '.editorconfig': 'a', 'apps/api/test/image.png': 'one',
    'apps/api/src/value.ts': "import { readFileSync } from 'node:fs'; export const value = readFileSync(new URL('../test/image.png', import.meta.url))" }
  await unchanged({ ...files, 'apps/api/src/value.ts': base['apps/api/src/value.ts']! }, { '.editorconfig': 'b', 'apps/api/test/image.png': 'two' })
  await changed(files, { 'apps/api/test/image.png': 'two' })
  await unchanged(files, { '.editorconfig': 'b' })
})

it('hashes effective runtime manifest and compiler fields, including inherited settings', async () => {
  const manifest = JSON.parse(base['apps/api/package.json']!)
  const files: Files = { ...base, 'apps/api/tsconfig.json': '{"extends":"../../tsconfig.base.json","compilerOptions":{"strict":true}}',
    'tsconfig.base.json': '{"compilerOptions":{"jsx":"automatic","strict":true}}',
    'apps/api/tsconfig.build.json': '{"compilerOptions":{"declaration":true}}' }
  await unchanged(files, { 'apps/api/package.json': JSON.stringify({ ...manifest, description: 'documentation', scripts: { lint: 'eslint .' } }),
    'apps/api/tsconfig.build.json': '{"compilerOptions":{"declaration":false}}',
    'apps/api/tsconfig.json': '{"extends":"../../tsconfig.base.json","compilerOptions":{"strict":false},"include":["src"]}' })
  await changed(files, { 'apps/api/package.json': JSON.stringify({ ...manifest, type: 'commonjs' }) })
  await changed(files, { 'tsconfig.base.json': '{"compilerOptions":{"jsx":"preserve"}}' })
})

it('uses raw manifests and configs when a test actually reads them', async () => {
  const files: Files = { ...base, 'apps/api/src/value.ts': "import { readFileSync } from 'node:fs'; export const value = readFileSync(new URL('../../../package.json', import.meta.url))" }
  await changed(files, { 'package.json': JSON.stringify({ ...JSON.parse(base['package.json']!), description: 'new' }) })
})

it('scopes execution files by suite, including imports reached through a shared runner', async () => {
  const files: Files = { ...base, 'scripts/ci-suite.sh': 'run tests',
    'scripts/ci-affected-run.mjs': "import './ci-files.mjs'",
    'scripts/ci-files.mjs': 'export const files = 1',
    'scripts/test-integration.mjs': "import './integration-only.mjs'",
    'scripts/integration-only.mjs': 'export const run = 1',
    '.github/workflows/ci-cache.yml': 'warm cache' }
  for (const path of ['scripts/test-integration.mjs', 'scripts/integration-only.mjs', '.github/workflows/ci-cache.yml']) {
    await unchanged(files, { [path]: 'changed' })
  }
  await changed(files, { 'scripts/test-integration.mjs': 'changed' }, test, 'integration')
  await changed(files, { 'scripts/ci-files.mjs': 'changed' })
  await changed(files, { 'scripts/ci-suite.sh': 'changed' })
})

it('follows Vitest setup only in projects whose execution config loads it', async () => {
  const files: Files = { ...base, 'apps/api/vitest.config.mjs': "export default { test: { setupFiles: ['../../scripts/vitest-setup.mjs'] } }",
    'scripts/vitest-setup.mjs': 'export const setup = 1',
    'packages/contracts/package.json': '{"name":"contracts"}',
    'packages/contracts/src/value.test.ts': 'export const value = 1' }
  await changed(files, { 'scripts/vitest-setup.mjs': 'export const setup = 2' })
  await unchanged(files, { 'scripts/vitest-setup.mjs': 'export const setup = 2' }, 'packages/contracts/src/value.test.ts')
})

it('ignores paths in comments and fixture strings while following filesystem arguments', async () => {
  const files: Files = { ...base, [test]: "import { readFileSync } from 'node:fs';\n// apps/api/src/other\nconst fixture = 'apps/api/src/other';\nexport const value = readFileSync(new URL('./fixture.txt', import.meta.url))",
    'apps/api/src/other/data.json': 'one', 'apps/api/test/fixture.txt': 'one' }
  await unchanged(files, { 'apps/api/src/other/data.json': 'two' })
  await changed(files, { 'apps/api/test/fixture.txt': 'two' })
  const fixture = "export const fixture = `\n// ci-key-inputs: apps/api/src/other\n`; export const value = 1"
  await unchanged({ ...files, [test]: fixture }, { 'apps/api/src/other/data.json': 'two' })
})

it('erases named type-only imports and exports, preserving mixed runtime imports', async () => {
  const files: Files = { ...base, [test]: "import { type Shape as Renamed } from '../src/types.js';\nexport { type Shape } from '../src/types.js';\nexport const value = 1;",
    'apps/api/src/types.ts': 'export type Shape = string' }
  await unchanged(files, { 'apps/api/src/types.ts': 'export type Shape = number' })
  await changed({ ...files, [test]: "import { type Shape, value } from '../src/types.js'; export { value };" },
    { 'apps/api/src/types.ts': 'export const value = 2; export type Shape = number' })
  await changed({ ...files, [test]: "import {} from '../src/types.js'" }, { 'apps/api/src/types.ts': 'console.log(1)' })
})

function lock(eslint = '1', runner = '1', zod = '1', policies = '') {
  return `lockfileVersion: '9.0'\n${policies}\nimporters:\n  .: {}\n  apps/api:\n    dependencies:\n      zod: { version: '${zod}' }\n    devDependencies:\n      vitest: { version: '${runner}' }\n      eslint: { version: '${eslint}' }\npackages:\n  zod@${zod}: { resolution: { integrity: z${zod} } }\n  vitest@${runner}: { resolution: { integrity: v${runner} } }\n  eslint@${eslint}: { resolution: { integrity: e${eslint} } }\nsnapshots:\n  zod@${zod}: {}\n  vitest@${runner}: {}\n  eslint@${eslint}: {}\n`
}
it('keys execution tools and imported packages instead of unused devDependencies', async () => {
  const files: Files = { ...base, 'pnpm-lock.yaml': lock() }
  await unchanged(files, { 'pnpm-lock.yaml': lock('2'), 'apps/api/package.json': JSON.stringify({
    ...JSON.parse(base['apps/api/package.json']!), devDependencies: { vitest: '1', eslint: '2' },
  }) })
  await changed(files, { 'pnpm-lock.yaml': lock('1', '2') })
  await changed({ ...files, [test]: "import eslint from 'eslint'; export { eslint }" }, { 'pnpm-lock.yaml': lock('2') })
})

it('scopes overrides and patches to the resolved dependency tree', async () => {
  const files: Files = { ...base, 'pnpm-lock.yaml': lock('1', '1', '1', 'overrides: { unrelated: "2" }\npatchedDependencies: { unrelated@1: old }') }
  await unchanged(files, { 'pnpm-lock.yaml': lock('1', '1', '1', 'overrides: { unrelated: "3" }\npatchedDependencies: { unrelated@1: new }') })
  const usesZod = { ...files, [test]: "import z from 'zod'; export { z }" }
  await changed(usesZod, { 'pnpm-lock.yaml': lock('1', '1', '2', 'overrides: { zod: "2" }') })
  await changed(usesZod, { 'pnpm-lock.yaml': lock('1', '1', '1', 'patchedDependencies: { zod@1: patched }') })
})

it('declared compiled artifacts cover source, build configuration and compiler dependencies', async () => {
  const files: Files = { ...base, [test]: '// ci-key-inputs: packages/contracts/src packages/contracts/tsconfig.build.json packages/contracts/package.json typescript\n'
    + "import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; const execute = promisify(execFile); export const run = (binary) => execute(binary, ['-p', 'tsconfig.build.json'])",
    'packages/contracts/package.json': '{"name":"contracts","devDependencies":{"typescript":"1"}}',
    'packages/contracts/tsconfig.build.json': '{"include":["src"]}',
    'packages/contracts/src/value.ts': 'export const value = 1' }
  for (const path of ['packages/contracts/src/value.ts', 'packages/contracts/tsconfig.build.json', 'packages/contracts/package.json']) {
    await changed(files, { [path]: path.endsWith('package.json') ? '{"name":"contracts","version":"2"}' : `${files[path]}\n` })
  }
})

it('covers parameterized content readers, including renamed and namespace readers, with project data', async () => {
  for (const source of [
    "import { readFileSync } from 'node:fs'; export const value = (path) => readFileSync(path)",
    "import { readFile as $read } from 'node:fs/promises'; export const value = (root) => $read(root)",
    "import * as fs from 'node:fs'; export const value = (root) => fs.readFileSync(root)",
    "import { readFileSync } from 'node:fs'; const path = new URL('./known.json', import.meta.url); export const value = (path) => readFileSync(path)",
  ]) await changed({ ...base, 'apps/api/src/value.ts': source, 'apps/api/src/known.json': 'one' }, { 'apps/api/src/known.json': 'two' })
  await changed({ ...base, 'apps/api/src/value.ts': "import { readFileSync } from 'node:fs'; export const value = readFileSync('apps/api/test/data.json')",
    'apps/api/test/data.json': 'one' }, { 'apps/api/test/data.json': 'two' })
})

it('keys parameterized directory readers on names instead of unrelated file contents', async () => {
  for (const source of [
    "import { readdir as list } from 'node:fs/promises'; export const value = (root) => list(root)",
    "import * as fs from 'node:fs'; export const value = (root) => fs.readdirSync(root)",
  ]) {
    const files = { ...base, 'apps/api/src/value.ts': source, 'apps/api/src/known.json': 'one' }
    await unchanged(files, { 'apps/api/src/known.json': 'two' })
    await changed(files, { 'apps/api/src/added.json': 'new name' })
  }
})

it('refuses actual external file inputs rather than inferring them from parameters', async () => {
  for (const source of [
    "import { readFileSync } from 'node:fs'; export const value = readFileSync(process.env.FILE ?? './known.json')",
    "import { readFileSync } from 'node:fs'; const path = process.env.FILE; export const value = readFileSync(path)",
    "import { readFileSync } from 'node:fs'; export const value = readFileSync('/opt/external/data.json')",
  ]) expect(await key({ ...base, 'apps/api/src/value.ts': source })).toMatchObject({ key: null })
})

it('treats filesystem contents as data, and directory enumeration as names', async () => {
  const files: Files = { ...base, 'apps/api/src/value.ts': "import { readFileSync } from 'node:fs'; export const value = readFileSync(new URL('./data.mjs', import.meta.url))",
    'apps/api/src/data.mjs': "import './other.js'", 'apps/api/src/other.ts': 'export const other = 1' }
  await unchanged(files, { 'apps/api/src/other.ts': 'export const other = 2' })
  await changed(files, { 'apps/api/src/data.mjs': 'new contents' })
  const enumerates = { ...files, 'apps/api/src/value.ts': "import { readdirSync } from 'node:fs'; export const value = readdirSync(new URL('./assets', import.meta.url))",
    'apps/api/src/assets/a.png': 'one' }
  await unchanged(enumerates, { 'apps/api/src/assets/a.png': 'two' })
  await changed(enumerates, { 'apps/api/src/assets/b.png': 'three' })
  const recursive = { ...enumerates, 'apps/api/src/value.ts': "import { readdirSync as list } from 'node:fs'; export const value = list(new URL('./assets', import.meta.url), { recursive: true })",
    'apps/api/src/assets/nested/a.png': 'nested' }
  await unchanged(recursive, { 'apps/api/src/assets/nested/a.png': 'new contents' })
  await changed(recursive, { 'apps/api/src/assets/nested/b.png': 'new name' })
})

it('follows constant variable paths and explicit declarations for production directory reads', async () => {
  const source = "import { readFileSync } from 'node:fs'; const path = new URL('./data.json', import.meta.url); export const value = readFileSync(path)"
  const files: Files = { ...base, 'apps/api/src/value.ts': source, 'apps/api/src/data.json': 'one' }
  await changed(files, { 'apps/api/src/data.json': 'two' })
  const declared = { ...files, 'apps/api/src/value.ts': '// ci-key-inputs: apps/api/src/assets\n'
    + "import { readdirSync } from 'node:fs'; export const value = (root) => readdirSync(root)", 'apps/api/src/assets/image.png': 'one' }
  await changed(declared, { 'apps/api/src/assets/image.png': 'two' })
})

it('keys generic process wrappers on their source and refuses an environment-supplied executable', async () => {
  const source = "import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; const execute = promisify(execFile); export const value = (binary) => execute(binary, [])"
  for (const file of [test, 'apps/api/src/value.ts']) {
    await changed({ ...base, [file]: source }, { [file]: source.replace('[]', '["--version"]') })
  }
  expect(await key({ ...base, [test]: "import { execFile } from 'node:child_process'; export const value = execFile(process.env.BINARY, [])" }))
    .toMatchObject({ key: null })
})

it('covers undeclared build commands with project source, raw configuration and installed build tools', async () => {
  const files: Files = { ...base, [test]: "import { execFileSync } from 'node:child_process'; export const value = execFileSync('tsc', ['-p', 'tsconfig.build.json'])",
    'apps/api/tsconfig.build.json': '{"include":["src"]}', 'pnpm-lock.yaml': lock() }
  await changed(files, { 'apps/api/src/value.ts': 'export const value = 2' })
  await changed(files, { 'apps/api/tsconfig.build.json': '{"include":["other"]}' })
  await changed(files, { 'pnpm-lock.yaml': lock('2') })
})

it('tracks the script and imports of a Node child whose path is held in constants', async () => {
  const files: Files = { ...base, [test]: "import { spawnSync } from 'node:child_process'; import { join } from 'node:path';\n"
    + "const source = 'apps/api/src';\nconst script = join(source, 'child.mjs');\nexport const value = spawnSync(process.execPath, [script])",
    'apps/api/src/child.mjs': "import './value.js'" }
  await changed(files, { 'apps/api/src/value.ts': 'export const value = 2' })
})

it('shares cyclic transitive closures without losing file or dependency identity', async () => {
  const files: Files = { ...base, [test]: "import '../src/a.js'", 'apps/api/test/second.test.ts': "import '../src/b.js'",
    'apps/api/src/a.ts': "import './b.js'; export const a = 1", 'apps/api/src/b.ts': "import './a.js'; import './value.js'" }
  const graph = await CiResultKeys.create(tree(files), AbortSignal.timeout(10_000))
  expect((await graph.key(test, 'unit', 'unit-api')).key).not.toBe((await graph.key('apps/api/test/second.test.ts', 'unit', 'unit-api')).key)
  for (const file of [test, 'apps/api/test/second.test.ts']) await changed(files, { 'apps/api/src/value.ts': 'export const value = 2' }, file)
})

it('keys a large shared closure batch within one second', async () => {
  const files = { ...base }
  const tests = Array.from({ length: 1200 }, (_, index) => `apps/api/test/batch${index}.test.ts`)
  for (const file of tests) files[file] = "import '../src/shared0.js'"
  for (let index = 0; index < 400; index++) files[`apps/api/src/shared${index}.ts`] = index === 399 ? 'export const end = 1' : `import './shared${index + 1}.js'`
  const start = performance.now()
  const graph = await CiResultKeys.create(tree(files), AbortSignal.timeout(10_000))
  const results = await Promise.all(tests.map(file => graph.key(file, 'unit', 'unit-api')))
  expect(results.every(result => result.key !== null)).toBe(true)
  expect(new Set(results.map(result => result.key)).size).toBe(tests.length)
  expect(performance.now() - start).toBeLessThan(1000)
  console.log(`Shared closure batch: ${Math.round(performance.now() - start)} ms for ${tests.length} keys`)
})

it('keys parameterized runtime I/O on project data instead of refusing every caller', async () => {
  const files: Files = { ...base,
    'apps/api/src/value.ts': "import { readFileSync, readdirSync } from 'node:fs'; export const value = (path) => [readFileSync(path), readdirSync(path)]",
    'apps/api/test/fixtures/data.json': '{"a":1}', 'apps/api/migrations/schema.sql': 'select 1',
    'apps/api/test/fixtures/generated.ts': 'export const fixture = 1',
    'apps/other/data.json': 'unrelated' }
  for (const path of ['apps/api/test/fixtures/data.json', 'apps/api/migrations/schema.sql', 'apps/api/test/fixtures/generated.ts']) {
    await changed(files, { [path]: `${files[path]}\n` })
  }
  await changed(files, { 'apps/api/test/fixtures/new.json': 'new input' })
  await unchanged(files, { 'apps/other/data.json': 'changed' })
})

it('covers repository reads with relative working directories and proves missing generated inputs absent', async () => {
  const files: Files = { ...base,
    'apps/api/src/value.ts': "import { readFileSync, existsSync } from 'node:fs'; export const value = [readFileSync('test/data.json'), existsSync(new URL('./generated.json', import.meta.url))]",
    'apps/api/test/data.json': 'one' }
  await changed(files, { 'apps/api/test/data.json': 'two' })
  await changed(files, { 'apps/api/src/generated.json': 'now present' })
})

it('follows paths passed to generic process wrappers and keys inline child code by its source', async () => {
  const files: Files = { ...base,
    'apps/api/src/process.ts': "import { fork, spawn } from 'node:child_process'; export const run = (path) => fork(path); export const inline = () => spawn(process.execPath, ['-e', 'process.exit(0)'])",
    'apps/api/src/value.ts': "import { run } from './process.js'; export const value = () => run(new URL('./child.mjs', import.meta.url))",
    'apps/api/src/child.mjs': "import './dependency.js'", 'apps/api/src/dependency.ts': 'export const value = 1' }
  await changed(files, { 'apps/api/src/child.mjs': 'process.exit(0)' })
  await changed(files, { 'apps/api/src/dependency.ts': 'export const value = 2' })
  await changed(files, { 'apps/api/src/process.ts': files['apps/api/src/process.ts']!.replace('process.exit(0)', 'process.exit(1)') })
})

it('does not mistake an imported host-inspection capability for an external test input', async () => {
  const source = "import { readFileSync } from 'node:fs'; export const value = () => readFileSync('/etc/os-release')"
  await changed({ ...base, 'apps/api/src/value.ts': source }, { 'apps/api/src/value.ts': `${source}\n` })
})

it('covers callers in other reachable projects when a shared reader takes a fixture path', async () => {
  const files: Files = { ...base, [test]: "import '../../worker/src/caller.mjs'",
    'apps/worker/src/caller.mjs': "import { value } from '../../api/src/value.js'; export const read = (path) => value(path)",
    'apps/api/src/value.ts': "import { readFileSync } from 'node:fs'; export const value = (path) => readFileSync(path)",
    'apps/worker/test/data.json': 'one' }
  await changed(files, { 'apps/worker/test/data.json': 'two' })
})

it('follows source files supplied directly to a generic reader at its caller', async () => {
  const files: Files = { ...base, [test]: "import { value } from '../src/value.js'; export const text = value('./source.mjs')",
    'apps/api/src/value.ts': "import { readFileSync } from 'node:fs'; export const value = (path) => readFileSync(path)",
    'apps/api/test/source.mjs': 'export const value = 1' }
  await changed(files, { 'apps/api/test/source.mjs': 'export const value = 2' })
})


it('keeps unrelated source out when imported code can build a runtime workspace', async () => {
  const files: Files = { ...base,
    'apps/api/src/value.ts': "import { spawn } from 'node:child_process'; export const value = (cwd) => spawn('corepack', ['pnpm', 'build'], { cwd })",
    'apps/api/src/unrelated.ts': 'export const other = 1', 'apps/api/tsconfig.build.json': '{"include":["src"]}' }
  await unchanged(files, { 'apps/api/src/unrelated.ts': 'export const other = 2',
    'apps/api/tsconfig.build.json': '{"include":["other"]}' })
})

it('keeps a root manifest release bump out of readers that join a file name to a caller-supplied directory', async () => {
  const files = { ...base,
    'apps/api/src/value.ts': "import { readFileSync } from 'node:fs'; import { join } from 'node:path'; export const value = (directory) => readFileSync(join(directory, 'package.json'))" }
  await unchanged(files, { 'package.json': JSON.stringify({ ...JSON.parse(base['package.json']!), version: '0.0.126' }) })
  await changed(files, { 'apps/api/src/value.ts': `${files['apps/api/src/value.ts']}\n` })
})

it('keeps a root manifest release bump out of a computed import resolved from a directory manifest', async () => {
  const files = { ...base, [test]: "import { createRequire } from 'node:module'; import { join } from 'node:path'; import { pathToFileURL } from 'node:url';\n"
    + "const api = new URL('../', import.meta.url).pathname; export const load = () => import(pathToFileURL(createRequire(join(api, 'package.json')).resolve('vitest/node')).href)" }
  await unchanged(files, { 'package.json': JSON.stringify({ ...JSON.parse(base['package.json']!), version: '0.0.126' }) })
  await changed(files, { 'pnpm-lock.yaml': 'lockfileVersion: 9' })
})

it('keys an explicit root manifest read on everything but the release version', async () => {
  const files = { ...base,
    'apps/api/src/value.ts': "import { readFileSync } from 'node:fs'; export const value = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'))" }
  const manifest = JSON.parse(base['package.json']!)
  await unchanged(files, { 'package.json': JSON.stringify({ ...manifest, version: '0.0.126' }) })
  await changed(files, { 'package.json': JSON.stringify({ ...manifest, packageManager: 'pnpm@12.0.0' }) })
})

it('does not load every source and helper named by formatting arguments or output directories', async () => {
  const files = { ...base,
    'apps/api/src/value.ts': "import { mkdir } from 'node:fs/promises'; import { join } from 'node:path';\n"
      + "const portionKey = (...parts) => parts.join(':'); export const value = portionKey('apps/api', 'test');\n"
      + "export const prepare = (output) => mkdir(join(output, 'test/helpers'), { recursive: true })",
    'apps/api/test/helpers/fleetSync.ts': 'export const settle = () => 1',
    'apps/api/src/unrelated.ts': 'export const other = 1' }
  await unchanged(files, { 'apps/api/test/helpers/fleetSync.ts': 'export const settle = () => 2',
    'apps/api/src/unrelated.ts': 'export const other = 2' })
  await changed(files, { 'apps/api/src/value.ts': `${files['apps/api/src/value.ts']}\n` })
})

it('keeps copied source directories and explicit manifest reads as content inputs', async () => {
  const files = { ...base,
    'apps/api/src/value.ts': "import { cp } from 'node:fs/promises'; export const value = (output) => cp(new URL('./assets', import.meta.url), output, { recursive: true })",
    'apps/api/src/assets/child.mjs': 'export const value = 1' }
  await changed(files, { 'apps/api/src/assets/child.mjs': 'export const value = 2' })
  await changed({ ...files, 'apps/api/src/value.ts': "import { cp } from 'node:fs/promises'; import { join } from 'node:path';\n"
    + "const source = join(repository, 'apps/api/src/assets'); export const value = (output) => cp(source, output, { recursive: true })" },
    { 'apps/api/src/assets/child.mjs': 'export const value = 2' })
  await changed({ ...files, 'apps/api/src/value.ts': "import { readFileSync } from 'node:fs'; export const value = readFileSync(new URL('../package.json', import.meta.url))" },
    { 'apps/api/package.json': JSON.stringify({ ...JSON.parse(base['apps/api/package.json']!), description: 'read by the test' }) })
})

it('keeps createRequire anchors out of raw harness inputs while retaining package resolution', async () => {
  const manifest = JSON.parse(base['apps/api/package.json']!)
  const files = { ...base, 'pnpm-lock.yaml': lock(),
    'scripts/ci-package-paths.mjs': "import { createRequire } from 'node:module';\n"
      + "const anchor = new URL('../apps/api/package.json', import.meta.url); const require = createRequire(anchor);\n"
      + "export const value = require('zod')" }
  await unchanged(files, { 'apps/api/package.json': JSON.stringify({ ...manifest, version: '2', description: 'new description' }) })
  await changed(files, { 'pnpm-lock.yaml': lock('1', '1', '2') })
  const aliased = { ...files, 'scripts/ci-package-paths.mjs': files['scripts/ci-package-paths.mjs']
    .replace('const require =', 'const load =').replace("require('zod')", "load('zod')") }
  await changed(aliased, { 'pnpm-lock.yaml': lock('1', '1', '2') })
  await changed(files, { 'apps/api/package.json': JSON.stringify({ ...manifest, type: 'commonjs' }) })
  const alsoReads = { ...files, 'scripts/ci-package-paths.mjs': files['scripts/ci-package-paths.mjs']
    + "; import { readFileSync } from 'node:fs'; const read = (path) => readFileSync(path); export const contents = read(anchor)" }
  await changed(alsoReads, { 'apps/api/package.json': JSON.stringify({ ...manifest, description: 'observed contents' }) })
})

it('uses the require anchors importer when a script loads a package from another project', async () => {
  const rootZod = '  .:\n    dependencies:\n      zod: { version: \'root\' }'
  const files = { ...base, 'package.json': JSON.stringify({ name: 'root', dependencies: { zod: 'root' } }),
    'scripts/anchor.test.mjs': "import { createRequire } from 'node:module'; const require = createRequire(new URL('../apps/api/package.json', import.meta.url)); export const value = require('zod')",
    'pnpm-lock.yaml': lock().replace('  .: {}', rootZod) }
  await changed(files, { 'pnpm-lock.yaml': lock('1', '1', '2').replace('  .: {}', rootZod) }, 'scripts/anchor.test.mjs')
})

it('does not refuse keys for glob syntax inside strings or comments', async () => {
  const source = "export const value = (name) => name === 'import.meta.glob';\n// import.meta.glob('./*.ts')\n"
  const files = { ...base, 'apps/api/src/value.ts': source }
  await changed(files, { 'apps/api/src/value.ts': `${source}export const other = 1\n` })
  expect(await key({ ...files, 'apps/api/src/value.ts': `${source}export const modules = import.meta.glob('./*.ts')` }))
    .toMatchObject({ key: null })
})

it('distinguishes application open methods from bound filesystem readers', async () => {
  const files = { ...base, [test]: "import { rm } from 'node:fs/promises';\n"
    + "const Journal = { open: async (path) => path }; export const journal = Journal.open(process.env.TMPDIR); export { rm }" }
  expect((await key(files)).key).toMatch(/^[a-f0-9]{64}$/)
  for (const source of [
    "import { readFileSync as read } from 'node:fs'; export const value = read(process.env.FILE)",
    "import * as fs from 'node:fs'; export const value = fs.readFileSync(process.env.FILE)",
    "import { promises as fs } from 'node:fs'; export const value = fs.readFile(process.env.FILE)",
    "const { readFileSync: read } = require('node:fs'); export const value = read(process.env.FILE)",
  ]) expect(await key({ ...files, [test]: source })).toMatchObject({ key: null })
})

it('keeps transitive runner dependencies out of runner-free keys unless the test or setup loads them', async () => {
  const helper = 'packages/verification-runner/src/process.mjs'
  const files = { ...base,
    'scripts/ci-watchdog.mjs': `import { stop } from '../${helper}'; export { stop }`,
    [helper]: 'export const stop = () => 1' }
  const first = await key(files)
  expect(first.key).toMatch(/^[a-f0-9]{64}$/)
  const changes = { [helper]: 'export const stop = () => 2' }
  const after = await key({ ...files, ...changes })
  expect(after.key).not.toBe(first.key)
  expect(after.runnerFreeKey).toBe(first.runnerFreeKey)
  for (const loads of [{ [test]: `import '../../../${helper}'` },
    { 'apps/api/vitest.config.mjs': `import '../../${helper}'; export default {}` }]) {
    const before = await key({ ...files, ...loads })
    expect(before.key).toMatch(/^[a-f0-9]{64}$/)
    expect((await key({ ...files, ...loads, ...changes })).runnerFreeKey).not.toBe(before.runnerFreeKey)
  }
})

it('keeps a directory named only as a call argument out of the key while its reader covers the data', async () => {
  const files = { ...base, [test]: "import '../../../packages/runner/src/runner.mjs'",
    'packages/runner/src/runner.mjs': "import { readdirSync } from 'node:fs'; const portionKey = (...parts) => parts.join(':');\n"
      + "export const key = portionKey('apps/api', 'test'); export const list = (root) => readdirSync(root)",
    'apps/api/src/other.ts': 'export const other = 1' }
  await unchanged(files, { 'apps/api/src/other.ts': 'export const other = 2' })
  await changed(files, { 'apps/api/src/added.ts': 'export const added = 1' })
})

it('keys a directory listed under a caller-supplied checkout by its names, not its file contents', async () => {
  const files = { ...base,
    'apps/api/src/value.ts': "import { readdir } from 'node:fs/promises'; import { join } from 'node:path';\n"
      + "export const value = async (source) => { const tests = join(source, 'apps/worker/test'); return readdir(tests) }",
    'apps/worker/test/other.test.mjs': 'export const other = 1' }
  await unchanged(files, { 'apps/worker/test/other.test.mjs': 'export const other = 2' })
  await changed(files, { 'apps/worker/test/added.test.mjs': 'export const added = 1' })
})

it('keys a directory listed by git ls-files on its file names, not their contents', async () => {
  const files = { ...base,
    'apps/api/src/value.ts': "import { execFileSync } from 'node:child_process'; export const value = (cwd) => execFileSync('git', ['ls-files', '--', 'apps/worker'], { cwd })",
    'apps/worker/src/other.mjs': 'export const other = 1' }
  await unchanged(files, { 'apps/worker/src/other.mjs': 'export const other = 2' })
  await changed(files, { 'apps/worker/src/added.mjs': 'export const added = 1' })
  const staged = { ...files, 'apps/api/src/value.ts': files['apps/api/src/value.ts'].replace("'ls-files',", "'ls-files', '--stage',") }
  await changed(staged, { 'apps/worker/src/other.mjs': 'export const other = 2' })
})

it('keys a file copied from a caller-supplied checkout by that file, not its whole directory', async () => {
  const files = { ...base,
    'apps/api/src/value.ts': "import { copyFile } from 'node:fs/promises'; import { join } from 'node:path'; const skill = 'skill/guide.md';\n"
      + "export const value = (repository, output) => copyFile(join(repository, 'apps/worker/src', skill), join(output, skill))",
    'apps/worker/src/skill/guide.md': 'one', 'apps/worker/src/other.mjs': 'export const other = 1' }
  await unchanged(files, { 'apps/worker/src/other.mjs': 'export const other = 2' })
  await changed(files, { 'apps/worker/src/skill/guide.md': 'two' })
})
