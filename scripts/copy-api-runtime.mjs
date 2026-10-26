import { apiRuntimeFiles } from '../packages/verification-runner/runtime-files.mjs'
import { createRuntimeBuildIdentity } from '../packages/contracts/src/runtimeBuildIdentityNode.mjs'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function copyApiRuntime(repository, output) {
  // Preserve the builder's relative asset paths inside the deployed API package.
  const runtime = join(output, 'ci-runtime')
  for (const path of apiRuntimeFiles) {
    const destination = join(runtime, path)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(join(repository, path), destination)
  }
  const browserSkill = 'modules/browser-runtime/skill/browser-use.md'
  await mkdir(dirname(join(output, browserSkill)), { recursive: true })
  await copyFile(join(repository, 'apps/api/src', browserSkill), join(output, browserSkill))
  const entrypoint = join(output, 'modules/jobs/ciRuntimeContext.mjs')
  await mkdir(dirname(entrypoint), { recursive: true })
  await writeFile(entrypoint,
    "export { buildCiRuntimeContext, ciRuntimeInputDigest, parseCiLock } from '../../ci-runtime/apps/worker/artifacts/ci-runtime/context.mjs'\n")
  await writeFile(join(output, 'runtime-build.json'), `${JSON.stringify(createRuntimeBuildIdentity(repository))}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repository = fileURLToPath(new URL('../', import.meta.url))
  const output = join(repository, 'apps/api/dist')
  await copyApiRuntime(repository, output)
}
