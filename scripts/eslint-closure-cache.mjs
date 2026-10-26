// Lints only the files whose result could have changed since they last passed, for type-aware ESLint rules.
// A file's key hashes its own text, every repository file it imports (transitively, through workspace packages' exports
// to their sources), the locked tree of each installed package those files import, the project's locked development
// tools and the shared inputs (lint config, tsconfig, manifests, local rules, ambient declarations).
// ESLint's own --cache keys a file by its text alone, so a typed rule could keep passing a file whose import changed.
// Usage, from a package directory: node ../../scripts/eslint-closure-cache.mjs [eslint args...]
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { createRequire, isBuiltin } from 'node:module'
import { ciModuleCandidates, resolveImport, workspacePackageExports } from '../packages/contracts/src/ciImportGraph.mjs'
import { lockIdentities } from '../packages/contracts/src/ciLockIdentities.mjs'

const root = resolve(import.meta.dirname, '..')
const project = process.cwd()
const cacheFile = join(project, 'node_modules/.cache/eslint/closure-passes.json')
const sourcePattern = /\.(?:[cm]?[jt]sx?)$/
const skip = new Set(['node_modules', 'dist', 'build', 'coverage', '.logs', '.git'])
const ts = createRequire(join(project, 'package.json'))('typescript')
const configInputs = new Set()
const config = ts.getParsedCommandLineOfConfigFile(join(project, 'tsconfig.json'), {}, {
  ...ts.sys,
  readFile(path) {
    const value = ts.sys.readFile(path)
    if (value !== undefined) configInputs.add(path)
    return value
  },
  onUnRecoverableConfigFileDiagnostic(error) {
    throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'))
  },
})
if (config.errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(config.errors, {
  getCurrentDirectory: () => project, getCanonicalFileName: value => value, getNewLine: () => '\n',
}))
const resolutionCache = ts.createModuleResolutionCache(project, path => path, config.options)

function walk(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) walk(path, files)
    else if (entry.isFile()) files.push(path)
  }
  return files
}
const hash = value => createHash('sha256').update(value).digest('hex')
const contents = new Map(), fileHashes = new Map()
const text = path => {
  let value = contents.get(path)
  if (value === undefined) { value = readFileSync(path, 'utf8'); contents.set(path, value) }
  return value
}
const fileHash = path => {
  let value = fileHashes.get(path)
  if (value === undefined) { value = hash(text(path)); fileHashes.set(path, value) }
  return value
}

// Installed packages join a key by their locked trees, so a lockfile change relints only the files importing a package
// whose tree changed (or every file of a project whose development tools, such as ESLint or TypeScript, changed).
const loadYaml = () => {
  for (const base of [project, join(root, 'apps/ci')]) {
    try { return createRequire(join(base, 'package.json'))('yaml') }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }
  }
  throw new Error('The yaml package is needed to read pnpm-lock.yaml.')
}
const lockPath = join(root, 'pnpm-lock.yaml')
const lock = existsSync(lockPath) ? loadYaml().parse(text(lockPath)) : {}
const locked = lockIdentities(lock ?? {}, { packageMarker: 'package:', toolsMarker: 'tools:' })
const importers = Object.keys(lock?.importers ?? {}).sort((left, right) => right.length - left.length)
const importerOf = file => {
  const path = relative(root, file)
  return importers.find(importer => importer !== '.' && (path === importer || path.startsWith(`${importer}/`))) ?? '.'
}
const installedIdentity = (file, name) => locked.get(`package:${importerOf(file)}\t${name}`) ?? locked.get(`package:*\t${name}`)
  ?? `unlocked:${name}`
const workspaceExports = workspacePackageExports(path => existsSync(join(root, path)) ? text(join(root, path)) : undefined)
const repositoryPaths = { has: path => existsSync(join(root, path)) && statSync(join(root, path)).isFile() }

