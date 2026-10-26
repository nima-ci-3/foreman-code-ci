import { createHash } from 'node:crypto'
import { existsSync, globSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path'
import { INSTALLATION_NAMES } from '../packages/contracts/src/installationNames.mjs'
import { createRuntimeBuildIdentity } from '../packages/contracts/src/runtimeBuildIdentityNode.mjs'

export const buildProjects = { contracts: 'packages/contracts', 'contracts-node': 'packages/contracts-node', ci: 'apps/ci', api: 'apps/api', web: 'apps/web' }

function walk(directory, visit) {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) walk(path, visit)
    else if (entry.isFile() || entry.isSymbolicLink() && statSync(path).isFile()) visit(path)
    else throw new Error(`Build cache cannot inventory this input: ${path}`)
  }
}

// Read pnpm's generated block maps without installing a YAML parser: the archive
// key is requested by both cloud providers before node_modules is restored.
function lockBlocks(text) {
  const maps = {}, lines = text.split('\n')
  let section, key
  for (const line of lines) {
    const top = /^(\w+):/.exec(line)
    if (top) { section = top[1]; maps[section] = new Map(); key = undefined }
    else {
      const entry = /^  (\S.*):(?: \{\})?$/.exec(line)
      if (entry && maps[section]) { key = unquote(entry[1]); maps[section].set(key, '') }
      if (key) maps[section].set(key, maps[section].get(key) + line + '\n')
    }
  }
  return maps
}
const unquote = value => value.startsWith("'") ? value.slice(1, -1).replaceAll("''", "'")
  : value.startsWith('"') ? JSON.parse(value) : value
const packageName = name => name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]
const imports = text => [...text.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g)].map(match => match[1])

