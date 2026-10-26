// Fingerprint compiler inputs by parsing/resolving them, without checking or emitting a project.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonicalJson } from '../packages/contracts/src/canonicalJson.ts'
import { createRuntimeBuildIdentity } from '../packages/contracts/src/runtimeBuildIdentityNode.mjs'
import { apiRuntimeFiles } from '../packages/verification-runner/runtime-files.mjs'

export function compilerCacheKey(root, kind) {
  root = resolve(root)
  const project = join(root, 'apps', kind === 'api' ? 'api' : 'web')
  const require = createRequire(join(project, 'package.json'))
  const ts = require('typescript')
  const inputs = new Map()
  const add = (path, contents) => inputs.set(relative(root, path), contents)
  add(require.resolve('typescript'), readFileSync(require.resolve('typescript')))
  const workspaces = []
  for (const parent of ['apps', 'packages']) {
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      const directory = join(root, parent, entry.name)
      if (entry.isDirectory() && existsSync(join(directory, 'package.json'))) {
        workspaces.push({ directory, name: JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name })
      }
    }
  }
  // Workspace declarations are rebuilt later in the suite. Resolve their sources even if dist is missing or stale.
  const sourcePath = path => {
    for (const { directory, name } of workspaces) {
      const alias = `/node_modules/${name}/`
      if (path.includes(alias)) path = join(directory, path.slice(path.lastIndexOf(alias) + alias.length))
      if (path === `${directory}/dist`) return `${directory}/src`
      const prefix = `${directory}/dist/`
      if (!path.startsWith(prefix)) continue
      const base = join(directory, 'src', path.slice(prefix.length))
      const candidates = /\.d\.[cm]?ts$/.test(base)
        ? [base.replace(/\.d\.ts$/, '.ts'), base.replace(/\.d\.mts$/, '.mjs'), base]
        : [base]
      return candidates.find(candidate => existsSync(candidate)) ?? base
    }
    return path
  }
  const resolutionFields = ['name', 'type', 'main', 'module', 'types', 'typings', 'exports', 'imports', 'typesVersions']
  const readFile = path => {
    const contents = ts.sys.readFile(sourcePath(path))
    if (contents !== undefined && path.endsWith('/package.json')) {
      const manifest = JSON.parse(contents)
      add(path, canonicalJson(Object.fromEntries(resolutionFields.map(field => [field, manifest[field]]))))
    }
    return contents
  }
  const configs = kind === 'api' ? ['tsconfig.build.json'] : ['tsconfig.app.json', 'tsconfig.node.json']
  for (const name of configs) {
    const config = ts.getParsedCommandLineOfConfigFile(join(project, name), {}, {
      ...ts.sys, readFile,
      onUnRecoverableConfigFileDiagnostic(error) { throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n')) },
    })
    if (config.errors.length) throw new Error(ts.flattenDiagnosticMessageText(config.errors[0].messageText, '\n'))
    // Effective options and roots, so unused configs and excluded CSS/assets/scripts never enter the key.
    add(join(project, name), canonicalJson({ options: config.options, roots: config.fileNames }).replaceAll(root, '<root>'))
    const host = ts.createCompilerHost(config.options)
    host.readFile = readFile
    host.fileExists = path => ts.sys.fileExists(sourcePath(path))
    host.directoryExists = path => ts.sys.directoryExists(sourcePath(path))
    host.realpath = path => ts.sys.realpath(sourcePath(path))
    const program = ts.createProgram(config.fileNames, config.options, host)
    for (const source of program.getSourceFiles()) add(sourcePath(source.fileName), source.text)
  }
  if (kind === 'api') {
    // These inputs really affect copied assets and the identity embedded in dist/runtime-build.json.
    add(join(root, 'runtime-build.json'), canonicalJson(createRuntimeBuildIdentity(root)))
    for (const path of [...apiRuntimeFiles, 'scripts/copy-api-runtime.mjs',
      'packages/verification-runner/runtime-files.mjs', 'packages/contracts/src/runtimeBuildIdentityNode.mjs']) {
      add(join(root, path), existsSync(join(root, path)) ? readFileSync(join(root, path)) : '<missing>')
    }
  }
  const hash = createHash('sha256').update(process.version).update(ts.version)
  for (const [path, contents] of [...inputs].sort(([a], [b]) => a.localeCompare(b))) hash.update(path).update('\0').update(contents).update('\0')
  return hash.digest('hex')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [kind, root = process.cwd()] = process.argv.slice(2)
  if (!['api', 'web'].includes(kind)) throw new Error('Usage: ci-compiler-key.mjs api|web [root]')
  console.log(compilerCacheKey(root, kind))
}
