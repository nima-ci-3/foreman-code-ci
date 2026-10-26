import { expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeComputer } from './helpers/fleetSync.js'

it('checks the selected Claude profile without exposing credentials or accepting a directory alias', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'foreman-claude-probe-')))
  try {
    const signedIn = join(directory, 'signed-in'), signedOut = join(directory, 'signed-out'), alias = join(directory, 'alias')
    await Promise.all([mkdir(signedIn), mkdir(signedOut), symlink(signedIn, alias)])
    const computer = fakeComputer()
    computer.ports.environment.ANTHROPIC_API_KEY = 'ambient-secret'
    const run = computer.ports.run
    let probes = 0
    computer.ports.run = async (binary, args, options) => {
      if (!binary.endsWith('claude') || args[0] !== 'auth') return run(binary, args, options)
      probes++
      if (options.environment?.ANTHROPIC_API_KEY !== undefined) throw new Error('Ambient API key was inherited')
      const loggedIn = options.environment?.CLAUDE_CONFIG_DIR === signedIn
      return { code: loggedIn ? 0 : 1, stdout: JSON.stringify({ loggedIn, token: 'private-token' }), stderr: '' }
    }
    const probe = (profileDirectory: string) => computer.maintenance.status(AbortSignal.timeout(1000),
      { claudeProfileProbe: { profileDirectory } })
    expect((await probe(signedIn)).claudeProfileProbe).toEqual({ authenticated: true, reason: null })
    const result = (await probe(signedOut)).claudeProfileProbe
    expect(result).toMatchObject({ authenticated: false })
    expect(JSON.stringify(result)).not.toContain('private-token')
    expect((await probe(alias)).claudeProfileProbe).toMatchObject({ authenticated: null })
    expect(probes).toBe(2)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
