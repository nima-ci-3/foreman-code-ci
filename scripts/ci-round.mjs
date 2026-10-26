// Runs the clean round for a pushed commit through Foreman CI (a proven gate by default; --full runs every file):
//   corepack pnpm round [<commit>] [--full]
// It is the same gate `corepack pnpm release` requires, started under the shared gate commandId, so a release of this
// commit reuses it instead of running the round again. Exits 0 only when every part passed.
import { execFileSync } from 'node:child_process'
import { awaitTickets, mcpClient, workspaceFor } from './ci-remote.mjs'
import { gateCommandId } from './verify-release-round.mjs'

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
  const failed = (await awaitTickets(call, workspaceId, tickets)).filter(run => run.state !== 'passed')
  if (failed.length) { console.error(`[round] Not clean: ${failed.map(run => `${run.suite} ticket ${run.id} ${run.state}`).join('; ')}`); return 1 }
  console.error(`[round] ${commit.slice(0, 12)} passed a clean round; \`corepack pnpm release\` reuses it.`)
  return 0
})().catch(error => { console.error(`[round] ${error.message}`); return 1 })
