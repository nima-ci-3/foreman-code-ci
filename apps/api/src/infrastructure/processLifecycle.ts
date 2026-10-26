import type { Logger } from 'pino'
import { flushLogsSync } from './logger.js'

/**
 * Nothing in the API process may end without a final log line. Installed first
 * in server.ts, before configuration or infrastructure can fail.
 *
 * Crashes keep Node's own semantics (exit 1) but are logged at fatal first.
 * The logger writes asynchronously, so each final line is drained explicitly before exit.
 * SIGKILL and the kernel OOM killer cannot be caught: the absence of a
 * `process exiting` line after the last entry means exactly that.
 */
export function installProcessLifecycleLogging(log: Logger, exit: (code: number) => void = (code) => process.exit(code)) {
  let crashed = false
  const crash = (kind: 'uncaught exception' | 'unhandled rejection') => (error: unknown) => {
    if (crashed) return
    crashed = true
    log.fatal({ err: error instanceof Error ? error : new Error(String(error)) }, kind)
    flushLogsSync()
    exit(1)
  }
  const onException = crash('uncaught exception'), onRejection = crash('unhandled rejection')
  const onWarning = (warning: Error) => log.warn({ err: warning }, 'process warning')
  const onSignal = (signal: NodeJS.Signals) => log.info({ signal }, 'shutdown signal received')
  const onExit = (code: number) => {
    log[code === 0 ? 'info' : 'error']({ exitCode: code, uptimeSeconds: Math.round(process.uptime()) }, 'process exiting')
    flushLogsSync()
  }
  process.on('uncaughtException', onException)
  process.on('unhandledRejection', onRejection)
  process.on('warning', onWarning)
  // Observe only, once: server.ts owns the shutdown, and a second signal must
  // still reach Node's default handler and end a hung shutdown.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.prependOnceListener(signal, onSignal)
  process.on('exit', onExit)
  return () => {
    process.off('uncaughtException', onException)
    process.off('unhandledRejection', onRejection)
    process.off('warning', onWarning)
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.off(signal, onSignal)
    process.off('exit', onExit)
  }
}

/**
 * Ends the process once a signal's shutdown has finished. Shutdown drains requests, runtime steps and the
 * database first; a handle still open after that must not keep a closed API alive until systemd kills it.
 * A shutdown still running at the deadline names what it waits for, flushed so the line survives, then exits
 * before systemd's own kill would discard the evidence.
 */
export async function exitAfterShutdown(close: () => Promise<void>, log: Logger,
  exit: (code: number) => void = (code) => process.exit(code),
  { deadlineMs = 20_000, pending = () => ({}) }: { deadlineMs?: number; pending?: () => object } = {}) {
  let code = 0
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<'deadline'>(resolve => { timer = setTimeout(() => resolve('deadline'), deadlineMs) })
  try {
    if (await Promise.race([close().then(() => 'closed' as const), deadline]) === 'deadline') {
      log.error({ deadlineMs, ...pending() }, 'shutdown deadline reached')
      flushLogsSync()
      code = 1
    }
  } catch (error) {
    log.error({ err: error }, 'shutdown failed')
    code = 1
  } finally { clearTimeout(timer) }
  const handles = process.getActiveResourcesInfo().filter(kind => kind !== 'TTYWrap')
  if (handles.length) log.warn({ handles }, 'handles still open after shutdown')
  exit(code)
}
