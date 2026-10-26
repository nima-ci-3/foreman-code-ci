import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./ci-publish-suite-state.sh', import.meta.url))

function publish(uploadFailures) {
  const root = mkdtempSync(join(tmpdir(), 'ci-publish-state-'))
  try {
    mkdirSync(join(root, 'apps/api/node_modules/.cache/tsc'), { recursive: true })
    writeFileSync(join(root, 'apps/api/node_modules/.cache/tsc/state'), 'new')
    mkdirSync(join(root, 'packages'))
    mkdirSync(join(root, '.logs'))
    writeFileSync(join(root, '.logs/ci-suite-state-before'), 'old')
    const bin = join(root, 'bin')
    mkdirSync(bin)
    // A gh stand-in: the release exists, and the first `uploadFailures` uploads fail like a GitHub 500.
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
[ "$2" = upload ] || exit 0
echo upload >> "${root}/uploads"
[ "$(wc -l < "${root}/uploads")" -gt ${uploadFailures} ] || { echo 'HTTP 500' >&2; exit 1; }
`)
    chmodSync(join(bin, 'gh'), 0o755)
    const result = spawnSync(script, { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
      ASSET: 'state.tar.gz', GITHUB_REPOSITORY: 'owner/repo', RUNNER_TEMP: root, CI_STATE_RETRY_SECONDS: '0' } })
    return { status: result.status, output: result.stdout + result.stderr, uploads: readFileSync(join(root, 'uploads'), 'utf8').split('\n').filter(Boolean).length }
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('a transient upload failure is retried and the passing check stays passed', () => {
  assert.deepEqual((({ status, uploads }) => ({ status, uploads }))(publish(1)), { status: 0, uploads: 2 })
})

test('a persistent GitHub failure warns instead of failing the check', () => {
  const result = publish(10)
  assert.equal(result.status, 0)
  assert.equal(result.uploads, 3)
  assert.match(result.output, /::warning::Could not publish state\.tar\.gz/)
})
