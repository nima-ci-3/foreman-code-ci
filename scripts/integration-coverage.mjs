import { Session } from 'node:inspector'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { executedFunctions, functionSpans } from '../packages/contracts/src/ciFunctionCoverage.mjs'

/** Function-level V8 coverage avoids counters for every statement and source-map/HTML reporting. */
export async function startFileCoverage() {
  const session = new Session()
  session.connect()
  const post = (method, params) => new Promise((done, reject) => {
    session.post(method, params, (error, result) => error ? reject(error) : done(result))
  })
  await post('Profiler.enable')
  await post('Profiler.startPreciseCoverage', { callCount: false, detailed: false })
  const stop = async (root, tracked) => {
    try {
      const { result } = await post('Profiler.takePreciseCoverage')
      stop.requiresStatic = result.some(script => /^node:(?:internal\/)?(?:child_process|worker)/.test(script.url)
        && script.functions.some(fn => /^(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|Worker)$/.test(fn.functionName)
          && fn.ranges.some(range => range.count > 0)))
      await post('Profiler.stopPreciseCoverage')
      const files = executedRepositoryFiles(result, root, tracked)
      stop.functions = await executedFunctionStarts(result, root, new Set(files), post)
      return files
    } finally {
      session.disconnect()
    }
  }
  return stop
}

