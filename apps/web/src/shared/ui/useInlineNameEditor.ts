import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

/**
 * A name shown as a button that turns into a field when clicked. Enter saves and Escape cancels (never while an
 * input method is composing), both returning focus to the name; leaving the field saves too. `onCommit` receives a
 * trimmed, non-empty, changed name and whether the keyboard committed it, so a caller may confirm a blur first.
 */
export function useInlineNameEditor({ name, disabled = false, onCommit }: {
  name: string; disabled?: boolean; onCommit(next: string, by: { keyboard: boolean }): void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)
  const input = useRef<HTMLInputElement>(null)
  const title = useRef<HTMLButtonElement>(null)
  const active = useRef(false)
  const restoreFocus = useRef(false)
  useEffect(() => {
    if (editing) { input.current?.focus(); input.current?.select() }
    else if (restoreFocus.current) { restoreFocus.current = false; title.current?.focus() }
  }, [editing])
  const finish = (save: boolean, keyboard: boolean) => {
    if (!active.current) return
    active.current = false
    restoreFocus.current = keyboard
    const next = value.trim()
    setEditing(false)
    if (save && !disabled && next && next !== name) onCommit(next, { keyboard })
  }
  const begin = () => {
    if (disabled) return
    setValue(name)
    active.current = true
    setEditing(true)
  }
  return { editing, begin, title, field: {
    ref: input, value,
    onChange: (event: { currentTarget: HTMLInputElement }) => setValue(event.currentTarget.value),
    onBlur: () => finish(true, false),
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing || (event.key !== 'Enter' && event.key !== 'Escape')) return
      event.preventDefault()
      event.stopPropagation()
      finish(event.key === 'Enter', true)
    },
  } }
}
