import { homedir } from 'node:os'
import { join } from 'node:path'
import { RepositoryProbeInputSchema, type RepositoryProbeInput } from '@foreman-code/contracts/computer-maintenance'
import type { MaintenancePorts } from './maintenancePorts.js'

/** Match the execution host's Git cache and probe GitHub without prompting or changing it. */
export async function probeRepository(ports: MaintenancePorts, raw: RepositoryProbeInput, signal: AbortSignal) {
  const input = RepositoryProbeInputSchema.parse(raw)
  const git = await ports.find('git')
  if (!git) return { ready: false, reason: 'Git is not installed on this computer. Install Git and retry.' }
  const inheritedGit = Object.fromEntries(Object.keys(ports.environment).filter(key => key.startsWith('GIT_'))
    .map(key => [key, undefined]))
  const environment = { ...inheritedGit, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0', GCM_INTERACTIVE: 'never' }
  const run = (args: string[]) => ports.run(git, args, { signal, timeoutMs: 15_000, environment })
  if (input.commit) {
    const cache = join(ports.environment.HOME ?? homedir(), '.local', 'share', 'foreman-code', 'git', ...input.repository.split('/'))
    const commit = await run(['-C', cache, 'cat-file', '-e', `${input.commit}^{commit}`])
    signal.throwIfAborted()
    if (commit.code === 0) {
      const objects = await run(['-C', cache, 'rev-list', '--objects', '--no-object-names', '--missing=print', `${input.commit}^{tree}`])
      signal.throwIfAborted()
      if (objects.code === 0 && !objects.stdout.split('\n').some(line => /^\?[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(line))) {
        return { ready: true, reason: null }
      }
    }
  }
  const result = await run(['ls-remote', '--exit-code', `https://github.com/${input.repository}.git`, 'HEAD'])
  signal.throwIfAborted()
  if (result.code === 0) return { ready: true, reason: null }
  if (result.code === null) return { ready: false, reason: 'The GitHub access check did not finish. Check Git and the network on this computer, then retry.' }
  // Git credential helpers may print secrets; never return their stderr.
  const reason = /could not resolve (?:host|proxy)/iu.test(result.stderr)
    ? 'GitHub could not be reached because DNS failed. Check the network on this computer.'
    : /failed to connect|connection (?:timed out|reset)|recv failure|send failure/iu.test(result.stderr)
      ? 'GitHub could not be reached. Check the network on this computer and retry.'
      : `Cannot access ${input.repository} from this computer. Check the repository and, if needed, sign in to GitHub there.`
  return { ready: false, reason }
}
