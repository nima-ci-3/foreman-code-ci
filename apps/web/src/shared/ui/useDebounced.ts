import { useEffect, useRef, useState } from 'react'

/** The value once it has stayed unchanged for `delayMs`. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return settled
}

/** Commits a draft (search text) once it has stayed unchanged for `delayMs` and differs from the committed value.
 * A change to either value restarts the wait; re-renders and a new `commit` function do not. */
export function useDebouncedCommit<T>(draft: T, committed: T, commit: (value: T) => void, delayMs: number) {
  const latest = useRef(commit)
  latest.current = commit
  useEffect(() => {
    if (Object.is(draft, committed)) return
    const timer = setTimeout(() => latest.current(draft), delayMs)
    return () => clearTimeout(timer)
  }, [draft, committed, delayMs])
}
