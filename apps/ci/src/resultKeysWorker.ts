// Worker thread that computes CI result cache keys, so walking import graphs and hashing never runs on the API's
// event loop. Blobs come from one `git cat-file --batch` process per commit instead of a process per file.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promisify } from 'node:util'
import { parentPort } from 'node:worker_threads'
import { CiResultKeys, type CiTestTree } from './resultCache.js'

export interface ResultKeysRequest {
  id: number
  clone: string
  commit: string
  files: { file: string; suite: string; part: string }[]
  timeoutMs: number
}
export type ResultKeysReply = { id: number; keys: Record<string, { key: string | null; reason?: string }> }
  | { id: number; error: string }

const run = promisify(execFile)

/** Reads blobs in request order over one long-lived `git cat-file --batch`. */
class BlobReader {
  private readonly process: ChildProcessWithoutNullStreams
  private readonly waiting: { resolve(value: string): void; reject(error: Error): void }[] = []
  private buffer = Buffer.alloc(0)
  private failure: Error | undefined

  constructor(clone: string) {
    this.process = spawn('git', ['-C', clone, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.process.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.drain()
    })
    const fail = (error: Error) => {
      this.failure = error
      for (const waiter of this.waiting.splice(0)) waiter.reject(error)
    }
    this.process.on('error', fail)
    this.process.on('close', code => fail(new Error(`git cat-file exited with ${code}.`)))
    this.process.stdin.on('error', fail)
  }

  read(id: string): Promise<string> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject })
      this.process.stdin.write(`${id}\n`)
    })
  }

  close() {
    this.process.stdin.end()
    this.process.kill()
  }

  private drain() {
    while (this.waiting.length) {
      const newline = this.buffer.indexOf(10)
      if (newline < 0) return
      const header = this.buffer.subarray(0, newline).toString('utf8')
      if (header.endsWith(' missing')) {
        this.buffer = this.buffer.subarray(newline + 1)
        this.waiting.shift()!.reject(new Error(`The CI commit has no object ${header.split(' ')[0]}.`))
        continue
      }
      const size = Number(header.split(' ')[2])
      if (this.buffer.length < newline + 1 + size + 1) return
      const content = this.buffer.subarray(newline + 1, newline + 1 + size).toString('utf8')
      this.buffer = this.buffer.subarray(newline + 1 + size + 1)
      this.waiting.shift()!.resolve(content)
    }
  }
}

/** The key graphs of recently keyed commits; each holds its blob reader open. */
const graphs = new Map<string, Promise<{ keys: CiResultKeys; reader: BlobReader }>>()

async function graphFor(clone: string, commit: string) {
  const id = `${clone}\0${commit}`
  let graph = graphs.get(id)
  if (!graph) {
    graph = (async () => {
      const listing = await run('git', ['-C', clone, 'ls-tree', '-r', '-z', commit], { maxBuffer: 256 * 1024 * 1024 })
      const blobs = new Map<string, string>()
      for (const entry of listing.stdout.split('\0').filter(Boolean)) {
        const tab = entry.indexOf('\t')
        const [mode, type, object] = entry.slice(0, tab).split(' ')
        // Submodules have no blob; a test reaching one has no key.
        if (type === 'blob') blobs.set(entry.slice(tab + 1), `${mode}:${object}`)
      }
      const reader = new BlobReader(clone)
      const tree: CiTestTree = { blobs, read: async path => {
        const object = blobs.get(path)?.split(':')[1]
        if (!object) throw new Error(`The CI commit has no file ${path}.`)
        return reader.read(object)
      } }
      try {
        return { keys: await CiResultKeys.create(tree, AbortSignal.timeout(60_000)), reader }
      } catch (error) {
        reader.close()
        throw error
      }
    })()
    graph.catch(() => graphs.delete(id))
    graphs.set(id, graph)
    if (graphs.size > 8) {
      const [oldest, evicted] = graphs.entries().next().value!
      graphs.delete(oldest)
      void evicted.then(value => value.reader.close(), () => undefined)
    }
  }
  return graph
}

async function answer(request: ResultKeysRequest): Promise<ResultKeysReply> {
  try {
    const keys = (await graphFor(request.clone, request.commit)).keys.bounded(AbortSignal.timeout(request.timeoutMs))
    const entries = await Promise.all(request.files.map(async ({ file, suite, part }) => [file, await keys.key(file, suite, part)] as const))
    return { id: request.id, keys: Object.fromEntries(entries) }
  } catch (error) {
    return { id: request.id, error: error instanceof Error ? error.message : String(error) }
  }
}

parentPort?.on('message', (request: ResultKeysRequest) => {
  void answer(request).then(reply => parentPort!.postMessage(reply))
})
