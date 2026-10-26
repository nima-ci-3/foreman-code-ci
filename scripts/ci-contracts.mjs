import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { buildInputHash, contractsArchiveKey } from './build-cache-inputs.mjs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)

export const contractsCacheKey = contractsArchiveKey

function outputHash(output) {
  const hash = createHash('sha256')
  const visit = directory => {
    for (const entry of readdirSync(join(output, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = join(directory, entry.name)
      if (relative === '.ci-cache-key') continue
      if (entry.isDirectory()) visit(relative)
      else if (entry.isFile()) hash.update(relative).update('\0').update(readFileSync(join(output, relative))).update('\0')
      else throw new Error(`Unexpected contracts output: ${relative}`)
    }
  }
  visit('')
  return hash.digest('hex')
}

function ready(output, key) {
  try {
    const stamp = JSON.parse(readFileSync(join(output, '.ci-cache-key'), 'utf8'))
    if (stamp.key !== key) return false
    if (existsSync(join(output, 'index.js')) && stamp.output === outputHash(output)) return true
    console.warn('[ci-cache] contracts artifacts changed or missing; rebuilding')
    return false
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`[ci-cache] invalid contracts artifacts; rebuilding: ${error.message}`)
    return false
  }
}

export function contractsReady(root) {
  const output = join(root, 'packages/contracts/dist')
  try {
    const stamp = JSON.parse(readFileSync(join(output, '.ci-cache-key'), 'utf8'))
    const command = stamp.command.map(value => value.replaceAll('<checkout>', root))
    return ready(output, buildInputHash(root, 'contracts', command, join(root, stamp.cwd)))
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`[ci-cache] contracts readiness unavailable; rebuilding: ${error.message}`)
    return false
  }
}

function copy(source, destination) {
  mkdirSync(destination, { recursive: true })
  const result = spawnSync('cp', ['-a', '--reflink=auto', `${source}/.`, destination], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error('Cannot copy contracts build')
}

function build(root, cache, command) {
  let key
  try { key = buildInputHash(root, 'contracts', command, process.cwd()) }
  catch (error) { console.warn(`[ci-cache] contracts inputs unavailable; running without reuse: ${error.message}`) }
  const output = join(root, 'packages/contracts/dist')
  const stamp = join(output, '.ci-cache-key')
  if (key && ready(output, key)) {
    console.log('[ci-cache] contracts build reused')
    return 0
  }
  const cached = key ? join(cache, key) : null
  if (cached && ready(cached, key)) {
    rmSync(output, { recursive: true, force: true })
    copy(cached, output)
    console.log('[ci-cache] contracts build restored')
    return 0
  }
  rmSync(output, { recursive: true, force: true })
  const result = spawnSync(command[0], command.slice(1), { cwd: process.cwd(), stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) return result.status ?? 1
  if (!existsSync(join(output, 'index.js'))) throw new Error('Contracts compiler produced no entry point')
  // Never publish output against inputs that changed while the compiler ran.
  if (!key || key !== buildInputHash(root, 'contracts', command, process.cwd())) return 0
  writeFileSync(stamp, JSON.stringify({ key, command: command.map(value => value.replaceAll(root, '<checkout>')), cwd: relative(root, process.cwd()), output: outputHash(output) }))
  const temporary = join(cache, `${key}.${randomUUID()}`)
  try {
    copy(output, temporary)
    rmSync(cached, { recursive: true, force: true })
    renameSync(temporary, cached)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
  console.log('[ci-cache] contracts build saved')
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [action, root, cache, divider, ...command] = process.argv.slice(2)
  if (action === 'key' && root) console.log(contractsCacheKey(root))
  else if (action === 'ready' && root) process.exitCode = contractsReady(root) ? 0 : 1
  else if ((action === 'build' || action === 'locked-build') && root && cache && divider === '--' && command.length) {
    mkdirSync(cache, { recursive: true })
    if (action === 'locked-build') process.exitCode = build(root, cache, command)
    else {
      const result = spawnSync('flock', [join(cache, `${contractsCacheKey(root)}.lock`),
        process.execPath, script, 'locked-build', root, cache, '--', ...command], { stdio: 'inherit' })
      if (result.error) throw result.error
      process.exitCode = result.status ?? 1
    }
  } else throw new Error('Usage: ci-contracts.mjs key|ready root | build root cache -- compiler [args...]')
}
