// The repository import graph shared by the affected-test selector (scripts/ci-affected.mjs) and Main's CI
// result cache, so both agree on which files a test file depends on.
import { posix } from 'node:path'

/** Files whose text is read for imports. */
export const ciCodeFile = /\.(?:[cm]?[jt]sx?|json|css)$/

/** Shared CI infrastructure: a change runs the full suite, and the result cache keys every test on it. */
export const ciInfrastructure = [
  /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*|vitest\.config\.[^/]*|eslint\.config\.[^/]*)$/,
  /(?:^|\/)migrations?\/|Migration\.[cm]?[jt]s$/,
  /^packages\/contracts\/src\/index\.ts$/,
  /^packages\/contracts\/src\/ci(?:Coverage|ImportGraph)\.[^/]+$/,
  /^apps\/ci\/src\//,
  /^scripts\/(?:test-integration[^/]*|test-resources[^/]*|integration-process[^/]*|integration-coverage[^/]*|ci-[^/]*|vitest-[^/]*|test-db\.mjs|test-command\.mjs|heavy-job\.mjs)$/,
  /^scripts\/(?:eslint-plugin-foreman\/|eslint-closure-cache\.mjs$|lint-allowlist\.(?:mjs|json)$|check-[^/]+\.mjs$|api-module-boundaries-pending\.mjs$)/,
  /^apps\/web\/heavy-tests\.json$/,
  /^apps\/api\/test\/(?:helpers\/|setup[^/]*$)|^apps\/web\/src\/test\//,
  /^(?:\.github\/workflows\/|\.circleci\/)/,
]

/** @param {string} file */
export function ciInfrastructureFile(file) {
  return ciInfrastructure.some(pattern => pattern.test(file))
}

/** Literal module specifiers of static imports, re-exports, dynamic imports, requires and Vitest module mocks.
 * `isCode(index)`, when given, drops matches that start inside a string or comment (code written as fixture text).
 * @param {string} text
 * @param {(index: number) => boolean} [isCode]
 * @returns {string[]} */
export function importSpecifiers(text, isCode) {
  const values = []
  const pattern = /\b(?:import|export)\s+(?:[^;'"]*?\s+from\s*)?['"]([^'"]+)['"]|\b(?:import|require|vi\.mock|vi\.doMock|vi\.importActual|vi\.importMock)\s*(?:<[^>]*>)?\s*\(\s*['"]([^'"]+)['"]/g
  for (const match of text.matchAll(pattern)) {
    if (!isCode || isCode(match.index)) values.push(match[1] ?? match[2])
  }
  return values
}

/** Workspace packages whose bare specifiers name repository source: the package name and its directory. */
export const ciWorkspacePackages = Object.freeze({ '@foreman-code/contracts': 'packages/contracts', '@foreman-code/contracts-node': 'packages/contracts-node', '@foreman-code/ci': 'apps/ci',
  '@foreman-code/api': 'apps/api' })

/** Each workspace package's `exports` map, from its package.json text; a missing manifest has no exports.
 * @param {(path: string) => string | undefined} read
 * @returns {Record<string, Record<string, unknown>>} */
export function workspacePackageExports(read) {
  return Object.fromEntries(Object.entries(ciWorkspacePackages).map(([name, directory]) => {
    const text = read(`${directory}/package.json`)
    const exports = text ? JSON.parse(text).exports : undefined
    return [name, exports && typeof exports === 'object' ? exports : {}]
  }))
}

/** Extensions and index files a module path may resolve to, in the order TypeScript and Node try them; every
 * resolver of repository imports (the selector, the result cache, the ESLint closure cache) uses this one list.
 * @param {string} target
 * @returns {string[]} */
export function ciModuleCandidates(target) {
  const stem = target.replace(/\.(?:[cm]?js|jsx)$/, '')
  return [target, ...['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx', '.json', '/index.ts', '/index.tsx', '/index.js']
    .map(extension => `${stem}${extension}`)]
}

/** The source path, relative to its package, that a workspace package's `exports` entry names: a string, or the
 * import, default or types condition; built `dist` paths map to their `src` sources, as tests run them.
 * @param {unknown} entry
 * @returns {string | undefined} */
export function ciExportSource(entry) {
  const conditions = entry && typeof entry === 'object' ? /** @type {Record<string, unknown>} */ (entry) : undefined
  const path = typeof entry === 'string' ? entry
    : [conditions?.import, conditions?.default, conditions?.types].find(value => typeof value === 'string')
  return typeof path === 'string' ? path.replace(/^\.\//, '').replace(/^dist\//, 'src/') : undefined
}

/** The repository file a relative or workspace-package specifier names, or null when it names none.
 * @param {string} file
 * @param {string} specifier
 * @param {{ has(path: string): boolean }} paths
 * @param {Record<string, unknown>} exports Each workspace package's `exports` map by package name
 *   (`workspacePackageExports`), or the contracts package's `exports` map alone.
 * @returns {string | null} */
export function resolveImport(file, specifier, paths, exports) {
  specifier = specifier.split('?')[0].split('#')[0]
  // A map keyed by subpaths ('.', './x') is the contracts manifest's own `exports`.
  const packages = Object.keys(exports).some(key => key.startsWith('.')) ? { '@foreman-code/contracts': exports } : exports
  const name = Object.keys(ciWorkspacePackages).find(value => specifier === value || specifier.startsWith(`${value}/`))
  let target
  if (specifier.startsWith('.')) target = posix.normalize(posix.join(posix.dirname(file), specifier))
  else if (name) {
    const path = ciExportSource(/** @type {Record<string, unknown>} */ (packages[name] ?? {})[`.${specifier.slice(name.length)}`])
    if (path) target = `${ciWorkspacePackages[name]}/${path}`
  }
  if (!target) return null
  return ciModuleCandidates(target).find(candidate => paths.has(candidate)) ?? null
}

/** Repository files named by literal fixture URLs or filesystem reads.
 * @param {string} file
 * @param {string} text
 * @param {{ has(path: string): boolean }} paths
 * @returns {string[]} */
export function runtimeDependencies(file, text, paths) {
  const resolved = new Set()
  const add = (base, literal) => {
    const target = posix.normalize(posix.join(base, literal))
    if (paths.has(target)) resolved.add(target)
    else {
      const source = resolveImport(file, `./${posix.relative(posix.dirname(file), target)}`, paths, {})
      if (source) resolved.add(source)
    }
  }
  for (const match of text.matchAll(/\bnew\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) {
    if (match[1].startsWith('.')) add(posix.dirname(file), match[1])
  }
  const parts = file.split('/')
  const project = ['apps', 'packages'].includes(parts[0]) ? parts.slice(0, 2).join('/') : parts[0]
  for (const match of text.matchAll(/\b(?:readFile|readFileSync|createReadStream)\s*\(\s*['"]([^'"]+)['"]/g)) {
    if (match[1].startsWith('/') || /^[a-z]+:/i.test(match[1])) continue
    for (const base of [posix.dirname(file), project, '']) add(base, match[1])
  }
  return [...resolved]
}
