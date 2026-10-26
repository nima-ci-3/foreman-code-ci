import { isBuiltin } from 'node:module'
import { posix } from 'node:path'
import { ciCodeFile, ciExportSource, importSpecifiers, resolveImport } from '@foreman-code/contracts/ci-import-graph'
import { lockIdentities, type CiLockfile } from '@foreman-code/contracts/ci-lock-identities'
import { sha256Hex } from '@foreman-code/contracts-node/server-kit'
import { parse as parseYaml } from 'yaml'

/** Bump only when changed input identities and doubt rules cannot already exclude unsafe older proofs. */
const CI_RESULT_CACHE_VERSION = 2

/** A test file's input key, or null with the reason it must run. `runnerFreeKey` leaves out runner-only roots and
 * their imports: a proof that matches only it was made by another runner, so a sample of such files reruns. */
export interface CiResultKey { key: string | null; reason?: string; runnerFreeKey?: string; /** How many inputs the key hashes. */ inputs?: number }
/** A content identity for a file of a test's own closure in place of its blob (masked by functions the test ran), or
 * undefined to keep the blob. */
export type CiFileMask = (path: string, blob: string, read: () => Promise<string>) => Promise<string | undefined>

/** One commit of the repository for result cache keys. */
export interface CiTestTree {
  /** Every file with its git mode and blob id (`100644:<sha>`), which change with its content. */
  blobs: ReadonlyMap<string, string>
  read(path: string, signal: AbortSignal): Promise<string>
}

/** The key cannot prove the file's inputs, so the file must run. */
class CacheDoubt extends Error {}

interface Analysis {
  specifiers: string[]; literals: string[]
  /** Each computed import or require call: the string literals its argument names. */
  computed: { kind: 'import' | 'require'; literals: string[] }[]
  /** Each process start (spawn, exec, fork, new Worker): whether its command is named, and the literals it passes. */
  processes: { named: boolean; literals: string[]; command: string[]; entrypoint: string | null; external: boolean; build: boolean; moduleScope: boolean }[]
  /** `// ci-key-inputs: <path or package> ...`: what a test that builds and runs artifacts actually depends on. */
  declaredInputs: string[]
  reads: { paths: string[] | null; namesOnly: boolean; recursive: boolean; external: boolean; moduleScope: boolean }[]
  paths: string[]
  /** Literals passed straight to a call or joined to an unknown base: a file is an input, a directory only a name (its
   * reader, process or copy keys the data). */
  arguments: string[]
  anchors: string[]
  doubt: string | null
  /** A path reference in a static Vitest alias replacement, paired with the import name it replaces. */
  aliasUrls: Record<number, string>
}

const ANALYSES_MAX = 50_000
/** By blob, extension and config role: a blob's imports never change. */
const analyses = new Map<string, Analysis>()

/**
 * Files that run tests and report their results: suite scripts, runners, reporters and execution workflows.
 * executionFile selects the roots for each suite/project; configs supply their own setup and runner paths.
 * Other CI code (selection, admission, planning, Main's result collection, lint checks) cannot change a test's
 * outcome; a test that uses it imports it and is keyed on it like any other code.
 */
const TEST_EXECUTION_FILES = [
  /^scripts\/(?!.*\.(?:test|spec)\.)(?:ci-suite\.sh|ci-user-systemd\.sh|ci-affected-run\.mjs|ci-files\.mjs|ci-unit-files\.mjs|ci-test-results\.mjs|ci-node-test-reporter\.mjs|ci-progress-reporter\.mjs|ci-package-paths\.mjs|ci-packages\.mjs|ci-contracts\.mjs|ci-watchdog\.mjs|ci-remote\.mjs|heavy-job\.mjs|test-command\.mjs|test-db\.mjs|test-integration[^/]*\.mjs|test-resources[^/]*\.mjs|integration-[^/]+\.mjs|vitest-[^/]+\.mjs)$/,
  /^packages\/contracts\/ci-test-runner\.mjs$/,
  /^packages\/ci-protocol\/src\/(?!.*\.d\.[cm]?ts$)/,
  /^(?:\.github\/workflows\/ci\.yml|\.circleci\/config\.yml)$/,
]
const CONFIG = '\0config:'
const INTEGRATION_EXECUTION = /^scripts\/(?:ci-user-systemd\.sh|test-integration[^/]*\.mjs|integration-(?!process\.mjs$)[^/]+\.mjs)$/

function executionFile(path: string, suite: string, project: string) {
  return TEST_EXECUTION_FILES.some(pattern => pattern.test(path))
    // Vitest setup and its custom runner join through the project's actual config, below.
    && !/^scripts\/vitest-|^packages\/contracts\/ci-test-runner/.test(path)
    && (suite === 'integration' || !INTEGRATION_EXECUTION.test(path))
    && (project === 'apps/api' || suite === 'integration' || !/^scripts\/(?:test-command|test-db|test-resources[^/]*|integration-process)\.mjs$/.test(path))
    && (!/^scripts\/ci-node-test-reporter/.test(path) || ['scripts', 'apps/worker'].includes(project))
}
const VITEST_CONFIG = /(?:^|\/)vitest\.config\.[cm]?[jt]s$/

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
function codeMask(text: string, includeComments = false) {
  const code = new Uint8Array(text.length)
  const templates: number[] = [] // brace depth of each open `${`
  let state: 'code' | 'line' | 'block' | "'" | '"' | '`' = 'code'
  let depth = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!, next = text[index + 1]
    if (state === 'code') {
      if (char === '/' && (next === '/' || next === '*')) {
        state = next === '/' ? 'line' : 'block'
        if (includeComments) code[index] = code[index + 1] = 1
        index++
        continue
      }
      if (char === "'" || char === '"' || char === '`') { state = char; continue }
      if (char === '{') depth++
      else if (char === '}') {
        if (templates.length && depth === templates[templates.length - 1]) { templates.pop(); state = '`'; continue }
        depth--
      }
      code[index] = 1
    } else if (state === 'line') { if (includeComments) code[index] = 1; if (char === '\n') state = 'code' }
    else if (state === 'block') {
      if (includeComments) code[index] = 1
      if (char === '*' && next === '/') { if (includeComments) code[index + 1] = 1; state = 'code'; index++ }
    }
    else if (char === '\\') index++
    else if (state === '`' && char === '$' && next === '{') { templates.push(depth); state = 'code'; index++ }
    else if (char === state) state = 'code'
  }
  return code
}

/** Top-level call arguments, ignoring commas inside strings and nested expressions. */
function argumentsOf(text: string) {
  const code = codeMask(text)
  const args: string[] = []
  let depth = 0, start = 0
  for (let index = 0; index < text.length; index++) {
    if (!code[index]) continue
    if ('([{'.includes(text[index]!)) depth++
    else if (')]}'.includes(text[index]!)) depth--
    else if (text[index] === ',' && depth === 0) { args.push(text.slice(start, index).trim()); start = index + 1 }
  }
  args.push(text.slice(start).trim())
  return args
}

