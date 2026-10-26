import { isBuiltin } from 'node:module'
import { posix } from 'node:path'
import { ciCodeFile, ciExportSource, importSpecifiers, resolveImport } from '@foreman-code/contracts/ci-import-graph'
import { sha256Hex } from '@foreman-code/contracts-node/server-kit'
import { parse as parseYaml } from 'yaml'

/** Bump when the key inputs or the doubt rules change, so earlier passes stop matching. */
const CI_RESULT_CACHE_VERSION = 2

/** A test file's input key, or null with the reason it must run. `runnerFreeKey` leaves out the files that run tests
 * (TEST_EXECUTION_FILES): a proof that matches only it was made by another runner, so a sample of such files reruns. */
export interface CiResultKey { key: string | null; reason?: string; runnerFreeKey?: string }

/** One commit of the repository for result cache keys. */
export interface CiTestTree {
  /** Every file with its git mode and blob id (`100644:<sha>`), which change with its content. */
  blobs: ReadonlyMap<string, string>
  read(path: string, signal: AbortSignal): Promise<string>
}

/** The key cannot prove the file's inputs, so the file must run. */
class CacheDoubt extends Error {}

interface Analysis {
  specifiers: string[]; literals: string[]; relatives: string[]
  /** Each computed import or require call: the string literals its argument names. */
  computed: { kind: 'import' | 'require'; literals: string[] }[]
  /** Each process start (spawn, exec, fork, new Worker): whether its command is named, and the literals it passes. */
  processes: { named: boolean; literals: string[]; command: string[] }[]
  /** Directories named relative to the file by URL (`new URL('.', import.meta.url)`). */
  anchoredDirectories: string[]
  /** `// ci-key-inputs: <path or package> ...`: what a test that builds and runs artifacts actually depends on. */
  declaredInputs: string[]
  doubt: string | null; testDoubt: string | null
}

const ANALYSES_MAX = 50_000
/** By blob and extension: a blob's imports never change. */
const analyses = new Map<string, Analysis>()

/**
 * Files that run tests and report their results, wherever a test lives: the suite script and what it runs, the test
 * runners and reporters, result parsing and collection, and the CI workflows. Their imports join every key too.
 * Other CI code (selection, admission, planning, Main's result collection, lint checks) cannot change a test's
 * outcome; a test that uses it imports it and is keyed on it like any other code.
 */
const TEST_EXECUTION_FILES = [
  /^scripts\/(?:ci-suite\.sh|ci-user-systemd\.sh|ci-affected-run\.mjs|ci-files\.mjs|ci-unit-files\.mjs|ci-test-results\.mjs|ci-node-test-reporter\.mjs|ci-progress-reporter\.mjs|ci-package-paths\.mjs|ci-packages\.mjs|ci-contracts\.mjs|ci-watchdog\.mjs|ci-remote\.mjs|heavy-job\.mjs|test-command\.mjs|test-db\.mjs|test-integration[^/]*\.mjs|test-resources[^/]*\.mjs|integration-[^/]+\.mjs|vitest-[^/]+\.mjs)$/,
  /^packages\/contracts\/ci-test-runner\.mjs$/,
  /^packages\/ci-protocol\/src\//,
  /^(?:\.github\/workflows|\.circleci)\//,
]
/** A project's own run configuration: its manifest, TypeScript and Vitest configs (setup files follow from the config). */
const PROJECT_CONFIG = /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|vitest\.config\.[cm]?[jt]s)$/

const DOUBTS: [RegExp, string][] = [
  [/import\.meta\.glob/, 'imports a glob'],
]

/** The index just past the parenthesis that closes the one at `open`, skipping strings; -1 when it never closes. */
function closingParen(text: string, open: number) {
  let depth = 0
  for (let index = open; index < text.length; index++) {
    const char = text[index]!
    if (char === '"' || char === "'" || char === '`') {
      for (index++; index < text.length && text[index] !== char; index++) if (text[index] === '\\') index++
    } else if (char === '(') depth++
    else if (char === ')' && --depth === 0) return index + 1
  }
  return -1
}

/** For each character of a source text, whether it is code (not inside a string, template text or comment), so
 * generated code inside template literals and documentation are not read as calls. Regex literals are not tracked. */
