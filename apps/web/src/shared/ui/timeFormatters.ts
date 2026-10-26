/** "Oct 25, 2026, 11:40 PM": one date-and-time style for every timestamp label, in the viewer's locale. */
export function formatDateTime(value: string | number | Date): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** "0.4s", "12s", "2m 4s", "1h 5m": one elapsed-time style; negative spans read as zero. */
export function formatElapsed(milliseconds: number): string {
  const safe = Math.max(0, milliseconds)
  if (safe < 10_000) return `${(safe / 1000).toFixed(1).replace(/\.0$/, '')}s`
  const seconds = Math.round(safe / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
