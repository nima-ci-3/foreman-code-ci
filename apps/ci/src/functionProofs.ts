import type pg from 'pg'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { CiCachedFile, CiRunRecord, IntegrationCoverage } from '@foreman-code/contracts'
import { compactIntegrationCoverage } from '@foreman-code/contracts/ci-coverage'
import { functionSpans, maskedText, type FunctionSpan } from '@foreman-code/contracts/ci-function-coverage'
import { sha256Hex } from '@foreman-code/contracts-node/server-kit'
import type { CiFileMask, CiResultKey, CiResultKeys } from './resultCache.js'

/** Per test file, the functions it ran in each source file (paths from functionSpans). Source files it ran without a
 * set keep all their text. */
export type ExecutedFunctions = Record<string, Record<string, string[]>>

/** Executed functions as one key batch carries them: each distinct set once, and per test file the set of each source. */
export interface FunctionCoverageInput { sets: string[][]; tests: Record<string, Record<string, number>> }

/** The keys of the given test files under their function masks (functionMasks), computed at one commit. */
export type MaskedKeys = (files: string[], functions: FunctionCoverageInput) => Promise<Record<string, string | null>>

/** The report's file map without its function sets. */
export function withoutFunctions(report: IntegrationCoverage): IntegrationCoverage {
  const files = { ...report }
  delete files.functionSets
  delete files.functions
  return files
}

/** The largest compressed coverage report a device reply carries. */
const DEVICE_REPORT_LIMIT = 700_000

/** A coverage report as a device reply carries it (gzip, base64); one too large for the reply drops its function sets
 * first, since the file map alone still serves selection. Undefined when even that is too large. */
export function deviceCoverageReport(report: IntegrationCoverage): string | undefined {
  const compress = (value: IntegrationCoverage) => gzipSync(JSON.stringify(compactIntegrationCoverage(value))).toString('base64')
  const whole = compress(report)
  if (whole.length <= DEVICE_REPORT_LIMIT) return whole
  const filesOnly = compress(withoutFunctions(report))
  return filesOnly.length <= DEVICE_REPORT_LIMIT ? filesOnly : undefined
}

/** A proof older than this is not used, as for exact proofs. */
const PROOF_DAYS = 30

export function reportFunctions(report: IntegrationCoverage): ExecutedFunctions | undefined {
  if (!report.functionSets || !report.functions) return undefined
  const sets = report.functionSets
  return Object.fromEntries(Object.entries(report.functions).map(([test, indexes]) =>
    [test, Object.fromEntries(indexes.map(index => [sets[index]![0], sets[index]![1]]))]))
}

export function packFunctions(executed: ExecutedFunctions): FunctionCoverageInput {
  const sets: string[][] = []
  const indexes = new Map<string, number>()
  const tests = Object.fromEntries(Object.entries(executed).map(([test, files]) => [test, Object.fromEntries(
    Object.entries(files).map(([file, paths]) => {
      const key = JSON.stringify(paths)
      let index = indexes.get(key)
      if (index === undefined) {
        index = sets.push(paths) - 1
        indexes.set(key, index)
      }
      return [file, index]
    }))]))
  return { sets, tests }
}

let typescript: Promise<typeof import('typescript')> | undefined
const spanCache = new Map<string, FunctionSpan[]>()

/** Each test file's mask: a source file it ran with a set reads as its text with every other function's body blanked
 * (maskedText), so the key changes only when module code, a head or a body the test ran changes. */
export function functionMasks(input: FunctionCoverageInput): (test: string) => CiFileMask | undefined {
  const identities = new Map<string, Promise<string>>()
  return test => {
    const files = input.tests[test]
    if (!files) return undefined
    return async (path, blob, read) => {
      const set = files[path]
      if (set === undefined) return undefined
      const id = `${blob}\0${set}`
      let identity = identities.get(id)
      if (!identity) {
        identity = (async () => {
          const ts = await (typescript ??= import('typescript').then(module => module.default))
          const text = await read()
          let spans = spanCache.get(`${blob}\0${path}`)
          if (!spans) {
            spans = functionSpans(text, path, ts)
            if (spanCache.size >= 8192) spanCache.delete(spanCache.keys().next().value!)
            spanCache.set(`${blob}\0${path}`, spans)
          }
          return `masked:${sha256Hex(maskedText(text, spans, new Set(input.sets[set])))}`
        })()
        identities.set(id, identity)
      }
      return identity
    }
  }
}

