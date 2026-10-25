import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function stateDigest(root) {
  const hash = createHash('sha256')
  const visit = directory => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) hash.update(relative(root, path)).update('\0').update(readFileSync(path)).update('\0')
    }
  }
  for (const parent of ['apps', 'packages']) {
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      for (const kind of ['tsc', 'eslint']) visit(join(root, parent, entry.name, 'node_modules/.cache', kind))
    }
  }
  return hash.digest('hex')
}

export function recordSuiteState(root) {
  mkdirSync(join(root, '.logs'), { recursive: true })
  writeFileSync(join(root, '.logs/ci-suite-state-before'), stateDigest(root))
}

export function suiteStateChanged(root) {
  return readFileSync(join(root, '.logs/ci-suite-state-before'), 'utf8') !== stateDigest(root)
}

/** Keep three recent compiler/linter states; dependency caches and other refs have independent ownership. */
export function obsoleteSuiteStateCaches(caches, ref) {
  return caches.filter(cache => cache.ref === ref && cache.key.startsWith('suite-state-'))
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at) || right.id - left.id)
    .slice(3)
}

export function pruneSuiteState(repository, ref, gh = args => execFileSync('gh', args, {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
})) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !ref.startsWith('refs/heads/')) {
    throw new Error('Suite cache cleanup requires a repository and branch ref.')
  }
  const query = new URLSearchParams({ per_page: '100', ref, key: 'suite-state-', sort: 'created_at', direction: 'desc' })
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repository}/actions/caches?${query}`]))
  const obsolete = obsoleteSuiteStateCaches(pages.flatMap(page => page.actions_caches), ref)
  for (const cache of obsolete) {
    if (!Number.isSafeInteger(cache.id) || cache.id < 1) throw new Error('Invalid suite cache id.')
    gh(['api', '--method', 'DELETE', `repos/${repository}/actions/caches/${cache.id}`])
  }
  console.log(`Removed ${obsolete.length} old suite state cache(s); retained up to three generations on ${ref}.`)
  return obsolete.length
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const action = process.argv[2] ?? 'prune'
  if (action === 'record') recordSuiteState(process.cwd())
  else if (action === 'changed') console.log(suiteStateChanged(process.cwd()))
  else if (action === 'prune') pruneSuiteState(process.env.GITHUB_REPOSITORY ?? '', process.env.GITHUB_REF ?? '')
  else throw new Error('Use record, changed or prune for suite state caches.')
}
