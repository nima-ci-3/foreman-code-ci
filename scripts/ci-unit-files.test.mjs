import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { durationSlice, measuredUnitDurations, unitFiles } from './ci-unit-files.mjs'

test('duration slices balance measured work and cover every file exactly once', () => {
  const durations = { a: 100, b: 80, c: 60, d: 40, e: 20, f: 10 }
  const files = Object.keys(durations)
  const shards = [1, 2, 3].map(index => durationSlice(files, durations, `${index}/3`))
  assert.deepEqual(shards.flat().sort(), files)
  const loads = shards.map(shard => shard.reduce((sum, file) => sum + durations[file], 0))
  assert.ok(Math.max(...loads) - Math.min(...loads) <= 10)
  assert.deepEqual(durationSlice([...files].reverse(), durations, '1/3'), shards[0])
})

test('unmeasured files use the measured median and invalid durations use the same fallback', () => {
  const files = ['a', 'b', 'c', 'd']
  assert.deepEqual(durationSlice(files, { a: 100, b: 40 }, '1/2'), ['a', 'd'])
  assert.deepEqual(durationSlice(files, { a: 100, b: 40, c: -1, d: null }, '1/2'), ['a', 'd'])
  assert.deepEqual(durationSlice(files, {}, '1/2'), ['a', 'c'])
  assert.deepEqual(durationSlice(files, { a: NaN, b: Infinity }, '2/2'), ['b', 'd'])
  assert.deepEqual(durationSlice([...files].reverse(), {}), files)
})

test('invalid and empty shards fail instead of starting an unfiltered suite', () => {
  for (const slice of ['0/2', '3/2', '1/0', '1/3', 's:1', '1.5/2', '1/2/3']) {
    assert.throws(() => durationSlice(['a', 'b'], {}, slice), /Invalid unit slice/)
  }
})

test('unit CLI partitions a learned snapshot by typical durations even when peaks have a different order', t => {
  const directory = mkdtempSync(join(tmpdir(), 'unit-estimates-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'durations.json')
  const files = ['apps/api/src/a.test.ts', 'apps/api/src/b.test.ts', 'apps/api/src/c.test.ts']
  const durations = Object.fromEntries(files.map((file, index) => [file, [100, 40, 30][index]]))
  writeFileSync(path, JSON.stringify({ durations, durationPeaks: { ...durations, [files[2]]: 10_000 } }))
  const bin = join(directory, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'git'), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(files.join('\0') + '\0')})\n`, { mode: 0o755 })
  const result = spawnSync(process.execPath, ['scripts/ci-unit-files.mjs', 'select', 'unit-api', '1/2'], {
    encoding: 'utf8', env: { ...process.env, DURATIONS_INPUT: path, PATH: `${bin}${delimiter}${process.env.PATH}` },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.split('\0').filter(Boolean), ['src/a.test.ts'])
})

test('API discovery retains unit tests and excludes integration, acceptance and generated files', () => {
  assert.deepEqual(unitFiles([
    'apps/api/test/a.test.ts', 'apps/api/src/b.spec.tsx', 'apps/api/test/c.test.mjs',
    'apps/api/test/a.integration.test.ts', 'apps/api/test/a.acceptance.test.ts',
    'apps/api/node_modules/module/a.test.ts', 'apps/api/dist/a.test.js',
    'apps/web/src/a.test.tsx', 'apps/api/test/helper.ts',
  ], 'unit-api'), ['apps/api/src/b.spec.tsx', 'apps/api/test/a.test.ts', 'apps/api/test/c.test.mjs'])
  assert.throws(() => unitFiles([], 'other'), /Unknown unit suite/)
})

test('JSON reporter timings retain only successful files inside the selected package', () => {
  const root = resolve('report-fixture')
  const result = (name, status, startTime, endTime) => ({ name: resolve(root, name), status, startTime, endTime })
  const report = { testResults: [
    result('apps/api/test/a.test.ts', 'passed', 100, 175),
    result('apps/api/test/b.test.ts', 'failed', 100, 300),
    result('apps/api/test/c.test.ts', 'passed', 100, 100),
    result('apps/api/test/d.test.ts', 'passed', 100, undefined),
    result('apps/web/src/a.test.tsx', 'passed', 100, 200),
    result('../outside.test.ts', 'passed', 100, 200),
  ] }
  assert.deepEqual(measuredUnitDurations(report, root), { 'apps/api/test/a.test.ts': 75 })
  assert.deepEqual(measuredUnitDurations({}, root), {})
})

for (const exitCode of [0, 7]) {
  test(`unit runner saves durations and preserves command exit ${exitCode}`, t => {
    const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'unit-durations-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const output = join(directory, 'reports', 'durations.json')
    const calls = join(directory, 'calls.json')
    const root = fileURLToPath(new URL('..', import.meta.url))
    mkdirSync(join(directory, 'reports'))
    writeFileSync(join(directory, 'pnpm'), `#!${process.execPath}
const { writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
const args = process.argv.slice(2)
if (args.includes('build')) process.exit(0)
writeFileSync(process.env.CALLS_FILE, JSON.stringify(args))
const report = args.find(arg => arg.startsWith('--outputFile.json=')).split('=').slice(1).join('=')
const file = args.find(arg => arg.endsWith('.test.tsx') || arg.endsWith('.test.ts') || arg.endsWith('.spec.ts'))
writeFileSync(report, JSON.stringify({ testResults: [
  { name: resolve(file), startTime: 100, endTime: 175, status: 'passed' }
] }))
process.exit(Number(process.env.SUITE_EXIT_CODE))
`, { mode: 0o755 })
    // The API slice joins a CI cgroup through sudo; the fixture has nothing to delegate.
    writeFileSync(join(directory, 'sudo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const result = spawnSync('bash', ['scripts/ci-suite.sh'], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, SUITE: 'unit-api', SCOPE: 'full', SLICE: '1/3', CI_PREREQUISITES_UNTRACKED: '1',
        CI_PROGRESS_FILE: '', CI_WATCHDOG_ACTIVE: '', CI_EXPECTED_DURATION_MS: '',
        CI_HOST_RUNNER: '0',
        DURATIONS_INPUT: '', DURATIONS_OUTPUT: output, CI_STATE: join(directory, 'state'),
        PATH: `${directory}${delimiter}${process.env.PATH}`, CALLS_FILE: calls,
        SUITE_EXIT_CODE: String(exitCode) },
    })
    assert.equal(result.status, exitCode, result.stderr)
    const args = JSON.parse(readFileSync(calls, 'utf8'))
    assert.ok(args.includes('--reporter=default'))
    assert.ok(args.includes('--reporter=json'))
    assert.ok(!args.some(arg => arg.startsWith('--shard=')))
    const measured = JSON.parse(readFileSync(output, 'utf8'))
    assert.equal(Object.keys(measured).length, 1)
    assert.equal(Object.values(measured)[0], 75)
    assert.ok(Object.keys(measured)[0].startsWith('apps/api/'))
    assert.equal(JSON.parse(readFileSync(`${output}.vitest.json`, 'utf8')).testResults.length, 1)
  })
}
