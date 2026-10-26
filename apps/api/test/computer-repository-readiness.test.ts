import { expect, it } from 'vitest'
import { fakeComputer } from './helpers/fleetSync.js'

it('uses a complete cached commit, otherwise checks repository access without exposing credentials', async () => {
  const computer = fakeComputer()
  const find = computer.ports.find
  const run = computer.ports.run
  const commit = 'a'.repeat(40)
  let missingObject = false
  let remoteAccess = false
  let remoteChecks = 0
  computer.ports.find = name => name === 'git' ? Promise.resolve('/fake/git') : find(name)
  computer.ports.run = async (binary, args, options) => {
    if (binary !== '/fake/git') return run(binary, args, options)
    if (args[2] === 'cat-file') return { code: 0, stdout: '', stderr: '' }
    if (args[2] === 'rev-list') return { code: 0, stdout: missingObject ? `?${'b'.repeat(40)}\n` : `${commit}\n`, stderr: '' }
    if (args[0] === 'ls-remote') {
      remoteChecks++
      return remoteAccess ? { code: 0, stdout: `${commit}\tHEAD\n`, stderr: '' }
        : { code: 128, stdout: '', stderr: 'fatal: Authentication failed token=secret' }
    }
    throw new Error('Unexpected Git operation')
  }
  const probe = () => computer.maintenance.status(AbortSignal.timeout(1000),
    { repositoryProbe: { repository: 'owner/project', commit } })
  expect((await probe()).repositoryProbe).toEqual({ ready: true, reason: null })
  expect(remoteChecks).toBe(0)

  missingObject = true
  const failed = (await probe()).repositoryProbe
  expect(failed).toMatchObject({ ready: false, reason: expect.stringContaining('owner/project') })
  expect(JSON.stringify(failed)).not.toContain('secret')
  expect(remoteChecks).toBe(1)

  remoteAccess = true
  expect((await computer.maintenance.status(AbortSignal.timeout(1000),
    { repositoryProbe: { repository: 'owner/public-project' } })).repositoryProbe).toEqual({ ready: true, reason: null })
  expect(remoteChecks).toBe(2)
})
