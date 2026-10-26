// Independent check of result-cache skips: esbuild bundles each cached test file and lists the repository files it
// really imports; a skip is wrong when one of them changed between the commit whose pass proved it and the audited
// commit. It traces imports only (data reads and child processes stay with the key analyzer), but it shares no code
// with that analyzer, so an analyzer regression that drops imports shows up here.
//   node scripts/ci-cache-audit.mjs <ticketId>      (the checkout must be at the ticket's commit)
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BATCH = 32

/** `cached` is [{ file, commit }] as ci_get lists cachedFiles; returns the wrong skips with the changed inputs. */
export async function auditCachedFiles({ root, commit, cached, esbuild = loadEsbuild(root) }) {
  const changedSince = new Map()
  const changed = proof => {
    if (!changedSince.has(proof)) {
      changedSince.set(proof, new Set(execFileSync('git', ['diff', '--name-only', '--no-renames', proof, commit],
        { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean)))
    }
    return changedSince.get(proof)
  }
  const stale = [], unbundled = []
  for (let start = 0; start < cached.length; start += BATCH) {
    await Promise.all(cached.slice(start, start + BATCH).map(async ({ file, commit: proof }) => {
      let inputs
      try {
        const result = await esbuild.build({ entryPoints: [resolve(root, file)], bundle: true, write: false, metafile: true,
          platform: 'node', format: 'esm', logLevel: 'silent', absWorkingDir: root, conditions: ['source', 'import'],
          loader: { '.node': 'empty', '.sql': 'text', '.md': 'text', '.css': 'empty', '.html': 'text' },
          // Workspace packages resolve to their sources; installed packages are the lockfile's business.
          plugins: [{ name: 'external-packages', setup(build) {
            build.onResolve({ filter: /^[^./]/ }, args => args.path.startsWith('@foreman-code/') ? undefined
              : { path: args.path, external: true })
          } }] })
        inputs = Object.keys(result.metafile.inputs).map(input => relative(root, resolve(root, input)))
      } catch (error) {
        unbundled.push({ file, reason: String(error.message).split('\n')[0].slice(0, 200) })
        return
      }
      const hit = inputs.filter(input => changed(proof).has(input))
      if (hit.length) stale.push({ file, proof, changed: hit.slice(0, 10) })
    }))
  }
  return { checked: cached.length - unbundled.length, stale, unbundled }
}

function loadEsbuild(root) {
  return createRequire(resolve(root, 'apps/worker/package.json'))('esbuild')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { mcpClient, workspaceFor } = await import('./ci-remote.mjs')
  const call = await mcpClient('cache-audit')
  const workspaceId = await workspaceFor(call)
  const run = (await call('ci_get', { workspaceId, ticketId: process.argv[2], logTail: false })).run
  const root = fileURLToPath(new URL('..', import.meta.url))
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  if (head !== run.commit) throw new Error(`Check out ${run.commit} to audit its cached files (HEAD is ${head}).`)
  // Function proofs reuse passes across edits to functions the test never ran; their check is the coverage itself.
  const result = await auditCachedFiles({ root, commit: run.commit, cached: (run.cachedFiles ?? []).filter(item => !item.functions) })
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.stale.length ? 1 : 0
}