function lockIdentity(root, scope, names, add) {
  const path = join(root, 'pnpm-lock.yaml')
  if (!existsSync(path)) return
  const maps = lockBlocks(readFileSync(path, 'utf8'))
  const importer = maps.importers?.get(scope) ?? ''
  const versions = new Map()
  let name
  for (const line of importer.split('\n')) {
    const entry = /^      (.+):$/.exec(line)
    if (entry) name = unquote(entry[1])
    const version = /^        version: (.+)$/.exec(line)
    if (version && name) versions.set(name, unquote(version[1]))
  }
  const snapshotKey = (name, version) => version.startsWith('link:') ? null
    : /^\d/.test(version) ? `${name}@${version}` : version.replace(/^npm:/, '')
  const pending = [...names].sort().flatMap(name => {
    const version = versions.get(name)
    add(`dependency:${name}`, version ?? 'not locked')
    return version ? [snapshotKey(name, version)].filter(Boolean) : []
  })
  const seen = new Set()
  while (pending.length) {
    const key = pending.pop()
    if (seen.has(key)) continue
    seen.add(key)
    const record = maps.packages?.get(key.replace(/\(.*$/, '')) ?? ''
    add(`lock:${key}`, record)
    const snapshot = maps.snapshots?.get(key) ?? ''
    for (const match of snapshot.matchAll(/^      (.+): (.+)$/gm)) {
      const next = snapshotKey(unquote(match[1]), unquote(match[2]))
      if (!next) continue
      const metadata = maps.packages?.get(next.replace(/\(.*$/, '')) ?? ''
      const compatible = (field, current) => {
        const selection = new RegExp(`^    ${field}: \\[([^\\]]+)\\]$`, 'm').exec(metadata)
        if (!selection) return true
        const choices = selection[1].split(',').map(value => unquote(value.trim()))
        return !choices.includes(`!${current}`) && (!choices.some(value => !value.startsWith('!')) || choices.includes(current))
      }
      if (!compatible('os', process.platform) || !compatible('cpu', process.arch)) continue
      if (metadata.includes('    libc:')) {
        const libc = process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl'
        if (!compatible('libc', libc)) continue
      }
      add(`edge:${key}:${unquote(match[1])}`, next)
      pending.push(next)
    }
  }
}

const digest = () => {
  const hash = createHash('sha256')
  return { add(name, value) { hash.update(`${Buffer.byteLength(name)}:${name}:${Buffer.byteLength(value)}:`).update(value) },
    finish() { return hash.digest('hex') } }
}

// This is an archive lookup hint, independent of installed tooling. Admission
// always uses buildInputHash below, including the actual compiler input graph.
export function contractsArchiveKey(root) {
  const { add, finish } = digest()
  add('format', 'contracts-archive-v2')
  add('runtime', JSON.stringify([process.version, process.platform, process.arch]))
  const scope = buildProjects.contracts, names = new Set(['typescript']), seen = new Set()
  function config(path) {
    if (seen.has(path)) throw new Error('Cyclic contracts compiler configuration')
    seen.add(path)
    const text = readFileSync(path, 'utf8')
    add(relative(root, path), text)
    // Strip JSONC comments/trailing commas while preserving quoted strings.
    const json = text.replace(/^\uFEFF/, '')
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (match, string) => string ?? '')
      .replace(/("(?:[^"\\]|\\.)*")|,\s*(?=[}\]])/g, (match, string) => string ?? '')
    const value = JSON.parse(json)
    let result = { compilerOptions: {} }
    for (const parent of [value.extends ?? []].flat()) {
      const target = resolve(dirname(path), parent)
      const inherited = config(target.endsWith('.json') ? target : `${target}.json`)
      result = { ...result, ...inherited, compilerOptions: { ...result.compilerOptions, ...inherited.compilerOptions } }
    }
    for (const field of ['files', 'include', 'exclude']) {
      if (value[field]) value[field] = value[field].map(pattern => resolve(dirname(path), pattern))
    }
    seen.delete(path)
    return { ...result, ...value, compilerOptions: { ...result.compilerOptions, ...value.compilerOptions } }
  }
  const project = join(root, scope), value = config(join(project, 'tsconfig.build.json'))
  const patterns = entries => entries.map(pattern => /[.*?{}[\]]/.test(relative(project, pattern)) ? pattern : `${pattern}/**/*`)
  const roots = new Set([...(value.files ?? []), ...globSync(patterns(value.include ?? [join(project, '**/*')]),
    { exclude: patterns(value.exclude ?? [join(project, 'node_modules'), join(project, 'dist')]) })])
  const reached = new Set()
  function source(path) {
    if (reached.has(path)) return
    reached.add(path)
    const text = readFileSync(path, 'utf8')
    add(relative(root, path), text)
    for (const name of imports(text)) {
      if (!name.startsWith('.') && !name.startsWith('node:')) names.add(packageName(name))
      if (name.startsWith('.')) {
        const target = resolve(dirname(path), name)
        const candidates = [target.replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts'), target,
          ...['.ts', '.mts', '.mjs', '.js', '.tsx', '.json', '/index.ts', '/index.mjs'].map(suffix => target + suffix)]
        const resolved = candidates.find(path => existsSync(path) && statSync(path).isFile())
        if (resolved) source(resolved)
      }
    }
  }
  for (const path of [...roots].sort()) {
    if (/\.[cm]?tsx?$/.test(path) || value.compilerOptions.allowJs && /\.[cm]?jsx?$/.test(path)) source(path)
  }
  for (const name of value.compilerOptions.types ?? []) names.add(`@types/${name}`)
  const manifest = join(root, scope, 'package.json')
  if (existsSync(manifest)) {
    const value = JSON.parse(readFileSync(manifest, 'utf8'))
    if (value.devDependencies?.['@typescript/native']) names.add('@typescript/native')
    add('package mode', JSON.stringify([value.name, value.type, value.imports, value.exports]))
  }
  lockIdentity(root, scope, names, add)
  return finish()
}

export function buildInputHash(root, kind, command, cwd = join(root, buildProjects[kind])) {
  const project = join(root, buildProjects[kind]), require = createRequire(join(project, 'package.json'))
  const { add, finish } = digest()
  const normalize = value => value === process.execPath ? '<node>' : value.replaceAll(root, '<checkout>')
  add('format', 'build-inputs-v2')
  add('runtime', JSON.stringify([process.version, process.platform, process.arch]))
  const tools = new Set(['typescript']), runtimeTools = [], dependencyNames = new Set(), files = new Map(), manifests = new Set()
  const externalLabel = path => {
    let directory = dirname(path)
    while (directory !== dirname(directory)) {
      const manifest = join(directory, 'package.json')
      if (existsSync(manifest)) {
        const value = JSON.parse(readFileSync(manifest, 'utf8'))
        if (value.name) return `${value.name}@${value.version ?? 'unversioned'}/${relative(directory, path)}`
      }
      directory = dirname(directory)
    }
    throw new Error('Build cache input has no portable package identity')
  }
  const fileLabel = path => path.startsWith(`${root}/`) && !path.includes('/node_modules/') ? relative(root, path) : externalLabel(path)
  const addFile = path => {
    const label = fileLabel(path)
    files.set(label, path)
    if (path.includes('/node_modules/')) {
      const name = packageName(label)
      dependencyNames.add(name.slice(0, name.lastIndexOf('@')))
    }
  }
  const ts = require('typescript')
  let compilerArgs, viteArgs = []
  const compilerIndex = command.findIndex(value => /^tsc(?:\.[cm]?js)?$/.test(basename(value)))
  add('invocation', JSON.stringify([relative(root, cwd), command.map((value, index) => index === compilerIndex ? '<tsc>' : index === 0 && /^node(?:\.exe)?$/.test(basename(value)) ? '<node>' : normalize(value))]))
  if (compilerIndex >= 0) compilerArgs = command.slice(compilerIndex + 1)
  else if (['sh', 'bash'].includes(basename(command[0])) && command[1] === '-c') {
    const segments = command[2].split('&&')
    const segment = segments[0].trim()
    if (!/^tsc (?:-b|-p tsconfig\.build\.json)$/.test(segment)) throw new Error('Build cache cannot prove this shell command')
    compilerArgs = segment.slice(4).split(' ')
    if (kind === 'web') {
      const bundle = command[2].split('&&')[1]?.trim()
      if (segments.length !== 2 || !bundle?.startsWith('vite build') || /[\"'`$;|<>]/.test(bundle)) throw new Error('Build cache cannot prove this Vite command')
      viteArgs = bundle.slice('vite build'.length).trim().split(/\s+/).filter(Boolean)
    } else if (kind === 'api') {
      if (command[2] !== 'tsc -p tsconfig.build.json && node ../../scripts/copy-api-runtime.mjs && node dist/cli/harnessCompatibility.js') throw new Error('Build cache cannot prove this API command')
    } else if (segments.length !== 1) throw new Error('Build cache cannot prove shell side effects')
  } else if (kind === 'web' && command.includes('vite') && command.includes('build')) {
    compilerArgs = []
    viteArgs = command.slice(command.indexOf('build') + 1)
  } else throw new Error('Build cache cannot prove this build command')
  const buildMode = compilerArgs[0] === '-b' || compilerArgs[0] === '--build'
  const flags = ts.parseCommandLine(buildMode ? compilerArgs.slice(1) : compilerArgs)
  if (flags.errors.length) throw new Error('Build cache cannot resolve compiler flags')
  if (/(?:--(?:import|require|loader)|(?:^|\s)-r)(?:[=\s]|$)/.test(process.env.NODE_OPTIONS ?? '')) {
    throw new Error('Build cache cannot prove inputs of a Node preload hook')
  }
  const configs = new Set()
  const configAt = path => {
    if (configs.has(path)) return
    configs.add(path)
    const parsed = ts.getParsedCommandLineOfConfigFile(path, flags.options, { ...ts.sys,
      readFile(path) { const text = ts.sys.readFile(path); if (text !== undefined) addFile(path); return text },
      onUnRecoverableConfigFileDiagnostic(error) { throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n')) },
    })
    if (!parsed || parsed.errors.length) throw new Error('Build cache compiler configuration could not be resolved')
    // Construct the input graph only; never emit, typecheck, or inspect diagnostics.
    const host = ts.createCompilerHost(parsed.options)
    const read = host.readFile
    host.readFile = path => {
      const text = read(path)
      if (text !== undefined && path.endsWith('package.json')) manifests.add(path)
      return text
    }
    const resolutionCache = ts.createModuleResolutionCache(project, path => path, parsed.options)
    host.resolveModuleNameLiterals = (literals, containing, redirected, options, source) => literals.map(literal => {
      const mode = ts.getModeForUsageLocation(source, literal, options)
      const result = ts.resolveModuleName(literal.text, containing, options, host, resolutionCache, redirected, mode)
      add(`import:${fileLabel(containing)}:${literal.text}:${mode}`, result.resolvedModule ? fileLabel(result.resolvedModule.resolvedFileName) : 'unresolved')
      return result
    })
    const program = ts.createProgram(parsed.fileNames, parsed.options, host)
    for (const source of program.getSourceFiles()) addFile(source.fileName)
    for (const reference of parsed.projectReferences ?? []) configAt(ts.resolveProjectReferencePath(reference))
  }
  if (flags.fileNames.length && !buildMode) throw new Error('Build cache requires a compiler project')
  const config = flags.options.project ? resolve(cwd, flags.options.project)
    : join(project, kind === 'web' ? 'tsconfig.json' : 'tsconfig.build.json')
  configAt(config)
  for (const path of manifests) {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    add(`resolution:${path.startsWith(`${root}/`) && !path.includes('/node_modules/') ? relative(root, path) : externalLabel(path)}`,
      JSON.stringify([value.name, value.type, value.main, value.module, value.types, value.typings, value.typesVersions, value.exports, value.imports]))
  }
  if (kind === 'web') {
    tools.add('vite'); tools.add('@vitejs/plugin-react')
    walk(join(project, 'public'), addFile)
    const valueFlags = new Set(['--mode', '-m', '--base', '--target'])
    const optionalFlags = new Set(['--sourcemap', '--minify'])
    for (let index = 0; index < viteArgs.length; index++) {
      const [flag, inline] = viteArgs[index].split('=')
      if (valueFlags.has(flag)) { if (inline === undefined) index++; continue }
      if (optionalFlags.has(flag)) { if (inline === undefined && viteArgs[index + 1] && !viteArgs[index + 1].startsWith('-')) index++; continue }
      throw new Error('Build cache cannot prove custom Vite inputs or outputs')
    }
    const modeIndex = viteArgs.findIndex(value => value === '--mode' || value === '-m')
    const mode = modeIndex >= 0 ? viteArgs[modeIndex + 1] : viteArgs.find(value => value.startsWith('--mode='))?.slice(7) ?? 'production'
    for (const entry of ['index.html', 'vite.config.ts', '.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
      if (existsSync(join(project, entry))) addFile(join(project, entry))
    }
    const visited = new Set()
    function runtime(path, node = false) {
      const id = `${path}:${node}`
      if (visited.has(id)) return
      visited.add(id)
      addFile(path)
      const text = readFileSync(path, 'utf8')
      const options = { allowJs: true, resolveJsonModule: true, noDtsResolution: true,
        moduleResolution: node ? ts.ModuleResolutionKind.NodeNext : ts.ModuleResolutionKind.Bundler,
        customConditions: node ? [] : ['browser', 'module', process.env.NODE_ENV === 'development' ? 'development' : 'production'] }
      function follow(name) {
        if (/^(?:node:|data:|https?:|#)/.test(name) || builtinModules.includes(name)) return
        // Build tools contain dynamic loaders. Their complete installed runtime
        // trees are fingerprinted below; they are not application imports.
        if (node && tools.has(packageName(name))) { runtimeTools.push([packageName(name), path]); return }
        let target = ts.resolveModuleName(name, path, options, { ...ts.sys, readFile(path) { const text = ts.sys.readFile(path); if (text !== undefined && path.endsWith('package.json')) addFile(path); return text } }, undefined, undefined, ts.ModuleKind.ESNext).resolvedModule?.resolvedFileName
        if (!target && name.startsWith('.')) {
          const asset = resolve(dirname(path), name.split(/[?#]/)[0])
          if (existsSync(asset) && statSync(asset).isFile()) target = asset
        }
        if (!target) {
          try { target = createRequire(path).resolve(name) }
          catch { throw new Error(`Build cache cannot resolve runtime import ${name}`) }
        }
        runtime(target, node)
      }
      if (/\.css$/.test(path)) {
        for (const match of text.matchAll(/(?:@import\s+|url\(\s*)['"]?([^'"\s);]+)['"]?/g)) follow(match[1])
      } else if (/\.[cm]?[jt]sx?$/.test(path)) {
        const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
        function visit(ast) {
          if ((ts.isImportDeclaration(ast) || ts.isExportDeclaration(ast)) && ast.moduleSpecifier && ts.isStringLiteral(ast.moduleSpecifier)) {
            const clause = ast.importClause
            const bindings = clause?.namedBindings
            const typeExports = ts.isExportDeclaration(ast) && ast.exportClause && ts.isNamedExports(ast.exportClause) && ast.exportClause.elements.length > 0 && ast.exportClause.elements.every(item => item.isTypeOnly)
            const typeOnly = typeExports || ast.isTypeOnly || clause?.isTypeOnly || !clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly)
            if (!typeOnly) follow(ast.moduleSpecifier.text)
          }
          if (ts.isCallExpression(ast) && (ast.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(ast.expression) && ast.expression.text === 'require')) {
            if (!ast.arguments[0] || !ts.isStringLiteral(ast.arguments[0])) throw new Error('Build cache cannot prove a dynamic runtime import')
            follow(ast.arguments[0].text)
          }
          if (ts.isCallExpression(ast) && ast.expression.getText(source) === 'import.meta.glob') throw new Error('Build cache cannot prove runtime glob inputs')
          ts.forEachChild(ast, visit)
        }
        visit(source)
      }
    }
    const html = join(project, 'index.html')
    if (existsSync(html)) {
      for (const match of readFileSync(html, 'utf8').matchAll(/<script[^>]+src=['"]([^'"]+)['"]/g)) runtime(resolve(project, match[1].replace(/^\//, '')))
    }
    if (existsSync(join(project, 'vite.config.ts'))) runtime(join(project, 'vite.config.ts'), true)
    // Vite embeds this identity, including deliberately shared API/lock inputs.
    add('runtime identity', JSON.stringify(createRuntimeBuildIdentity(root)))
  }
  if (kind === 'api') {
    const copyScript = join(root, 'scripts/copy-api-runtime.mjs')
    addFile(copyScript)
    const { apiRuntimeFiles } = createRequire(import.meta.url)('../packages/verification-runner/runtime-files.mjs')
    for (const path of apiRuntimeFiles) addFile(join(root, path))
    addFile(join(root, 'apps/api/src/modules/browser-runtime/skill/browser-use.md'))
    add('runtime identity', JSON.stringify(createRuntimeBuildIdentity(root)))
  }
  const environment = new Set(['NODE_OPTIONS'])
  if (kind === 'web') {
    environment.add('NODE_ENV')
    for (const suffix of ['BROWSER_ORIGIN', 'DEV_BROWSER_ORIGIN', 'WEB_PORT']) environment.add(INSTALLATION_NAMES.environment[suffix])
    for (const name of Object.keys(process.env)) if (name.startsWith('VITE_')) environment.add(name)
    for (const path of files.values()) {
      if (!path.startsWith(root) || path.includes('/node_modules/')) continue
      for (const match of readFileSync(path, 'utf8').matchAll(/\bprocess\.env(?:\.([A-Za-z_][\w]*)|\[['"]([^'"]+)['"]\])/g)) environment.add(match[1] ?? match[2])
    }
  }
  for (const name of [...environment].sort()) add(`env:${name}`, process.env[name] ?? '<unset>')
  if (existsSync(join(project, 'node_modules/@typescript/native'))) tools.add('@typescript/native')
  const toolDirectories = new Set()
  function tool(name, from = join(project, 'package.json'), selected) {
    const loader = createRequire(from)
    let entry = selected
    try { entry ??= loader.resolve(`${name}/package.json`) }
    catch {
      let directory = dirname(loader.resolve(name))
      while (directory !== dirname(directory)) {
        const manifest = join(directory, 'package.json')
        if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name) break
        directory = dirname(directory)
      }
      entry = join(directory, 'package.json')
    }
    const directory = realpathSync(dirname(entry))
    if (toolDirectories.has(directory)) return
    toolDirectories.add(directory)
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    dependencyNames.add(name)
    walk(directory, path => {
      if (path.includes('/node_modules/', directory.length) || /\.(?:map|md|txt)$/.test(path) || /\.d\.[cm]?ts$/.test(path)) return
      if (/\.(?:[cm]?js|json|node)$/.test(path) || !path.slice(directory.length + 1).includes('.')) addFile(path)
    })
    for (const dependency of Object.keys(manifest.dependencies ?? {})) tool(dependency, entry)
    const toolRequire = createRequire(entry)
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      try { toolRequire.resolve(`${dependency}/package.json`) }
      catch {
        try { toolRequire.resolve(dependency) } catch { continue } // Optional platform packages may be absent.
      }
      tool(dependency, entry)
    }
  }
  for (const name of tools) tool(name)
  for (const [name, from] of runtimeTools) tool(name, from)
  // Key the selected launcher, not its installation address. pnpm's generated
  // shims embed checkout/store prefixes; their target names still matter.
  const executables = compilerIndex >= 0 ? [command[compilerIndex]] : compilerArgs.length ? ['tsc'] : []
  for (const executable of executables) {
    const path = executable.includes('/') ? resolve(cwd, executable)
      : (process.env.PATH ?? '').split(delimiter).map(directory => resolve(cwd, directory, executable)).find(path => existsSync(path) && statSync(path).isFile())
    if (!path) throw new Error('Build cache compiler launcher is unavailable')
    let directory = dirname(realpathSync(path))
    while (directory !== dirname(directory) && !existsSync(join(directory, 'package.json'))) directory = dirname(directory)
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest.bin?.tsc) tool(manifest.name, manifestPath, manifestPath)
    }
    add('compiler launcher', readFileSync(path, 'utf8').replaceAll(root, '<checkout>')
      .replace(/(?:[A-Za-z]:)?\/(?:[^\s'";:]+\/)*node_modules\//g, '<modules>/'))
  }
  for (const [label, path] of [...files].sort(([a], [b]) => a.localeCompare(b))) add(label, readFileSync(path))
  lockIdentity(root, buildProjects[kind], new Set([...tools, ...dependencyNames]), add)
  return finish()
}
