// Lints only the files whose result could have changed since they last passed, for type-aware ESLint rules.
// Typed files key the declarations/sources TypeScript actually resolves, their imported package trees and active
// compiler inputs. JavaScript files key only their own text and lint inputs. Exemptions are keyed per file.
// ESLint's own --cache keys a file by its text alone, so a typed rule could keep passing a file whose import changed.
// Usage, from a package directory: node ../../scripts/eslint-closure-cache.mjs [eslint args...]
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { createRequire, isBuiltin } from 'node:module'
import { pendingSqlTextTests } from './eslint-plugin-foreman/pendingSqlTextTests.mjs'
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

const edges = new Map()
function dependencies(file) {
  let value = edges.get(file)
  if (value) return value
  value = { files: [], installed: [] }
  const source = ts.createSourceFile(file, text(file), ts.ScriptTarget.Latest, true)
  source.impliedNodeFormat = ts.getImpliedNodeFormatForFile(file, undefined, ts.sys, config.options)
  value.mode = source.impliedNodeFormat
  const visit = node => {
    const parent = node.parent
    if (ts.isStringLiteralLike(node) && (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)
      || ts.isExternalModuleReference(parent)
      || (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent))
      || (ts.isCallExpression(parent) && parent.arguments[0] === node
        && (parent.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(parent.expression) && parent.expression.text === 'require'))))) {
      const specifier = node.text
      const mode = ts.getModeForUsageLocation(source, node, config.options)
      const resolved = ts.resolveModuleName(specifier, file, config.options, ts.sys, resolutionCache, undefined, mode)
      const target = resolved.resolvedModule?.resolvedFileName
      const actual = target && realpathSync(target)
      if (actual && !actual.split(/[\\/]/).includes('node_modules')) {
        value.files.push(actual)
      } else if (!specifier.startsWith('.') && !specifier.startsWith('node:') && !isBuiltin(specifier)) {
        const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
        value.installed.push(installedIdentity(file, name))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  const info = ts.preProcessFile(text(file), false, true)
  for (const { fileName } of info.referencedFiles) {
    const target = resolve(dirname(file), fileName)
    if (existsSync(target)) value.files.push(target)
  }
  edges.set(file, value)
  return value
}
function closureKey(file, shared) {
  const seen = new Set([file]), queue = [file], installed = new Set()
  while (queue.length) {
    const next = dependencies(queue.pop())
    for (const target of next.files) if (!seen.has(target)) { seen.add(target); queue.push(target) }
    for (const identity of next.installed) installed.add(identity)
  }
  const parts = [...seen].sort().map(path => `${relative(root, path)}\0${fileHash(path)}\0${dependencies(path).mode ?? ''}`)
  return hash([shared, ...parts, ...[...installed].sort()].join('\n'))
}

const projectFiles = walk(project)
// Global scripts and module augmentations affect types even when no file imports them.
const ambientFiles = config.fileNames.filter(file => {
  const source = ts.createSourceFile(file, text(file), ts.ScriptTarget.Latest, false)
  return !ts.isExternalModule(source) || source.statements.some(node => ts.isModuleDeclaration(node)
    && (node.flags & ts.NodeFlags.GlobalAugmentation || ts.isStringLiteral(node.name)))
})
const sharedInputs = [
  ...projectFiles.filter(file => /(?:^|\/)eslint\.config\.[cm]?js$/.test(file)),
  join(root, 'package.json'), join(project, 'package.json'),
  join(root, 'scripts/lint-allowlist.mjs'),
  resolve(import.meta.filename),
  ...walk(join(root, 'scripts/eslint-plugin-foreman')).filter(file => !file.endsWith('/pendingSqlTextTests.mjs')),
].filter(file => existsSync(file)).sort()
// Resolution fields can affect lint; descriptive metadata, scripts and CI settings cannot. Installed dependency
// versions are already tracked through the lock identities above, rather than the manifest's version ranges.
function inputHash(file) {
  if (!file.endsWith('package.json')) return fileHash(file)
  const manifest = JSON.parse(text(file))
  return hash(JSON.stringify(Object.fromEntries(['name', 'type', 'imports', 'exports', 'main', 'types', 'typings', 'typesVersions']
    .map(key => [key, manifest[key]]))))
}
const shared = hash(JSON.stringify([process.version, process.argv.slice(2),
  locked.get('tools:.') ?? null, locked.get(`tools:${importerOf(join(project, 'package.json'))}`) ?? null,
  sharedInputs.map(file => [relative(root, file), inputHash(file)])]))
const typedShared = hash(JSON.stringify([shared, [...configInputs].sort().map(file => [relative(root, file), fileHash(file)]),
  ambientFiles.sort().map(file => closureKey(file, ''))]))
const allowlist = JSON.parse(text(join(root, 'scripts/lint-allowlist.json')))
function exemptionKey(file) {
  const id = fileHash(file)
  const disabled = process.env.FOREMAN_LINT_BASELINE === '1' || !allowlist.files?.[id] ? []
    : Object.entries(allowlist.eslint ?? {}).filter(([, ids]) => ids.includes(id)).map(([rule]) => rule).sort()
  return JSON.stringify([disabled, pendingSqlTextTests.has(relative(root, file))])
}
const targets = projectFiles.filter(file => sourcePattern.test(file)).sort()
const keys = Object.fromEntries(targets.map(file => [relative(project, file), /\.[cm]?tsx?$/.test(file)
  ? closureKey(file, `${typedShared}\n${exemptionKey(file)}`)
  : hash([shared, fileHash(file), exemptionKey(file)].join('\n'))]))
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
