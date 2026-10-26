import type pg from 'pg'
import { z } from 'zod'
import { CI_LOG_MAX_BYTES, CI_TEST_RESULT_LIMITS, CiTestResultsSchema, type CiCacheReport, type CiCachedFile, type CiRunRecord } from '@foreman-code/contracts'
import { sha256Hex } from '@foreman-code/contracts-node/server-kit'
import type { CiContext } from './environment.js'
import { CiResultKeys, type CiResultKey, type CiTestTree } from './resultCache.js'

/** Keys are computed while ci_run waits; past this the request runs every file instead. Keying every test of the
 * repository takes about 20 s, and a run of every file costs minutes, so the budget only stops a hung computation. */
const KEY_BUDGET_MS = 120_000
const CacheKeysSchema = z.record(z.string(), z.string())
/** Of the files proven only under another test runner, this share (at least one per part) reruns as a canary. */
const RUNNER_CANARY_SHARE = 0.05

/** A file's keys as admission stores them: the full key, then the runner-free key when there is one. */
export function storedKeys(value: CiResultKey): string | null {
  return value.key && (value.runnerFreeKey ? `${value.key} ${value.runnerFreeKey}` : value.key)
}

export interface CachedSelection {
  /** The selected files that still run. */
  files: string[]
  /** Input keys of the files that run and have one (storedKeys); a passed run records them. */
  keys: Record<string, string>
  cached: CiCachedFile[]
  report?: CiCacheReport
  /** Keys could not be computed: nothing is proven and nothing is known to be unprovable. */
  unavailable?: true
}

/** Splits an explicit affected selection into files an earlier passed ticket of the workspace proved with identical
 * inputs and files that must run. Any failure to compute keys runs every file. */
