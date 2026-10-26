import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createTestRoot, removeTestRoot, testAdminUrl } from './test-resources.mjs'
import { integrationEnvironment, vitestCommand } from './test-integration.mjs'

const execute = promisify(execFile)
const apiConfig = new URL('../apps/api/vitest.config.mjs', import.meta.url).href
const runner = fileURLToPath(new URL('../packages/contracts/ci-test-runner.mjs', import.meta.url))
const vitest = fileURLToPath(new URL('../apps/api/node_modules/vitest', import.meta.url))

test('integration slots retain warm transforms when a peer invalidates its module cache', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-vitest-cache-'))
  const resources = []
  t.after(() => {
    for (const resource of resources) removeTestRoot(resource)
    rmSync(directory, { recursive: true, force: true })
  })
  const slots = Array.from({ length: 4 }, (_, offset) => {
    const root = join(directory, `checkout-${offset + 1}`)
    mkdirSync(join(root, 'node_modules/.pnpm'), { recursive: true })
    symlinkSync(vitest, join(root, 'node_modules/vitest'))
    writeFileSync(join(root, 'package.json'), '{"type":"module"}')
    writeFileSync(join(root, 'node_modules/.pnpm/lock.yaml'), "lockfileVersion: '9.0'\nsettings: { autoInstallPeers: true }\n")
    writeFileSync(join(root, 'value.ts'), 'export const value: number = 42\n')
    writeFileSync(join(root, 'cache.test.ts'), `import { expect, test } from 'vitest'
import { value } from './value.js'
test('loads the transformed module', () => expect(value).toBe(42))
`)
    writeFileSync(join(root, 'vitest.config.mjs'), `import config from ${JSON.stringify(apiConfig)}
import { appendFileSync } from 'node:fs'
export default { ...config, plugins: [{ name: 'count-fixture-transforms', transform(code, id) {
  if (id === ${JSON.stringify(join(root, 'value.ts'))}) appendFileSync(${JSON.stringify(join(root, 'transforms'))}, 'transform\\n')
} }], test: { ...config.test, globalSetup: [], setupFiles: [], maxWorkers: 1,
  runner: config.test.runner ? ${JSON.stringify(runner)} : undefined, include: ['cache.test.ts'] } }
`)
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['add', 'value.ts', 'cache.test.ts'], { cwd: root })
    const resource = createTestRoot(directory)
    resources.push(resource)
    const environment = integrationEnvironment({ ...process.env, CI: 'true', CI_PROGRESS_FILE: '',
      CI_REPOSITORY_ROOT: root, FOREMAN_CODE_VITEST_CACHE: join(directory, 'module-cache'),
      FOREMAN_CODE_INTEGRATION_COVERAGE_DIRECTORY: root, FOREMAN_CODE_TEST_FILE: 'apps/api/test/cache.test.ts',
    }, { ...resource, index: offset + 1, databaseUrl: new URL('/graphql_test_cache', testAdminUrl).href })
    const command = vitestCommand(environment, 'apps/api/cache.test.ts')
    const run = () => execute(command.command, command.args, {
      cwd: root, env: command.env, timeout: 20_000,
    })
    return { root, run, transforms: () => readFileSync(join(root, 'transforms'), 'utf8') }
  })

  const initial = await Promise.allSettled(slots.map(slot => slot.run()))
  for (const result of initial) assert.equal(result.status, 'fulfilled', result.reason?.message)
  for (const slot of slots) assert.equal(slot.transforms(), 'transform\n')
  // A restored cache may belong to an older installation. Its invalidation must be local to the slot.
  writeFileSync(join(slots[0].root, 'node_modules/.pnpm/lock.yaml'), "lockfileVersion: '9.0'\nsettings: { autoInstallPeers: false }\n")
  await slots[0].run()
  const results = await Promise.allSettled(slots.slice(1).map(slot => slot.run()))
  for (const result of results) assert.equal(result.status, 'fulfilled', result.reason?.message)
  assert.equal(slots[0].transforms(), 'transform\ntransform\n')
  for (const slot of slots.slice(1)) assert.equal(slot.transforms(), 'transform\n',
    'A peer invalidation discarded this slot’s reusable transform')
  for (const slot of slots) {
    const coverage = JSON.parse(readFileSync(join(slot.root, 'cache.test.ts.json'), 'utf8'))
    assert.ok(coverage.files.includes('value.ts'), 'The custom runner must still collect module coverage')
  }
})
