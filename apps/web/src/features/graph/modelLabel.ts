/** A readable name for a model id the model list does not name: claude-haiku-4-5-20251001 → Haiku 4.5. */
export function modelLabel(id: string) {
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id)
  if (!claude) return id
  const [, family, major, minor] = claude
  return `${family![0]!.toUpperCase()}${family!.slice(1)} ${major}${minor ? `.${minor}` : ''}`
}
