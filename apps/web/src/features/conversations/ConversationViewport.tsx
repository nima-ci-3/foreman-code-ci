import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react'
import { useRememberedChatScroll } from '../chat-core'

/**
 * The one transcript scroller for Agent and Operator chats: it follows new output, stops following once the reader
 * scrolls up, and keeps following when either the content or the viewport itself resizes. No server data lives here.
 */
export function ConversationViewport({ revision, children, storageKey, label = 'Agent conversation transcript', classPrefix = 'conversation-viewport' }: {
  revision: string; children: (onBrowse: () => void) => ReactNode; storageKey?: string
  /** Accessible name of the scroll region. */
  label?: string
  /** Class of the wrapper; the scroll region gets `${classPrefix}-scroll`. */
  classPrefix?: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null), contentRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  useRememberedChatScroll(storageKey, scrollRef, following)
  const onBrowse = useCallback(() => { following.current = false }, [])
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    if (following.current) scroll.scrollTop = scroll.scrollHeight
  }, [revision])
  useLayoutEffect(() => {
    if (!contentRef.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const scroll = scrollRef.current
      if (scroll && following.current) scroll.scrollTop = scroll.scrollHeight
    })
    observer.observe(contentRef.current)
    if (scrollRef.current) observer.observe(scrollRef.current)
    return () => observer.disconnect()
  }, [])
  return <div className={classPrefix}>
    <div ref={scrollRef} className={`${classPrefix}-scroll`} role="region" aria-label={label} tabIndex={0}
      onScroll={(event) => {
        const scroll = event.currentTarget
        following.current = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 48
      }}>
      <div ref={contentRef}>{children(onBrowse)}</div>
    </div>
  </div>
}
