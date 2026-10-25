import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'

it('installs the published recipe with real pinned Python, wheels and Chromium, including AppArmor recovery', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--test',
    fileURLToPath(new URL('../../worker/test/publishedBrowserRuntime.integration.mjs', import.meta.url))],
  { timeout: 850_000, maxBuffer: 8 * 1024 * 1024, env: process.env })
  console.info(stdout)
}, 900_000)
