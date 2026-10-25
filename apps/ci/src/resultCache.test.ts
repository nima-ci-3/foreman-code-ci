import { expect, it } from 'vitest'
import { CiResultKeys, type CiTestTree } from './resultCache.js'

function tree(files: Record<string, string>): CiTestTree {
  return { blobs: new Map(Object.entries(files).map(([path, text]) => [path, `100644:${Buffer.from(text).toString('hex').slice(0, 40)}`])),
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