export async function planCachedSelection(context: CiContext, pool: pg.Pool, input: { workspaceId: string; repository: string; commit: string
  suite: string; files: readonly string[]; partOf(file: string): string
  /** Keys for the files (preferred, computed off the event loop), or the commit's tree to key them in process. */
  keys?(files: { file: string; suite: string; part: string }[], signal: AbortSignal): Promise<Record<string, CiResultKey>>
  tree?(signal: AbortSignal): Promise<CiTestTree>
  /** Of files without an exact proof, those a function proof still covers (functionProofs). */
  functionProofs?: ((files: string[]) => Promise<CiCachedFile[]>) | undefined }): Promise<CachedSelection> {
  const files = [...new Set(input.files)].sort()
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  try {
    const keys = await Promise.race([
      (async () => {
        if (input.keys) {
          const keyed = await input.keys(files.map(file => ({ file, suite: input.suite, part: input.partOf(file) })), controller.signal)
          return new Map(files.map(file => [file, keyed[file] ?? { key: null, reason: 'no key was computed' }] as const))
        }
        if (!input.tree) throw new Error('No result cache keys are available.')
        const graph = await CiResultKeys.create(await input.tree(controller.signal), controller.signal)
        const entries = await Promise.all(files.map(async file => [file, await graph.key(file, input.suite, input.partOf(file))] as const))
        return new Map(entries)
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Result cache keys took longer than ${KEY_BUDGET_MS} ms.`)
          controller.abort(error)
          reject(error)
        }, KEY_BUDGET_MS)
      }),
    ])
    const keyed = new Map([...keys].flatMap(([file, value]) => value.key === null ? [] : [[file, value] as const]))
    // A failure newer than a file's pass voids that proof, whatever key the failure ran at.
    const rows = (await pool.query<{ cache_key: string; file: string; ticket_id: string; commit: string }>(
      `select c.cache_key,c.file,c.ticket_id,c.commit from ci_test_result_cache c
        where c.workspace_id=$1 and c.repository=$2 and c.cache_key=any($3::text[])
          and not exists (select 1 from ci_test_failures f where f.workspace_id=c.workspace_id and f.repository=c.repository
            and f.suite=$4 and f.file=c.file and f.failed_at >= c.passed_at)`,
      [input.workspaceId, input.repository, [...keyed.values()].flatMap(value => [value.key!, ...value.runnerFreeKey ? [value.runnerFreeKey] : []]),
        input.suite])).rows
    const proofs = new Map(rows.map(row => [row.cache_key, row]))
    const cached: CiCachedFile[] = []
    const remaining: string[] = []
    // Proven by identical code under a different test runner: a sample of each part reruns to prove the new runner.
    const otherRunner = new Map<string, { file: string; proof: typeof rows[number] }[]>()
    for (const file of files) {
      const value = keyed.get(file)
      const proof = proofs.get(value?.key ?? '')
      const runnerFree = value?.runnerFreeKey ? proofs.get(value.runnerFreeKey) : undefined
      if (proof && proof.file === file) cached.push({ file, ticketId: proof.ticket_id, commit: proof.commit })
      else if (runnerFree && runnerFree.file === file) {
        const part = input.partOf(file)
        otherRunner.set(part, [...otherRunner.get(part) ?? [], { file, proof: runnerFree }])
      } else remaining.push(file)
    }
    for (const candidates of otherRunner.values()) {
      const order = candidates.map(candidate => ({ ...candidate,
        rank: sha256Hex(`${keyed.get(candidate.file)!.key}\0${candidate.file}`) }))
        .sort((left, right) => left.rank.localeCompare(right.rank))
      const canaries = Math.max(1, Math.ceil(order.length * RUNNER_CANARY_SHARE))
      for (const [index, { file, proof }] of order.entries()) {
        if (index < canaries) remaining.push(file)
        else cached.push({ file, ticketId: proof.ticket_id, commit: proof.commit })
      }
    }
    if (input.functionProofs && remaining.length) {
      try {
        const proven = await input.functionProofs(remaining)
        const files = new Set(proven.map(item => item.file))
        cached.push(...proven)
        remaining.splice(0, remaining.length, ...remaining.filter(file => !files.has(file)))
      } catch (error) {
        context.log.warn({ err: error, workspaceId: input.workspaceId, commit: input.commit }, 'CI function proofs unavailable')
      }
    }
    remaining.sort()
    const unkeyed = [...keys].flatMap(([file, value]) => value.key === null ? [{ file, reason: value.reason }] : [])
    context.log.info({ workspaceId: input.workspaceId, commit: input.commit, suite: input.suite, cached: cached.map(item => item.file),
      unkeyed: unkeyed.slice(0, 20) }, 'CI result cache applied to an affected selection')
    const report: CiCacheReport = { unkeyed: unkeyed.slice(0, 200).map(({ file, reason }) => ({ file, reason: (reason ?? 'no reason given').slice(0, 500) })),
      unkeyedCount: unkeyed.length,
      largest: [...keyed].flatMap(([file, value]) => value.inputs === undefined ? [] : [{ file, inputs: value.inputs }])
        .sort((left, right) => right.inputs - left.inputs || left.file.localeCompare(right.file)).slice(0, 10) }
    return { files: remaining, cached, report,
      keys: Object.fromEntries(remaining.flatMap(file => keyed.has(file) ? [[file, storedKeys(keyed.get(file)!)!]] : [])) }
  } catch (error) {
    controller.abort(error)
    context.log.warn({ err: error, workspaceId: input.workspaceId, commit: input.commit }, 'CI result cache unavailable; running every selected file')
    return { files, keys: {}, cached: [], unavailable: true }
  } finally {
    clearTimeout(timer)
  }
}

/** The log lines naming the files a request skipped and the tickets that proved them. */
export function ciCachedNotice(cached: readonly CiCachedFile[]): string {
  const head = `Result cache: skipped ${cached.length} selected file(s) that already passed with identical inputs:`
  const lines = [head]
  let bytes = head.length
  for (const [index, item] of cached.entries()) {
    const line = `  ${item.file} (passed in ticket ${item.ticketId} at commit ${item.commit.slice(0, 12)})`
    if (bytes + line.length + 80 > CI_LOG_MAX_BYTES) {
      lines.push(`  ... and ${cached.length - index} more; ci_get lists every one in cachedFiles.`)
      break
    }
    lines.push(line)
    bytes += line.length + 1
  }
  return lines.join('\n')
}

/** Records every file a finished part proved, and returns them: reported passed with no skipped test, under its input key. Only that
 * file's own result matters, so files that passed in a failed part are recorded too; failed, skipped, unreported and
 * unkeyed files never are. Keys come from admission or, for runs whose files the runner chose, from the commit. */
export async function recordCiResultCache(pool: pg.Pool, run: CiRunRecord, state: string,
  keysFor?: (files: readonly string[]) => Promise<Record<string, string>>): Promise<string[]> {
  if (!['passed', 'failed'].includes(state)) return []
  const row = (await pool.query<{ result_cache_keys: unknown; test_results: unknown }>(
    'select result_cache_keys,test_results from ci_runs where id=$1', [run.id])).rows[0]
  const results = CiTestResultsSchema.safeParse(row?.test_results)
  if (!results.success) return []
  // Results keep failed, then skipped, then passed tests: within this bound every skipped test is listed.
  const skippedListed = results.data.summary.failed + results.data.summary.skipped <= CI_TEST_RESULT_LIMITS.tests
  const passedFiles = results.data.proven ?? results.data.files.filter(reported => reported.status === 'passed'
    && reported.tests.every(test => test.status === 'passed')
    && (results.data.truncated ? skippedListed : reported.tests.length > 0)).map(reported => reported.file)
  // A file that failed reruns until it passes; a pass clears its failure.
  const failedFiles = results.data.files.filter(reported => reported.status === 'failed'
    || reported.tests.some(test => test.status === 'failed')).map(reported => reported.file)
  // Results are dated by when the part finished, so a late collection or a backfill never overrides a newer result.
  const resultAt = run.finishedAt ?? new Date().toISOString()
  if (failedFiles.length) {
    await pool.query(`insert into ci_test_failures(workspace_id,repository,suite,file,ticket_id,commit,failed_at)
      select $1,$2,$3,file,$4,$5,$7 from unnest($6::text[]) as failed(file)
      on conflict (workspace_id,repository,suite,file) do update set ticket_id=excluded.ticket_id, commit=excluded.commit,
        failed_at=excluded.failed_at where ci_test_failures.failed_at <= excluded.failed_at`,
    [run.workspaceId, run.repository, run.suite, run.id, run.commit, failedFiles, resultAt])
  }
  if (!passedFiles.length) return []
  await pool.query(`delete from ci_test_failures where workspace_id=$1 and repository=$2 and suite=$3 and file=any($4::text[])
    and failed_at < $5`, [run.workspaceId, run.repository, run.suite, passedFiles, resultAt])
  const admitted = CacheKeysSchema.safeParse(row?.result_cache_keys)
  const keys: Record<string, string> = { ...(admitted.success ? admitted.data : {}) }
  const missing = passedFiles.filter(file => !keys[file])
  if (missing.length && keysFor) Object.assign(keys, await keysFor(missing))
  // A stored value carries the full key and, after a space, the runner-free key; the pass proves the file under both.
  const proven = [...new Map(passedFiles.flatMap(file => (keys[file]?.split(' ') ?? []).map(key => [key, file] as const)))]
    .map(([key, file]) => [file, key] as const)
  if (!proven.length) return passedFiles
  await pool.query(`insert into ci_test_result_cache(workspace_id,repository,cache_key,file,ticket_id,commit,passed_at)
    select $1,$2,proven.cache_key,proven.file,$3,$4,$7 from unnest($5::text[],$6::text[]) as proven(file,cache_key)
    on conflict (workspace_id,repository,cache_key) do update set file=excluded.file, ticket_id=excluded.ticket_id,
      commit=excluded.commit, passed_at=excluded.passed_at where ci_test_result_cache.passed_at <= excluded.passed_at`,
  [run.workspaceId, run.repository, run.id, run.commit, proven.map(([file]) => file), proven.map(([, key]) => key), resultAt])
  await pool.query(`delete from ci_test_result_cache where workspace_id=$1 and passed_at < now() - interval '30 days'`,
    [run.workspaceId])
  return passedFiles
}

/** Test files of the suite whose latest result was a failure. */
export async function failedTestFiles(pool: pg.Pool, input: { workspaceId: string; repository: string; suite: string }) {
  return new Set((await pool.query<{ file: string }>(
    'select file from ci_test_failures where workspace_id=$1 and repository=$2 and suite=$3',
    [input.workspaceId, input.repository, input.suite])).rows.map(row => row.file))
}