export function executedRepositoryFiles(scripts, root, tracked) {
  const files = new Set()
  for (const script of scripts) {
    if (!script.url.startsWith('file:') || !script.functions.some(fn => fn.ranges.some(range => range.count > 0))) continue
    let file = relative(root, fileURLToPath(script.url.split('?')[0])).replaceAll('\\', '/')
    // Both contracts packages and CI execute their built modules; selection compares the corresponding repository sources.
    file = file.replace(/^packages\/(contracts(?:-node)?)\/dist\//, 'packages/$1/src/').replace(/^apps\/ci\/dist\//, 'apps/ci/src/')
    const stem = file.replace(/\.[cm]?js$/, '')
    const candidate = [file, `${stem}.ts`, `${stem}.mts`, `${stem}.tsx`].find(path => tracked.has(path))
    if (candidate) files.add(candidate)
  }
  return [...files].sort()
}

const VLQ = new Int8Array(128).fill(-1)
for (const [index, char] of [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].entries()) VLQ[char.charCodeAt(0)] = index

/** Source map segments per generated line up to `lastLine`: [column, source, line, column], decoded from `mappings`. */
function decodeMappings(mappings, lastLine) {
  const lines = [[]]
  const state = [0, 0, 0, 0]
  let field = 0, value = 0, shift = 0
  for (let index = 0; index <= mappings.length; index++) {
    const code = index < mappings.length ? mappings.charCodeAt(index) : 59
    if (code === 44 || code === 59) {
      // A segment ends: ',' continues the line, ';' starts the next one.
      if (field >= 4) lines.at(-1).push([state[0], state[1], state[2], state[3]])
      field = 0
      if (code === 59) {
        if (lines.length > lastLine) break
        lines.push([])
        state[0] = 0
      }
      continue
    }
    const digit = VLQ[code]
    value += (digit & 31) << shift
    if (digit & 32) shift += 5
    else {
      if (field < 4) state[field] += value & 1 ? -(value >>> 1) : value >>> 1
      field++
      value = shift = 0
    }
  }
  return lines
}

/** A source position inside each executed function of the repository's source modules, as [line, column] in the file:
 * the first mapped position of the function's executed code, through the module's inline source map (functionSpans
 * attributes it). Executed code without any mapping is generated (Vite's export getters and imports), not source.
 * Built packages run other code than their sources and are left out: nothing in them is blanked. */
async function executedFunctionStarts(scripts, root, files, post) {
  await post('Debugger.enable')
  const starts = {}
  try {
    for (const script of scripts) {
      if (!script.url.startsWith('file:')) continue
      const file = relative(root, fileURLToPath(script.url.split('?')[0])).replaceAll('\\', '/')
      const executed = script.functions.filter(fn => fn.ranges[0]?.count > 0)
      // A built package (dist) counts for its source when its map names exactly that file (selection compares sources).
      if (!executed.length || !files.has(file) && !/^(?:packages\/[^/]+|apps\/ci)\/dist\//.test(file)) continue
      const { scriptSource } = await post('Debugger.getScriptSource', { scriptId: script.scriptId })
      const offsets = generatedPositions(scriptSource, executed.flatMap(fn => [fn.ranges[0].startOffset, fn.ranges[0].endOffset]))
      const ranges = executed.map((_, index) => [offsets[2 * index], offsets[2 * index + 1]]).filter(([start]) => start)
      // Vitest appends its own comments after the map.
      const map = [...scriptSource.matchAll(/\n\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)/g)].at(-1)
      if (!map) {
        // Plain modules run as written.
        if (files.has(file) && scriptSource === readFileSync(resolve(root, file), 'utf8')) {
          starts[file] = [...starts[file] ?? [], ...ranges.map(([start]) => start)]
        }
        continue
      }
      const sourceMap = JSON.parse(Buffer.from(map[1], 'base64').toString('utf8'))
      if (sourceMap.sources?.length !== 1) continue
      const source = files.has(file) ? file
        : relative(root, resolve(root, dirname(file), sourceMap.sourceRoot ?? '', sourceMap.sources[0])).replaceAll('\\', '/')
      if (!files.has(source)) continue
      const lines = decodeMappings(sourceMap.mappings, Math.max(0, ...ranges.map(([, end]) => end[0])))
      const positions = []
      for (const [[startLine, startColumn], [endLine, endColumn]] of ranges) {
        for (let line = startLine; line <= endLine; line++) {
          const segment = lines[line]?.find(item => (line > startLine || item[0] >= startColumn) && (line < endLine || item[0] < endColumn))
          if (segment) {
            positions.push([segment[2], segment[3]])
            break
          }
        }
      }
      starts[source] = [...starts[source] ?? [], ...positions]
    }
  } finally {
    await post('Debugger.disable')
  }
  return starts
}

/** [line, column] of each offset in the code the module map describes: Vite's module runner wraps it in a function
 * on the first line; null for offsets in that wrapper. */
function generatedPositions(source, offsets) {
  const wrapper = /^'use strict';async \([^)]*\)=>\{\{/.exec(source)?.[0].length ?? 0
  const lineStarts = [0]
  for (let index = source.indexOf('\n'); index >= 0; index = source.indexOf('\n', index + 1)) lineStarts.push(index + 1)
  return offsets.map(offset => {
    if (offset < wrapper) return null
    if (offset > source.length) offset = source.length
    let low = 0, high = lineStarts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (lineStarts[middle] <= offset) low = middle
      else high = middle - 1
    }
    return [low, offset - lineStarts[low] - (low === 0 ? wrapper : 0)]
  })
}

/** Converts each test's function starts into the paths of the functions they start (functionSpans), sharing one parse
 * per source file. Sets are stored once and tests list `[file, set]` pairs; files without a set keep all their text. */
export function functionCoverage(root, reports) {
  const ts = createRequire(new URL('../apps/api/package.json', import.meta.url))('typescript')
  const spans = new Map()
  const sets = []
  const setIndexes = new Map()
  const functions = {}
  for (const [test, starts] of Object.entries(reports)) {
    const entries = []
    for (const [file, positions] of Object.entries(starts ?? {})) {
      let parsed = spans.get(file)
      if (parsed === undefined) {
        try {
          const text = readFileSync(resolve(root, file), 'utf8')
          const lineStarts = [0]
          for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) lineStarts.push(index + 1)
          parsed = { spans: functionSpans(text, file, ts), lineStarts }
        } catch (error) {
          console.error(`[integration] no function coverage for ${file}: ${error.message}`)
          parsed = null
        }
        spans.set(file, parsed)
      }
      if (!parsed) continue
      const executed = executedFunctions(parsed.spans, positions.map(([line, column]) => (parsed.lineStarts[line] ?? Infinity) + column))
      if (!executed) continue
      const key = JSON.stringify([file, executed])
      let index = setIndexes.get(key)
      if (index === undefined) {
        index = sets.push([file, executed]) - 1
        setIndexes.set(key, index)
      }
      entries.push(index)
    }
    functions[test] = entries.sort((left, right) => left - right)
  }
  return { functionSets: sets, functions }
}

/** Each worker writes once; the parent publishes only reports from successful, complete first attempts. */
export function integrationCoverageReport(directory, commit, testFiles, completed, root = process.cwd()) {
  const coverage = {}
  const staticTests = []
  const starts = {}
  for (const file of completed) {
    const path = resolve(directory, `${file.slice('apps/api/test/'.length)}.json`)
    if (existsSync(path)) {
      const report = JSON.parse(readFileSync(path, 'utf8'))
      coverage[file] = report.files
      if (report.requiresStatic) staticTests.push(file)
      else if (report.functions) starts[file] = report.functions
    } else {
      coverage[file] = []
      staticTests.push(file)
    }
  }
  return { version: 1, commit, testFiles, coverage, staticTests,
    ...Object.keys(starts).length ? functionCoverage(root, starts) : {} }
}

export function writeFileCoverage(directory, file, files, requiresStatic, functions) {
  writeFileSync(resolve(directory, `${file.slice('apps/api/test/'.length)}.json`), JSON.stringify({ files, requiresStatic, functions }))
}
