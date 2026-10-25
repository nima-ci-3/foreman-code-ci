// The one definition of which repository files are CI unit and integration test files. Main's inventories, the
// affected selector, the integration runner, the unit slicer and the release verifier all read it, so the files a
// suite runs, the files a gate must prove and the files a release accepts are the same set.
import { posix } from 'node:path'

const testFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const ignoredDirectory = /(?:^|\/)(?:node_modules|dist|\.git)\//

/** An API integration test: any `apps/api/**\/*.integration.test.ts` outside build output, as a plain
 * repository-relative path. The unit suite excludes every such file, so none can fall between the two suites.
 * @param {string} file */
export function integrationTestFile(file) {
  return file.startsWith('apps/api/') && file.endsWith('.integration.test.ts') && !ignoredDirectory.test(file)
    && posix.normalize(file) === file && file.split('/').every(part => part && part !== '.' && part !== '..')
}

/** A unit test: any test file outside build output, except the API's integration and acceptance tests. The web
 * interface has no unit tests (owner decision 2026-10-25; see AGENTS.md).
 * @param {string} file */
export function unitTestFile(file) {
  return testFile.test(file) && !ignoredDirectory.test(file) && !file.startsWith('apps/web/')
    && !(file.startsWith('apps/api/') && /\.(?:integration|acceptance)\.test\.ts$/.test(file))
}