function codeMask(text: string) {
  const code = new Uint8Array(text.length)
  const templates: number[] = [] // brace depth of each open `${`
  let state: 'code' | 'line' | 'block' | "'" | '"' | '`' = 'code'
  let depth = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!, next = text[index + 1]
    if (state === 'code') {
      if (char === '/' && next === '/') { state = 'line'; index++; continue }
      if (char === '/' && next === '*') { state = 'block'; index++; continue }
      if (char === "'" || char === '"' || char === '`') { state = char; continue }
      if (char === '{') depth++
      else if (char === '}') {
        if (templates.length && depth === templates[templates.length - 1]) { templates.pop(); state = '`'; continue }
        depth--
      }
      code[index] = 1
    } else if (state === 'line') { if (char === '\n') state = 'code' }
    else if (state === 'block') { if (char === '*' && next === '/') { state = 'code'; index++ } }
    else if (char === '\\') index++
    else if (state === '`' && char === '$' && next === '{') { templates.push(depth); state = 'code'; index++ }
    else if (char === state) state = 'code'
  }
  return code
}

/** Every import or require call whose argument is not one string literal, with the literals the argument names:
 * `import(join(release, 'apps/worker/src/x.mjs'))`, `createRequire(import.meta.url)('../package.json')`, and calls of
 * a name bound to createRequire. Method calls and declarations (`dispatch.require(...)`) and `require.resolve` (which
 * only finds a path) load nothing. */
/** Every call that starts a process. Its command is named when it is a literal (a system tool such as git, or a
 * repository script the literals name) or Node running a script a literal names; anything else could run any file. */
