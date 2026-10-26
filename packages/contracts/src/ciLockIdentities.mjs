// Per-package identities from pnpm-lock.yaml, shared by Main's CI result keys and the lint closure cache, so a
// lockfile change reaches only the files that import a package whose locked tree changed.
import { createHash } from 'node:crypto'

const sha256 = (/** @type {string} */ value) => createHash('sha256').update(value).digest('hex')

/**
 * @typedef {{ lockfileVersion?: unknown; settings?: unknown; overrides?: unknown; patchedDependencies?: Record<string, unknown>;
 *   importers?: Record<string, Partial<Record<'dependencies' | 'devDependencies' | 'optionalDependencies', Record<string, { version?: string }>>>>;
 *   packages?: Record<string, { resolution?: unknown }>;
 *   snapshots?: Record<string, Partial<Record<'dependencies' | 'optionalDependencies', Record<string, string>>>> }} CiLockfile
 */

/** Identities of every package each lockfile importer declares: the package's locked tree (each snapshot it reaches
 * with its resolution) plus the lockfile settings that change how anything installs. Keys are
 * `<packageMarker><importer>\t<name>` (and `<packageMarker>*\t<name>` for the first importer declaring the name) and
 * `<toolsMarker><importer>` for the importer's development dependencies together.
 * @param {CiLockfile} lock
 * @param {{ packageMarker: string; toolsMarker: string }} markers
 * @returns {Map<string, string>} */
export function lockIdentities(lock, { packageMarker, toolsMarker }) {
  const base = JSON.stringify([lock.lockfileVersion, lock.settings])
  const snapshotKey = (/** @type {string} */ name, /** @type {string} */ version) => version.startsWith('link:') ? null
    // An aliased dependency's version is the real package's `<name>@<version>`.
    : /^@?[^@]+@/.test(version) && !/^\d/.test(version) ? version : `${name}@${version}`
  /** @type {Map<string, string>} */
  const trees = new Map()
  const treeOf = (/** @type {string} */ root) => {
    let identity = trees.get(root)
    if (identity) return identity
    const reached = new Set()
    const frontier = [root]
    while (frontier.length) {
      const key = /** @type {string} */ (frontier.pop())
      if (reached.has(key)) continue
      reached.add(key)
      const snapshot = lock.snapshots?.[key]
      for (const field of /** @type {const} */ (['dependencies', 'optionalDependencies'])) {
        for (const [name, version] of Object.entries(snapshot?.[field] ?? {})) {
          const next = snapshotKey(name, version)
          if (next) frontier.push(next)
        }
      }
    }
    identity = sha256(JSON.stringify([base, [...reached].sort().map(key =>
      [key, lock.packages?.[key.replace(/\(.*$/, '')]?.resolution ?? null, lock.snapshots?.[key] ?? null,
        // Overrides already select the resolved snapshot; patches affect only the package they modify.
        lock.patchedDependencies?.[key.replace(/\(.*$/, '')] ?? null])]))
    trees.set(root, identity)
    return identity
  }
  /** @type {Map<string, string>} */
  const identities = new Map()
  for (const [importer, declared] of Object.entries(lock.importers ?? {})) {
    const tools = []
    for (const field of /** @type {const} */ (['dependencies', 'devDependencies', 'optionalDependencies'])) {
      for (const [name, entry] of Object.entries(declared[field] ?? {})) {
        const key = typeof entry?.version === 'string' ? snapshotKey(name, entry.version) : null
        if (!key) continue
        const identity = treeOf(key)
        identities.set(`${packageMarker}${importer}\t${name}`, identity)
        if (!identities.has(`${packageMarker}*\t${name}`)) identities.set(`${packageMarker}*\t${name}`, identity)
        if (field === 'devDependencies') tools.push(`${name}:${identity}`)
      }
    }
    identities.set(`${toolsMarker}${importer}`, sha256(JSON.stringify([base, tools.sort()])))
  }
  return identities
}
