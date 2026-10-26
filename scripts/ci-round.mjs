// Runs the clean round for a pushed commit through Foreman CI (a proven gate by default; --full runs every file):
//   corepack pnpm round [<commit>] [--full]
// It is the same gate `corepack pnpm release` requires, started under the shared gate commandId, so a release of this
// commit reuses it instead of running the round again. Exits 0 only when every part passed.
import { execFileSync } from 'node:child_process'
import { awaitTickets, cacheReportLines, mcpClient, workspaceFor } from './ci-remote.mjs'
import { gateCommandId } from './verify-release-round.mjs'
import { auditCachedFiles } from './ci-cache-audit.mjs'

const args = process.argv.slice(2)
const full = args.includes('--full')
const commit = execFileSync('git', ['rev-parse', args.find(arg => arg !== '--full') ?? 'HEAD'], { encoding: 'utf8' }).trim()
process.exitCode = await (async () => {
  const call = await mcpClient('round')
  const workspaceId = await workspaceFor(call)
  const started = await call('ci_run', { workspaceId, commit, suite: 'integration', scope: full ? 'full' : 'affected', gate: true,
    priority: 'high', commandId: full ? `full-${gateCommandId(commit)}` : gateCommandId(commit) })
  const tickets = (started.partitions ?? [{ ticketId: started.ticketId }]).map(value => value.ticketId)
  console.error(`[round] Gate for ${commit.slice(0, 12)}: ${tickets.length} parts`)
  const first = (await call('ci_get', { workspaceId, ticketId: tickets[0], logTail: false })).run
  for (const line of cacheReportLines(first)) console.error(`[round] ${line}`)
  const failed = (await awaitTickets(call, workspaceId, tickets)).filter(run => run.state !== 'passed')
  if (failed.length) { console.error(`[round] Not clean: ${failed.map(run => `${run.suite} ticket ${run.id} ${run.state}`).join('; ')}`); return 1 }
  // Every round traces the files it skipped, independently of the key analyzer (function-proven skips excepted).
  const skipped = (first.cachedFiles ?? []).filter(item => !item.functions)
  const root = new URL('..', import.meta.url).pathname
  const atCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() === commit
    && execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim() === ''
  if (skipped.length && !atCommit) console.error(`[round] cache audit skipped: the checkout is not a clean ${commit.slice(0, 12)}.`)
  else if (skipped.length) {
    const audit = await auditCachedFiles({ root, commit, cached: skipped })
    console.error(`[round] cache audit: traced ${audit.checked} skipped files, ${audit.stale.length} wrong skips, `
      + `${audit.unbundled.length} not bundled.`)
    for (const { file, proof, changed } of audit.stale) {
      console.error(`[round]   wrong skip ${file}: proven at ${proof.slice(0, 12)}, imports changed ${changed.join(', ')}`)
    }
    if (audit.stale.length) { console.error('[round] Not clean: the result cache skipped files whose imports changed.'); return 1 }
  }
  console.error(`[round] ${commit.slice(0, 12)} passed a clean round; \`corepack pnpm release\` reuses it.`)
  return 0
})().catch(error => { console.error(`[round] ${error.message}`); return 1 })
