import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { nativeAcceptanceFiles } from './test-native-acceptance.mjs'

const args = process.argv.slice(2)
// Reject invalid selections before queue admission, database provisioning or builds.
nativeAcceptanceFiles(args)

const result = spawnSync(process.execPath, ['scripts/heavy-job.mjs', '--', process.execPath,
  'scripts/test-command.mjs', '--', 'sh', '-c',
  'corepack pnpm --filter @foreman-code/contracts build && corepack pnpm --filter @foreman-code/contracts-node build'
    + ' && corepack pnpm --filter @foreman-code/ci build && node scripts/test-native-acceptance.mjs "$@"',
  '--', ...args], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit',
})
if (result.error) throw result.error
if (result.signal) process.kill(process.pid, result.signal)
process.exitCode = result.status ?? 1
