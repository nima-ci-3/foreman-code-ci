import { createHash } from 'node:crypto'
import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { planCachedSelection } from '@foreman-code/ci/resultCacheStore'
import { GitCiCommits } from '@foreman-code/ci/commits'
import type { CiTestTree } from '@foreman-code/ci/resultCache'
import { mainCiContext } from '../../src/modules/ci/context.js'

const pool = { query: vi.fn(async () => ({ rows: [] })) } as unknown as pg.Pool
const selection = { workspaceId: 'workspace', repository: 'example/project', commit: 'a'.repeat(40),
  suite: 'unit', partOf: () => 'api' }
afterEach(() => { vi.useRealTimers() })

function fixture(label: string, count: number) {
  const files = Array.from({ length: count }, (_, index) => `apps/api/src/${label}-${index}.test.ts`)
  const shared = `apps/api/src/${label}-shared.ts`
  const contents = new Map([
    ...files.map((file, index) => [file, `import './${label}-shared.js'; export const value = ${index}`] as const),
    [shared, `export const shared = '${label}'`] as const,
  ])
  const blobs = new Map([...contents].map(([file, content]) =>
    [file, `100644:${createHash('sha1').update(content).digest('hex')}`]))
  return { files, shared, contents, blobs }
}

it('bounds blob reads across every selected file and reads a shared dependency once', async () => {
  const f = fixture('bounded', 64)
  let active = 0
  let peak = 0
  const reads = new Map<string, number>()
  const tree: CiTestTree = { blobs: f.blobs, read: async file => {
    active++
    peak = Math.max(peak, active)
    reads.set(file, (reads.get(file) ?? 0) + 1)
    await new Promise<void>(resolve => setImmediate(resolve))
    active--
    return f.contents.get(file)!
  } }
  const result = await planCachedSelection(mainCiContext, pool, { ...selection, files: f.files, tree: async () => tree })
  expect(Object.keys(result.keys)).toHaveLength(f.files.length)
  expect.soft(peak).toBeLessThanOrEqual(16)
  expect.soft(reads.get(f.shared)).toBe(1)
})

it('cancels active Git reads and leaves queued blobs unread when the key budget expires', async () => {
  const f = fixture('canceled', 64)
  const contents = new Map([...f.blobs].map(([file, blob]) => [blob.split(':')[1]!, f.contents.get(file)!]))
  let active = 0
  let started = 0
  let ready!: () => void
  const reading = new Promise<void>(resolve => { ready = resolve })
  const commits = new GitCiCommits(mainCiContext, { cloneDirectory: () => process.cwd(), git: async (args, { signal }) => {
    if (args[0] === 'ls-tree') return { code: 0, stderr: '', stdout: [...f.blobs]
      .map(([file, blob]) => `100644 blob ${blob.split(':')[1]}\t${file}\0`).join('') }
    if (args[0] !== 'cat-file' || args[1] !== 'blob') return { code: 0, stdout: '', stderr: '' }
    started++
    active++
    ready()
    await new Promise<void>((resolve, reject) => {
      signal.addEventListener('abort', () => { active--; reject(signal.reason) }, { once: true })
      if (signal.aborted) { active--; resolve() }
    })
    return { code: 0, stdout: contents.get(args[2]!)!, stderr: '' }
  } })
  vi.useFakeTimers()
  const pending = planCachedSelection(mainCiContext, pool, { ...selection, files: f.files,
    tree: (signal?: AbortSignal) => commits.testTree(selection.repository, selection.commit, signal) })
  await reading
  await vi.advanceTimersByTimeAsync(120_000)
  expect(await pending).toEqual({ files: f.files.sort(), keys: {}, cached: [], unavailable: true })
  expect(active).toBe(0)
  const stoppedAt = started
  await vi.advanceTimersByTimeAsync(30_000)
  expect(started).toBe(stoppedAt)
})

it('still serves proofs when keying every test takes longer than 20 seconds', async () => {
  // Keying the whole repository takes about 20 s; a 20 s budget turned such rounds into runs of every file.
  const files = ['apps/api/test/slow-keys.test.ts']
  const proofs = vi.fn(async () => ({ rows: [{ cache_key: `key:${files[0]}`, file: files[0], ticket_id: 'earlier', commit: 'b'.repeat(40) }] }))
  vi.useFakeTimers()
  const pending = planCachedSelection(mainCiContext, { query: proofs } as unknown as pg.Pool, { ...selection, files,
    keys: keyed => new Promise(resolve => setTimeout(() => resolve(Object.fromEntries(keyed.map(({ file }) => [file, { key: `key:${file}` }]))), 30_000)) })
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await pending).toMatchObject({ files: [], cached: [{ file: files[0], ticketId: 'earlier' }] })
})

it('serves files proven under another test runner from the cache except a canary sample of each part', async () => {
  // A change to the test runner alone used to rerun every test; now about one in twenty reruns to prove the runner.
  const files = Array.from({ length: 40 }, (_, index) => `apps/api/test/runner-${index}.test.ts`)
  const proofs = vi.fn(async (_sql: string, values: unknown[]) => ({ rows: (values[2] as string[])
    .filter(key => key.startsWith('free:')).map(key => ({ cache_key: key, file: key.slice(5), ticket_id: 'earlier', commit: 'b'.repeat(40) })) }))
  const result = await planCachedSelection(mainCiContext, { query: proofs } as unknown as pg.Pool, { ...selection, files,
    keys: async keyed => Object.fromEntries(keyed.map(({ file }) => [file, { key: `new:${file}`, runnerFreeKey: `free:${file}` }])) })
  expect(result.files).toHaveLength(2)
  expect(result.cached).toHaveLength(38)
  // The canaries record their pass under both keys.
  expect(result.keys[result.files[0]!]).toBe(`new:${result.files[0]} free:${result.files[0]}`)
})
