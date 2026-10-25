import type { KeyboardEvent, RefObject } from 'react'

/** Typeahead buffer one open menu keeps between key presses. */
export type MenuTypeahead = { text: string; at: number }

/**
 * The menu item a key moves focus to, for every menu: arrows wrap, Home/End jump, and printable keys search labels
 * (a repeated letter cycles; composition input is ignored). `focusable` lists the item indexes focus may land on.
 * Returns -1 when the key does not move focus.
 */
export function menuKeyTarget(event: KeyboardEvent, input: {
  labels: readonly (string | undefined)[]; focusable: readonly number[]; current: number; typeahead: MenuTypeahead
}): number {
  const { labels, focusable, current, typeahead } = input
  if (!focusable.length) return -1
  const offset = focusable.indexOf(current)
  if (event.key === 'ArrowDown') return focusable[(offset + 1) % focusable.length]!
  if (event.key === 'ArrowUp') return focusable[(offset - 1 + focusable.length) % focusable.length]!
  if (event.key === 'Home') return focusable[0]!
  if (event.key === 'End') return focusable.at(-1)!
  if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey
    && !event.nativeEvent.isComposing) {
    const now = Date.now()
    const char = event.key.toLocaleLowerCase()
    const previous = now - typeahead.at < 650 ? typeahead.text : ''
    const text = previous === char ? char : previous + char
    typeahead.text = text
    typeahead.at = now
    return [...focusable.slice(offset + 1), ...focusable.slice(0, offset + 1)]
      .find(index => labels[index]?.toLocaleLowerCase().startsWith(text)) ?? -1
  }
  return -1
}

/**
 * Tab out of an open menu: close it and move focus to the control after (or before) its trigger, resolved before the
 * focused item is removed, so focus never falls back to the page body.
 */
export function tabOutOfMenu(event: KeyboardEvent, trigger: RefObject<HTMLElement | null>, close: () => void) {
  event.preventDefault()
  event.stopPropagation()
  const button = trigger.current
  const scope = button?.closest('dialog') ?? document.body
  const candidates = Array.from(scope.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,[tabindex="0"]'))
    .filter(element => !element.closest('[role="menu"],[hidden],[inert]') && !element.matches(':disabled')
      && element.getClientRects().length > 0)
  const current = button ? candidates.indexOf(button) : -1
  close()
  ;(candidates[current + (event.shiftKey ? -1 : 1)] ?? button)?.focus()
}
