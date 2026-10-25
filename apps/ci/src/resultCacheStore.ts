import type pg from 'pg'
import { z } from 'zod'
import { CI_LOG_MAX_BYTES, CI_TEST_RESULT_LIMITS, CiTestResultsSchema, type CiCachedFile, type CiRunRecord } from '@foreman-code/contracts'
import type { CiContext } from './environment.js'
import { CiResultKeys, type CiTestTree } from './resultCache.js'

/** Keys are computed while ci_run waits; past this the request runs every file instead. */
const KEY_BUDGET_MS = 20_000
const CacheKeysSchema = z.record(z.string(), z.string())

export interface CachedSelection {
  /** The selected files that still run. */
  files: string[]
  /** Input keys of the files that run and have one; a passed run records them. */
  keys: Record<string, string>
  cached: CiCachedFile[]
}

/** Splits an explicit affected selection into files an earlier passed ticket of the workspace proved with identical
 * inputs and files that must run. Any failure to compute keys runs every file. */
export async function planCachedSelection(context: CiContext, pool: pg.Pool, input: { workspaceId: string; repository: string; commit: string
  suite: string; files: readonly string[]; partOf(file: string): string; tree(signal: AbortSignal): Promise<CiTestTree> }): Promise<CachedSelection> {
  const files = [...new Set(input.files)].sort()
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  try {
    const keys = await Promise.race([
      (async () => {
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
    const keyed = new Map([...keys].flatMap(([file, value]) => value.key === null ? [] : [[file, value.key] as const]))
    const rows = (await pool.query<{ cache_key: string; file: string; ticket_id: string; commit: string }>(
      `select cache_key,file,ticket_id,commit from ci_test_result_cache
        where workspace_id=$1 and repository=$2 and cache_key=any($3::text[])`,
      [input.workspaceId, input.repository, [...keyed.values()]])).rows
    const proofs = new Map(rows.map(row => [row.cache_key, row]))
    const cached: CiCachedFile[] = []
    const remaining: string[] = []
    for (const file of files) {
      const proof = proofs.get(keyed.get(file) ?? '')
      if (proof && proof.file === file) cached.push({ file, ticketId: proof.ticket_id, commit: proof.commit })
      else remaining.push(file)
    }
    const unkeyed = [...keys].flatMap(([file, value]) => value.key === null ? [{ file, reason: value.reason }] : [])
    context.log.info({ workspaceId: input.workspaceId, commit: input.commit, suite: input.suite, cached: cached.map(item => item.file),
      unkeyed: unkeyed.slice(0, 20) }, 'CI result cache applied to an affected selection')
    return { files: remaining, cached,
      keys: Object.fromEntries(remaining.flatMap(file => keyed.has(file) ? [[file, keyed.get(file)!]] : [])) }
  } catch (error) {
    controller.abort(error)
    context.log.warn({ err: error, workspaceId: input.workspaceId, commit: input.commit }, 'CI result cache unavailable; running every selected file')
    return { files, keys: {}, cached: [] }
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

/** Records every file a finished part proved: reported passed with no skipped test, under its input key. Only that
 * file's own result matters, so files that passed in a failed part are recorded too; failed, skipped, unreported and
 * unkeyed files never are. Keys come from admission or, for runs whose files the runner chose, from the commit. */
export async function recordCiResultCache(pool: pg.Pool, run: CiRunRecord, state: string,
  keysFor?: (files: readonly string[]) => Promise<Record<string, string>>) {
  if (!['passed', 'failed'].includes(state)) return
  const row = (await pool.query<{ result_cache_keys: unknown; test_results: unknown }>(
    'select result_cache_keys,test_results from ci_runs where id=$1', [run.id])).rows[0]
  const results = CiTestResultsSchema.safeParse(row?.test_results)
  if (!results.success) return
  // Results keep failed, then skipped, then passed tests: within this bound every skipped test is listed.
  const skippedListed = results.data.summary.failed + results.data.summary.skipped <= CI_TEST_RESULT_LIMITS.tests
  const passedFiles = results.data.files.filter(reported => reported.status === 'passed'
    && reported.tests.every(test => test.status === 'passed')
    && (results.data.truncated ? skippedListed : reported.tests.length > 0)).map(reported => reported.file)
  if (!passedFiles.length) return
  const admitted = CacheKeysSchema.safeParse(row?.result_cache_keys)
  const keys: Record<string, string> = { ...(admitted.success ? admitted.data : {}) }
  const missing = passedFiles.filter(file => !keys[file])
  if (missing.length && keysFor) Object.assign(keys, await keysFor(missing))
  const proven = passedFiles.flatMap(file => keys[file] ? [[file, keys[file]!] as const] : [])
  if (!proven.length) return
  await pool.query(`insert into ci_test_result_cache(workspace_id,repository,cache_key,file,ticket_id,commit)
    select $1,$2,proven.cache_key,proven.file,$3,$4 from unnest($5::text[],$6::text[]) as proven(file,cache_key)
    on conflict (workspace_id,repository,cache_key) do update set file=excluded.file, ticket_id=excluded.ticket_id,
      commit=excluded.commit, passed_at=now()`,
  [run.workspaceId, run.repository, run.id, run.commit, proven.map(([file]) => file), proven.map(([, key]) => key)])
  await pool.query(`delete from ci_test_result_cache where workspace_id=$1 and passed_at < now() - interval '30 days'`,
    [run.workspaceId])
}