/** The exact key, or with masks the key under the file's mask; a file without one has no masked key. */
export async function maskedKey(keys: CiResultKeys, file: string, suite: string, part: string,
  masks?: ReturnType<typeof functionMasks>): Promise<CiResultKey> {
  if (!masks) return keys.key(file, suite, part)
  const mask = masks(file)
  return mask ? keys.key(file, suite, part, mask) : { key: null, reason: 'no function coverage' }
}

const decode = (value: Buffer) => JSON.parse(gunzipSync(value).toString()) as Record<string, string[]>

/** Records, for each test file the part proved, the functions it ran and its key under them at the part's commit.
 * Sets merge with the file's earlier record: blanking less only makes the proof stricter, and paths the code no
 * longer has blank nothing. */
export async function recordFunctionProofs(pool: pg.Pool, run: CiRunRecord, passed: readonly string[],
  executed: ExecutedFunctions, keys: MaskedKeys) {
  const files = passed.filter(file => executed[file])
  if (!files.length) return
  const saved = new Map((await pool.query<{ file: string; executed: Buffer }>(
    `select file,executed from ci_test_function_proofs where workspace_id=$1 and repository=$2 and suite=$3 and file=any($4::text[])`,
    [run.workspaceId, run.repository, run.suite, files])).rows.map(row => [row.file, decode(row.executed)]))
  const merged: ExecutedFunctions = Object.fromEntries(files.map(file => {
    const before = saved.get(file) ?? {}
    const now = executed[file]!
    // A source the file ran without a set now (whole text) stays whole.
    return [file, Object.fromEntries(Object.entries(now).map(([source, paths]) =>
      [source, [...new Set([...before[source] ?? [], ...paths])].sort()]))]
  }))
  const masked = await keys(files, packFunctions(merged))
  const proven = files.filter(file => masked[file])
  if (!proven.length) return
  await pool.query(`insert into ci_test_function_proofs(workspace_id,repository,suite,file,cache_key,executed,ticket_id,commit,passed_at)
    select $1,$2,$3,proven.file,proven.cache_key,proven.executed,$4,$5,$9
      from unnest($6::text[],$7::text[],$8::bytea[]) as proven(file,cache_key,executed)
    on conflict (workspace_id,repository,suite,file) do update set cache_key=excluded.cache_key, executed=excluded.executed,
      ticket_id=excluded.ticket_id, commit=excluded.commit, passed_at=excluded.passed_at
      where ci_test_function_proofs.passed_at <= excluded.passed_at`,
  [run.workspaceId, run.repository, run.suite, run.id, run.commit, proven, proven.map(file => masked[file]!),
    proven.map(file => gzipSync(JSON.stringify(merged[file]))), run.finishedAt ?? new Date().toISOString()])
}

/** The files whose latest function proof still holds at the commit: their key under the functions they ran is the
 * one they passed with, and no failure came after. */
export async function functionProven(pool: pg.Pool, input: { workspaceId: string; repository: string; suite: string
  files: readonly string[] }, keys: MaskedKeys): Promise<CiCachedFile[]> {
  if (!input.files.length) return []
  const rows = (await pool.query<{ file: string; cache_key: string; executed: Buffer; ticket_id: string; commit: string }>(
    `select p.file,p.cache_key,p.executed,p.ticket_id,p.commit from ci_test_function_proofs p
      where p.workspace_id=$1 and p.repository=$2 and p.suite=$3 and p.file=any($4::text[])
        and p.passed_at > now() - make_interval(days => $5)
        and not exists (select 1 from ci_test_failures f where f.workspace_id=p.workspace_id and f.repository=p.repository
          and f.suite=p.suite and f.file=p.file and f.failed_at >= p.passed_at)`,
    [input.workspaceId, input.repository, input.suite, input.files, PROOF_DAYS])).rows
  if (!rows.length) return []
  const masked = await keys(rows.map(row => row.file),
    packFunctions(Object.fromEntries(rows.map(row => [row.file, decode(row.executed)]))))
  return rows.filter(row => masked[row.file] === row.cache_key)
    .map(row => ({ file: row.file, ticketId: row.ticket_id, commit: row.commit }))
}
