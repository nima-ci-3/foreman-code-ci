import { expect, it } from 'vitest'
import { integrationTestFile, unitTestFile } from './ciTestInventory.mjs'

it('puts every API integration test in exactly one suite, wherever it lives', () => {
  // Two integration tests under apps/api/src ran nowhere: the unit suite excluded them and the integration
  // inventory took only apps/api/test/*.
  for (const file of ['apps/api/test/a.integration.test.ts', 'apps/api/test/nested/b.integration.test.ts',
    'apps/api/src/modules/devices/c.integration.test.ts']) {
    expect([integrationTestFile(file), unitTestFile(file)]).toEqual([true, false])
  }
  for (const file of ['apps/api/src/a.test.ts', 'apps/web/src/b.test.tsx', 'scripts/c.test.mjs', 'apps/worker/test/d.test.mjs']) {
    expect([integrationTestFile(file), unitTestFile(file)]).toEqual([false, true])
  }
  for (const file of ['apps/api/test/../x.integration.test.ts', 'apps/api/dist/x.integration.test.ts',
    'apps/api/test/x.acceptance.test.ts', 'apps/web/test/x.test.tsx', 'node_modules/x/y.test.ts']) {
    expect([integrationTestFile(file), unitTestFile(file)]).toEqual([false, false])
  }
})
