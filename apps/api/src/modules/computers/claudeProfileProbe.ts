import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { parseClaudeAuthStatus } from '../provider-accounts/index.js'
import type { MaintenancePorts } from './maintenancePorts.js'

/** Read subscription authentication from the selected host-local profile without opening a native turn. */
export async function probeClaudeProfile(ports: MaintenancePorts, profileDirectory: string, signal: AbortSignal) {
  if (!isAbsolute(profileDirectory) || resolve(profileDirectory) !== profileDirectory
    || await realpath(profileDirectory) !== profileDirectory) {
    return { authenticated: null, reason: 'The selected Claude profile directory is unavailable or has an unsafe alias.' }
  }
  const info = await lstat(profileDirectory)
  if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid()) {
    return { authenticated: null, reason: 'The selected Claude profile directory is not owned by this computer user.' }
  }
  const binary = await ports.find('claude')
  if (!binary) return { authenticated: null, reason: 'Claude is not installed on this computer.' }
  const stripped = Object.fromEntries(Object.keys(ports.environment).filter(key =>
    ['BASH_ENV', 'ENV', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'SSH_AUTH_SOCK'].includes(key)
    || /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS)(?:_|$)/.test(key)
    || /^(?:ANTHROPIC_|CLAUDE_|CLAUDECODE$|OPENAI_|CODEX_|GOOGLE_|GEMINI_|AWS_|AZURE_|VERTEX_|BEDROCK_)/.test(key)
    || key === 'DATABASE_URL' || key.endsWith('_DATABASE_URL') || key === 'PGPASSWORD').map(key => [key, undefined]))
  const result = await ports.run(binary, ['auth', 'status'], { signal, timeoutMs: 15_000,
    environment: { ...stripped, CLAUDE_CONFIG_DIR: profileDirectory, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' } })
  signal.throwIfAborted()
  const status = parseClaudeAuthStatus(result)
  if (status.kind === 'unreadable' && status.signedOutNotice || status.kind === 'status' && !status.loggedIn) {
    return { authenticated: false, reason: 'Claude is signed out in the selected profile.' }
  }
  if (status.kind !== 'status' || result.code !== 0) {
    return { authenticated: null, reason: 'Claude sign-in status could not be verified for the selected profile.' }
  }
  return { authenticated: true, reason: null }
}
