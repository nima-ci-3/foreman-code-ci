import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { ResultKeysReply, ResultKeysRequest } from './resultKeysWorker.js'

const workerUrl = new URL('./resultKeysWorker.js', import.meta.url)

/** Computes result cache keys on one worker thread (resultKeysWorker), restarted after a crash. */
export class ResultKeyThread {
  private worker: Worker | undefined
  private next = 1
  private readonly pending = new Map<number, { resolve(reply: ResultKeysReply): void; reject(error: Error): void }>()

  /** Only built code has the worker module; tests running sources compute keys in process. */
  static available() {
    return existsSync(fileURLToPath(workerUrl))
  }

  async keys(clone: string, commit: string, files: ResultKeysRequest['files'], timeoutMs: number, functions?: ResultKeysRequest['functions']) {
    const id = this.next++
    const reply = await new Promise<ResultKeysReply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.thread().postMessage({ id, clone, commit, files, timeoutMs, ...functions ? { functions } : {} } satisfies ResultKeysRequest)
    })
    if ('error' in reply) throw new Error(reply.error)
    return reply.keys
  }

  private thread() {
    if (this.worker) return this.worker
    const worker = new Worker(workerUrl)
    // A key batch never holds the API process open at shutdown.
    worker.unref()
    worker.on('message', (reply: ResultKeysReply) => {
      this.pending.get(reply.id)?.resolve(reply)
      this.pending.delete(reply.id)
    })
    const fail = (error: Error) => {
      if (this.worker === worker) this.worker = undefined
      for (const waiter of this.pending.values()) waiter.reject(error)
      this.pending.clear()
    }
    worker.on('error', fail)
    worker.on('exit', code => fail(new Error(`The result key thread exited with ${code}.`)))
    this.worker = worker
    return worker
  }
}