function processCalls(text: string, code: Uint8Array): Analysis['processes'] {
  const calls: Analysis['processes'] = []
  for (const match of text.matchAll(/(?<![\w$])(?:(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(|new\s+Worker\s*\()/g)) {
    if (!code[match.index] || (text[match.index - 1] === '.' && !/\b(?:child_process|childProcess|cp)\.$/.test(text.slice(match.index - 20, match.index)))) continue
    const open = match.index + match[0].length - 1
    const close = closingParen(text, open)
    if (close > 0 && /^\s*[:{]/.test(text.slice(close, close + 40))) continue
    const argument = close < 0 ? text.slice(open + 1) : text.slice(open + 1, close - 1)
    const declared = [...argument.matchAll(/\/\*\s*ci-key:\s*(\S+)\s*\*\//g)].map(found => found[1]!)
    const literals = [...declared, ...[...argument.matchAll(/(['"`])([^'"`$\n]+)\1/g)].map(literal => literal[2]!)]
    // The command is the first argument, or what a variable holding it is defined as in this file.
    const first = argument.replace(/\/\*[^]*?\*\//g, '').trimStart()
    const name = /^([A-Za-z_$][\w$]*)\s*[,)]?/.exec(first)?.[1]
    const definition = name && !/^(?:process)$/.test(name)
      // A declaration or a parameter default (`runtime = process.execPath`).
      ? new RegExp(`(?:\\b(?:const|let|var)\\s+|[(,]\\s*)${name.replace(/\$/g, '\\$')}(?:\\s*:\\s*[\\w.]+)?\\s*=\\s*([^;\\n,)]+)`).exec(text)?.[1]
      : undefined
    const command = (value: string) => /^\s*(['"`])[^'"`$]+\1/.test(value)
    // Node runs inline code or a script; a repository script is reached through the paths the file names, which
    // join the key on their own.
    const node = (value: string) => /^\s*process\.execPath\b/.test(value)
    // The literals of the command argument itself (`fork(fileURLToPath(new URL('./child.ts', import.meta.url)))`):
    // a command that names a repository file is proven by it.
    let depth = 0, end = first.length
    for (let index = 0; index < first.length; index++) {
      const char = first[index]!
      if (char === '"' || char === "'" || char === '`') {
        for (index++; index < first.length && first[index] !== char; index++) if (first[index] === '\\') index++
      } else if ('([{'.includes(char)) depth++
      else if (')]}'.includes(char)) depth--
      else if (char === ',' && depth === 0) { end = index; break }
    }
    calls.push({ named: declared.length > 0 || command(first) || node(first)
      || definition !== undefined && (command(definition) || node(definition)), literals,
      command: [...first.slice(0, end).matchAll(/(['"`])([^'"`$\n]+)\1/g)].map(literal => literal[2]!) })
  }
  return calls
}

function computedCalls(text: string, code: Uint8Array): Analysis['computed'] {
  const names = [...new Set(['require', ...[...text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createRequire\s*\(/g)]
    .map(match => match[1]!)])].map(name => name.replace(/\$/g, '\\$')).join('|')
  const call = new RegExp(`(?<![.\\w$])(?:(import)|(?:${names})|createRequire\\s*\\([^()]*(?:\\([^()]*\\)[^()]*)*\\))\\s*\\(`, 'g')
  const calls: Analysis['computed'] = []
  for (const match of text.matchAll(call)) {
    if (!code[match.index]) continue
    const open = match.index + match[0].length - 1
    const close = closingParen(text, open)
    // `require(sql: JobSql): Promise<void>` or `async require(...) {` declares a method.
    if (close > 0 && /^\s*[:{]/.test(text.slice(close, close + 40))) continue
    const argument = close < 0 ? text.slice(open + 1) : text.slice(open + 1, close - 1)
    // One literal argument is an ordinary specifier (importSpecifiers reads it), except a createRequire call's.
    if (/^\s*(['"])[^'"]*\1\s*(?:,[^]*)?$/.test(argument) && !match[0].startsWith('createRequire')) continue
    // `import(/* ci-key: <specifier> */ path)` names what a runtime path loads: an installed package the lockfile
    // pins, or the repository file a bundle is built from. The named input joins the key like a literal.
    const declared = [...argument.matchAll(/\/\*\s*ci-key:\s*(\S+)\s*\*\//g)].map(found => found[1]!)
    // A path held in a variable is traced one step to the expression that defines it in this file.
    // A definition the environment or arguments can override (`process.env.X ?? './a.js'`) proves nothing.
    const defined = [...new Set(argument.match(/(?<![.\w$'"`])[A-Za-z_$][\w$]*/g) ?? [])].flatMap(name =>
      [...text.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*=\\s*([^;\\n]+)`, 'g'))].map(found => found[1]!))
      .filter(definition => !/\bprocess\.|\?\?|\|\|/.test(definition))
    calls.push({ kind: match[1] ? 'import' : 'require', literals: [...declared,
      ...[argument, ...defined].flatMap(value => [...value.matchAll(/(['"`])([^'"`$\n]+)\1/g)].map(literal => literal[2]!))] })
  }
  return calls
}
/** Test code that reads repository files by path or runs other programs depends on files no import names. */
const TEST_DOUBTS: [RegExp, string][] = [
  [/import\.meta\.(?:url|dirname|filename)|\b__dirname\b|\b__filename\b|process\.cwd\s*\(/, 'reads files by path'],
  [/['"](?:node:)?(?:child_process|worker_threads)['"]|\bnew\s+Worker\s*\(/, 'starts other processes'],
]
const testSupport = /(?:^|\/)(?:test|tests|__tests__|fixtures?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|test-?support|test-?utils/i
const pathLiteral = /['"`]((?:\.{1,2}\/)*[A-Za-z0-9_@-][A-Za-z0-9_.@-]*(?:\/[A-Za-z0-9_.@-]+)+)['"`]/g
const scriptFile = /\.[cm]?[jt]sx?$/
/** Another test in a named directory (fixture tests excepted: runner tests execute those). */
const listedTest = /^(?!.*(?:^|\/)fixtures?\/).*\.(?:test|spec)\.[cm]?[jt]sx?$/
/** Marks an edge whose file joins the key by content only (a file inside a named directory). */
const DATA = '\0data:'
/** Marks an edge whose imports are followed without doubts (a script inside a named directory). */
const LOOSE = '\0loose:'
/** Marks a test file a named directory lists; it joins the key by name only (`foreman/no-source-text-tests` forbids
 * tests from reading another test's source, so only the file's presence can matter). */
const LISTED = '\0listed:'
/** Marks an installed package a file imports (`<project>\t<name>`); it joins the key by its locked dependency tree. */
const PACKAGE = '\0package:'
/** Marks a project's development tools (test runner, loaders); they join the key by their locked dependency trees. */
const TOOLS = '\0tools:'
const LOCKFILE = 'pnpm-lock.yaml'
const relativeLiteral = /['"`](\.{1,2}\/[^'"`\s$]*)['"`]/g

/** Share the read limit across manifests and all test closures of the selection. */
function boundedTree(tree: CiTestTree, signal: AbortSignal): CiTestTree {
  let active = 0
  const waiting: (() => void)[] = []
  return { blobs: tree.blobs, read: async path => {
    if (active >= 16) await new Promise<void>(resolve => { waiting.push(resolve) })
    else active++
    try {
      signal.throwIfAborted()
      return await tree.read(path, signal)
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  } }
}

function analyze(path: string, source: string): Analysis {
  const css = path.endsWith('.css')
  // Type-only imports are erased before tests run; they cannot change a unit or integration result.
  const text = css ? source : source.replace(/^[ \t]*(?:import|export)[ \t]+type\b[^;'"]*?\bfrom[ \t]*['"][^'"\n]+['"]/gm,
    statement => statement.replace(/[^\n]/g, ' '))
  const data = css || path.endsWith('.json')
  const code = data ? new Uint8Array(0) : codeMask(text)
  // CSS imports name their files like JS imports; one that names no literal could load anything.
  const cssImports = css ? [...text.matchAll(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1/g)].map(match => match[2]!) : []
  return {
    specifiers: css ? cssImports.filter(specifier => !/^(?:https?:)?\/\//.test(specifier))
      : data ? [] : importSpecifiers(text, index => code[index] === 1),
    literals: data ? [] : [...text.matchAll(pathLiteral)].map(match => match[1]!),
    relatives: data ? [] : [...new Set([...text.matchAll(relativeLiteral)].map(match => match[1]!))],
    computed: data ? [] : computedCalls(text, code),
    processes: data || !TEST_DOUBTS[1]![0].test(text) ? [] : processCalls(text, code),
    // Only a comment line declares inputs; the same words inside a string (a test fixture) do not.
    declaredInputs: data ? [] : [...text.matchAll(/^[ \t]*(?:\/\/|\/\*|\*)[ \t]*ci-key-inputs:[ \t]*([^\n*]+)/gm)]
      .flatMap(match => match[1]!.trim().split(/\s+/)),
    anchoredDirectories: data ? [] : [...text.matchAll(/new\s+URL\(\s*['"](\.{1,2})\/?['"]\s*,\s*import\.meta\.url\s*\)/g)].map(match => match[1]!),
    doubt: css ? (/@import\b/.test(text) && cssImports.length < (text.match(/@import\b/g) ?? []).length ? 'imports CSS by a computed name' : null) : DOUBTS.find(([pattern]) => pattern.test(text))?.[1] ?? null,
    testDoubt: data ? null : TEST_DOUBTS.find(([pattern]) => pattern.test(text))?.[1] ?? null,
  }
}

/** The package directory a test file belongs to: apps/<name>, packages/<name> or its top-level directory. */
function projectOf(file: string) {
  const parts = file.split('/')
  return ['apps', 'packages'].includes(parts[0]!) ? parts.slice(0, 2).join('/') : parts[0]!
}

function packageName(specifier: string) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

function exportsOf(manifests: { path: string; value: Record<string, unknown> }[], path: string) {
  const exports = manifests.find(manifest => manifest.path === path)?.value.exports
  return exports && typeof exports === 'object' ? exports as Record<string, unknown> : {}
}

interface SharedGraph {
  resolvedEdges: Map<string, Promise<string[]>>; harness: Map<string, Promise<Set<string>>>
  environments: Map<string, string[]>; directories: Set<string>
  /** Content identities that replace a file's blob in keys (the root manifest without its release version). */
  identities: Map<string, string>
}

/** Conservative input keys for test files of one commit: a file's key changes whenever anything it can observe
 * changes, and a file whose inputs the import graph cannot prove has no key. */
export class CiResultKeys {
  private readonly pendingAnalyses = new Map<string, Promise<Analysis>>()
  /** Each file's resolved imports and each project's harness, shared by every test closure of the commit and by
   * every bounded() copy, so later parts of one commit reuse the graph instead of walking it again. */
  private readonly resolvedEdges: Map<string, Promise<string[]>>
  private readonly harness: Map<string, Promise<Set<string>>>
  private readonly environments: Map<string, string[]>
  private readonly directories: Set<string>
  private readonly identities: Map<string, string>

  private constructor(private readonly source: CiTestTree, private readonly tree: CiTestTree, private readonly exports: Record<string, unknown>,
    private readonly workspacePackages: ReadonlyMap<string, { directory: string; exports: Record<string, unknown> }>,
    private readonly packages: ReadonlySet<string>, private readonly signal: AbortSignal,
    shared?: SharedGraph) {
    this.resolvedEdges = shared?.resolvedEdges ?? new Map()
    this.harness = shared?.harness ?? new Map()
    this.environments = shared?.environments ?? new Map()
    this.directories = shared?.directories ?? new Set()
    this.identities = shared?.identities ?? new Map()
    if (shared) return
    for (const path of tree.blobs.keys()) {
      const parts = path.split('/')
      for (let index = 1; index < parts.length; index++) this.directories.add(parts.slice(0, index).join('/'))
    }
  }

  /** Reads the contracts and CI exports and the external packages every manifest declares (workspace packages excluded). */
  static async create(input: CiTestTree, signal: AbortSignal): Promise<CiResultKeys> {
    const tree = boundedTree(input, signal)
    const manifests = await Promise.all([...tree.blobs.keys()].filter(path => posix.basename(path) === 'package.json')
      .map(async path => ({ path, value: JSON.parse(await tree.read(path, signal)) as Record<string, unknown> })))
    const workspace = new Set(manifests.map(manifest => manifest.value.name).filter(name => typeof name === 'string'))
    const packages = new Set<string>()
    for (const { value } of manifests) {
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        const declared = value[field]
        if (!declared || typeof declared !== 'object') continue
        for (const [name, version] of Object.entries(declared)) {
          if (typeof version === 'string' && !/^(?:workspace|link|file|portal):/.test(version) && !workspace.has(name)) {
            packages.add(name)
          }
        }
      }
    }
    // Every workspace package resolves through its own exports to its sources, as tests run them.
    const workspacePackages = new Map(manifests.flatMap(manifest => typeof manifest.value.name === 'string'
      ? [[manifest.value.name, { directory: posix.dirname(manifest.path), exports: exportsOf(manifests, manifest.path) }] as const] : []))
    const keys = new CiResultKeys(input, tree, exportsOf(manifests, 'packages/contracts/package.json'), workspacePackages, packages, signal)
    // A release only bumps the root manifest's version, which no test reads; it must not invalidate every proof.
    const root = manifests.find(manifest => manifest.path === 'package.json')
    if (root) keys.identities.set('package.json', `version-free:${sha256Hex(JSON.stringify({ ...root.value, version: null }))}`)
    if (tree.blobs.has(LOCKFILE)) {
      for (const [marker, identity] of lockIdentities(parseYaml(await tree.read(LOCKFILE, signal)) as Lockfile)) keys.identities.set(marker, identity)
    }
    return keys
  }

  /** The same commit's keys under another deadline, for a graph that outlives the work that built it. */
  bounded(signal: AbortSignal) {
    return new CiResultKeys(this.source, boundedTree(this.source, signal), this.exports, this.workspacePackages, this.packages, signal,
      { resolvedEdges: this.resolvedEdges, harness: this.harness, environments: this.environments, directories: this.directories,
        identities: this.identities })
  }

  /** The file's key for the suite and part, or null with the reason it must run. */
  async key(file: string, suite: string, part: string): Promise<CiResultKey> {
    try {
      this.signal.throwIfAborted()
      const project = projectOf(file)
      const environment = this.environment(project)
      const harness = await this.harnessFiles(project, environment)
      const own = await this.closure([file], true)
      const paths = [...new Set([...environment, ...harness, ...own, ...this.locked ? [`${TOOLS}${this.importer(project)}`] : []])].sort()
      // The file is part of its key: tests whose closures reach each other cover the same paths, and one proof per
      // key would otherwise stand for several files.
      const hash = (selected: string[], scope: string) => sha256Hex(JSON.stringify([CI_RESULT_CACHE_VERSION, scope, suite, part, file,
        selected.map(path => [path, this.identity(path)])]))
      return { key: hash(paths, 'all'),
        runnerFreeKey: hash(paths.filter(path => !TEST_EXECUTION_FILES.some(pattern => pattern.test(path))), 'runner-free') }
    } catch (error) {
      if (error instanceof CacheDoubt) return { key: null, reason: error.message }
      throw error
    }
  }

  /** A path's content identity; an imported package's is its locked tree as the importing project resolves it. */
  private identity(path: string) {
    if (!path.startsWith(PACKAGE)) return this.identities.get(path) ?? this.tree.blobs.get(path)
    const [project, name] = path.slice(PACKAGE.length).split('\t') as [string, string]
    return this.identities.get(`${PACKAGE}${this.importer(project)}\t${name}`) ?? this.identities.get(`${PACKAGE}*\t${name}`) ?? null
  }

  /** The lockfile was read: its packages join keys one tree at a time instead of the whole file. */
  private get locked() {
    return this.identities.has(`${TOOLS}.`)
  }

  private importer(project: string) {
    return this.identities.has(`${TOOLS}${project}`) ? project : '.'
  }

  /** Files hashed by content for every test of a project: root files, CI scripts and workflows, the project's and the
   * contracts package's CI infrastructure, and the project's data files (fixtures, SQL, assets) a test may read. */
  private environment(project: string) {
    let files = this.environments.get(project)
    if (!files) {
      files = this.projectEnvironment(project)
      this.environments.set(project, files)
    }
    return files
  }

  private projectEnvironment(project: string) {
    return [...this.tree.blobs.keys()].filter(path => {
      if (/\.md$/i.test(path)) return false
      // The lockfile joins keys per package (lockIdentities); a test sees only the locked trees it imports.
      if (!path.includes('/')) return path !== LOCKFILE || !this.locked
      if (TEST_EXECUTION_FILES.some(pattern => pattern.test(path))) return true
      return path.startsWith(`${project}/`) && (!ciCodeFile.test(path) || PROJECT_CONFIG.test(path))
    })
  }

  /** What the environment's configs, setup files and runner scripts load, including files they name by relative path.
   * Shared test helpers are hashed by content; a test that imports one reaches its imports through its own closure. */
  private harnessFiles(project: string, environment: string[]) {
    let files = this.harness.get(project)
    if (!files) {
      const roots = environment.filter(path => scriptFile.test(path) && !/(?:^|\/)eslint\.config\./.test(path)
        && !/^(?:\.github|\.circleci)\//.test(path) && !path.startsWith('apps/api/test/helpers/'))
      files = this.closure(roots, false)
      this.harness.set(project, files)
      files.catch(error => { if (!(error instanceof CacheDoubt)) this.harness.delete(project) })
    }
    return files
  }

  private async analysis(path: string, blob: string) {
    const id = `${blob}${posix.extname(path)}`
    const cached = analyses.get(id)
    if (cached) return cached
    let pending = this.pendingAnalyses.get(id)
    if (!pending) {
      pending = this.tree.read(path, this.signal).then(text => {
        const value = analyze(path, text)
        if (analyses.size >= ANALYSES_MAX) analyses.delete(analyses.keys().next().value!)
        analyses.set(id, value)
        return value
      }).finally(() => { this.pendingAnalyses.delete(id) })
      this.pendingAnalyses.set(id, pending)
    }
    return pending
  }

  /** Every repository file the roots import, transitively. Strict closures (a test's own) reject anything the static
   * graph cannot prove; the harness closure follows the same edges and the paths its scripts name. */
  private async closure(roots: string[], strict: boolean) {
    const files = new Set<string>()
    const walked = new Set<string>()
    let frontier = roots
    while (frontier.length) {
      const next: string[] = []
      for (let start = 0; start < frontier.length; start += 16) {
        await Promise.all(frontier.slice(start, start + 16).map(async file => {
          if (file.startsWith(DATA)) {
            files.add(file.slice(DATA.length))
            return
          }
          if (file.startsWith(PACKAGE) || file.startsWith(LISTED)) {
            files.add(file)
            return
          }
          const loose = file.startsWith(LOOSE)
          const path = loose ? file.slice(LOOSE.length) : file
          // A file walked strictly needs no loose walk; a loose walk never doubts.
          const mode = loose || !strict ? 'l' : 's'
          if (walked.has(`s:${path}`) || walked.has(`${mode}:${path}`)) return
          walked.add(`${mode}:${path}`)
          files.add(path)
          const edges = await this.edges(path, strict && !loose)
          next.push(...loose ? edges.map(edge => edge.startsWith('\0') ? edge : `${LOOSE}${edge}`) : edges)
        }))
      }
      frontier = next
      // Cached edges resolve as microtasks only; yield so a large key batch never starves requests and timers.
      await new Promise(resolve => setImmediate(resolve))
    }
    return files
  }

  private edges(file: string, strict: boolean): Promise<string[]> {
    const id = `${strict ? 's' : 'h'}:${file}`
    let edges = this.resolvedEdges.get(id)
    if (!edges) {
      edges = this.resolveEdges(file, strict)
      this.resolvedEdges.set(id, edges)
      // A doubt is a fact about the commit; a failed read or an expired deadline is not, so a later call retries.
      edges.catch(error => { if (!(error instanceof CacheDoubt)) this.resolvedEdges.delete(id) })
    }
    return edges
  }

  private async resolveEdges(file: string, strict: boolean): Promise<string[]> {
    const blob = this.tree.blobs.get(file)
    if (!blob) throw new CacheDoubt(`${file} is not in the commit.`)
    if (!/^100(?:644|755):/.test(blob)) throw new CacheDoubt(`${file} is a link or submodule.`)
    if (!ciCodeFile.test(file)) return []
    const analysis = await this.analysis(file, blob)
    const support = testSupport.test(file)
    if (strict && analysis.doubt) throw new CacheDoubt(`${file} ${analysis.doubt}.`)
    // Test support that starts a process must name what it runs; files it reads are proven by the paths it names
    // (below): named files join the key and are followed, files in named directories join it by content.
    const edges: string[] = []
    for (const call of strict && support && analysis.declaredInputs.length === 0 ? analysis.processes : []) {
      if (call.named) continue
      const commands = call.command.flatMap(literal => this.computedTarget(file, literal))
        .filter((target): target is string => target !== true && !target.startsWith(PACKAGE))
      if (!commands.length) throw new CacheDoubt(`${file} starts a process it names by a computed path.`)
      edges.push(...commands)
    }
    // A computed import or require is proven by the literals it names: repository files join the key, and packages
    // the manifests pin are covered by the lockfile. A call that names nothing resolvable could load anything.
    // A test that builds an artifact and then loads or runs it declares the inputs the artifact is made from; they
    // join the key (files by content with their scripts' imports followed, directories whole, packages through the
    // lockfile), and that file's runtime loads and process starts are covered by the declaration.
    const declared = strict && support && analysis.declaredInputs.length > 0
    for (const input of declared ? analysis.declaredInputs : []) {
      const targets = this.computedTarget(file, input)
      const named = targets.length ? targets.filter((target): target is string => target !== true)
        : this.namedFiles(file, input, true)
      if (!targets.length && !named.length) throw new CacheDoubt(`${file} declares the input ${input}, which is not a repository path or pinned package.`)
      edges.push(...named.map(path => path.startsWith('\0') ? path : `${scriptFile.test(path) ? LOOSE : DATA}${path}`))
    }
    for (const call of analysis.computed) {
      const resolved = call.literals.flatMap(literal => this.computedTarget(file, literal))
      if (resolved.length) edges.push(...resolved.filter((target): target is string => target !== true))
      else if (strict && !declared) throw new CacheDoubt(`${file} ${call.kind === 'import' ? 'imports' : 'requires'} a computed module.`)
    }
    for (const specifier of analysis.specifiers) {
      const relative = specifier.startsWith('.') || specifier.startsWith('/')
      const name = packageName(specifier)
      const workspace = !relative && name !== '@foreman-code/contracts' ? this.workspacePackages.get(name) : undefined
      if (relative || workspace || name === '@foreman-code/contracts') {
        const target = specifier.startsWith('/') ? null
          : workspace ? this.workspaceSource(file, specifier, name, workspace) : resolveImport(file, specifier, this.tree.blobs, this.exports)
        // A relative import of a workspace package's build (`../packages/contracts/dist/x.js`) runs its source.
        const built = !target && relative ? this.computedTarget(file, specifier).find((value): value is string => value !== true) : undefined
        if (built) {
          edges.push(built)
          continue
        }
        if (!target) {
          // Runner scripts and configs are hashed by content as environment files; a name they mention that is not a
          // repository file (documentation text, a generated module) adds nothing to follow. A test's own closure
          // must prove every import.
          if (!strict) continue
          throw new CacheDoubt(`${file} imports ${specifier}, which is not a repository file.`)
        }
        edges.push(target)
      } else if (!specifier.startsWith('node:') && !isBuiltin(specifier)) {
        if (this.packages.has(name)) edges.push(`${PACKAGE}${projectOf(file)}\t${name}`)
        // Aliases, virtual modules and workspace packages other than contracts have no edge the key can follow.
        else if (strict) throw new CacheDoubt(`${file} imports ${specifier}, which no manifest pins.`)
      }
    }
    // Code a test reaches that reads files by path or starts processes names their entrypoints and data relative to
    // itself ('./worker.ts' for a forked child): every such name that is a repository file joins the key.
    if (strict && !support && analysis.testDoubt) {
      for (const literal of analysis.relatives) {
        const target = resolveImport(file, literal, this.tree.blobs, {})
        if (target) edges.push(target)
      }
    }
    // Test support can read repository files it names, and configs name their runners and setup files by relative
    // path; those files join the key.
    if (support && strict) {
      for (const literal of [...analysis.relatives, ...analysis.anchoredDirectories]) {
        const target = resolveImport(file, literal, this.tree.blobs, {})
        edges.push(...target ? [target] : this.namedFiles(file, literal))
      }
    }
    for (const literal of analysis.literals) {
      if (support && strict) edges.push(...this.namedFiles(file, literal))
      else if (!strict && literal.startsWith('.')) {
        const named = posix.join(posix.dirname(file), literal)
        if (this.tree.blobs.has(named)) edges.push(named)
      }
    }
    return edges
  }

  /** What one literal in a computed import names: a repository file, `true` for a pinned or built-in package, or
   * nothing. */
  private computedTarget(file: string, literal: string): (string | true)[] {
    if (literal.startsWith('.')) {
      const target = resolveImport(file, literal, this.tree.blobs, {})
      if (target) return [target]
      literal = posix.normalize(posix.join(posix.dirname(file), literal))
      if (!/^(?:apps|packages)\/[^/]+\/dist\//.test(literal)) return []
    }
    if (this.tree.blobs.has(literal)) return [literal]
    // A built file of a workspace package (`apps/api/dist/x.js`) runs that package's source.
    const built = /^((?:apps|packages)\/[^/]+)\/dist\/(.+)$/.exec(literal)
    if (built) {
      const target = resolveImport('', `./${built[1]}/src/${built[2]}`, this.tree.blobs, {})
      return target ? [target] : []
    }
    if (literal.startsWith('node:') || isBuiltin(literal)) return [true]
    const name = packageName(literal)
    const workspace = name !== '@foreman-code/contracts' ? this.workspacePackages.get(name) : undefined
    if (workspace) {
      const target = this.workspaceSource(file, literal, name, workspace)
      return target ? [target] : []
    }
    if (name === '@foreman-code/contracts') {
      const target = resolveImport(file, literal, this.tree.blobs, this.exports)
      return target ? [target] : []
    }
    return /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/[\w.@-]+)*$/.test(literal) && this.packages.has(name)
      ? [`${PACKAGE}${projectOf(file)}\t${name}`] : []
  }

  /** The workspace package source a `<package>/<module>` specifier names through the package's exports (built `dist`
   * paths map to their `src` sources, as tests run them). */
  private workspaceSource(file: string, specifier: string, name: string,
    workspace: { directory: string; exports: Record<string, unknown> }): string | null {
    const path = ciExportSource(workspace.exports[`.${specifier.slice(name.length)}`])
    if (!path) return null
    const target = `${workspace.directory}/${path}`
    return resolveImport(file, `./${posix.relative(posix.dirname(file), target)}`, this.tree.blobs, {})
  }

  /** Repository files a literal names. `declared` inputs (`ci-key-inputs`) may name the project itself. */
  private namedFiles(file: string, literal: string, declared = false): string[] {
    const project = projectOf(file)
    const candidates = literal.startsWith('.') ? [posix.join(posix.dirname(file), literal)] : [literal, `${project}/${literal}`]
    const named: string[] = []
    for (const candidate of candidates) {
      if (this.tree.blobs.has(candidate)) named.push(candidate)
      // The project or a directory above it (`resolve('../..')`) is a base for paths, not data: walking it put the
      // whole repository in the keys of every test whose setup names the repository root.
      else if (!declared && (candidate === project || project.startsWith(`${candidate}/`))) continue
      else if (this.directories.has(candidate)) {
        // Every file in a named directory joins the key by content; its scripts may be run, so their imports are
        // followed too, loosely like the harness's (what resolves joins the key, nothing doubts).
        const inside = [...this.tree.blobs.keys()].filter(path => path.startsWith(`${candidate}/`))
        named.push(...inside.map(path => `${listedTest.test(path) ? LISTED : scriptFile.test(path) ? LOOSE : DATA}${path}`))
      }
    }
    return named
  }
}

interface Lockfile {
  lockfileVersion?: unknown; settings?: unknown; overrides?: unknown; patchedDependencies?: unknown
  importers?: Record<string, Partial<Record<'dependencies' | 'devDependencies' | 'optionalDependencies', Record<string, { version?: string }>>>>
  packages?: Record<string, { resolution?: unknown }>
  snapshots?: Record<string, Partial<Record<'dependencies' | 'optionalDependencies', Record<string, string>>>>
}

/** Identities of every package each lockfile importer declares: the package's locked tree (each snapshot it reaches
 * with its resolution) plus the lockfile settings that change how anything installs. A lockfile change then
 * reaches only tests that import a package whose tree changed, or whose project's development tools changed. */
function lockIdentities(lock: Lockfile): Map<string, string> {
  const base = JSON.stringify([lock.lockfileVersion, lock.settings, lock.overrides, lock.patchedDependencies])
  const snapshotKey = (name: string, version: string) => version.startsWith('link:') ? null
    // An aliased dependency's version is the real package's `<name>@<version>`.
    : /^@?[^@]+@/.test(version) && !/^\d/.test(version) ? version : `${name}@${version}`
  const trees = new Map<string, string>()
  const treeOf = (root: string) => {
    let identity = trees.get(root)
    if (identity) return identity
    const reached = new Set<string>()
    const frontier = [root]
    while (frontier.length) {
      const key = frontier.pop()!
      if (reached.has(key)) continue
      reached.add(key)
      const snapshot = lock.snapshots?.[key]
      for (const field of ['dependencies', 'optionalDependencies'] as const) {
        for (const [name, version] of Object.entries(snapshot?.[field] ?? {})) {
          const next = snapshotKey(name, version)
          if (next) frontier.push(next)
        }
      }
    }
    identity = sha256Hex(JSON.stringify([base, [...reached].sort().map(key =>
      [key, lock.packages?.[key.replace(/\(.*$/, '')]?.resolution ?? null, lock.snapshots?.[key] ?? null])]))
    trees.set(root, identity)
    return identity
  }
  const identities = new Map<string, string>()
  for (const [importer, declared] of Object.entries(lock.importers ?? {})) {
    const tools: string[] = []
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
      for (const [name, entry] of Object.entries(declared[field] ?? {})) {
        const key = typeof entry?.version === 'string' ? snapshotKey(name, entry.version) : null
        if (!key) continue
        const identity = treeOf(key)
        identities.set(`${PACKAGE}${importer}\t${name}`, identity)
        if (!identities.has(`${PACKAGE}*\t${name}`)) identities.set(`${PACKAGE}*\t${name}`, identity)
        if (field === 'devDependencies') tools.push(`${name}:${identity}`)
      }
    }
    identities.set(`${TOOLS}${importer}`, sha256Hex(JSON.stringify([base, tools.sort()])))
  }
  return identities
}
