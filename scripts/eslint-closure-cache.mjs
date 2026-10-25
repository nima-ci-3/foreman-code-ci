// Lints only the files whose result could have changed since they last passed, for type-aware ESLint rules.
// A file's key hashes its own text, every repository file it imports (transitively; a workspace package counts as its
// whole source tree) and the shared inputs (lint config, tsconfig, lockfile, local rules, ambient declarations).
// ESLint's own --cache keys a file by its text alone, so a typed rule could keep passing a file whose import changed.
// Usage, from a package directory: node ../../scripts/eslint-closure-cache.mjs [eslint args...]
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const project = process.cwd()
const cacheFile = join(project, 'node_modules/.cache/eslint/closure-passes.json')
const sourcePattern = /\.(?:[cm]?[jt]sx?)$/
const skip = new Set(['node_modules', 'dist', 'build', 'coverage', '.logs', '.git'])

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

// Workspace packages a file may import by name; each is one dependency covering its whole source tree.
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
    const files = walk(directory).filter(file => sourcePattern.test(file) || file.endsWith('package.json')).sort()
    value = hash(files.map(file => `${relative(root, file)}\0${fileHash(file)}`).join('\n'))
    packageHashes.set(directory, value)
  }
  return value
}

const specifiers = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bexport\s+\*\s+from\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g
function resolveRelative(from, specifier) {
  const base = resolve(dirname(from), specifier)
  const stem = base.replace(/\.(?:[cm]?js|jsx)$/, '')
  for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, `${stem}.js`, `${stem}.mjs`,
    join(base, 'index.ts'), join(base, 'index.tsx'), join(base, 'index.js')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return undefined
}
const edges = new Map()
function dependencies(file) {
  let value = edges.get(file)
  if (value) return value
  value = { files: [], packages: [] }
  for (const [, specifier] of text(file).matchAll(specifiers)) {
    if (specifier.startsWith('.')) {
      const target = resolveRelative(file, specifier)
      if (target) value.files.push(target)
    } else {
      const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
      if (packages.has(name)) value.packages.push(packages.get(name))
    }
  }
  edges.set(file, value)
  return value
}
function closureKey(file, shared) {
  const seen = new Set([file]), queue = [file], workspace = new Set()
  while (queue.length) {
    const next = dependencies(queue.pop())
    for (const target of next.files) if (!seen.has(target)) { seen.add(target); queue.push(target) }
    for (const directory of next.packages) workspace.add(directory)
  }
  const parts = [...seen].sort().map(path => `${relative(root, path)}\0${fileHash(path)}`)
  const packageParts = [...workspace].sort().map(directory => `${relative(root, directory)}\0${packageHash(directory)}`)
  return hash([shared, ...parts, ...packageParts].join('\n'))
}

const projectFiles = walk(project)
const sharedInputs = [
  ...projectFiles.filter(file => /(?:^|\/)(?:eslint\.config\.[cm]?js|tsconfig[^/]*\.json|package\.json)$/.test(file)
    || file.endsWith('.d.ts')),
  join(root, 'pnpm-lock.yaml'), join(root, 'package.json'), join(root, 'tsconfig.base.json'),
  ...walk(join(root, 'scripts/eslint-plugin-foreman')),
].filter(file => existsSync(file)).sort()
const shared = hash(JSON.stringify([process.version, process.argv.slice(2),
  sharedInputs.map(file => [relative(root, file), fileHash(file)])]))

const targets = projectFiles.filter(file => sourcePattern.test(file) && !file.endsWith('.d.ts'))
const keys = Object.fromEntries(targets.map(file => [relative(project, file), closureKey(file, shared)]))
let passed = {}
try { passed = JSON.parse(readFileSync(cacheFile, 'utf8')).files ?? {} }
catch (error) { if (error.code !== 'ENOENT') console.warn(`Lint pass cache unreadable, linting everything: ${error.message}`) }
const stale = Object.keys(keys).filter(file => passed[file] !== keys[file])
console.log(`Lint closure cache: ${targets.length - stale.length} of ${targets.length} files unchanged since they passed; linting ${stale.length}.`)
let status = 0
// Bounded argument lists; ESLint still applies its ignores to every path it is given.
for (let start = 0; start < stale.length && status === 0; start += 400) {
  const result = spawnSync(process.execPath, ['--max-old-space-size=8192', './node_modules/eslint/bin/eslint.js',
    ...process.argv.slice(2), '--no-warn-ignored', ...stale.slice(start, start + 400)], { stdio: 'inherit' })
  status = result.status ?? 1
}
if (status === 0) {
  mkdirSync(dirname(cacheFile), { recursive: true })
  writeFileSync(cacheFile, JSON.stringify({ files: keys }))
}
process.exit(status)
