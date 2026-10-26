import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { CiResultKeys, type CiTestTree } from '../src/resultCache.js'

// A small repository shaped like the real one at the points where keys broke in practice: a product version
// reader, a verification runner that formats and lists directories, a git inventory, a createRequire anchor, a
// quoted glob name, a helper only some tests use, and a shared integration runner.
type Files = Record<string, string>
const tests = Array.from({ length: 12 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
const helperUsers = new Set(tests.slice(0, 2))
const units = Array.from({ length: 6 }, (_, index) => `apps/api/src/modules/feature${index}.test.ts`)
const repository: Files = {
  'package.json': JSON.stringify({ name: 'root', version: '0.0.125', type: 'module', packageManager: 'pnpm@11.27.0',
    scripts: { test: 'vitest run', 'test:integration': 'node scripts/test-integration.mjs' } }),
  'CHANGELOG.md': '## 0.0.125\n',
  'apps/api/package.json': JSON.stringify({ name: 'api', type: 'module', devDependencies: { vitest: '1' } }),
  'scripts/test-integration.mjs': "import { runFiles } from '../packages/verification-runner/src/integration-process.mjs'\nrunFiles()",
  'scripts/ci-files.mjs': "import { execFileSync } from 'node:child_process'\n"
    + "export const integrationFileList = (cwd) => execFileSync('git', ['ls-files', '--', 'apps/api'], { cwd, encoding: 'utf8' })",
  'scripts/build-cache-inputs.mjs': "export const viteGlob = (name) => name === 'import.meta.glob'",
  'packages/verification-runner/src/integration-process.mjs': 'export const runFiles = () => 1',
  'packages/verification-runner/src/verification-runner.mjs': "import { readdirSync } from 'node:fs'\nimport { join } from 'node:path'\n"
    + "const portionKey = (...parts) => parts.join(':')\nexport const portions = [portionKey('apps/api', 'test'), portionKey('apps/worker', 'test')]\n"
    + "export const repositoryFiles = (root, directory) => readdirSync(join(root, directory), { recursive: true })",
  'apps/api/src/infrastructure/productVersion.ts': "import { readFileSync } from 'node:fs'\nimport { join } from 'node:path'\n"
    + "export const readProductVersion = (release: string) => JSON.parse(readFileSync(join(release, 'package.json'), 'utf8')).version",
  'apps/api/src/infrastructure/vitest.ts': "import { createRequire } from 'node:module'\nimport { join } from 'node:path'\nimport { pathToFileURL } from 'node:url'\n"
    + "const api = new URL('../../', import.meta.url).pathname\n"
    + "export const loadVitest = () => import(pathToFileURL(createRequire(join(api, 'package.json')).resolve('vitest/node')).href)",
  'apps/api/src/app.ts': "import { readProductVersion } from './infrastructure/productVersion.js'\nimport { loadVitest } from './infrastructure/vitest.js'\n"
    + "import { repositoryFiles } from '../../../packages/verification-runner/src/verification-runner.mjs'\n"
    + "import { integrationFileList } from '../../../scripts/ci-files.mjs'\nimport { viteGlob } from '../../../scripts/build-cache-inputs.mjs'\n"
    + 'export const app = { readProductVersion, loadVitest, repositoryFiles, integrationFileList, viteGlob }',
  'apps/api/test/helpers/fleetSync.ts': 'export const settle = () => 1',
  'apps/worker/test/update.test.mjs': 'export const update = 1',
  ...Object.fromEntries(tests.map(test => [test, `import { app } from '../src/app.js'\n${helperUsers.has(test)
    ? "import { settle } from './helpers/fleetSync.js'\nexport const value = [app, settle]" : 'export const value = app'}`])),
  ...Object.fromEntries(units.map(test => [test, "import { app } from '../app.js'\nexport const value = app"])),
}

function tree(files: Files): CiTestTree {
  return { blobs: new Map(Object.entries(files).map(([path, text]) => [path, `100644:${createHash('sha1').update(text).digest('hex')}`])),
    read: async path => { if (!(path in files)) throw new Error(`Missing ${path}`); return files[path]! } }
}
async function keys(files: Files) {
  const graph = await CiResultKeys.create(tree(files), AbortSignal.timeout(10_000))
  return new Map(await Promise.all([...tests.map(async test => [test, await graph.key(test, 'integration', 'integration')] as const),
    ...units.map(async test => [test, await graph.key(test, 'unit', 'unit-api')] as const)]))
}
const survivors = (before: Awaited<ReturnType<typeof keys>>, after: typeof before, field: 'key' | 'runnerFreeKey' = 'key') =>
  [...before].filter(([test, key]) => typeof key[field] === 'string' && after.get(test)![field] === key[field]).map(([test]) => test)

it('keys every test of the real-shaped repository', async () => {
  for (const [test, key] of await keys(repository)) expect(key, test).toMatchObject({ key: expect.stringMatching(/^[a-f0-9]{64}$/) })
})

it('keeps every key across a version-only release commit', async () => {
  const before = await keys(repository)
  const after = await keys({ ...repository, 'CHANGELOG.md': '## 0.0.126\n\n## 0.0.125\n',
    'package.json': repository['package.json']!.replace('0.0.125', '0.0.126') })
  expect(survivors(before, after)).toHaveLength(tests.length + units.length)
})

it('changes only the keys of tests that import an edited helper', async () => {
  const before = await keys(repository)
  const after = await keys({ ...repository, 'apps/api/test/helpers/fleetSync.ts': 'export const settle = () => 2' })
  expect([...before.keys()].filter(test => !survivors(before, after).includes(test)).sort()).toEqual([...helperUsers].sort())
})

it('keeps runner-free keys across an integration runner change', async () => {
  const before = await keys(repository)
  const after = await keys({ ...repository,
    'packages/verification-runner/src/integration-process.mjs': 'export const runFiles = () => 2' })
  expect(survivors(before, after, 'runnerFreeKey').filter(test => tests.includes(test))).toHaveLength(tests.length)
})

it('keeps keys when unrelated tests are edited in a directory the runner only formats or lists', async () => {
  const before = await keys(repository)
  const after = await keys({ ...repository, 'apps/worker/test/update.test.mjs': 'export const update = 2' })
  expect(survivors(before, after)).toHaveLength(tests.length + units.length)
})
