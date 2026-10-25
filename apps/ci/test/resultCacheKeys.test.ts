import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { CiResultKeys, type CiTestTree } from '../src/resultCache.js'

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

it('changes a test key when a child process entrypoint the tested code names by path changes', async () => {
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
