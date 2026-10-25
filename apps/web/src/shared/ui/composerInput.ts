import { useLayoutEffect, type KeyboardEvent, type RefObject } from 'react'

/** Enter sends; Shift/Alt/Ctrl/Meta+Enter and Enter while an input method is composing do not. */
export function isComposerSendKey(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
    && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229
}

/**
 * Grows a chat textarea with its content up to a limit, and measures again when its width changes (a narrower
 * column wraps the same text onto more lines).
 */
export function useAutosizeTextarea(ref: RefObject<HTMLTextAreaElement | null>, value: string,
  { minHeight = 0, maxHeight, maxLines }: { minHeight?: number; maxHeight?: number; maxLines?: number }) {
  useLayoutEffect(() => {
    const input = ref.current
    if (!input) return
    const resize = () => {
      input.style.height = 'auto'
      const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 20
      const limit = maxHeight ?? lineHeight * (maxLines ?? 8)
      input.style.height = `${Math.min(limit, Math.max(minHeight, input.scrollHeight))}px`
    }
    resize()
    let width = input.clientWidth
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
      if (input.clientWidth === width) return
      width = input.clientWidth
      resize()
    })
    observer?.observe(input)
    return () => observer?.disconnect()
  }, [maxHeight, maxLines, minHeight, ref, value])
}