// Workspace packages a file may import by name. One whose exports map names its sources resolves to the exact source
// file; any other counts as its whole source tree.
const packages = new Map()
for (const parent of ['apps', 'packages']) {
  for (const name of readdirSync(join(root, parent))) {
    const manifest = join(root, parent, name, 'package.json')
    if (existsSync(manifest)) packages.set(JSON.parse(readFileSync(manifest, 'utf8')).name, join(root, parent, name))
  }
}
const packageHashes = new Map()
function packageHash(directory) {
  let value = packageHashes.get(directory)
  if (value === undefined) {
    const pending = walk(directory).filter(file => sourcePattern.test(file) || file.endsWith('package.json'))
    const files = new Set(), expanded = new Set([directory]), installedTrees = new Set()
    for (let index = 0; index < pending.length; index++) {
      const file = pending[index]
      if (files.has(file)) continue
      files.add(file)
      const next = dependencies(file)
      pending.push(...next.files)
      for (const identity of next.installed) installedTrees.add(identity)
      for (const dependency of next.packages) {
        if (expanded.has(dependency)) continue
        expanded.add(dependency)
        pending.push(...walk(dependency).filter(file => sourcePattern.test(file) || file.endsWith('package.json')))
      }
    }
    value = hash([...[...files].sort().map(file => `${relative(root, file)}\0${fileHash(file)}`), ...[...installedTrees].sort()].join('\n'))
    packageHashes.set(directory, value)
  }
  return value
}

function resolveRelative(from, specifier) {
  for (const candidate of ciModuleCandidates(resolve(dirname(from), specifier))) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return undefined
}
const edges = new Map()
function dependencies(file) {
  let value = edges.get(file)
  if (value) return value
  value = { files: [], packages: [], installed: [] }
  const info = ts.preProcessFile(text(file), true, true)
  for (const { fileName: specifier } of info.importedFiles) {
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
    if (!specifier.startsWith('.') && packages.has(name)) {
      const source = name in workspaceExports ? resolveImport(relative(root, file), specifier, repositoryPaths, workspaceExports) : null
      if (source) value.files.push(join(root, source))
      else value.packages.push(packages.get(name))
      continue
    }
    // Static imports and dynamic imports can select different export conditions in the same file.
    const targets = [ts.ModuleKind.ESNext, ts.ModuleKind.CommonJS].map(mode =>
      ts.resolveModuleName(specifier, file, config.options, ts.sys, resolutionCache, undefined, mode).resolvedModule?.resolvedFileName)
    if (specifier.startsWith('.')) targets.push(resolveRelative(file, specifier))
    let inRepository = false
    for (const target of new Set(targets)) {
      if (target && !target.split(/[\\/]/).includes('node_modules')) { value.files.push(target); inRepository = true }
    }
    if (!inRepository && !specifier.startsWith('.') && !specifier.startsWith('node:') && !isBuiltin(specifier)) {
      value.installed.push(installedIdentity(file, name))
    }
  }
  for (const { fileName } of info.referencedFiles) {
    const target = resolve(dirname(file), fileName)
    if (existsSync(target)) value.files.push(target)
  }
  edges.set(file, value)
  return value
}
function closureKey(file, shared) {
  const seen = new Set([file]), queue = [file], workspace = new Set(), installed = new Set()
  while (queue.length) {
    const next = dependencies(queue.pop())
    for (const target of next.files) if (!seen.has(target)) { seen.add(target); queue.push(target) }
    for (const directory of next.packages) workspace.add(directory)
    for (const identity of next.installed) installed.add(identity)
  }
  const parts = [...seen].sort().map(path => `${relative(root, path)}\0${fileHash(path)}`)
  const packageParts = [...workspace].sort().map(directory => `${relative(root, directory)}\0${packageHash(directory)}`)
  return hash([shared, ...parts, ...packageParts, ...[...installed].sort()].join('\n'))
}

