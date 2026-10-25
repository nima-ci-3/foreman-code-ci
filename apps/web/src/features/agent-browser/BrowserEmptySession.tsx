import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Button } from '../../shared/ui/nocturne'
import { browserAccessDenied, browserErrorMessage, browserRequestUncertain } from './errors'
import { validateBrowserRead } from './queries'
import type { BrowserSelection, BrowserSessionRead, BrowserUiPort } from './types'

/** An empty session has no tab lease to capture, but can still create its next page. */
export function BrowserEmptySession(props: {
  port: BrowserUiPort; initial: BrowserSessionRead; selection?: BrowserSelection; readOnly: boolean
  onRead(read: BrowserSessionRead): void; onSelectTab(tabId: string): void
  onDenied(): void; onCleanupError(message: string): void
}) {
  const [viewerId] = useState(() => crypto.randomUUID())
  const held = useRef<number | undefined>(undefined)
  const mounted = useRef(false)
  const current = useRef(props)
  current.current = props
  const release = async () => {
    const epoch = held.current
    if (epoch === undefined) return
    const control = await current.current.port.release(current.current.initial.session, viewerId, epoch, crypto.randomUUID())
    if (held.current === epoch) held.current = undefined
    return control
  }
  const cleanup = () => { void release().catch(error => current.current.onCleanupError(browserErrorMessage(error))) }
  const cleanupRef = useRef(cleanup)
  cleanupRef.current = cleanup
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; cleanupRef.current() }
  }, [])
  const create = useMutation({ mutationFn: async (request: { commandId: string; epoch?: number }) => {
    if (request.epoch === undefined) {
      const control = await props.port.acquire(props.initial.session, viewerId, request.commandId)
      if (control.sessionId !== props.initial.session.id || control.state !== 'user' || control.controllingViewerId !== viewerId) {
        throw new Error('User control is not confirmed.')
      }
      held.current = request.epoch = control.epoch
    }
    if (!mounted.current) { cleanupRef.current(); return null }
    const receipt = await props.port.createTab(props.initial.session, viewerId, request.epoch, request.commandId)
    const read = validateBrowserRead(receipt, props.selection)
    if (read.session.id !== props.initial.session.id || read.session.browserGeneration !== props.initial.session.browserGeneration
      || !read.tabs.some(tab => tab.tabId === receipt.createdTabId)) throw new Error('The new browser tab is not confirmed. Check the original action.')
    return { read, tabId: receipt.createdTabId }
  }, retry: false, onSuccess: async result => {
    let control
    try { control = await release() } catch (error) { current.current.onCleanupError(browserErrorMessage(error)) }
    if (!result || !mounted.current) return
    props.onRead(control ? { ...result.read, control } : result.read); props.onSelectTab(result.tabId)
  }, onError: error => {
    if (!browserRequestUncertain(error)) cleanupRef.current()
    if (mounted.current && browserAccessDenied(error)) props.onDenied()
  } })
  const uncertain = create.isError && browserRequestUncertain(create.error)
  return <div className="agent-browser-actions"><p>No browser tab is open.</p>
    {!props.readOnly ? <Button disabled={create.isPending} onClick={() => create.mutate(uncertain && create.variables
      ? create.variables : { commandId: crypto.randomUUID() })}>{uncertain ? 'Check original browser action' : 'New tab'}</Button> : null}
    {create.error ? <p role="alert">{browserErrorMessage(create.error)}</p> : null}
  </div>
}