function pathValue(text: string, code: Uint8Array, expression: string, seen = new Set<string>()): string | null {
  const literal = /^(['"`])([^'"`$\n]*)\1$/.exec(expression)
  if (literal) return literal[2]!
  if (/^[A-Za-z_$][\w$]*$/.test(expression) && !seen.has(expression)) {
    seen.add(expression)
    const definitions = [...text.matchAll(new RegExp(`\\bconst\\s+${expression.replace(/\$/g, '\\$')}\\s*=\\s*([^;\\n]+)`, 'g'))]
      .filter(match => code[match.index])
    const parameter = new RegExp(`(?:^|[,\\s])${expression.replace(/\$/g, '\\$')}(?:\\s*[:=,]|\\s*$)`)
    const shadowed = [...text.matchAll(/\(([^()]*)\)\s*(?:(?::[^={;\n]+)?=>|(?::[^={;\n]+)?\{)/g)]
      .some(match => code[match.index] && parameter.test(match[1]!))
      || [...text.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)].some(match => code[match.index] && match[1] === expression)
    return definitions.length === 1 && !shadowed ? pathValue(text, code, definitions[0]![1]!.trim(), seen) : null
  }
  const call = /^(?:new\s+)?([\w.]+)\s*\(([^]*)\)$/.exec(expression)
  if (!call) return null
  const args = argumentsOf(call[2]!)
  const name = call[1]!.split('.').at(-1)
  if (name === 'URL' && args[1] === 'import.meta.url') {
    const path = pathValue(text, code, args[0]!, new Set(seen))
    return path !== null && path.startsWith('.') ? `@file/${path}` : null
  }
  if (name === 'fileURLToPath' && args.length === 1) return pathValue(text, code, args[0]!, seen)
  if (name === 'join' || name === 'resolve') {
    const values = args.map(arg => pathValue(text, code, arg, new Set(seen)))
    return values.every((value): value is string => value !== null) ? values.join('/') : null
  }
  return null
}

/** A path supplied by the host environment is an actual input outside the commit. Function parameters alone are
 * not: tests commonly pass paths to files they just created. Follow constant aliases before making that distinction. */
function externalPath(text: string, code: Uint8Array, expression: string, seen = new Set<string>()): boolean {
  if (/\bprocess\.env(?:\.|\[)/.test(expression)) return true
  if (!/^[A-Za-z_$][\w$]*$/.test(expression) || seen.has(expression)) return false
  seen.add(expression)
  return [...text.matchAll(new RegExp(`\\bconst\\s+${expression.replace(/\$/g, '\\$')}\\s*=\\s*([^;\\n]+)`, 'g'))]
    .some(match => code[match.index] && externalPath(text, code, match[1]!, seen))
}

/** Path constructors at callers also supply inputs to generic filesystem/process wrappers. Follow the complete
 * constant path when possible, or its named alternatives (for example a TS/JS child URL) otherwise. */
function constructedPaths(text: string, code: Uint8Array) {
  const paths: string[] = [], literals: string[] = []
  for (const match of text.matchAll(/\b(?:new\s+URL|(?:[\w$]+\.)?(?:join|resolve))\s*\(/g)) {
    if (!code[match.index]) continue
    const open = match.index + match[0].length - 1, close = closingParen(text, open)
    if (close < 0) continue
    const expression = text.slice(match.index, close)
    const value = pathValue(text, code, expression)
    if (value !== null) paths.push(value.replace(/^@file\//, ''))
    // A bare name joined to an unknown directory (`join(release, 'package.json')`) names no repository file.
    // With an unknown base its literals name files (inputs) or directories whose reader keys their data.
    else literals.push(...[...expression.matchAll(/(['"`])([^'"`$\n]+)\1/g)].map(literal => literal[2]!).filter(literal => literal.includes('/')))
  }
  // A literal passed directly to a wrapper is as visible as a constructor at its caller. Avoid scanning every
  // enclosing call body: nested test callbacks can otherwise make this pass quadratic in the file size.
  for (const match of text.matchAll(/\b[\w$.]+\s*\(\s*(['"`])([^'"`$\n]+)\1/g)) {
    if (code[match.index] && (match[2]!.includes('/') || /\.(?:[cm]?[jt]sx?|json)$/.test(match[2]!))) literals.push(match[2]!)
  }
  return { paths, literals }
}

/** Resolution anchors and output destinations are paths, but do not read their contents. Keep their positions
 * blank so enclosing computed imports and the loose harness scan cannot turn them back into raw inputs. */
async function pathContexts(path: string, text: string, code: Uint8Array) {
  const anchors: string[] = []
  if (!/\b(?:createRequire|writeFile|writeFileSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|copyFile|copyFileSync|cp|cpSync|rename|renameSync|outdir|outfile)\b/.test(text)) {
    return { text, anchors }
  }
  const ts = (await import('typescript')).default
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const spans: [number, number][] = []
  const anchorNames = new Set<string>()
  const outputs = new Set(['writeFile', 'writeFileSync', 'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync'])
  const copies = new Set(['copyFile', 'copyFileSync', 'cp', 'cpSync', 'rename', 'renameSync'])
  const omit = (node: import('typescript').Node) => spans.push([node.getStart(source), node.end])
  const visit = (node: import('typescript').Node) => {
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression) ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ''
      const argument = node.arguments[0]
      if (name === 'createRequire' && argument) {
        const value = pathValue(text, code, argument.getText(source))
        if (value !== null) anchors.push(value.replace(/^@file\//, ''))
        else {
          const literals = (child: import('typescript').Node) => {
            if (ts.isStringLiteralLike(child) && child.text.includes('/')) anchors.push(child.text)
            ts.forEachChild(child, literals)
          }
          literals(argument)
        }
        if (ts.isIdentifier(argument)) anchorNames.add(argument.text)
        omit(argument)
      } else if (outputs.has(name) && argument) omit(argument)
      else if (copies.has(name) && node.arguments[1]) omit(node.arguments[1])
    } else if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
      && ['outdir', 'outfile'].includes(node.name.text)) omit(node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(source)
  const otherUses = (node: import('typescript').Node) => {
    if (ts.isIdentifier(node) && anchorNames.has(node.text)
      && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)
      && !(ts.isCallExpression(node.parent) && ts.isIdentifier(node.parent.expression)
        && node.parent.expression.text === 'createRequire' && node.parent.arguments[0] === node)) anchorNames.delete(node.text)
    ts.forEachChild(node, otherUses)
  }
  otherUses(source)
  // A constant URL used as a createRequire anchor is still only a resolution base.
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && anchorNames.has(declaration.name.text) && declaration.initializer) omit(declaration.initializer)
    }
  }
  const characters = text.split('')
  for (const [start, end] of spans) for (let index = start; index < end; index++) {
    if (characters[index] !== '\n') characters[index] = ' '
  }
  return { text: characters.join(''), anchors }
}

/** Repository-qualified paths under a caller-supplied root: `join(repository, 'apps/api/src', skill)` names the constant
 * suffix after its last unknown segment, or else the qualified literals it contains. */
function qualifiedPaths(text: string, code: Uint8Array, expression: string) {
  const qualified = (path: string) => /^(?:apps|packages)\/[^/]+(?:\/|$)|^(?:scripts|runtime|patches)(?:\/|$)/.test(path)
  const call = /^(?:[\w$]+\.)?(?:join|resolve)\s*\(([^]*)\)$/.exec(expression)
  if (call) {
    const values = argumentsOf(call[1]!).map(arg => pathValue(text, code, arg))
    const suffix = values.slice(values.lastIndexOf(null) + 1)
    if (suffix.length && qualified(suffix.join('/'))) return [posix.normalize(suffix.join('/'))]
  }
  return [...expression.matchAll(/(['"`])([^'"`$\n]+)\1/g)].map(found => found[2]!).filter(qualified)
}

/** Filesystem readers may be renamed imports or namespace members. */
function filesystemReads(text: string, code: Uint8Array, moduleScope: (index: number) => boolean): Analysis['reads'] {
  const readers = 'readFile|readFileSync|readdir|readdirSync|opendir|opendirSync|createReadStream|stat|statSync|lstat|lstatSync|access|accessSync|existsSync|readlink|readlinkSync|realpath|realpathSync|open|openSync|watch|watchFile|glob|globSync|copyFile|copyFileSync|cp|cpSync'
  const known = new Set(readers.split('|'))
  const names = new Map<string, string>()
  const namespaces = new Set<string>()
  for (const match of text.matchAll(/\bimport\s+(?:[\w$]+\s*,\s*)?\{([^}]+)\}\s*from\s*['"](?:node:)?fs(?:\/promises)?['"]/g)) {
    if (!code[match.index]) continue
    for (const binding of match[1]!.split(',')) {
      const [original, alias] = binding.trim().split(/\s+as\s+/)
      if (known.has(original!)) names.set(alias ?? original!, original!)
      else if (original === 'promises') namespaces.add(alias ?? original)
    }
  }
  for (const match of text.matchAll(/\bimport\s+(?:\*\s+as\s+)?([\w$]+)(?:\s*,\s*\{[^}]*\})?\s+from\s*['"](?:node:)?fs(?:\/promises)?['"]|\bconst\s+([\w$]+)\s*=\s*(?:require|await\s+import)\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/g)) {
    if (code[match.index]) namespaces.add(match[1] ?? match[2]!)
  }
  for (const match of text.matchAll(/\bconst\s*\{([^}]+)\}\s*=\s*(?:require|await\s+import)\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/g)) {
    if (!code[match.index]) continue
    for (const binding of match[1]!.split(',')) {
      const [original, alias] = binding.trim().split(/\s*:\s*/)
      if (known.has(original!)) names.set(alias ?? original!, original!)
      else if (original === 'promises') namespaces.add(alias ?? original)
    }
  }
  // Follow simple reader aliases (including promisify), without treating their uses as path literals.
  for (const match of text.matchAll(/\bconst\s+([\w$]+)\s*=\s*(?:promisify\(\s*)?(?:([\w$]+)\.)?([\w$]+)\s*(?:\)|[;\n])/g)) {
    if (!code[match.index]) continue
    const reader = match[2] ? namespaces.has(match[2]) && known.has(match[3]!) ? match[3] : undefined : names.get(match[3]!)
    if (reader) names.set(match[1]!, reader)
  }
  const reads: Analysis['reads'] = []
  const escape = (name: string) => name.replace(/\$/g, '\\$')
  const bindings = [...names.keys()].map(escape)
  if (namespaces.size) bindings.push(`(?:${[...namespaces].map(escape).join('|')})(?:\\.promises)?\\.(?:${readers})`)
  if (!bindings.length) return reads
  const pattern = new RegExp(`(?<![.\\w$])(?:${bindings.join('|')})\\s*\\(`, 'g')
  for (const match of text.matchAll(pattern)) {
    if (!code[match.index]) continue
    const open = match.index + match[0].length - 1
    const close = closingParen(text, open)
    const args = close < 0 ? [] : argumentsOf(text.slice(open + 1, close - 1))
    const binding = match[0].replace(/\s*\($/, '')
    const reader = names.get(binding) ?? binding.split('.').at(-1)!
    // A write-only open observes no existing repository contents.
    if (/^open(?:Sync)?$/.test(reader) && /^['"](?:w|wx|a|ax)['"]$/.test(args[1] ?? '')) continue
    const arg = args[0] ?? ''
    const value = pathValue(text, code, arg)
    // A repository-qualified suffix (`join(source, 'apps/worker/test')`) names what a reader observes even when the
    // checkout root is supplied by a caller. A copy consumes exactly it; its destination remains only an output path.
    const copy = /^(?:copyFile|cp)(?:Sync)?$/.test(reader)
    const definition = value === null && /^[\w$]+$/.test(arg)
      ? [...text.matchAll(new RegExp(`\\bconst\\s+${escape(arg)}\\s*=\\s*([^;\\n]+)`, 'g'))].filter(found => code[found.index]) : []
    const qualified = value === null ? qualifiedPaths(text, code, definition.length === 1 ? definition[0]![1]!.trim() : arg) : []
    const namesOnly = /^(?:readdir|opendir)(?:Sync)?$/.test(reader)
    const options = args[1] ?? ''
    const recursive = /['"]?recursive['"]?\s*:\s*(true|false)\b/.exec(options)?.[1]
    const unknownOptions = namesOnly && (/^[\w$]+$/.test(options) || /\.\.\./.test(options)
      || /\brecursive\b/.test(options) && recursive === undefined)
    const read = { namesOnly, recursive: recursive === 'true', external: value === null && externalPath(text, code, arg), moduleScope: moduleScope(match.index) }
    reads.push({ ...read, paths: unknownOptions ? null : value !== null ? [value] : copy && qualified.length ? qualified : null })
    if (!copy && !unknownOptions && qualified.length) reads.push({ ...read, external: false, paths: qualified })
  }
  return reads
}

/** Every import or require call whose argument is not one string literal, with the literals the argument names:
 * `import(join(release, 'apps/worker/src/x.mjs'))`, `createRequire(import.meta.url)('../package.json')`, and calls of
 * a name bound to createRequire. Method calls and declarations (`dispatch.require(...)`) and `require.resolve` (which
 * only finds a path) load nothing. */
/** Every call that starts a process. Its command is named when it is a literal (a system tool such as git, or a
 * repository script the literals name) or Node running a script a literal names; anything else could run any file. */
function processCalls(text: string, code: Uint8Array, moduleScope: (index: number) => boolean): Analysis['processes'] {
  const calls: Analysis['processes'] = []
  const names = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
  for (const match of text.matchAll(/\bconst\s+(\w+)\s*=\s*promisify\(\s*(\w+)\s*\)/g)) {
    if (code[match.index] && names.has(match[2]!)) names.add(match[1]!)
  }
  for (const match of text.matchAll(new RegExp(`(?<![\\w$])(?:(?:${[...names].join('|')})\\s*\\(|new\\s+Worker\\s*\\()`, 'g'))) {
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
    const node = (value: string) => /^\s*(?:process\.execPath\b|(['"])node\1)/.test(value)
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
    const args = argumentsOf(argument)
    const array = /^\[([^]*)\]$/.exec(args[1] ?? '')
    const script = array ? argumentsOf(array[1]!).map(value => pathValue(text, code, value)) : []
    literals.push(...script.filter((value): value is string => value !== null && !value.startsWith('-'))
      .map(value => value.replace(/^@file\//, '')))
    const nodeCommand = node(first) || definition !== undefined && node(definition)
    const nodeScript = script.find(value => value === null || !value.startsWith('-'))
    const inline = script.some(value => value === '-e' || value === '--eval')
    const build = /^\s*(['"])(?:tsc|vite|esbuild|corepack|pnpm|npm)\1/.test(first)
    calls.push({ named: declared.length > 0 || (nodeCommand ? !!nodeScript || inline
      : !build && (command(first) || definition !== undefined && command(definition))), literals,
      external: externalPath(text, code, args[0] ?? ''), build, moduleScope: moduleScope(match.index),
      entrypoint: nodeCommand && !inline && nodeScript ? nodeScript.replace(/^@file\//, '') : null,
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
    // importSpecifiers reads ordinary import/require literals; createRequire calls and their aliases stay here.
    // A data: URL carries its module text inline; whatever produced that text is an input of its own.
    if (/^\s*[`'"]data:/.test(argument)) continue
    if (/^\s*(['"])[^'"]*\1\s*(?:,[^]*)?$/.test(argument) && /^(?:import|require)\s*\(/.test(match[0])) continue
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
const startsProcesses = /['"](?:node:)?(?:child_process|worker_threads)['"]|\bnew\s+Worker\s*\(/
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
/** Whole project data for parameterized runtime I/O, without pulling all application source into every key. */
const INPUTS = '\0inputs:'
/** Directory enumeration observes names and modes, not the bytes of every file a project contains. */
const NAMES = '\0names:'
const LOCKFILE = 'pnpm-lock.yaml'

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

/** A static Vitest resolve.alias replacement names a module; computing its URL does not load it. Only recognize
 * the direct node:url expression in a literal exported config. Other expressions retain the conservative edges. */
async function aliasUrlPositions(path: string, text: string): Promise<Record<number, string>> {
  const positions: Record<number, string> = {}
  if (!VITEST_CONFIG.test(path)) return positions
  const ts = (await import('typescript')).default
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const imported = (name: string, module: string) => source.statements.some(statement => ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === module
    && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
    && statement.importClause.namedBindings.elements.some(item => item.name.text === name && !item.propertyName))
  if (!imported('fileURLToPath', 'node:url') || !imported('URL', 'node:url')) return positions
  const property = (object: import('typescript').Expression | undefined, name: string) => object && ts.isObjectLiteralExpression(object)
    ? object.properties.find((item): item is import('typescript').PropertyAssignment => ts.isPropertyAssignment(item)
      && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === name)?.initializer : undefined
  for (const statement of source.statements) {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals) continue
    let config = statement.expression
    if (ts.isCallExpression(config) && ts.isIdentifier(config.expression) && config.expression.text === 'defineConfig'
      && imported('defineConfig', 'vitest/config') && config.arguments.length === 1) config = config.arguments[0]!
    // Custom plugins or composed configs can inspect alias targets themselves; leave those graphs whole.
    if (!ts.isObjectLiteralExpression(config) || !config.properties.every(item => ts.isPropertyAssignment(item)
      && ts.isIdentifier(item.name) && ['resolve', 'test'].includes(item.name.text))) continue
    const aliases = property(property(config, 'resolve'), 'alias')
    if (!aliases || !ts.isArrayLiteralExpression(aliases)) continue
    for (const alias of aliases.elements) {
      const find = property(alias, 'find')
      if (!find || !ts.isStringLiteral(find)) continue
      const replacement = property(alias, 'replacement')
      if (!replacement || !ts.isCallExpression(replacement) || !ts.isIdentifier(replacement.expression)
        || replacement.expression.text !== 'fileURLToPath' || replacement.arguments.length !== 1) continue
      const url = replacement.arguments[0]!
      if (!ts.isNewExpression(url) || !ts.isIdentifier(url.expression) || url.expression.text !== 'URL'
        || url.arguments?.length !== 2 || !ts.isStringLiteral(url.arguments[0]!)
        || url.arguments[1]!.getText(source) !== 'import.meta.url') continue
      positions[url.arguments[0]!.getStart(source)] = find.text
    }
  }
  return positions
}

async function analyze(path: string, source: string): Promise<Analysis> {
  const css = path.endsWith('.css')
  // Type-only imports are erased before tests run; they cannot change a unit or integration result.
  const sourceCode = codeMask(source)
  const text = css ? source : source.replace(/\b(?:import|export)\s+(?:type\s+[^;'"]*?|\{[^}]*\})\s*from\s*['"][^'"\n]+['"]/g,
    (statement: string, index: number) => {
      if (!sourceCode[index]) return statement
      const bindings = /^(?:import|export)\s*\{([^}]*)\}/.exec(statement)?.[1]?.replace(/\/\*[^]*?\*\/|\/\/[^\n]*/g, '')
        .split(',').filter(value => value.trim())
      return /^(?:import|export)\s+type\b/.test(statement)
        || bindings?.length && bindings.every(value => /^\s*type\s+\w/.test(value))
        ? statement.replace(/[^\n]/g, ' ') : statement
    })
  const data = css || path.endsWith('.json')
  const code = data ? new Uint8Array(0) : codeMask(text)
  const declarations = text.includes('ci-key-inputs:') ? codeMask(text, true) : code
  // CSS imports name their files like JS imports; one that names no literal could load anything.
  const cssImports = css ? [...text.matchAll(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1/g)].map(match => match[2]!) : []
  // Importing a function that can inspect the host is not proof that a test reads that host input. Refuse only
  // concrete external reads in tests or at module scope; parameterized I/O is covered by project data and callers.
  const deferred = new Uint8Array(text.length)
  for (const arrow of text.matchAll(/=>\s*/g)) {
    if (!code[arrow.index]) continue
    const start = arrow.index + arrow[0].length
    if (text[start] === '{') continue
    let nesting = 0
    for (let index = start; index < text.length; index++) {
      if (code[index]) {
        const char = text[index]!
        if (nesting === 0 && /[;,)\]}\n]/.test(char)) break
        if ('([{'.includes(char)) nesting++
        else if (')]}'.includes(char)) nesting--
      }
      deferred[index] = 1
    }
  }
  const moduleScope = new Uint8Array(text.length)
  let depth = 0
  for (let index = 0; index < text.length; index++) {
    moduleScope[index] = depth === 0 && !deferred[index] ? 1 : 0
    if (code[index] && text[index] === '{') depth++
    else if (code[index] && text[index] === '}') depth--
  }
  const atModuleScope = (index: number) => moduleScope[index] === 1
  const reads = data ? [] : filesystemReads(text, code, atModuleScope)
  const readPaths = new Set(reads.flatMap(read => read.paths ?? []).map(path => path.replace(/^@file\//, '')))
  const references = data ? { text, anchors: [] } : await pathContexts(path, text, code)
  const literals = data ? [] : [...references.text.matchAll(pathLiteral)]
  const aliasUrls = await aliasUrlPositions(path, text)
  return {
    specifiers: css ? cssImports.filter(specifier => !/^(?:https?:)?\/\//.test(specifier))
      : data ? [] : importSpecifiers(text, index => code[index] === 1),
    literals: literals.map(match => match[1]!),
    aliasUrls: Object.fromEntries(literals.flatMap((match, index) => aliasUrls[match.index] ? [[index, aliasUrls[match.index]!]] : [])),
    computed: data ? [] : computedCalls(references.text, code),
    reads,
    ...data ? { paths: [], arguments: [] } : (({ paths, literals }) => ({ paths: paths.filter(path => !readPaths.has(path)),
      arguments: literals.filter(path => !readPaths.has(path)) }))(constructedPaths(references.text, code)),
    anchors: references.anchors,
    processes: data || !startsProcesses.test(text) ? [] : processCalls(text, code, atModuleScope),
    // Only a comment line declares inputs; the same words inside a string (a test fixture) do not.
    declaredInputs: data ? [] : [...text.matchAll(/^[ \t]*(?:\/\/|\/\*|\*)[ \t]*ci-key-inputs:[ \t]*([^\n*]+)/gm)]
      .filter(match => declarations[match.index + match[0].search(/\S/)] === 1)
      .flatMap(match => match[1]!.trim().split(/\s+/)),
    doubt: css ? (/@import\b/.test(text) && cssImports.length < (text.match(/@import\b/g) ?? []).length ? 'imports CSS by a computed name' : null)
      : DOUBTS.find(([pattern]) => [...text.matchAll(new RegExp(pattern.source, 'g'))].some(match => code[match.index] === 1))?.[1] ?? null,
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
  /** Effective execution configuration and resolved package identities; explicit reads retain raw file blobs. */
  identities: Map<string, string>
  closures: Map<string, Promise<ClosureIndex>>
}

interface ClosureIndex {
  files(file: string): string[] | undefined
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
  private readonly closures: Map<string, Promise<ClosureIndex>>

  private constructor(private readonly source: CiTestTree, private readonly tree: CiTestTree, private readonly exports: Record<string, unknown>,
    private readonly workspacePackages: ReadonlyMap<string, { directory: string; exports: Record<string, unknown> }>,
    private readonly packages: ReadonlySet<string>, private readonly signal: AbortSignal,
    shared?: SharedGraph) {
    this.resolvedEdges = shared?.resolvedEdges ?? new Map()
    this.harness = shared?.harness ?? new Map()
    this.environments = shared?.environments ?? new Map()
    this.directories = shared?.directories ?? new Set()
    this.identities = shared?.identities ?? new Map()
    this.closures = shared?.closures ?? new Map()
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
    const inputs = new Map<string, [string, string][]>()
    const names = new Map<string, [string, string][]>()
    for (const [path, blob] of tree.blobs) {
      const project = projectOf(path)
      const listed = names.get(project) ?? []
      listed.push([path, blob.split(':')[0]!])
      names.set(project, listed)
      // Configs keep their effective-field identities unless explicitly read or used to build an artifact.
      if (/(?:^|\/)(?:package\.json|tsconfig[^/]*\.json)$/.test(path)) continue
      if (ciCodeFile.test(path) && !path.endsWith('.json') && !/(?:^|\/)fixtures?\//.test(path)) continue
      const files = inputs.get(project) ?? []
      files.push([path, blob])
      inputs.set(project, files)
    }
    for (const [project, files] of inputs) keys.identities.set(`${INPUTS}${project}`, sha256Hex(JSON.stringify(files.sort())))
    for (const [project, files] of names) keys.identities.set(`${NAMES}${project}`, sha256Hex(JSON.stringify(files.sort())))
    // Every release bumps the root version; a read of the root manifest observes its other fields.
    const root = manifests.find(manifest => manifest.path === 'package.json')
    if (root) keys.identities.set('package.json', sha256Hex(JSON.stringify(['manifest-without-version',
      Object.entries(root.value).filter(([field]) => field !== 'version')])))
    for (const { path, value } of manifests) {
      keys.identities.set(`${CONFIG}${path}`, sha256Hex(JSON.stringify([value.type, value.packageManager])))
      const scripts = value.scripts as Record<string, unknown> | undefined
      for (const name of ['test', 'test:integration', 'db:up']) {
        keys.identities.set(`${CONFIG}${path}:${name}`, sha256Hex(JSON.stringify(scripts?.[name] ?? null)))
      }
    }
    // Vitest's transform uses the nearest tsconfig and its inherited runtime options, not build-only configs or
    // typechecking flags. Explicit file reads and declared build inputs still use the complete original blobs.
    const compilerFields = ['target', 'jsx', 'jsxFactory', 'jsxFragmentFactory', 'jsxImportSource', 'experimentalDecorators',
      'useDefineForClassFields', 'verbatimModuleSyntax', 'importsNotUsedAsValues', 'preserveValueImports', 'alwaysStrict', 'baseUrl', 'paths']
    const config = async (path: string, ancestors: string[] = []): Promise<Record<string, unknown>> => {
      if (ancestors.includes(path)) throw new CacheDoubt(`${path} has cyclic tsconfig inheritance.`)
      const text = await tree.read(path, signal)
      const value = JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[^]*?\*\//g, (match, string) => string ?? '')
        .replace(/,\s*([}\]])/g, '$1')) as { extends?: string | string[]; compilerOptions?: Record<string, unknown> }
      let options: Record<string, unknown> = {}
      for (const parent of typeof value.extends === 'string' ? [value.extends] : value.extends ?? []) {
        const target = posix.join(posix.dirname(path), parent)
        const resolved = tree.blobs.has(target) ? target : `${target}.json`
        if (!tree.blobs.has(resolved)) throw new CacheDoubt(`${path} extends an unproven compiler configuration.`)
        options = { ...options, ...await config(resolved, [...ancestors, path]) }
      }
      return { ...options, ...value.compilerOptions }
    }
    await Promise.all([...tree.blobs.keys()].filter(path => posix.basename(path) === 'tsconfig.json').map(async path => {
      try {
        const options = await config(path)
        keys.identities.set(`${CONFIG}${path}`, sha256Hex(JSON.stringify(compilerFields.map(field => [field, options[field]]))))
      } catch (error) {
        if (!(error instanceof CacheDoubt) && !(error instanceof SyntaxError)) throw error
        keys.identities.set(`${CONFIG}${path}`, `doubt:${error.message}`)
      }
    }))
    if (tree.blobs.has(LOCKFILE)) {
      for (const [marker, identity] of lockIdentities(parseYaml(await tree.read(LOCKFILE, signal)) as CiLockfile,
        { packageMarker: PACKAGE, toolsMarker: TOOLS })) keys.identities.set(marker, identity)
    }
    return keys
  }

  /** The same commit's keys under another deadline, for a graph that outlives the work that built it. */
  bounded(signal: AbortSignal) {
    return new CiResultKeys(this.source, boundedTree(this.source, signal), this.exports, this.workspacePackages, this.packages, signal,
      { resolvedEdges: this.resolvedEdges, harness: this.harness, environments: this.environments, directories: this.directories,
        identities: this.identities, closures: this.closures })
  }

  /** The file's key for the suite and part, or null with the reason it must run. With a mask, the key of the inputs
   * that file's mask keeps (a separate key space, without a runner-free key). */
  async key(file: string, suite: string, part: string, mask?: CiFileMask): Promise<CiResultKey> {
    try {
      this.signal.throwIfAborted()
      const project = projectOf(file)
      const environment = this.environment(project, suite)
      const harness = await this.harnessFiles(project, suite, environment)
      const own = await this.sharedClosure(file)
      const tools = this.locked && !['scripts', 'apps/worker'].includes(project) ? [`${PACKAGE}${project}\tvitest`] : []
      // A shared reader can observe data from any calling project in this closure, including the test's own.
      const markers = [INPUTS, NAMES].filter(marker => own.some(path => path.startsWith(marker)))
      const data = markers.length ? [...new Set([project, ...own.filter(path => !path.startsWith('\0')).map(projectOf)])]
        .flatMap(project => markers.map(marker => `${marker}${project}`)) : []
      const paths = [...new Set([...environment, ...harness, ...own, ...tools, ...data])].sort()
      const masked = new Map<string, string>()
      if (mask) {
        // Environment and harness files stay whole: every test of the project loads them.
        const shared = new Set([...environment, ...harness])
        for (const path of own) {
          const blob = this.tree.blobs.get(path)
          const identity = blob && !shared.has(path)
            ? await mask(path, blob, () => this.tree.read(path, this.signal)) : undefined
          if (identity) masked.set(path, identity)
        }
      }
      // The file is part of its key: tests whose closures reach each other cover the same paths, and one proof per
      // key would otherwise stand for several files.
      const hash = (selected: string[], scope: string) => sha256Hex(JSON.stringify([CI_RESULT_CACHE_VERSION, scope, suite, part, file,
        selected.map(path => [path, masked.get(path) ?? this.identity(path)])]))
      // Discard earlier function proofs, which could omit teardown calls or escape their smoke computer's scope.
      if (mask) return { key: hash(paths, 'masked-v2') }
      // A runner's imports belong to that runner too. Configured setup and dependencies the test itself imports
      // remain inputs even when they also occur in the runner's closure.
      const runtime = await this.harnessFiles(project, suite, environment, true)
      let required: Set<string> | undefined
      return { key: hash(paths, 'all'), inputs: paths.length,
        runnerFreeKey: hash(paths.filter(path => !harness.has(path) && !TEST_EXECUTION_FILES.some(pattern => pattern.test(path))
          || runtime.has(path) || (required ??= new Set(own)).has(path)), 'runner-free') }
    } catch (error) {
      if (error instanceof CacheDoubt) return { key: null, reason: error.message }
      throw error
    }
  }

  /** A path's content identity; an imported package's is its locked tree as the importing project resolves it. */
  private identity(path: string) {
    if (path.startsWith(LISTED)) return this.tree.blobs.get(path.slice(LISTED.length))?.split(':')[0] ?? 'directory'
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

  /** Execution inputs shared by a project's tests in this suite. Data files join only through reads or declarations. */
  private environment(project: string, suite: string) {
    const scope = `${project}:${suite}`
    let files = this.environments.get(scope)
    if (!files) {
      files = this.projectEnvironment(project, suite)
      this.environments.set(scope, files)
    }
    return files
  }

  private projectEnvironment(project: string, suite: string) {
    const files = [...this.tree.blobs.keys()].filter(path => executionFile(path, suite, project)
      || path.startsWith(`${project}/vitest.config.`))
    // Without split package identities, the complete lockfile remains an input of every test.
    if (!this.locked && this.tree.blobs.has(LOCKFILE)) files.push(LOCKFILE)
    for (const path of ['package.json', `${project}/package.json`]) {
      for (const suffix of ['', `:${suite === 'integration' && path === 'package.json' ? 'test:integration' : 'test'}`,
        ...project === 'apps/api' && path === 'package.json' ? [':db:up'] : []]) {
        const marker = `${CONFIG}${path}${suffix}`
        if (this.identities.has(marker)) files.push(marker)
      }
    }
    return files
  }

  /** What the environment's configs, setup files and runner scripts load, including files they name by relative path.
   * Shared test helpers are hashed by content; a test that imports one reaches its imports through its own closure. */
  private harnessFiles(project: string, suite: string, environment: string[], runtime = false) {
    const scope = `${project}:${suite}${runtime ? ':runtime' : ''}`
    let files = this.harness.get(scope)
    if (!files) {
      const roots = environment.filter(path => scriptFile.test(path) && !/(?:^|\/)eslint\.config\./.test(path)
        && !/^(?:\.github|\.circleci)\//.test(path) && !path.startsWith('apps/api/test/helpers/')
        && (!runtime || !TEST_EXECUTION_FILES.some(pattern => pattern.test(path))))
      files = this.closure(roots, false)
      this.harness.set(scope, files)
      files.catch(error => { if (!(error instanceof CacheDoubt)) this.harness.delete(scope) })
    }
    return files
  }

  private async analysis(path: string, blob: string) {
    const id = `${blob}${posix.extname(path)}${VITEST_CONFIG.test(path) ? ':vitest-config' : ''}`
    const cached = analyses.get(id)
    if (cached) return cached
    let pending = this.pendingAnalyses.get(id)
    if (!pending) {
      pending = this.tree.read(path, this.signal).then(async text => {
        const value = await analyze(path, text)
        if (analyses.size >= ANALYSES_MAX) analyses.delete(analyses.keys().next().value!)
        analyses.set(id, value)
        return value
      }).finally(() => { this.pendingAnalyses.delete(id) })
      this.pendingAnalyses.set(id, pending)
    }
    return pending
  }

  /** Condense cycles once, then union bitsets on the resulting DAG. Each module's transitive graph is computed
   * once for the commit, rather than walking the same application closure separately for thousands of tests. */
  private async sharedClosure(file: string) {
    let pending = this.closures.get('tests')
    if (!pending) {
      pending = this.indexClosures([...this.tree.blobs.keys()].filter(path => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)).concat(file))
      this.closures.set('tests', pending)
      pending.catch(() => { this.closures.delete('tests') })
    }
    return (await pending).files(file) ?? [...await this.closure([file], true)]
  }

  private async indexClosures(roots: string[]): Promise<ClosureIndex> {
    const nodes: { path: string; strict: boolean; leaf: boolean; output: string; edges: number[]; doubt?: string }[] = []
    const ids = new Map<string, number>()
    const add = (file: string, strict: boolean) => {
      const loose = file.startsWith(LOOSE)
      const path = loose ? file.slice(LOOSE.length) : file
      const leaf = path.startsWith('\0')
      const id = `${leaf ? 'v' : strict && !loose ? 's' : 'l'}:${path}`
      let index = ids.get(id)
      if (index === undefined) {
        index = nodes.length
        ids.set(id, index)
        nodes.push({ path, strict: strict && !loose, leaf, output: path.startsWith(DATA) ? path.slice(DATA.length) : path, edges: [] })
      }
      return index
    }
    const entries = new Map(roots.map(file => [file, add(file, true)]))
    for (let start = 0; start < nodes.length;) {
      this.signal.throwIfAborted()
      const batch = nodes.slice(start, start + 16)
      await Promise.all(batch.map(async node => {
        if (node.leaf) return
        try { node.edges = (await this.edges(node.path, node.strict)).map(edge => add(edge, node.strict)) }
        catch (error) {
          if (!(error instanceof CacheDoubt)) throw error
          node.doubt = error.message
        }
      }))
      start += batch.length
      // Let abort deadlines and unrelated requests run during large graph loads.
      if (start % 256 === 0) await new Promise(resolve => setImmediate(resolve))
    }
    const outputs = [...new Set(nodes.map(node => node.output))].sort()
    const outputIds = new Map(outputs.map((path, index) => [path, index]))
    const discovery = new Int32Array(nodes.length).fill(-1)
    const low = new Int32Array(nodes.length)
    const groupOf = new Int32Array(nodes.length).fill(-1)
    const stack: number[] = []
    const groups: { bits: Uint32Array; doubt?: string }[] = []
    let clock = 0
    const visit = (index: number) => {
      discovery[index] = low[index] = clock++
      stack.push(index)
      for (const edge of nodes[index]!.edges) {
        if (discovery[edge] === -1) { visit(edge); low[index] = Math.min(low[index]!, low[edge]!) }
        else if (groupOf[edge] === -1) low[index] = Math.min(low[index]!, discovery[edge]!)
      }
      if (low[index] !== discovery[index]) return
      const members: number[] = []
      for (;;) {
        const member = stack.pop()!
        groupOf[member] = groups.length
        members.push(member)
        if (member === index) break
      }
      const group: { bits: Uint32Array; doubt?: string } = { bits: new Uint32Array(Math.ceil(outputs.length / 32)) }
      for (const member of members) {
        const node = nodes[member]!, output = outputIds.get(node.output)!
        group.bits[output >>> 5]! |= 1 << (output & 31)
        if (node.doubt) group.doubt = node.doubt
        for (const edge of node.edges) {
          const child = groups[groupOf[edge]!]
          if (!child) continue // The edge stays in this strongly connected component.
          if (child.doubt) group.doubt = child.doubt
          for (let word = 0; word < group.bits.length; word++) group.bits[word]! |= child.bits[word]!
        }
      }
      groups.push(group)
    }
    for (let index = 0; index < nodes.length; index++) if (discovery[index] === -1) visit(index)
    return { files: file => {
      const index = entries.get(file)
      if (index === undefined) return undefined
      const group = groups[groupOf[index]!]!
      if (group.doubt) throw new CacheDoubt(group.doubt)
      return outputs.filter((_, output) => (group.bits[output >>> 5]! & (1 << (output & 31))) !== 0)
    } }
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
          if (file.startsWith(PACKAGE) || file.startsWith(LISTED) || file.startsWith(CONFIG) || file.startsWith(INPUTS) || file.startsWith(NAMES) || file.startsWith(TOOLS)) {
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
    if (strict && analysis.doubt) throw new CacheDoubt(`${file} ${analysis.doubt}.`)
    // Follow named runtime inputs as well as imports. Parameterized runtime I/O adds project data; only a
    // concrete external input is a reason to refuse a key.
    const edges: string[] = []
    for (const literal of analysis.anchors) {
      const target = resolveImport(file, literal, this.tree.blobs, {})
        ?? (this.tree.blobs.has(literal) ? literal : undefined)
      // createRequire observes resolution at this manifest, rather than its description, version or scripts.
      if (target?.endsWith('/package.json') || target === 'package.json') {
        edges.push(`${CONFIG}${target}`)
        // A require anchored in another project resolves its packages there, even when this script has a
        // different nearest importer. Ordinary imports still keep their own project identities below.
        for (const specifier of [...analysis.specifiers, ...analysis.computed.flatMap(call => call.literals)]) {
          const name = packageName(specifier)
          if (this.packages.has(name)) edges.push(`${PACKAGE}${projectOf(target)}\t${name}`)
        }
      }
    }
    if (strict) {
      let directory = posix.dirname(file)
      let manifest = false, compiler = !/\.[cm]?tsx?$/.test(file)
      while (true) {
        for (const name of ['package.json', 'tsconfig.json']) {
          if (name === 'package.json' ? manifest : compiler) continue
          const marker = `${CONFIG}${directory === '.' ? '' : `${directory}/`}${name}`
          const identity = this.identities.get(marker)
          if (!identity) continue
          if (identity.startsWith('doubt:')) throw new CacheDoubt(identity.slice(6))
          edges.push(marker)
          if (name === 'package.json') manifest = true
          else compiler = true
        }
        if (directory === '.' || manifest && compiler) break
        directory = posix.dirname(directory)
      }
    }
    for (const call of strict && analysis.declaredInputs.length === 0 ? analysis.processes : []) {
      if (call.external && (listedTest.test(file) || call.moduleScope)) throw new CacheDoubt(`${file} starts a process supplied by the host environment.`)
      if (call.entrypoint) edges.push(...this.computedTarget(file, call.entrypoint).filter((target): target is string => target !== true))
      edges.push(...call.command.flatMap(literal => this.computedTarget(file, literal))
        .filter((target): target is string => target !== true))
      if (!call.named) edges.push(`${INPUTS}${projectOf(file)}`)
      if (call.build && (listedTest.test(file) || call.moduleScope)) {
        // A real build observes source and raw build configuration, plus the project's installed tools.
        edges.push(...this.namedFiles(file, projectOf(file), true), `${TOOLS}${this.importer(projectOf(file))}`)
      }
    }
    // A computed import or require is proven by the literals it names: repository files join the key, and packages
    // the manifests pin are covered by the lockfile. A call that names nothing resolvable could load anything.
    // A test that builds an artifact and then loads or runs it declares the inputs the artifact is made from; they
    // join the key (files by content with their scripts' imports followed, directories whole, packages through the
    // lockfile), and that file's runtime loads and process starts are covered by the declaration.
    const declared = strict && analysis.declaredInputs.length > 0
    for (const input of declared ? analysis.declaredInputs : []) {
      const targets = this.computedTarget(file, input)
      const named = targets.length ? targets.filter((target): target is string => target !== true)
        : this.namedFiles(file, input, true)
      if (!targets.length && !named.length) throw new CacheDoubt(`${file} declares the input ${input}, which is not a repository path or pinned package.`)
      edges.push(...named.map(path => path.startsWith('\0') ? path : `${scriptFile.test(path) ? LOOSE : DATA}${path}`))
    }
    if (strict && !declared) {
      for (const read of analysis.reads) {
        if (read.external && (listedTest.test(file) || read.moduleScope)) throw new CacheDoubt(`${file} reads a filesystem path supplied by the host environment.`)
        if (!read.paths) {
          edges.push(`${read.namesOnly ? NAMES : INPUTS}${projectOf(file)}`)
          continue
        }
        for (const literal of read.paths) {
          const anchored = literal.startsWith('@file/')
          if (literal.startsWith('/')) {
            if (listedTest.test(file) || read.moduleScope) throw new CacheDoubt(`${file} reads an absolute filesystem path outside the commit.`)
            continue
          }
          const targets = anchored ? [posix.join(posix.dirname(file), literal.slice(6))]
            : [...new Set([posix.normalize(literal), posix.join(projectOf(file), literal), posix.join(posix.dirname(file), literal)])]
          for (const candidate of targets) {
            const target = candidate.replace(/\/$/, '') || '.'
            if (target.startsWith('../')) throw new CacheDoubt(`${file} reads a filesystem path outside the commit.`)
            const named = read.namesOnly && this.directories.has(target)
              ? [...new Set([...this.tree.blobs.keys()].filter(path => path.startsWith(`${target}/`))
                .map(path => `${LISTED}${target}/${read.recursive ? path.slice(target.length + 1) : path.slice(target.length + 1).split('/')[0]}`))]
              : this.namedFiles(file, target, true).map(path => `${DATA}${path.replace(/^\0(?:loose|data|listed):/, '')}`)
            // The commit also proves absence; adding a previously missing input must change the key.
            edges.push(...named.length ? named : [`${DATA}${target}`])
          }
        }
      }
    }
    if (strict) {
      for (const literal of analysis.paths) {
        const target = resolveImport(file, literal, this.tree.blobs, {})
        edges.push(...target ? [target] : this.namedFiles(file, literal))
      }
      // `portionKey('apps/api', 'test')` names a directory without reading it; a wrapper that does read it
      // reaches the data through its own reader.
      for (const literal of analysis.arguments) {
        const target = resolveImport(file, literal, this.tree.blobs, {})
        edges.push(...target ? [target] : this.namedFiles(file, literal, false, false))
      }
    }
    for (const call of analysis.computed) {
      // A bare file name (`createRequire(join(api, 'package.json'))`) is a segment of a directory path, not a root file.
      const resolved = call.literals.filter(literal => literal.includes('/') || !this.tree.blobs.has(literal))
        .flatMap(literal => this.computedTarget(file, literal))
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
    // Process arguments name executed scripts; fixture text and comments do not supply edges.
    if (strict && analysis.processes.length) {
      for (const call of analysis.processes) {
        // `git ls-files` prints names: a directory it lists joins the key by its file names, not their contents.
        const names = call.command.includes('git') && call.literals.includes('ls-files')
          && !call.literals.some(literal => /^(?:-s|--stage|--debug|--eol|-[a-z]*s[a-z]*)$/.test(literal))
        for (const literal of call.literals) {
          const target = resolveImport(file, literal, this.tree.blobs, {})
          const directory = names && !target && !this.tree.blobs.has(literal) && this.directories.has(literal.replace(/\/$/, ''))
          edges.push(...target ? [target] : directory
            ? [...this.tree.blobs.keys()].filter(path => path.startsWith(`${literal.replace(/\/$/, '')}/`)).map(path => `${LISTED}${path}`)
            : this.namedFiles(file, literal))
        }
      }
    }
    for (const [index, literal] of analysis.literals.entries()) {
      if (!strict && literal.startsWith('.')) {
        const named = posix.join(posix.dirname(file), literal)
        // Only omit an alias URL when ordinary import resolution already reaches that exact file. An override
        // of a package export, an unknown alias or a computed replacement stays a whole harness dependency.
        const alias = analysis.aliasUrls[index]
        if (alias) {
          const workspace = this.workspacePackages.get(packageName(alias))
          if (workspace && this.workspaceSource(file, alias, packageName(alias), workspace) === named) continue
        }
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
  private namedFiles(file: string, literal: string, declared = false, directories = true): string[] {
    const project = projectOf(file)
    const candidates = literal.startsWith('.') ? [posix.join(posix.dirname(file), literal)] : [literal, `${project}/${literal}`]
    const named: string[] = []
    for (const candidate of candidates) {
      if (this.tree.blobs.has(candidate)) named.push(candidate)
      // The project or a directory above it (`resolve('../..')`) is a base for paths, not data: walking it put the
      // whole repository in the keys of every test whose setup names the repository root.
      else if (!declared && (candidate === project || project.startsWith(`${candidate}/`))) continue
      else if (directories && this.directories.has(candidate)) {
        // Every file in a named directory joins the key by content; its scripts may be run, so their imports are
        // followed too, loosely like the harness's (what resolves joins the key, nothing doubts).
        const inside = [...this.tree.blobs.keys()].filter(path => path.startsWith(`${candidate}/`))
        named.push(...inside.map(path => `${listedTest.test(path) ? LISTED : scriptFile.test(path) ? LOOSE : DATA}${path}`))
      }
      if (named.length) break
    }
    return named
  }
}