const projectFiles = walk(project)
// Global scripts and module augmentations affect types even when no file imports them.
const ambientFiles = config.fileNames.filter(file => {
  const source = ts.createSourceFile(file, text(file), ts.ScriptTarget.Latest, false)
  return !ts.isExternalModule(source) || source.statements.some(node => ts.isModuleDeclaration(node)
    && (node.flags & ts.NodeFlags.GlobalAugmentation || ts.isStringLiteral(node.name)))
})
const sharedInputs = [
  ...configInputs, ...ambientFiles,
  ...projectFiles.filter(file => /(?:^|\/)(?:eslint\.config\.[cm]?js|tsconfig[^/]*\.json|package\.json)$/.test(file)
    || /\.d\.[cm]?ts$/.test(file)),
  join(root, 'package.json'), join(root, 'tsconfig.base.json'),
  join(root, 'scripts/lint-allowlist.json'), join(root, 'scripts/lint-allowlist.mjs'),
  resolve(import.meta.filename),
  ...walk(join(root, 'scripts/eslint-plugin-foreman')),
].filter(file => existsSync(file)).sort()
// A manifest's version and scripts cannot change a lint result; a release bump must not relint every file.
const inputHash = file => file.endsWith('package.json')
  ? hash(JSON.stringify({ ...JSON.parse(text(file)), version: undefined, scripts: undefined })) : fileHash(file)
const shared = hash(JSON.stringify([process.version, process.argv.slice(2),
  locked.get('tools:.') ?? null, locked.get(`tools:${importerOf(join(project, 'package.json'))}`) ?? null,
  process.env.FOREMAN_LINT_BASELINE ?? '',
  sharedInputs.map(file => [relative(root, file), inputHash(file)])]))

const targets = projectFiles.filter(file => sourcePattern.test(file)).sort()
const keys = Object.fromEntries(targets.map(file => [relative(project, file), closureKey(file, shared)]))
let passed = {}
try { passed = JSON.parse(readFileSync(cacheFile, 'utf8')).files ?? {} }
catch (error) { if (error.code !== 'ENOENT') console.warn(`Lint pass cache unreadable, linting everything: ${error.message}`) }
const stale = Object.keys(keys).filter(file => passed[file] !== keys[file])
console.log(`Lint closure cache: ${targets.length - stale.length} of ${targets.length} files unchanged since they passed; linting ${stale.length}.`)
let status = 0
// Each file proves itself: a file with no lint message passes and is recorded even when other files fail, so a fix
// commit relints only the failed files and the files whose inputs changed.
const failedFiles = new Set()
const reports = join(dirname(cacheFile), `eslint-report-${process.pid}.json`)
mkdirSync(dirname(cacheFile), { recursive: true })
// Bounded argument lists; ESLint still applies its ignores to every path it is given.
for (let start = 0; start < stale.length; start += 400) {
  const batch = stale.slice(start, start + 400)
  const result = spawnSync(process.execPath, ['--max-old-space-size=8192', './node_modules/eslint/bin/eslint.js',
    ...process.argv.slice(2), '--no-cache', '--no-warn-ignored', '--format', 'json', '--output-file', reports, ...batch],
  { stdio: 'inherit' })
  if (result.error) console.error('ESLint could not start:', result.error)
  let report
  try { report = JSON.parse(readFileSync(reports, 'utf8')) }
  catch (error) {
    // Without a report no file in the batch is proven.
    console.error(`ESLint report unreadable: ${error.message}`)
    for (const file of batch) failedFiles.add(file)
    status ||= result.status || 1
    continue
  }
  const before = failedFiles.size
  for (const entry of report) {
    if (!entry.messages.length) continue
    const file = relative(project, entry.filePath)
    failedFiles.add(file)
    for (const message of entry.messages) {
      console.log(`${file}:${message.line ?? 0}:${message.column ?? 0}  ${message.severity === 2 ? 'error' : 'warning'}  `
        + `${message.message}  ${message.ruleId ?? ''}`)
    }
  }
  // A failing exit without messages (a crash or a configuration error) proves nothing in the batch.
  if (result.status !== 0 && failedFiles.size === before) for (const file of batch) failedFiles.add(file)
  status ||= result.status ?? 1
}
try { rmSync(reports, { force: true }) } catch (error) { console.warn(`ignore: report cleanup failed: ${error.message}`) }
// Keys of files that passed, now or earlier; failed and unchecked files keep no pass.
const proven = Object.fromEntries(Object.entries(keys).filter(([file]) => !failedFiles.has(file)))
const temporary = `${cacheFile}.${process.pid}.tmp`
writeFileSync(temporary, JSON.stringify({ files: proven }))
renameSync(temporary, cacheFile)
if (failedFiles.size) console.log(`Lint: ${failedFiles.size} file(s) failed; ${Object.keys(proven).length} proven files are recorded.`)
process.exit(status)
